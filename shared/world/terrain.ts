import { createNoise2D, createNoise3D } from 'simplex-noise';
import { BLOCK } from './blocks.js';
import { CHUNK_SIZE, Chunk, WORLD_HEIGHT, type DimensionId, type TerrainGenerator } from './dimension.js';
import { hash2, hash3, mulberry32 } from './random.js';

export const SEA_LEVEL = 62;

export type Biome =
  | 'plains'
  | 'forest'
  | 'desert'
  | 'badlands'
  | 'mangrove_swamp'
  | 'snowy_plains'
  | 'deep_dark';

export interface Column {
  height: number;
  biome: Biome;
}

/** Fills a column of a chunk, treating a(x, y, z)-style writes as clipped to the chunk. */
function setLocal(chunk: Chunk, lx: number, y: number, lz: number, id: number, state = 0): void {
  if (lx < 0 || lz < 0 || lx >= CHUNK_SIZE || lz >= CHUNK_SIZE || y < 0 || y >= WORLD_HEIGHT) return;
  const idx = Chunk.index(lx, y, lz);
  chunk.ids[idx] = id;
  chunk.states[idx] = state;
}

function getLocal(chunk: Chunk, lx: number, y: number, lz: number): number {
  if (lx < 0 || lz < 0 || lx >= CHUNK_SIZE || lz >= CHUNK_SIZE || y < 0 || y >= WORLD_HEIGHT) return -1;
  return chunk.ids[Chunk.index(lx, y, lz)] ?? 0;
}

/**
 * Overworld: biome-driven heightmaps, caves, ores, sea, and trees/cacti.
 * Trees are computed from world coordinates with a 2-block margin, so canopies cross chunk borders
 * consistently no matter which chunk is generated first.
 */
export class OverworldGenerator implements TerrainGenerator {
  readonly dimension: DimensionId = 'overworld';
  private readonly continent: (x: number, y: number) => number;
  private readonly detail: (x: number, y: number) => number;
  private readonly temperature: (x: number, y: number) => number;
  private readonly humidity: (x: number, y: number) => number;
  private readonly deepDark: (x: number, y: number) => number;
  private readonly cave: (x: number, y: number, z: number) => number;
  private readonly treeSeed: number;

  constructor(readonly seed: number) {
    const rnd = mulberry32(seed);
    this.continent = createNoise2D(rnd);
    this.detail = createNoise2D(rnd);
    this.temperature = createNoise2D(rnd);
    this.humidity = createNoise2D(rnd);
    this.deepDark = createNoise2D(rnd);
    this.cave = createNoise3D(rnd);
    this.treeSeed = seed ^ 0x51ed;
  }

  columnAt(x: number, z: number): Column {
    const c = this.continent(x * 0.004, z * 0.004);
    const d = this.detail(x * 0.02, z * 0.02);
    const temp = this.temperature(x * 0.002, z * 0.002);
    const hum = this.humidity(x * 0.002 + 311, z * 0.002 - 97);
    const deep = this.deepDark(x * 0.003 - 57, z * 0.003 + 23);

    let biome: Biome;
    if (deep > 0.6 && temp < 0.2) biome = 'deep_dark';
    else if (temp > 0.35 && hum < -0.1) biome = 'badlands';
    else if (temp > 0.35) biome = 'desert';
    else if (hum > 0.35 && c < 0.15) biome = 'mangrove_swamp';
    else if (temp < -0.45) biome = 'snowy_plains';
    else if (hum > 0.1) biome = 'forest';
    else biome = 'plains';

    let height = 64 + c * 18 + d * 6;
    if (biome === 'mangrove_swamp') height = 60 + d * 2;
    if (biome === 'badlands') height = 66 + d * 10;
    if (biome === 'deep_dark') height = 40 + c * 6 + d * 3;
    height = Math.max(6, Math.min(WORLD_HEIGHT - 12, Math.round(height)));
    return { height, biome };
  }

