// Follow-session behaviour: the gesture→pause decision, orientation capture,
// and the selection-store paused/target transitions that drive the redesigned
// follow camera (docs/decisions/map-rendering.md §10, ux-screens.md §5).
//
// The map screen (index.tsx) and the retarget loop (TramLayers) are thin glue
// over these; the branching policy lives in pure helpers + the store so it can
// be pinned here without rendering the map.

import { orientationFromCamera, shouldPauseFollow } from '@/components/map/followCamera';
import { useSelectionStore } from '@/stores/selection';

const reset = () => useSelectionStore.getState().clear();

describe('shouldPauseFollow (gesture → pause decision)', () => {
  it('pauses when a followed tram is grabbed by a map gesture', () => {
    // (а) A gesture during an active, unpaused follow pauses it.
    expect(
      shouldPauseFollow({ followKey: '9001', followPaused: false, isGestureActive: true }),
    ).toBe(true);
  });

  it('does not pause when nothing is followed', () => {
    expect(
      shouldPauseFollow({ followKey: null, followPaused: false, isGestureActive: true }),
    ).toBe(false);
  });

  it('does not pause without an active gesture (camera-event noise, our own setCamera)', () => {
    expect(
      shouldPauseFollow({ followKey: '9001', followPaused: false, isGestureActive: false }),
    ).toBe(false);
  });

  it('is idempotent — an already-paused follow does not re-pause (one store write per gesture)', () => {
    expect(
      shouldPauseFollow({ followKey: '9001', followPaused: true, isGestureActive: true }),
    ).toBe(false);
  });
});

describe('orientationFromCamera', () => {
  it('snapshots exactly the current zoom/pitch/heading as the fixed follow angle', () => {
    // (б) "Return to follow" captures the user's CURRENT camera as orientation.
    const cam = { zoom: 16.2, pitch: 42, heading: 275 };
    expect(orientationFromCamera(cam)).toEqual({ zoom: 16.2, pitch: 42, heading: 275 });
  });

  it('returns a fresh object (no aliasing of the live camera ref)', () => {
    const cam = { zoom: 17.5, pitch: 60, heading: 10 };
    const snap = orientationFromCamera(cam);
    cam.heading = 90;
    expect(snap.heading).toBe(10);
  });
});

describe('selection store — follow pause / target transitions', () => {
  beforeEach(reset);
  afterEach(reset);

  it('(а) pausing keeps followTramKey — we remember which tram', () => {
    const s = useSelectionStore.getState();
    s.setFollowTramKey('9001');
    expect(useSelectionStore.getState().followPaused).toBe(false);
    s.setFollowPaused(true);
    const after = useSelectionStore.getState();
    expect(after.followPaused).toBe(true);
    expect(after.followTramKey).toBe('9001'); // NOT cleared
  });

  it('(б) returning clears the paused flag', () => {
    const s = useSelectionStore.getState();
    s.setFollowTramKey('9001');
    s.setFollowPaused(true);
    s.setFollowPaused(false);
    expect(useSelectionStore.getState().followPaused).toBe(false);
    expect(useSelectionStore.getState().followTramKey).toBe('9001');
  });

  it('(в) the ✕ (setFollowTramKey null) ends follow and hides the chip', () => {
    const s = useSelectionStore.getState();
    s.setFollowTramKey('9001');
    s.setFollowPaused(true);
    s.setFollowTramKey(null);
    const after = useSelectionStore.getState();
    expect(after.followTramKey).toBeNull();
    expect(after.followPaused).toBe(false);
  });

  it('(г) a spotter target switch never leaves follow paused', () => {
    const s = useSelectionStore.getState();
    // Following + paused (user had grabbed the camera)…
    s.setFollowTramKey('9001');
    s.setFollowPaused(true);
    // …then the spotter hops to the next arrival via setFollowTramKey.
    s.setFollowTramKey('9002');
    const after = useSelectionStore.getState();
    expect(after.followTramKey).toBe('9002');
    expect(after.followPaused).toBe(false); // live, not paused
  });

  it('clear() resets both follow fields', () => {
    const s = useSelectionStore.getState();
    s.setFollowTramKey('9001');
    s.setFollowPaused(true);
    s.setSelectedTramKey('9001');
    s.clear();
    const after = useSelectionStore.getState();
    expect(after.followTramKey).toBeNull();
    expect(after.followPaused).toBe(false);
    expect(after.selectedTramKey).toBeNull();
  });
});
