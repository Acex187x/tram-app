/** Mechanism-bearing GLBs are exclusive to the Three viewer. The map keeps
 * its compact merged meshes and never pays for movable leaf draw calls. */
export const VIEWER_MODEL_ASSETS: Readonly<Record<string, number>> = {
  t3: require('../../../assets/models/t3-viewer.glb'),
  t3rp: require('../../../assets/models/t3rp-viewer.glb'),
  t3rplf: require('../../../assets/models/t3rplf-viewer.glb'),
  'kt8d5-a': require('../../../assets/models/kt8d5-a-viewer.glb'),
  'kt8d5-b': require('../../../assets/models/kt8d5-b-viewer.glb'),
  'kt8d5-c': require('../../../assets/models/kt8d5-c-viewer.glb'),
  '14t-a': require('../../../assets/models/14t-a-viewer.glb'),
  '14t-b': require('../../../assets/models/14t-b-viewer.glb'),
  '14t-c': require('../../../assets/models/14t-c-viewer.glb'),
  '14t-d': require('../../../assets/models/14t-d-viewer.glb'),
  '14t-e': require('../../../assets/models/14t-e-viewer.glb'),
  '15t-a': require('../../../assets/models/15t-a-viewer.glb'),
  '15t-b': require('../../../assets/models/15t-b-viewer.glb'),
  '15t-c': require('../../../assets/models/15t-c-viewer.glb'),
  '52t-a': require('../../../assets/models/52t-a-viewer.glb'),
  '52t-b': require('../../../assets/models/52t-b-viewer.glb'),
  '52t-c': require('../../../assets/models/52t-c-viewer.glb'),
  '52t-d': require('../../../assets/models/52t-d-viewer.glb'),
  '52t-e': require('../../../assets/models/52t-e-viewer.glb'),
};