  generate(chunk: Chunk): void {
    const baseX = chunk.cx * CHUNK_SIZE;
    const baseZ = chunk.cz * CHUNK_SIZE;
    const columns: Column[] = [];
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        columns.push(this.columnAt(baseX + lx, baseZ + lz));
      }
    }

    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const wx = baseX + lx;
        const wz = baseZ + lz;
        const col = columns[lz * CHUNK_SIZE + lx]!;
        this.fillColumn(chunk, lx, lz, wx, wz, col);
      }
    }

    // Decorations: trees and cacti whose origin is within the chunk expanded by a margin.
    for (let mz = -2; mz < CHUNK_SIZE + 2; mz++) {
      for (let mx = -2; mx < CHUNK_SIZE + 2; mx++) {
        const wx = baseX + mx;
        const wz = baseZ + mz;
        const r = hash2(this.treeSeed, wx, wz);
        if (r > 0.04) continue;
        const col = this.columnAt(wx, wz);
        if (col.height <= SEA_LEVEL && col.biome !== 'mangrove_swamp') continue;
        if (col.biome === 'forest' && r < 0.03) this.placeTree(chunk, wx - baseX, col.height, wz - baseZ, wx, wz, false);
        else if (col.biome === 'plains' && r < 0.004) this.placeTree(chunk, wx - baseX, col.height, wz - baseZ, wx, wz, false);
        else if (col.biome === 'mangrove_swamp' && r < 0.02) this.placeTree(chunk, wx - baseX, SEA_LEVEL, wz - baseZ, wx, wz, true);
        else if (col.biome === 'desert' && r < 0.012) this.placeCactus(chunk, wx - baseX, col.height, wz - baseZ);
      }
    }
  }

  private fillColumn(chunk: Chunk, lx: number, lz: number, wx: number, wz: number, col: Column): void {
    const h = col.height;
    const deepDark = col.biome === 'deep_dark';
    for (let y = 0; y < WORLD_HEIGHT; y++) {
      if (y === 0) {
        setLocal(chunk, lx, y, lz, BLOCK.BEDROCK);
        continue;
      }
      if (y > h) {
        setLocal(chunk, lx, y, lz, y <= SEA_LEVEL ? BLOCK.WATER : BLOCK.AIR);
        continue;
      }
      // Caves: 3D noise threshold, not reaching the surface or bedrock.
      if (y > 2 && y < h - 3) {
        const threshold = deepDark ? 0.25 : 0.62;
        if (this.cave(wx * 0.04, y * 0.06, wz * 0.04) > threshold && (!deepDark || y < 40)) {
          setLocal(chunk, lx, y, lz, BLOCK.AIR);
          continue;
        }
      }
      let id: number;
      if (y === h) {
        id = surfaceBlock(col.biome, y);
        if (col.biome === 'snowy_plains' && y > 90) id = BLOCK.SNOW;
      } else if (y > h - 4) {
        id = col.biome === 'desert' ? BLOCK.SANDSTONE : col.biome === 'badlands' ? BLOCK.TERRACOTTA : BLOCK.DIRT;
      } else {
        id = y < 16 ? BLOCK.DEEPSLATE : BLOCK.STONE;
        if (deepDark && y < 30) id = BLOCK.DEEPSLATE;
        if (id === BLOCK.STONE) {
          const ore = hash3(this.treeSeed, wx, y, wz);
          if (y < 60 && ore < 0.012) id = BLOCK.COAL_ORE;
          else if (y < 40 && ore > 0.988) id = BLOCK.IRON_ORE;
          else if (ore > 0.998 && y < 20) id = BLOCK.DEEPSLATE;
        }
        if (y < 30 && col.biome === 'deep_dark' && hash3(this.treeSeed, wx, y, wz) < 0.05) id = BLOCK.SCULK;
      }
      setLocal(chunk, lx, y, lz, id);
    }
    if (deepDark) setLocal(chunk, lx, Math.max(1, Math.min(h, WORLD_HEIGHT - 1)), lz, BLOCK.SCULK);
    if (col.biome === 'mangrove_swamp' && h <= SEA_LEVEL) {
      for (let y = h - 3; y <= h; y++) setLocal(chunk, lx, y, lz, BLOCK.MUD);
    }
  }

  private placeTree(
    chunk: Chunk,
    lx: number,
    baseY: number,
    lz: number,
    wx: number,
    wz: number,
    mangrove: boolean,
  ): void {
    const trunk = mangrove ? BLOCK.MANGROVE_LOG : BLOCK.OAK_LOG;
    const leaves = BLOCK.OAK_LEAVES;
    const height = 4 + Math.floor(hash2(this.treeSeed + 7, wx, wz) * 3);
    const top = baseY + height;
    if (baseY + 1 >= WORLD_HEIGHT || top + 2 >= WORLD_HEIGHT) return;
    // Trunk is only ever written if its base column is inside this chunk.
    if (lx >= 0 && lx < CHUNK_SIZE && lz >= 0 && lz < CHUNK_SIZE) {
      for (let y = baseY + 1; y <= top; y++) setLocal(chunk, lx, y, lz, trunk);
    }
    for (let dy = top - 2; dy <= top + 1; dy++) {
      const radius = dy >= top ? 1 : 2;
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
          if (Math.abs(dx) === radius && Math.abs(dz) === radius && dy < top) continue;
          const px = lx + dx;
          const pz = lz + dz;
          if (getLocal(chunk, px, dy, pz) === BLOCK.AIR || getLocal(chunk, px, dy, pz) === BLOCK.WATER) {
            setLocal(chunk, px, dy, pz, leaves);
          }
        }
      }
    }
  }

  private placeCactus(chunk: Chunk, lx: number, baseY: number, lz: number): void {
    if (lx < 0 || lz < 0 || lx >= CHUNK_SIZE || lz >= CHUNK_SIZE) return;
    const height = 2 + Math.floor(Math.abs(hash2(this.treeSeed + 13, lx, lz)) * 2);
    for (let y = baseY + 1; y <= baseY + height; y++) setLocal(chunk, lx, y, lz, BLOCK.CACTUS);
  }
}

