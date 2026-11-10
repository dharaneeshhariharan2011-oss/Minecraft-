import { describe, expect, it } from 'vitest';
import { buildChunkMesh } from '../../client/engine/mesher.js';
import { raycastBlocks, raycastWorld } from '../../client/engine/raycast.js';
import { createDefaultRegistry, BLOCK } from '../../shared/world/blocks.js';
import { Chunk, Dimension } from '../../shared/world/dimension.js';
import { createGenerator } from '../../shared/world/terrain.js';

class EmptyGenerator {
  readonly dimension = 'overworld' as const;
  generate(): void {
    /* air */
  }
}

describe('chunk mesher', () => {
  it('emits six exposed faces for a lone block inside an empty chunk', () => {
    const registry = createDefaultRegistry();
    const dim = new Dimension('overworld', new EmptyGenerator() as never, registry);
    const chunk = dim.getChunk(0, 0);
    chunk.ids[Chunk.index(5, 60, 5)] = BLOCK.STONE;
    const mesh = buildChunkMesh(dim, chunk, { registry });
    expect(mesh.opaque.indices.length).toBe(36);
    expect(mesh.opaque.positions.length / 3).toBe(24);
    expect(mesh.transparent.indices.length).toBe(0);
  });

  it('culls faces shared with a neighbouring solid block', () => {
    const registry = createDefaultRegistry();
    const dim = new Dimension('overworld', new EmptyGenerator() as never, registry);
    // Use the dimension's own chunk so neighbour lookups see the same data the game renders.
    const chunk = dim.getChunk(0, 0);
    chunk.ids[Chunk.index(5, 60, 5)] = BLOCK.STONE;
    chunk.ids[Chunk.index(6, 60, 5)] = BLOCK.STONE;
    const mesh = buildChunkMesh(dim, chunk, { registry });
    expect(mesh.opaque.indices.length).toBe(60); // 10 faces: the shared pair hides two
  });

  it('builds a non-empty mesh for generated terrain', () => {
    const registry = createDefaultRegistry();
    const dim = new Dimension('overworld', createGenerator('overworld', 42) as never, registry);
    const chunk = dim.getChunk(0, 0);
    const mesh = buildChunkMesh(dim, chunk, { registry });
    expect(mesh.opaque.indices.length).toBeGreaterThan(0);
    expect(mesh.opaque.normals.length).toBe(mesh.opaque.positions.length);
    expect(mesh.opaque.colors.length).toBe(mesh.opaque.positions.length);
  });
});

describe('voxel raycast', () => {
  it('hits the first solid block along the ray and reports the placement cell', () => {
    const dim = new Dimension('overworld', new EmptyGenerator() as never, createDefaultRegistry());
    dim.setBlock(0, 5, 0, BLOCK.STONE);
    const hit = raycastWorld(dim, { x: 0.5, y: 10.5, z: 0.5 }, { x: 0, y: -1, z: 0 }, 20, (id) => id !== BLOCK.AIR);
    expect(hit).not.toBeNull();
    expect(hit!.y).toBe(5);
    expect(hit!.py).toBe(6);
    expect(hit!.ny).toBe(1);
  });

  it('returns null beyond the maximum distance', () => {
    const hit = raycastBlocks({ x: 0.5, y: 0.5, z: 0.5 }, { x: 1, y: 0, z: 0 }, 3, (x) => x === 50);
    expect(hit).toBeNull();
  });
});
