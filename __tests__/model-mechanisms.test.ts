import * as THREE from 'three';
import {
  CLOSED_DOORS,
  changeDoorTarget,
  doorProgress,
  indicatorLit,
  DOOR_TRAVEL_MS,
  INDICATOR_PERIOD_MS,
} from '@/components/model/mechanismMath';
import { bindMechanisms, applyMechanisms } from '@/components/model/mechanisms';

it('door motion reaches exact end poses and can reverse without jumping', () => {
  const opening = changeDoorTarget(CLOSED_DOORS, true, 1000);
  expect(doorProgress(opening, 1000)).toBe(0);
  expect(doorProgress(opening, 1000 + DOOR_TRAVEL_MS)).toBe(1);
  const midway = 1000 + DOOR_TRAVEL_MS * 0.4;
  const position = doorProgress(opening, midway);
  const closing = changeDoorTarget(opening, false, midway);
  expect(doorProgress(closing, midway)).toBe(position);
  expect(doorProgress(closing, midway + DOOR_TRAVEL_MS)).toBe(0);
  expect(doorProgress(opening, midway, true)).toBe(1);
});

it('only the explicitly selected side blinks and reduced motion makes it steady', () => {
  expect(indicatorLit('off', 'left', 1000, 0)).toBe(false);
  expect(indicatorLit('left', 'right', 1000, 0)).toBe(false);
  expect(indicatorLit('left', 'left', 0, 0)).toBe(true);
  expect(indicatorLit('left', 'left', INDICATOR_PERIOD_MS / 2, 0)).toBe(false);
  expect(indicatorLit('left', 'left', INDICATOR_PERIOD_MS, 0)).toBe(true);
  expect(indicatorLit('left', 'left', INDICATOR_PERIOD_MS / 2, 0, true)).toBe(true);
});

it('authored leaf pivots translate/rotate reversibly without changing the body', () => {
  const root = new THREE.Group(),
    door = new THREE.Group(),
    body = new THREE.Group();
  door.position.set(1, 2, 3);
  door.userData = {
    doorOpenTranslation: [0.08, 0, 0.6],
    doorOpenRotationY: Math.PI / 2,
  };
  root.add(door, body);
  const bindings = bindMechanisms(root);
  applyMechanisms(bindings, 1, 'off', 0, 0, false);
  expect(door.position.toArray()).toEqual([1.08, 2, 3.6]);
  expect(door.rotation.y).toBeCloseTo(Math.PI / 2);
  expect(body.position.toArray()).toEqual([0, 0, 0]);
  applyMechanisms(bindings, 0, 'off', 0, 0, false);
  expect(door.position.toArray()).toEqual([1, 2, 3]);
  expect(door.quaternion.equals(new THREE.Quaternion())).toBe(true);
});

it('indicator materials are isolated by side and restore the authored emission', () => {
  const root = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({
    color: '#dd7700',
    emissive: '#110000',
    emissiveIntensity: 0.2,
  });
  const left = new THREE.Mesh(new THREE.BoxGeometry(), material),
    right = left.clone();
  left.userData.indicatorSide = 'left';
  right.userData.indicatorSide = 'right';
  root.add(left, right);
  const bindings = bindMechanisms(root);
  expect(left.material).not.toBe(right.material);
  applyMechanisms(bindings, 0, 'left', 0, 0, false);
  expect((left.material as THREE.MeshStandardMaterial).emissiveIntensity).toBe(3);
  expect((right.material as THREE.MeshStandardMaterial).emissiveIntensity).toBe(0.2);
  expect(material.emissiveIntensity).toBe(0.2);
  applyMechanisms(bindings, 0, 'off', 0, 0, false);
  expect((left.material as THREE.MeshStandardMaterial).emissiveIntensity).toBe(0.2);
  expect((left.material as THREE.MeshStandardMaterial).emissive.getHex()).toBe(
    material.emissive.getHex(),
  );
});
