import * as THREE from 'three';
import { useSimulatorMaterials } from '@/components/model/simulatorMaterials';
import { bindMechanisms, applyMechanisms } from '@/components/model/mechanisms';

it('keeps shared paint, transparent glass and geometry while replacing only PBR lighting', () => {
  const root = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color: '#ba1324', roughness: 0.4 });
  const glass = new THREE.MeshStandardMaterial({
    color: '#354555',
    transparent: true,
    opacity: 0.45,
    depthWrite: false,
    side: THREE.DoubleSide,
    emissive: '#111111',
    emissiveIntensity: 0.2,
  });
  const geometry = new THREE.BoxGeometry();
  const left = new THREE.Mesh(geometry, [paint, glass]);
  const right = new THREE.Mesh(geometry, paint);
  const basic = new THREE.MeshBasicMaterial();
  const unchanged = new THREE.Mesh(geometry, basic);
  root.add(left, right, unchanged);
  expect(useSimulatorMaterials(root)).toEqual([paint, glass]);
  expect(left.geometry).toBe(geometry);
  expect(left.material[0]).toBe(right.material);
  expect(left.material[0]).toBeInstanceOf(THREE.MeshLambertMaterial);
  expect(left.material[0].color.equals(paint.color)).toBe(true);
  expect(left.material[1]).toMatchObject({
    transparent: true,
    opacity: 0.45,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  expect(unchanged.material).toBe(basic);
});

it('simulator lamps remain independently animated and restore their authored emission', () => {
  const root = new THREE.Group();
  const original = new THREE.MeshStandardMaterial({ emissive: '#331100', emissiveIntensity: 0.2 });
  const left = new THREE.Mesh(new THREE.BoxGeometry(), original);
  const right = left.clone();
  left.userData.indicatorSide = 'left';
  right.userData.indicatorSide = 'right';
  root.add(left, right);
  useSimulatorMaterials(root);
  const binding = bindMechanisms(root);
  applyMechanisms(binding, 0, 'left', 0, 0, false);
  expect(binding.indicators.map(({ material }) => material.emissiveIntensity)).toEqual([3, 0.2]);
  applyMechanisms(binding, 0, 'off', 0, 0, false);
  expect(binding.indicators.map(({ material }) => material.emissiveIntensity)).toEqual([0.2, 0.2]);
  expect(binding.indicators[0].material.emissive.equals(original.emissive)).toBe(true);
});
