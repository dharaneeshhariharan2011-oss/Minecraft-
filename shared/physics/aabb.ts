/** Axis-aligned bounding box. */
export interface AABB {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export type SolidTest = (x: number, y: number, z: number) => boolean;

const EPS = 1e-7;

/** Box for an entity standing with its feet at (x, y, z), centred horizontally. */
export function boxFromFeet(x: number, y: number, z: number, width: number, height: number): AABB {
  const hw = width / 2;
  return { minX: x - hw, minY: y, minZ: z - hw, maxX: x + hw, maxY: y + height, maxZ: z + hw };
}

export function translate(box: AABB, dx: number, dy: number, dz: number): AABB {
  return {
    minX: box.minX + dx,
    minY: box.minY + dy,
    minZ: box.minZ + dz,
    maxX: box.maxX + dx,
    maxY: box.maxY + dy,
    maxZ: box.maxZ + dz,
  };
}

export function intersects(a: AABB, b: AABB): boolean {
  return a.minX < b.maxX - EPS && a.maxX > b.minX + EPS && a.minY < b.maxY - EPS && a.maxY > b.minY + EPS && a.minZ < b.maxZ - EPS && a.maxZ > b.minZ + EPS;
}

/** Expands the box to include the swept region of moving by (dx, dy, dz). */
export function sweptBounds(box: AABB, dx: number, dy: number, dz: number): AABB {
  return {
    minX: Math.min(box.minX, box.minX + dx),
    minY: Math.min(box.minY, box.minY + dy),
    minZ: Math.min(box.minZ, box.minZ + dz),
    maxX: Math.max(box.maxX, box.maxX + dx),
    maxY: Math.max(box.maxY, box.maxY + dy),
    maxZ: Math.max(box.maxZ, box.maxZ + dz),
  };
}

/**
 * Moves `box` along a single axis by at most `d`, stopping at the first solid unit cube.
 * Returns the clamped distance actually travelled.
 */
function clampAxis(box: AABB, axis: 'x' | 'y' | 'z', d: number, isSolid: SolidTest): number {
  if (d === 0) return 0;
  const lo = (a: 'x' | 'y' | 'z'): number => box[`min${a.toUpperCase() as 'X' | 'Y' | 'Z'}`];
  const hi = (a: 'x' | 'y' | 'z'): number => box[`max${a.toUpperCase() as 'X' | 'Y' | 'Z'}`];
  const others = (['x', 'y', 'z'] as const).filter((a) => a !== axis);
  const [b1, b2] = others as [typeof others[0], typeof others[1]];
  const from1 = Math.floor(lo(b1) + EPS);
  const to1 = Math.ceil(hi(b1) - EPS) - 1;
  const from2 = Math.floor(lo(b2) + EPS);
  const to2 = Math.ceil(hi(b2) - EPS) - 1;

  let best = d;
  const cell = (k1: number, k2: number, k: number): [number, number, number] => {
    const c: Record<'x' | 'y' | 'z', number> = { x: 0, y: 0, z: 0 };
    c[b1] = k1;
    c[b2] = k2;
    c[axis] = k;
    return [c.x, c.y, c.z];
  };

  if (d > 0) {
    const start = Math.ceil(hi(axis) - EPS);
    const end = Math.floor(hi(axis) + d + EPS);
    for (let k = start; k <= end; k++) {
      let hit = false;
      for (let k1 = from1; k1 <= to1 && !hit; k1++) {
        for (let k2 = from2; k2 <= to2 && !hit; k2++) {
          const [x, y, z] = cell(k1, k2, k);
          if (isSolid(x, y, z)) hit = true;
        }
      }
      if (hit) {
        best = Math.min(best, Math.max(0, k - hi(axis)));
        break;
      }
    }
  } else {
    const start = Math.floor(lo(axis) + EPS) - 1;
    const end = Math.floor(lo(axis) + d + EPS);
    for (let k = start; k >= end; k--) {
      let hit = false;
      for (let k1 = from1; k1 <= to1 && !hit; k1++) {
        for (let k2 = from2; k2 <= to2 && !hit; k2++) {
          const [x, y, z] = cell(k1, k2, k);
          if (isSolid(x, y, z)) hit = true;
        }
      }
      if (hit) {
        best = Math.max(best, Math.min(0, k + 1 - lo(axis)));
        break;
      }
    }
  }
  return best;
}

export interface MoveResult {
  box: AABB;
  dx: number;
  dy: number;
  dz: number;
  /** Set when the requested movement along that axis was blocked. */
  collidedX: boolean;
  collidedY: boolean;
  collidedZ: boolean;
}

/**
 * Moves a box by (dx, dy, dz), resolving collisions one axis at a time (Y first, then X, then Z).
 * This is the standard sweep-and-clamp approach used by voxel engines.
 */
export function moveBox(box: AABB, dx: number, dy: number, dz: number, isSolid: SolidTest): MoveResult {
  let b = box;
  const ry = clampAxis(b, 'y', dy, isSolid);
  b = translate(b, 0, ry, 0);
  const rx = clampAxis(b, 'x', dx, isSolid);
  b = translate(b, rx, 0, 0);
  const rz = clampAxis(b, 'z', dz, isSolid);
  b = translate(b, 0, 0, rz);
  return {
    box: b,
    dx: rx,
    dy: ry,
    dz: rz,
    collidedX: Math.abs(rx - dx) > EPS,
    collidedY: Math.abs(ry - dy) > EPS,
    collidedZ: Math.abs(rz - dz) > EPS,
  };
}

/** True if the box overlaps any solid unit cube. */
export function collidesWithWorld(box: AABB, isSolid: SolidTest): boolean {
  for (let x = Math.floor(box.minX + EPS); x < Math.ceil(box.maxX - EPS); x++) {
    for (let y = Math.floor(box.minY + EPS); y < Math.ceil(box.maxY - EPS); y++) {
      for (let z = Math.floor(box.minZ + EPS); z < Math.ceil(box.maxZ - EPS); z++) {
        if (isSolid(x, y, z)) return true;
      }
    }
  }
  return false;
}
