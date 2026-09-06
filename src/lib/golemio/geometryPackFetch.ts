/** Startup pack transport only. No cache mutation, scheduling or native imports. */
export const PREFERRED_PACK_TIMEOUT_MS = 3_000;
export const PUBLIC_PACK_TIMEOUT_MS = 20_000;

export interface PackFetchOptions<T> {
  preferredUrl?: string;
  publicUrl: string;
  signal?: AbortSignal;
  parse: (value: unknown) => T | null;
  publicTimeoutMs?: number;
  supplementPublic?: boolean;
  onPack?: (pack: T, source: "preferred" | "public") => void;
}

/** The deadline settles the result itself: some native network/body reads do
 * not reject promptly on abort. Late completion cannot become an accepted pack. */
function fetchOne<T>(
  url: string,
  timeoutMs: number,
  options: PackFetchOptions<T>,
): Promise<T | null> {
  if (options.signal?.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const controller = new AbortController();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: T | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolve(value);
    };
    const abort = (): void => {
      controller.abort();
      finish(null);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(abort, timeoutMs);
    // The promise chain observes both a late network rejection and a late body
    // rejection after timeout. Neither can leak an unhandled rejection.
    void Promise.resolve()
      .then(() => {
        if (settled || options.signal?.aborted) return null;
        return fetch(url, {
          signal: controller.signal,
          headers: { Accept: "application/json", "Accept-Encoding": "gzip" },
        });
      })
      .then(async (response) => {
        if (!response || !response.ok || settled) return null;
        const body: unknown = await response.json();
        return settled || options.signal?.aborted ? null : options.parse(body);
      })
      .then(
        (value) => finish(value),
        () => finish(null),
      );
  });
}

/** A configured preferred source gets a short private-network deadline. All
 * unavailable/malformed outcomes fall back once to the ordinary public source.
 * Cancellation terminates the whole attempt; it never starts a fallback. */
export async function fetchGeometryPackSources<T>(
  options: PackFetchOptions<T>,
): Promise<T | null> {
  if (options.signal?.aborted) return null;
  const preferred = options.preferredUrl?.trim();
  let accepted: T | null = null;
  if (preferred && preferred !== options.publicUrl) {
    accepted = await fetchOne(preferred, PREFERRED_PACK_TIMEOUT_MS, options);
    if (options.signal?.aborted) return null;
    if (accepted !== null) {
      options.onPack?.(accepted, "preferred");
      if (!options.supplementPublic) return accepted;
    }
  }
  if (options.signal?.aborted) return null;
  const supplement = await fetchOne(
    options.publicUrl,
    options.publicTimeoutMs ?? PUBLIC_PACK_TIMEOUT_MS,
    options,
  );
  if (options.signal?.aborted) return null;
  if (supplement !== null) options.onPack?.(supplement, "public");
  return accepted ?? supplement;
}
