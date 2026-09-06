import * as THREE from 'three';
import { createModelRenderSurface, modelRenderSize } from '@/components/model/renderSurface';

it('bounds simulator PBR pixels through portrait, landscape and small windows', () => {
  expect(modelRenderSize(1668, 2420, 900)).toEqual({ width: 620, height: 900 });
  expect(modelRenderSize(2420, 1668, 900)).toEqual({ width: 900, height: 620 });
  expect(modelRenderSize(400, 600, 900)).toEqual({ width: 400, height: 600 });
});

it('physical devices retain the original native render path', () => {
  const render = jest.fn();
  const setRenderTarget = jest.fn();
  const renderer = { render, setRenderTarget } as unknown as THREE.WebGLRenderer;
  const surface = createModelRenderSurface(renderer, 1668, 2420, null);
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera();
  surface.render(scene, camera);
  expect(render).toHaveBeenCalledTimes(1);
  expect(render).toHaveBeenCalledWith(scene, camera);
  expect(setRenderTarget).not.toHaveBeenCalled();
});

it('simulator pass keeps the lit model intact and resizes its bounded target', () => {
  const render = jest.fn(),
    setRenderTarget = jest.fn();
  const surface = createModelRenderSurface(
    { render, setRenderTarget } as unknown as THREE.WebGLRenderer,
    1668,
    2420,
    900,
  );
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera();
  surface.render(scene, camera);
  const target = setRenderTarget.mock.calls[0][0] as THREE.WebGLRenderTarget;
  expect(target.width * target.height).toBeLessThanOrEqual(900 * 900);
  expect(render.mock.calls[0]).toEqual([scene, camera]);
  expect(setRenderTarget.mock.calls[1]).toEqual([null]);
  expect(render).toHaveBeenCalledTimes(2);
  surface.resize(2420, 1668);
  expect(target.width).toBe(900);
  expect(target.height).toBe(620);
  const disposed = jest.fn();
  target.addEventListener('dispose', disposed);
  surface.dispose();
  expect(disposed).toHaveBeenCalledTimes(1);
});
