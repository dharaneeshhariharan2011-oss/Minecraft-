import type { Dimension } from '../../shared/world/dimension.js';

export interface RayHit {
  /** Block that was hit. */
  x: number;
  y: number;
  z: number;
  /** Unit normal of the face that was hit. */
  nx: number;
  ny: number;
  nz: number;
  /** Position where a new block would be placed (adjacent to the hit face). */
  px: number;
  py: number;
  pz: number;
  distance: number;
}

/**
 * Amanatides–Woo voxel traversal. Walks the grid cells along a ray and returns the first cell for
 * which `isTarget` returns true, or null when nothing is hit within `maxDistance`.
 */
export function raycastBlocks(
  origin: { x: number; y: number; z: number },
  dir: { x: number; y: number; z: number },
  maxDistance: number,
  isTarget: (x: number, y: number, z: number) => boolean,
): RayHit | null {
  const len = Math.hypot(dir.x, dir.y, dir.z);
  if (len === 0) return null;
  const dx = dir.x / len;
  const dy = dir.y / len;
  const dz = dir.z / len;

  let x = Math.floor(origin.x);
  let y = Math.floor(origin.y);
  let z = Math.floor(origin.z);
  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  const stepZ = dz > 0 ? 1 : -1;
  const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;
  let tMaxX = dx > 0 ? (x + 1 - origin.x) * tDeltaX : dx < 0 ? (origin.x - x) * tDeltaX : Infinity;
  let tMaxY = dy > 0 ? (y + 1 - origin.y) * tDeltaY : dy < 0 ? (origin.y - y) * tDeltaY : Infinity;
  let tMaxZ = dz > 0 ? (z + 1 - origin.z) * tDeltaZ : dz < 0 ? (origin.z - z) * tDeltaZ : Infinity;

  let nx = 0;
  let ny = 0;
  let nz = 0;
  let t = 0;
  // Guard against pathological inputs; the step count is bounded by distance.
  for (let i = 0; i < 1000; i++) {
    if (isTarget(x, y, z)) {
      return {
        x,
        y,
        z,
        nx,
        ny,
        nz,
        px: x + nx,
        py: y + ny,
        pz: z + nz,
        distance: t,
      };
    }
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      t = tMaxX;
      if (t > maxDistance) return null;
      x += stepX;
      tMaxX += tDeltaX;
      nx = -stepX;
      ny = 0;
      nz = 0;
    } else if (tMaxY < tMaxZ) {
      t = tMaxY;
      if (t > maxDistance) return null;
      y += stepY;
      tMaxY += tDeltaY;
      nx = 0;
      ny = -stepY;
      nz = 0;
    } else {
      t = tMaxZ;
      if (t > maxDistance) return null;
      z += stepZ;
      tMaxZ += tDeltaZ;
      nx = 0;
      ny = 0;
      nz = -stepZ;
    }
  }
  return null;
}

/** Raycast against a dimension where any non-air, non-passable block counts as a hit. */
export function raycastWorld(
  dim: Dimension,
  origin: { x: number; y: number; z: number },
  dir: { x: number; y: number; z: number },
  maxDistance: number,
  hits: (id: number) => boolean,
): RayHit | null {
  return raycastBlocks(origin, dir, maxDistance, (x, y, z) => hits(dim.getId(x, y, z)));
}
