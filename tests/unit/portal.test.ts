import { describe, expect, it } from 'vitest';
import { BLOCK } from '../../shared/world/blocks.js';
import { Dimension, WORLD_HEIGHT } from '../../shared/world/dimension.js';
import { detectPortalFrame, findSafeSpawn, ignitePortal, scalePosition, NETHER_SCALE, PORTAL_MAX_SIZE } from '../../shared/world/portal.js';
import { createGenerator } from '../../shared/world/terrain.js';

class EmptyGenerator {
  readonly dimension = 'overworld' as const;
  generate(): void {
    /* air everywhere */
  }
}

function emptyDim(): Dimension {
  return new Dimension('overworld', new EmptyGenerator() as never);
}

/** Builds an obsidian frame with interior width x height in the XY plane (axis 'x') at z=0. */
function buildFrame(dim: Dimension, x0: number, y0: number, width: number, height: number, axis: 'x' | 'z' = 'x') {
  const at = (a: number, y: number): [number, number, number] => (axis === 'x' ? [x0 + a, y, 0] : [0, y, x0 + a]);
  for (let a = -1; a <= width; a++) {
    const [x, , z] = at(a, 0);
    dim.setBlock(x, y0 - 1, z, BLOCK.OBSIDIAN);
    dim.setBlock(x, y0 + height, z, BLOCK.OBSIDIAN);
  }
  for (let y = 0; y < height; y++) {
    const [lx, , lz] = at(-1, 0);
    const [rx, , rz] = at(width, 0);
    dim.setBlock(lx, y0 + y, lz, BLOCK.OBSIDIAN);
    dim.setBlock(rx, y0 + y, rz, BLOCK.OBSIDIAN);
  }
}

describe('portal coordinate scaling', () => {
  it('scales overworld coordinates by 1/8 when entering the nether', () => {
    expect(NETHER_SCALE).toBe(8);
    expect(scalePosition('overworld', 'nether', { x: 800, y: 64, z: -160 })).toEqual({ x: 100, y: 64, z: -20 });
  });

  it('scales nether coordinates by 8 when returning to the overworld', () => {
    expect(scalePosition('nether', 'overworld', { x: 12.5, y: 40, z: -3 })).toEqual({ x: 100, y: 40, z: -24 });
  });

  it('round-trips without drift for block-aligned coordinates', () => {
    const start = { x: 1234, y: 70, z: -4321 };
    const there = scalePosition('overworld', 'nether', start)!;
    const back = scalePosition('nether', 'overworld', there)!;
    expect(back.x).toBe(start.x);
    expect(back.z).toBe(start.z);
    expect(back.y).toBe(start.y);
  });

  it('does not scale the end and refuses direct overworld <-> end travel', () => {
    expect(scalePosition('overworld', 'the_end', { x: 5, y: 5, z: 5 })).toBeNull();
    expect(scalePosition('the_end', 'overworld', { x: 5, y: 5, z: 5 })).toBeNull();
    expect(scalePosition('the_end', 'the_end', { x: 5, y: 5, z: 5 })).toEqual({ x: 5, y: 5, z: 5 });
  });
});

describe('nether portal frame detection', () => {
  it('detects a minimal 2x3 frame and ignites its interior', () => {
    const dim = emptyDim();
    buildFrame(dim, 0, 60, 2, 3);
    const frame = detectPortalFrame(dim, { x: 0, y: 60, z: 0 });
    expect(frame).not.toBeNull();
    expect(frame!.width).toBe(2);
    expect(frame!.height).toBe(3);
    expect(frame!.interior).toHaveLength(6);
    ignitePortal(dim, frame!);
    expect(dim.getId(0, 60, 0)).toBe(BLOCK.NETHER_PORTAL);
    expect(dim.getId(1, 62, 0)).toBe(BLOCK.NETHER_PORTAL);
  });

  it('detects frames on the z axis too', () => {
    const dim = emptyDim();
    buildFrame(dim, 0, 60, 3, 4, 'z');
    const frame = detectPortalFrame(dim, { x: 0, y: 60, z: 1 });
    expect(frame).not.toBeNull();
    expect(frame!.axis).toBe('z');
    expect(frame!.width).toBe(3);
    expect(frame!.height).toBe(4);
  });

  it('rejects a frame that is too small (1 wide)', () => {
    const dim = emptyDim();
    buildFrame(dim, 0, 60, 1, 3);
    expect(detectPortalFrame(dim, { x: 0, y: 61, z: 0 })).toBeNull();
  });

  it('rejects a frame with a gap in the obsidian', () => {
    const dim = emptyDim();
    buildFrame(dim, 0, 60, 2, 3);
    dim.setBlock(-1, 61, 0, BLOCK.AIR);
    expect(detectPortalFrame(dim, { x: 0, y: 61, z: 0 })).toBeNull();
  });

  it('never accepts frames larger than the Bedrock maximum', () => {
    const dim = emptyDim();
    buildFrame(dim, 0, 60, PORTAL_MAX_SIZE + 3, 3);
    expect(detectPortalFrame(dim, { x: 0, y: 61, z: 0 })).toBeNull();
  });
});

describe('safe spawn search', () => {
  it('finds ground in a generated overworld column with two air blocks above', () => {
    const dim = new Dimension('overworld', createGenerator('overworld', 99));
    const spawn = findSafeSpawn(dim, 0, 0, 100);
    expect(spawn).not.toBeNull();
    const y = Math.floor(spawn!.y);
    expect(dim.getId(0, y - 1, 0)).not.toBe(BLOCK.AIR);
    expect(dim.getId(0, y, 0)).toBe(BLOCK.AIR);
    expect(dim.getId(0, y + 1, 0)).toBe(BLOCK.AIR);
    expect(y).toBeLessThan(WORLD_HEIGHT);
  });
});