function surfaceBlock(biome: Biome, y: number): number {
  switch (biome) {
    case 'desert':
      return BLOCK.SAND;
    case 'badlands':
      return BLOCK.TERRACOTTA;
    case 'mangrove_swamp':
      return y <= SEA_LEVEL ? BLOCK.MUD : BLOCK.GRASS;
    case 'snowy_plains':
      return BLOCK.GRASS;
    case 'deep_dark':
      return BLOCK.SCULK;
    default:
      return y <= SEA_LEVEL ? BLOCK.SAND : BLOCK.GRASS;
  }
}

/** Nether: netherrack with lava ocean below y=32, glowstone ceilings, soul sand and bridged fortresses. */
export class NetherGenerator implements TerrainGenerator {
  readonly dimension: DimensionId = 'nether';
  private readonly cave: (x: number, y: number, z: number) => number;
  private readonly soul: (x: number, z: number) => number;
  private readonly seedSalt: number;

  constructor(readonly seed: number) {
    const rnd = mulberry32(seed ^ 0x6e65746865);
    this.cave = createNoise3D(rnd);
    this.soul = createNoise2D(rnd);
    this.seedSalt = seed ^ 0x6e6e;
  }

  static readonly LAVA_LEVEL = 32;

  generate(chunk: Chunk): void {
    const baseX = chunk.cx * CHUNK_SIZE;
    const baseZ = chunk.cz * CHUNK_SIZE;
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const wx = baseX + lx;
        const wz = baseZ + lz;
        const soulHere = this.soul(wx * 0.03, wz * 0.03) > 0.45;
        for (let y = 0; y < WORLD_HEIGHT; y++) {
          let id: number = BLOCK.NETHERRACK;
          if (y === 0 || y === WORLD_HEIGHT - 1) {
            id = BLOCK.BEDROCK;
          } else if (y > 4 && y < WORLD_HEIGHT - 6 && this.cave(wx * 0.05, y * 0.08, wz * 0.05) > 0.55) {
            id = y <= NetherGenerator.LAVA_LEVEL ? BLOCK.LAVA : BLOCK.AIR;
          } else if (y <= NetherGenerator.LAVA_LEVEL && y > 0) {
            id = BLOCK.LAVA;
          } else if (y >= WORLD_HEIGHT - 8 && hash3(this.seedSalt, wx, y, wz) < 0.05) {
            id = BLOCK.GLOWSTONE;
          } else if (soulHere && y === NetherGenerator.LAVA_LEVEL + 1) {
            id = BLOCK.SOUL_SAND;
          }
          setLocal(chunk, lx, y, lz, id);
        }
      }
    }
    // Fortress: a bridge with rails and pillars placed in roughly one chunk in eight.
    if (hash2(this.seedSalt, chunk.cx, chunk.cz) < 0.125) this.placeFortress(chunk);
  }

  private placeFortress(chunk: Chunk): void {
    const deck = 58;
    for (let lz = 3; lz <= 12; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        setLocal(chunk, lx, deck, lz, BLOCK.NETHER_BRICKS);
        for (let y = deck + 1; y <= deck + 2; y++) setLocal(chunk, lx, y, lz, BLOCK.AIR);
      }
    }
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      setLocal(chunk, lx, deck + 1, 3, BLOCK.NETHER_BRICKS);
      setLocal(chunk, lx, deck + 1, 12, BLOCK.NETHER_BRICKS);
    }
    for (const px of [2, 13]) {
      for (const pz of [3, 12]) {
        for (let y = NetherGenerator.LAVA_LEVEL + 1; y <= deck; y++) setLocal(chunk, px, y, pz, BLOCK.NETHER_BRICKS);
      }
    }
  }
}

