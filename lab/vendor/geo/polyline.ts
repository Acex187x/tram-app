// Resolution shim for the VERBATIM engine copies in ../engine: they import
// `../geo/polyline` relative to their original home (src/lib/engine), so the
// lab provides that path here and forwards to the app's real module. Keeping
// the shim (instead of rewriting the import) is what lets every vendored file
// stay byte-identical to its commit:
//
//   git show 050c8ae:src/lib/engine/engine.ts | diff - lab/vendor/engine/engine.ts
//
// If the app ever drops src/lib/geo/polyline too, vendor it here as well —
// this file is the single place the frozen engine reaches back into the app.

export * from '@/lib/geo/polyline';
