import * as THREE from 'three';

/** Limit expensive PBR shading while preserving the native view's aspect. */
export function modelRenderSize(width: number, height: number, maxEdge: number) {
  const scale = Math.min(1, maxEdge / Math.max(1, width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Simulator OpenGL is software rasterized. Render the same lit geometry to a
 * bounded target, then upscale one simple quad; shrinking renderer.setSize
 * alone does not resize Expo GL's native drawing buffer. Physical devices
 * retain their native direct rendering path. */
export function createModelRenderSurface(
  renderer: THREE.WebGLRenderer,
  width: number,
  height: number,
  maxEdge: number | null,
) {
  if (maxEdge === null)
    return {
      render: (scene: THREE.Scene, camera: THREE.Camera) => renderer.render(scene, camera),
      resize: (_width: number, _height: number) => {},
      dispose: () => {},
    };
  const size = modelRenderSize(width, height, maxEdge);
  const target = new THREE.WebGLRenderTarget(size.width, size.height, {
    depthBuffer: true,
    stencilBuffer: false,
  });
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 2);
  camera.position.z = 1;
  const geometry = new THREE.PlaneGeometry(2, 2);
  const material = new THREE.MeshBasicMaterial({
    map: target.texture,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  scene.add(new THREE.Mesh(geometry, material));
  return {
    render: (modelScene: THREE.Scene, modelCamera: THREE.Camera) => {
      renderer.setRenderTarget(target);
      renderer.render(modelScene, modelCamera);
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
    },
    resize: (nextWidth: number, nextHeight: number) => {
      const next = modelRenderSize(nextWidth, nextHeight, maxEdge);
      target.setSize(next.width, next.height);
    },
    dispose: () => {
      target.dispose();
      geometry.dispose();
      material.dispose();
    },
  };
}
