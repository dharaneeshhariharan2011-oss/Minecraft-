import { BLOCK } from './blocks.js';
import type { Dimension, DimensionId } from './dimension.js';

/** Horizontal coordinate scale between the Overworld and the Nether (1 Nether block = 8 Overworld blocks). */
export const NETHER_SCALE = 8;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Converts a position from one dimension to another when a player walks through a portal.
 * Overworld <-> Nether scales X and Z by 8. The End is not coordinate-scaled.
 * Returns null when the transition is not allowed (e.g. Overworld <-> End directly).
 */
export function scalePosition(from: DimensionId, to: DimensionId, pos: Vec3): Vec3 | null {
  if (from === to) return { ...pos };
  if (from === 'overworld' && to === 'nether') {
    return { x: pos.x / NETHER_SCALE, y: pos.y, z: pos.z / NETHER_SCALE };
  }
  if (from === 'nether' && to === 'overworld') {
    return { x: pos.x * NETHER_SCALE, y: pos.y, z: pos.z * NETHER_SCALE };
  }
  return null;
}

/** Portal interior bounds: at least 2 wide and 3 tall, maximum 21 x 21 like Bedrock. */
export const PORTAL_MIN_WIDTH = 2;
export const PORTAL_MIN_HEIGHT = 3;
export const PORTAL_MAX_SIZE = 21;

export interface PortalFrame {
  /** Axis of the portal plane: 'x' spans along X (plane is Z-fixed), 'z' spans along Z. */
  axis: 'x' | 'z';
  /** Lowest-left interior block. */
  min: Vec3;
  width: number;
  height: number;
  /** Interior coordinates ordered bottom-up then along the axis. */
  interior: Vec3[];
}

/**
 * Finds a rectangular obsidian frame whose interior is filled with air, containing `origin`.
 * `origin` is a block inside the (empty) portal interior. Returns null when no valid frame exists.
 */
export function detectPortalFrame(dim: Dimension, origin: Vec3): PortalFrame | null {
  for (const axis of ['x', 'z'] as const) {
    const frame = scanAxis(dim, origin, axis);
    if (frame) return frame;
  }
  return null;
}

function scanAxis(dim: Dimension, origin: Vec3, axis: 'x' | 'z'): PortalFrame | null {
  const isInterior = (p: Vec3): boolean => {
    const id = dim.getId(p.x, p.y, p.z);
    return id === BLOCK.AIR || id === BLOCK.NETHER_PORTAL;
  };
  const isObsidian = (p: Vec3): boolean => dim.getId(p.x, p.y, p.z) === BLOCK.OBSIDIAN;
  const at = (dAlong: number, dy: number): Vec3 =>
    axis === 'x'
      ? { x: origin.x + dAlong, y: origin.y + dy, z: origin.z }
      : { x: origin.x, y: origin.y + dy, z: origin.z + dAlong };

  if (!isInterior(origin)) return null;

  // 1. Bottom row: go down while the column is still interior.
  let down = 0;
  while (-down < PORTAL_MAX_SIZE - 1 && isInterior(at(0, down - 1))) down--;
  const bottomDy = down;

  // 2. Width along the axis at the bottom row.
  let left = 0;
  while (left < PORTAL_MAX_SIZE && isInterior(at(-left - 1, bottomDy))) left++;
  let right = 0;
  while (right < PORTAL_MAX_SIZE && isInterior(at(right + 1, bottomDy))) right++;
  const width = left + right + 1;
  if (width < PORTAL_MIN_WIDTH || width > PORTAL_MAX_SIZE) return null;

  // 3. Height: go up while the centre column is interior.
  let height = 0;
  while (height < PORTAL_MAX_SIZE && isInterior(at(0, bottomDy + height))) height++;
  if (height < PORTAL_MIN_HEIGHT || height > PORTAL_MAX_SIZE) return null;

  // 4. Validate the full obsidian frame around the interior.
  for (let i = -left; i <= right; i++) {
    if (!isObsidian(at(i, bottomDy - 1))) return null;
    if (!isObsidian(at(i, bottomDy + height))) return null;
  }
  for (let dy = 0; dy < height; dy++) {
    if (!isObsidian(at(-left - 1, bottomDy + dy))) return null;
    if (!isObsidian(at(right + 1, bottomDy + dy))) return null;
    for (let i = -left; i <= right; i++) {
      if (!isInterior(at(i, bottomDy + dy))) return null;
    }
  }

  const interior: Vec3[] = [];
  for (let dy = 0; dy < height; dy++) {
    for (let i = -left; i <= right; i++) interior.push(at(i, bottomDy + dy));
  }
  return { axis, min: at(-left, bottomDy), width, height, interior };
}

/** Fills a detected frame's interior with nether portal blocks (the "ignition" step). */
export function ignitePortal(dim: Dimension, frame: PortalFrame): void {
  for (const p of frame.interior) {
    const axisState = frame.axis === 'x' ? 0 : 1;
    dim.setBlock(p.x, p.y, p.z, BLOCK.NETHER_PORTAL, axisState);
  }
}

/**
 * Finds a safe standing position in the column at x,z: solid ground with two empty blocks above it.
 * Searches downward from `startY` first, then upward. Returns null when nothing is found.
 */
export function findSafeSpawn(dim: Dimension, x: number, z: number, startY: number): Vec3 | null {
  const top = 127;
  const clampY = Math.max(1, Math.min(top - 2, Math.floor(startY)));
  const isSafe = (y: number): boolean => {
    const floor = dim.getBlock(x, y - 1, z);
    const feet = dim.getBlock(x, y, z);
    const head = dim.getBlock(x, y + 1, z);
    const solid = dim.registry.tryGet(floor.id);
    const passable = (id: number): boolean => {
      const def = dim.registry.tryGet(id);
      return !!def && !def.solid && def.shape !== 'liquid';
    };
    return !!solid && solid.solid && passable(feet.id) && passable(head.id) && floor.id !== BLOCK.LAVA;
  };
  for (let d = 0; d < 128; d++) {
    const down = clampY - d;
    if (down >= 1 && isSafe(down)) return { x: x + 0.5, y: down, z: z + 0.5 };
    const up = clampY + d;
    if (up <= top - 1 && isSafe(up)) return { x: x + 0.5, y: up, z: z + 0.5 };
  }
  return null;
}

/**
 * Builds an obsidian portal frame (4 wide, 5 tall, interior 2x3) with its base centre at (x, y, z)
 * facing the X axis, clearing the interior. Used so a traveller always has a way back.
 */
export function buildReturnPortal(dim: Dimension, x: number, y: number, z: number): PortalFrame {
  const width = 2;
  const height = 3;
  const left = -1;
  for (let a = left; a <= width; a++) {
    dim.setBlock(x + a, y - 1, z, BLOCK.OBSIDIAN);
    dim.setBlock(x + a, y + height, z, BLOCK.OBSIDIAN);
  }
  for (let dy = 0; dy < height; dy++) {
    dim.setBlock(x + left, y + dy, z, BLOCK.OBSIDIAN);
    dim.setBlock(x + width, y + dy, z, BLOCK.OBSIDIAN);
    for (let a = 0; a < width; a++) dim.setBlock(x + a, y + dy, z, BLOCK.AIR);
  }
  const interior: Vec3[] = [];
  for (let dy = 0; dy < height; dy++) for (let a = 0; a < width; a++) interior.push({ x: x + a, y: y + dy, z });
  return { axis: 'x', min: { x, y, z }, width, height, interior };
}
