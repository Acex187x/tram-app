import * as THREE from 'three';

/** The Simulator rasterizes OpenGL on the CPU. Lambert moves the lighting work
 * to vertices and avoids PBR's per-pixel microfacet powers. Geometry, authored
 * paint, glass opacity, emission and textures are preserved; metal highlights
 * are deliberately approximate. Physical devices never call this converter. */
export function useSimulatorMaterials(root: THREE.Object3D): THREE.Material[] {
  const replacements = new Map<THREE.Material, THREE.MeshLambertMaterial>();
  const replace = (material: THREE.Material): THREE.Material => {
    const source = material as THREE.MeshStandardMaterial;
    if (!source.isMeshStandardMaterial) return material;
    let result = replacements.get(source);
    if (!result) {
      result = new THREE.MeshLambertMaterial({
        name: source.name,
        color: source.color,
        emissive: source.emissive,
        emissiveIntensity: source.emissiveIntensity,
        map: source.map,
        emissiveMap: source.emissiveMap,
        alphaMap: source.alphaMap,
        opacity: source.opacity,
        transparent: source.transparent,
        alphaTest: source.alphaTest,
        side: source.side,
        depthTest: source.depthTest,
        depthWrite: source.depthWrite,
        vertexColors: source.vertexColors,
        flatShading: source.flatShading,
        toneMapped: source.toneMapped,
        polygonOffset: source.polygonOffset,
        polygonOffsetFactor: source.polygonOffsetFactor,
        polygonOffsetUnits: source.polygonOffsetUnits,
      });
      replacements.set(source, result);
    }
    return result;
  };
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map(replace)
      : replace(mesh.material);
  });
  // Originals are no longer reachable from meshes. Session disposal owns them.
  return [...replacements.keys()];
}
