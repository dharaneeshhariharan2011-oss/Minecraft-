import { BLOCK, defaultRegistry, type BlockRegistry } from './blocks.js';

export const CHUNK_SIZE = 16;
export const WORLD_HEIGHT = 128;
export const CHUNK_VOLUME = CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT;

export type DimensionId = 'overworld' | 'nether' | 'the_end';
export const DIMENSION_IDS: readonly DimensionId[] = ['overworld', 'nether', 'the_end'];

export interface BlockRef {
  id: number;
  state: number;
}

export interface BlockChange {
  dim: DimensionId;
  x: number;
  y: number;
  z: number;
  id: number;
  state: number;
  previousId: number;
}

export type BlockListener = (change: BlockChange) => void;

/** Terrain generators fill a freshly created chunk. Must be deterministic for a given seed. */
export interface TerrainGenerator {
  readonly dimension: DimensionId;
  generate(chunk: Chunk): void;
}

export function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

export function mod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

export class Chunk {
  readonly ids = new Uint16Array(CHUNK_VOLUME);
  readonly states = new Uint8Array(CHUNK_VOLUME);
  dirty = true;

  constructor(
    readonly cx: number,
    readonly cz: number,
  ) {}

  static index(lx: number, y: number, lz: number): number {
    return (y * CHUNK_SIZE + lz) * CHUNK_SIZE + lx;
  }

  get key(): string {
    return `${this.cx},${this.cz}`;
  }

  get(lx: number, y: number, lz: number): number {
    return this.ids[Chunk.index(lx, y, lz)] ?? 0;
  }
}

export function chunkKey(cx: number, cz: number): string {
  return `${cx},${cz}`;
}

interface Override {
  id: number;
  state: number;
}

/**
 * A dimension is an infinite voxel space. Chunks are generated lazily from a seed.
 * Player edits are kept as overrides so that unloading and regenerating a chunk never loses changes.
 */
export class Dimension {
  readonly chunks = new Map<string, Chunk>();
  private readonly overrides = new Map<string, Map<number, Override>>();
  private readonly listeners = new Set<BlockListener>();
  private readonly dirtyChunks = new Set<Chunk>();

  constructor(
    readonly id: DimensionId,
    private readonly generator: TerrainGenerator,
    readonly registry: BlockRegistry = defaultRegistry,
  ) {}

  /** Returns the chunk, generating it if necessary. */
  getChunk(cx: number, cz: number): Chunk {
    const key = chunkKey(cx, cz);
    let chunk = this.chunks.get(key);
    if (!chunk) {
      chunk = new Chunk(cx, cz);
      this.generator.generate(chunk);
      this.applyOverrides(chunk);
      chunk.dirty = true;
      this.chunks.set(key, chunk);
    }
    return chunk;
  }

  /** Returns true if a chunk exists already (does not generate). */
  hasChunk(cx: number, cz: number): boolean {
    return this.chunks.has(chunkKey(cx, cz));
  }

  private applyOverrides(chunk: Chunk): void {
    const map = this.overrides.get(chunk.key);
    if (!map) return;
    for (const [index, ov] of map) {
      chunk.ids[index] = ov.id;
      chunk.states[index] = ov.state;
    }
  }

  inBounds(y: number): boolean {
    return y >= 0 && y < WORLD_HEIGHT;
  }

  getBlock(x: number, y: number, z: number): BlockRef {
    if (!this.inBounds(y)) return { id: BLOCK.AIR, state: 0 };
    const chunk = this.getChunk(floorDiv(x, CHUNK_SIZE), floorDiv(z, CHUNK_SIZE));
    const idx = Chunk.index(mod(x, CHUNK_SIZE), y, mod(z, CHUNK_SIZE));
    return { id: chunk.ids[idx] ?? 0, state: chunk.states[idx] ?? 0 };
  }

  getId(x: number, y: number, z: number): number {
    return this.getBlock(x, y, z).id;
  }

  /**
   * Writes a block. Returns false if nothing changed or the position is outside world height.
   * Listeners are notified synchronously.
   */
  setBlock(x: number, y: number, z: number, id: number, state = 0): boolean {
    if (!this.inBounds(y)) return false;
    if (!this.registry.tryGet(id)) throw new Error(`unknown block id ${id}`);
    const cx = floorDiv(x, CHUNK_SIZE);
    const cz = floorDiv(z, CHUNK_SIZE);
    const chunk = this.getChunk(cx, cz);
    const lx = mod(x, CHUNK_SIZE);
    const lz = mod(z, CHUNK_SIZE);
    const idx = Chunk.index(lx, y, lz);
    const previousId = chunk.ids[idx] ?? 0;
    const previousState = chunk.states[idx] ?? 0;
    if (previousId === id && previousState === state) return false;

    chunk.ids[idx] = id;
    chunk.states[idx] = state & 0xff;
    chunk.dirty = true;
    this.dirtyChunks.add(chunk);

    let map = this.overrides.get(chunk.key);
    if (!map) {
      map = new Map();
      this.overrides.set(chunk.key, map);
    }
    map.set(idx, { id, state: state & 0xff });

    const change: BlockChange = { dim: this.id, x, y, z, id, state: state & 0xff, previousId };
    for (const l of this.listeners) l(change);
    return true;
  }

  /** Subscribes to every block change in this dimension. Returns an unsubscribe function. */
  onChange(listener: BlockListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Returns and clears chunks changed since the last call. */
  drainDirtyChunks(): Chunk[] {
    const out = [...this.dirtyChunks];
    this.dirtyChunks.clear();
    return out;
  }

  /** All edits applied to this dimension, used for world sync. */
  allEdits(): Array<{ x: number; y: number; z: number; id: number; state: number }> {
    const out: Array<{ x: number; y: number; z: number; id: number; state: number }> = [];
    for (const [key, map] of this.overrides) {
      const [cx, cz] = key.split(',').map(Number) as [number, number];
      for (const [idx, ov] of map) {
        const lx = idx % CHUNK_SIZE;
        const lz = Math.floor(idx / CHUNK_SIZE) % CHUNK_SIZE;
        const y = Math.floor(idx / (CHUNK_SIZE * CHUNK_SIZE));
        out.push({ x: cx * CHUNK_SIZE + lx, y, z: cz * CHUNK_SIZE + lz, id: ov.id, state: ov.state });
      }
    }
    return out;
  }

  /** Highest y with a non-air block in the column, or -1 when the column is empty. */
  topBlockY(x: number, z: number): number {
    for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
      if (this.getId(x, y, z) !== BLOCK.AIR) return y;
    }
    return -1;
  }

  /** Number of loaded chunks. */
  get loadedChunkCount(): number {
    return this.chunks.size;
  }
}