/** End: a floating end-stone island in the void with a ring of obsidian pillars. */
export class EndGenerator implements TerrainGenerator {
  readonly dimension: DimensionId = 'the_end';
  private readonly shape: (x: number, z: number) => number;
  static readonly ISLAND_TOP = 60;
  static readonly PILLAR_RING_RADIUS = 36;
  static readonly PILLAR_COUNT = 10;

  constructor(readonly seed: number) {
    this.shape = createNoise2D(mulberry32(seed ^ 0x656e64));
  }

  /** Obsidian pillar positions and heights (deterministic, derived only from the seed). */
  pillars(): Array<{ x: number; z: number; height: number }> {
    const out: Array<{ x: number; z: number; height: number }> = [];
    for (let i = 0; i < EndGenerator.PILLAR_COUNT; i++) {
      const angle = (i / EndGenerator.PILLAR_COUNT) * Math.PI * 2;
      out.push({
        x: Math.round(Math.cos(angle) * EndGenerator.PILLAR_RING_RADIUS),
        z: Math.round(Math.sin(angle) * EndGenerator.PILLAR_RING_RADIUS),
        height: 8 + ((i * 7 + (this.seed & 0xff)) % 12),
      });
    }
    return out;
  }

  generate(chunk: Chunk): void {
    const baseX = chunk.cx * CHUNK_SIZE;
    const baseZ = chunk.cz * CHUNK_SIZE;
    const top = EndGenerator.ISLAND_TOP;
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const wx = baseX + lx;
        const wz = baseZ + lz;
        const r = Math.hypot(wx, wz);
        const radius = 40 + this.shape(wx * 0.03, wz * 0.03) * 6;
        if (r < radius) {
          const depth = Math.max(1, Math.floor(((radius - r) / radius) * 14));
          for (let y = top - depth; y <= top; y++) setLocal(chunk, lx, y, lz, BLOCK.END_STONE);
        }
      }
    }
    for (const p of this.pillars()) {
      const lx = p.x - baseX;
      const lz = p.z - baseZ;
      if (lx < 0 || lz < 0 || lx >= CHUNK_SIZE || lz >= CHUNK_SIZE) continue;
      for (let y = top; y <= top + p.height; y++) setLocal(chunk, lx, y, lz, BLOCK.OBSIDIAN);
    }
  }
}

/** Builds the generator for a dimension. Each dimension uses a sub-seed so layouts differ. */
export function createGenerator(dim: DimensionId, seed: number): TerrainGenerator {
  switch (dim) {
    case 'overworld':
      return new OverworldGenerator(seed);
    case 'nether':
      return new NetherGenerator(seed ^ 0x4e455448);
    case 'the_end':
      return new EndGenerator(seed ^ 0x454e44);
  }
}

