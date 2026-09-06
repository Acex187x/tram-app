import * as THREE from 'three';
import { indicatorLit, type IndicatorDirection } from './mechanismMath';

type LampMaterial = THREE.MeshStandardMaterial | THREE.MeshLambertMaterial;

interface DoorNode {
  object: THREE.Object3D;
  position: THREE.Vector3;
  rotation: THREE.Quaternion;
  openRotation: THREE.Quaternion;
  translation: [number, number, number];
}
interface Indicator {
  side: 'left' | 'right';
  material: LampMaterial;
  baseEmission: THREE.Color;
  baseIntensity: number;
  lit: boolean;
}
export interface ModelMechanisms {
  doors: DoorNode[];
  indicators: Indicator[];
  /** Replaced originals may no longer be reachable from the scene graph. */
  materialsToDispose: THREE.Material[];
}
const Y_AXIS = new THREE.Vector3(0, 1, 0);

/** glTF extras are the generator/viewer contract. Bind once after loading. */
export function bindMechanisms(group: THREE.Object3D): ModelMechanisms {
  const doors: DoorNode[] = [],
    indicators: Indicator[] = [];
  const materialsToDispose: THREE.Material[] = [];
  const lamps = new Set<THREE.Object3D>();
  const bySide = new Map<THREE.Material, Map<string, LampMaterial>>();
  group.traverse((object) => {
    const { doorOpenTranslation, doorOpenRotationY, indicatorSide } = object.userData;
    const translation =
      Array.isArray(doorOpenTranslation) &&
      doorOpenTranslation.length === 3 &&
      doorOpenTranslation.every(Number.isFinite)
        ? (doorOpenTranslation as [number, number, number])
        : null;
    const rotationY =
      typeof doorOpenRotationY === 'number' && Number.isFinite(doorOpenRotationY)
        ? doorOpenRotationY
        : 0;
    if (translation || rotationY !== 0)
      doors.push({
        object,
        position: object.position.clone(),
        rotation: object.quaternion.clone(),
        openRotation: object.quaternion
          .clone()
          .multiply(new THREE.Quaternion().setFromAxisAngle(Y_AXIS, rotationY)),
        translation: translation ?? [0, 0, 0],
      });
    if (indicatorSide !== 'left' && indicatorSide !== 'right') return;
    // A tagged lamp can be a glTF mesh or a parent containing several parts.
    object.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh || lamps.has(mesh)) return;
      lamps.add(mesh);
      const clone = (base: THREE.Material): THREE.Material => {
        if (
          !(base as THREE.MeshStandardMaterial).isMeshStandardMaterial &&
          !(base as THREE.MeshLambertMaterial).isMeshLambertMaterial
        )
          return base;
        let sides = bySide.get(base);
        if (!sides) {
          sides = new Map();
          bySide.set(base, sides);
          materialsToDispose.push(base);
        }
        let material = sides.get(indicatorSide);
        if (!material) {
          material = (base as LampMaterial).clone();
          sides.set(indicatorSide, material);
          indicators.push({
            side: indicatorSide,
            material,
            baseEmission: material.emissive.clone(),
            baseIntensity: material.emissiveIntensity,
            lit: false,
          });
        }
        return material;
      };
      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map(clone)
        : clone(mesh.material);
    });
  });
  return { doors, indicators, materialsToDispose };
}

/** Runs inside the existing render loop: local transforms, no React updates. */
export function applyMechanisms(
  mechanisms: ModelMechanisms,
  progress: number,
  direction: IndicatorDirection,
  nowMs: number,
  signalStartedAtMs: number,
  reduceMotion: boolean,
): void {
  for (const door of mechanisms.doors) {
    door.object.position.set(
      door.position.x + door.translation[0] * progress,
      door.position.y + door.translation[1] * progress,
      door.position.z + door.translation[2] * progress,
    );
    door.object.quaternion.copy(door.rotation).slerp(door.openRotation, progress);
  }
  for (const indicator of mechanisms.indicators) {
    const lit = indicatorLit(direction, indicator.side, nowMs, signalStartedAtMs, reduceMotion);
    if (lit === indicator.lit) continue;
    indicator.lit = lit;
    if (lit) {
      indicator.material.emissive.set('#ff8800');
      indicator.material.emissiveIntensity = 3;
    } else {
      indicator.material.emissive.copy(indicator.baseEmission);
      indicator.material.emissiveIntensity = indicator.baseIntensity;
    }
  }
}
