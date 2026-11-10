/**
 * Block registry. Built-in blocks have fixed numeric ids; data-driven packs register
 * additional blocks with ids allocated from PACK_ID_START upwards.
 *
 * Block state is packed in one byte:
 *   bits 0-1  facing (0=N(-z) 1=E(+x) 2=S(+z) 3=W(-x)); also torch attachment and piston direction
 *   bit  2    flag   (slab top / sticky piston / door upper half)
 *   bit  3    waterlogged
 *   bit  4    active (lit lamp, open door, extended piston, lever on, powered button, torch lit)
 *   bits 5-6  repeater delay minus one (0..3 => 1..4 ticks)
 */

export const STATE = {
  FACING_MASK: 0b11,
  FLAG: 0b100,
  WATERLOGGED: 0b1000,
  ACTIVE: 0b10000,
  DELAY_SHIFT: 5,
  DELAY_MASK: 0b11 << 5,
} as const;

export const FACING_VECTORS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, -1],
  [1, 0, 0],
  [0, 0, 1],
  [-1, 0, 0],
];

export function facingOf(state: number): number {
  return state & STATE.FACING_MASK;
}

export function oppositeFacing(facing: number): number {
  return (facing + 2) & 3;
}

export type PushBehavior = 'normal' | 'immovable' | 'destroy';
export type BlockShape =
  | 'cube'
  | 'slab'
  | 'stairs'
  | 'fence'
  | 'door'
  | 'cross'
  | 'liquid'
  | 'redstone'
  | 'piston'
  | 'piston_head'
  | 'portal'
  | 'torch'
  | 'lever'
  | 'button'
  | 'repeater'
  | 'none';
export type ToolType = 'pickaxe' | 'axe' | 'shovel' | 'hoe' | 'none';

export interface BlockDef {
  id: number;
  /** Namespaced identifier, e.g. "minecraft:stone" or "dh:ruby_ore". */
  name: string;
  /** Average RGB colour used for rendering, 0xRRGGBB. */
  color: number;
  /** Seconds to break by hand (-1 = unbreakable). */
  hardness: number;
  /** Opaque cubes hide faces of neighbours. */
  opaque: boolean;
  /** Solid blocks stop player movement. */
  solid: boolean;
  shape: BlockShape;
  push: PushBehavior;
  sticky?: 'slime' | 'honey';
  /** Light emitted, 0..15. */
  light?: number;
  waterloggable?: boolean;
  /** Replaced directly when placed onto (grass, flowers, water). */
  replaceable?: boolean;
  tool?: ToolType;
  /** Item identifier dropped when broken. Defaults to the block itself. */
  drop?: string;
  /** Item identifier received when the block is broken; `null` means no drop. */
  dropItem?: string | null;
  /** Dimension-specific: blocks that generate in the Nether. */
  nether?: boolean;
  /** Redstone-conductive dust. */
  conductsRedstone?: boolean;
}

export class BlockRegistry {
  private readonly byId = new Map<number, BlockDef>();
  private readonly byName = new Map<string, BlockDef>();
  private nextPackId: number;

  constructor(readonly packIdStart = 256) {
    this.nextPackId = packIdStart;
  }

  register(def: Omit<BlockDef, 'id'> & { id?: number }): BlockDef {
    if (this.byName.has(def.name)) {
      throw new Error(`block already registered: ${def.name}`);
    }
    let id = def.id;
    if (id === undefined) {
      id = this.nextPackId++;
    } else if (this.byId.has(id)) {
      throw new Error(`block id already in use: ${id}`);
    }
    if (!Number.isInteger(id) || id < 0 || id > 65535) throw new Error(`invalid block id ${id}`);
    const full = { ...def, id } as BlockDef;
    this.byId.set(id, full);
    this.byName.set(full.name, full);
    return full;
  }

  get(id: number): BlockDef {
    return this.byId.get(id) ?? this.byId.get(BLOCK.AIR)!;
  }

  tryGet(id: number): BlockDef | undefined {
    return this.byId.get(id);
  }

  byIdentifier(name: string): BlockDef | undefined {
    return this.byName.get(name);
  }

  idOf(name: string): number {
    const def = this.byName.get(name);
    if (!def) throw new Error(`unknown block ${name}`);
    return def.id;
  }

  all(): BlockDef[] {
    return [...this.byId.values()];
  }
}

/** Fixed ids for built-in blocks. Keep values stable: they are stored in saved worlds. */
export const BLOCK = {
  AIR: 0,
  STONE: 1,
  DIRT: 2,
  GRASS: 3,
  SAND: 4,
  GRAVEL: 5,
  SANDSTONE: 6,
  SNOW: 7,
  ICE: 8,
  WATER: 9,
  LAVA: 10,
  BEDROCK: 11,
  OAK_LOG: 12,
  OAK_LEAVES: 13,
  OAK_PLANKS: 14,
  COBBLESTONE: 15,
  GLASS: 16,
  COAL_ORE: 17,
  IRON_ORE: 18,
  CLAY: 19,
  MUD: 20,
  MANGROVE_LOG: 21,
  DEEPSLATE: 22,
  SCULK: 23,
  TERRACOTTA: 24,
  CACTUS: 25,
  NETHERRACK: 26,
  SOUL_SAND: 27,
  GLOWSTONE: 28,
  NETHER_BRICKS: 29,
  NETHER_PORTAL: 30,
  OBSIDIAN: 31,
  END_STONE: 32,
  CRAFTING_TABLE: 33,
  FLETCHING_TABLE: 34,
  BLAST_FURNACE: 35,
  LECTERN: 36,
  ENCHANTING_TABLE: 37,
  BREWING_STAND: 38,
  REDSTONE_DUST: 39,
  REDSTONE_BLOCK: 40,
  REDSTONE_TORCH: 41,
  LEVER: 42,
  STONE_BUTTON: 43,
  REPEATER: 44,
  REDSTONE_LAMP: 45,
  PISTON: 46,
  STICKY_PISTON: 47,
  PISTON_HEAD: 48,
  SLIME_BLOCK: 49,
  HONEY_BLOCK: 50,
  OAK_DOOR: 51,
  OAK_STAIRS: 52,
  OAK_SLAB: 53,
  OAK_FENCE: 54,
  TALL_GRASS: 55,
  DEEP_DARK_SCULK_SHRIEKER: 56,
  BASALT: 57,
  OAK_SAPLING: 58,
} as const;

export const PACK_ID_START = 256;

export function createDefaultRegistry(): BlockRegistry {
  const r = new BlockRegistry(PACK_ID_START);
  const add = (
    id: number,
    name: string,
    color: number,
    hardness: number,
    extra: Partial<BlockDef> = {},
  ): void => {
    r.register({
      id,
      name,
      color,
      hardness,
      opaque: true,
      solid: true,
      shape: 'cube',
      push: 'normal',
      tool: 'pickaxe',
      ...extra,
    });
  };
  r.register({ id: BLOCK.AIR, name: 'minecraft:air', color: 0, hardness: 0, opaque: false, solid: false, shape: 'none', push: 'destroy', replaceable: true, dropItem: null });
  add(BLOCK.STONE, 'minecraft:stone', 0x7d7d7d, 1.5, { drop: 'minecraft:cobblestone' });
  add(BLOCK.DIRT, 'minecraft:dirt', 0x866043, 0.5, { tool: 'shovel' });
  add(BLOCK.GRASS, 'minecraft:grass_block', 0x5f9b38, 0.6, { tool: 'shovel', drop: 'minecraft:dirt' });
  add(BLOCK.SAND, 'minecraft:sand', 0xdbd3a0, 0.5, { tool: 'shovel' });
  add(BLOCK.GRAVEL, 'minecraft:gravel', 0x8b8582, 0.6, { tool: 'shovel' });
  add(BLOCK.SANDSTONE, 'minecraft:sandstone', 0xd9c98e, 0.8);
  add(BLOCK.SNOW, 'minecraft:snow', 0xf7fbfb, 0.2, { tool: 'shovel' });
  add(BLOCK.ICE, 'minecraft:ice', 0x9bc7f7, 0.5, { opaque: false });
  r.register({ id: BLOCK.WATER, name: 'minecraft:water', color: 0x3f76e4, hardness: -1, opaque: false, solid: false, shape: 'liquid', push: 'destroy', replaceable: true, dropItem: null });
  r.register({ id: BLOCK.LAVA, name: 'minecraft:lava', color: 0xd9500a, hardness: -1, opaque: false, solid: false, shape: 'liquid', push: 'destroy', replaceable: true, light: 15, dropItem: null });
  add(BLOCK.BEDROCK, 'minecraft:bedrock', 0x555555, -1, { push: 'immovable', tool: 'none' });
  add(BLOCK.OAK_LOG, 'minecraft:oak_log', 0x6b5230, 2, { tool: 'axe' });
  add(BLOCK.OAK_LEAVES, 'minecraft:oak_leaves', 0x3f7d2a, 0.2, { opaque: false, tool: 'none' });
  add(BLOCK.OAK_PLANKS, 'minecraft:oak_planks', 0xb8945f, 2, { tool: 'axe' });
  add(BLOCK.COBBLESTONE, 'minecraft:cobblestone', 0x6f6f6f, 2);
  add(BLOCK.GLASS, 'minecraft:glass', 0xc0ecf5, 0.3, { opaque: false });
  add(BLOCK.COAL_ORE, 'minecraft:coal_ore', 0x3c3c3c, 3);
  add(BLOCK.IRON_ORE, 'minecraft:iron_ore', 0x8c7a6b, 3);
  add(BLOCK.CLAY, 'minecraft:clay', 0x9ea4b0, 0.6, { tool: 'shovel' });
  add(BLOCK.MUD, 'minecraft:mud', 0x3b2f2a, 0.5, { tool: 'shovel' });
  add(BLOCK.MANGROVE_LOG, 'minecraft:mangrove_log', 0x6d3834, 2, { tool: 'axe' });
  add(BLOCK.DEEPSLATE, 'minecraft:deepslate', 0x4c4c50, 3);
  add(BLOCK.SCULK, 'minecraft:sculk', 0x0d2a33, 0.2, { tool: 'hoe' });
  add(BLOCK.TERRACOTTA, 'minecraft:terracotta', 0x9f5e3d, 1.25);
  add(BLOCK.CACTUS, 'minecraft:cactus', 0x2c7a2c, 0.4, { tool: 'none' });
  add(BLOCK.NETHERRACK, 'minecraft:netherrack', 0x6e2c2c, 0.4, { nether: true });
  add(BLOCK.SOUL_SAND, 'minecraft:soul_sand', 0x513d2d, 0.5, { tool: 'shovel', nether: true });
  add(BLOCK.GLOWSTONE, 'minecraft:glowstone', 0xe7b96a, 0.3, { light: 15, nether: true });
  add(BLOCK.NETHER_BRICKS, 'minecraft:nether_bricks', 0x2c1418, 2, { nether: true });
  add(BLOCK.BASALT, 'minecraft:basalt', 0x4d4d52, 1.25, { nether: true });
  add(BLOCK.NETHER_PORTAL, 'minecraft:portal', 0x7a2bd1, -1, { shape: 'portal', opaque: false, solid: false, push: 'destroy', replaceable: false, light: 11, dropItem: null, tool: 'none' });
  add(BLOCK.OBSIDIAN, 'minecraft:obsidian', 0x15101c, 50, { push: 'immovable', tool: 'pickaxe' });
  add(BLOCK.END_STONE, 'minecraft:end_stone', 0xdbe3a0, 3);
  add(BLOCK.CRAFTING_TABLE, 'minecraft:crafting_table', 0x8c6239, 2.5, { tool: 'axe' });
  add(BLOCK.FLETCHING_TABLE, 'minecraft:fletching_table', 0xa37e4f, 2.5, { tool: 'axe' });
  add(BLOCK.BLAST_FURNACE, 'minecraft:blast_furnace', 0x5b5b5b, 3.5);
  add(BLOCK.LECTERN, 'minecraft:lectern', 0x9e7a4a, 2, { tool: 'axe' });
  add(BLOCK.ENCHANTING_TABLE, 'minecraft:enchanting_table', 0x7d2a33, 5, { light: 0 });
  add(BLOCK.BREWING_STAND, 'minecraft:brewing_stand', 0x8d8d8d, 0.5, { opaque: false, shape: 'cube' });
  r.register({ id: BLOCK.REDSTONE_DUST, name: 'minecraft:redstone_wire', color: 0xaa0000, hardness: 0, opaque: false, solid: false, shape: 'redstone', push: 'destroy', replaceable: true, tool: 'none', conductsRedstone: true });
  add(BLOCK.REDSTONE_BLOCK, 'minecraft:redstone_block', 0xa81f1f, 5);
  r.register({ id: BLOCK.REDSTONE_TORCH, name: 'minecraft:redstone_torch', color: 0xf05a1f, hardness: 0, opaque: false, solid: false, shape: 'torch', push: 'destroy', replaceable: false, light: 7, tool: 'none' });
  r.register({ id: BLOCK.LEVER, name: 'minecraft:lever', color: 0x7a5d3c, hardness: 0.5, opaque: false, solid: false, shape: 'lever', push: 'destroy', tool: 'none' });
  r.register({ id: BLOCK.STONE_BUTTON, name: 'minecraft:stone_button', color: 0x8c8c8c, hardness: 0.5, opaque: false, solid: false, shape: 'button', push: 'destroy', tool: 'none' });
  r.register({ id: BLOCK.REPEATER, name: 'minecraft:unpowered_repeater', color: 0x9c8b7b, hardness: 0, opaque: false, solid: false, shape: 'repeater', push: 'destroy', tool: 'none' });
  add(BLOCK.REDSTONE_LAMP, 'minecraft:redstone_lamp', 0x8d6a3e, 0.3, { light: 0 });
  add(BLOCK.PISTON, 'minecraft:piston', 0x9b8a6b, 1.5, { shape: 'piston' });
  add(BLOCK.STICKY_PISTON, 'minecraft:sticky_piston', 0x7b9e4f, 1.5, { shape: 'piston', sticky: 'slime' });
  add(BLOCK.PISTON_HEAD, 'minecraft:piston_head', 0x9b8a6b, 1.5, { shape: 'piston_head', push: 'destroy', tool: 'none' });
  add(BLOCK.SLIME_BLOCK, 'minecraft:slime', 0x7fb35a, 0, { sticky: 'slime', tool: 'none', opaque: false });
  add(BLOCK.HONEY_BLOCK, 'minecraft:honey_block', 0xf3b721, 0, { sticky: 'honey', tool: 'none', opaque: false });
  r.register({ id: BLOCK.OAK_DOOR, name: 'minecraft:oak_door', color: 0xa98a52, hardness: 3, opaque: false, solid: true, shape: 'door', push: 'destroy', tool: 'axe' });
  r.register({ id: BLOCK.OAK_STAIRS, name: 'minecraft:oak_stairs', color: 0xb08c57, hardness: 2, opaque: false, solid: true, shape: 'stairs', push: 'normal', tool: 'axe', waterloggable: true });
  r.register({ id: BLOCK.OAK_SLAB, name: 'minecraft:oak_slab', color: 0xb8945f, hardness: 2, opaque: false, solid: true, shape: 'slab', push: 'normal', tool: 'axe', waterloggable: true });
  r.register({ id: BLOCK.OAK_FENCE, name: 'minecraft:oak_fence', color: 0xb08c57, hardness: 2, opaque: false, solid: true, shape: 'fence', push: 'normal', tool: 'axe', waterloggable: true });
  r.register({ id: BLOCK.TALL_GRASS, name: 'minecraft:tallgrass', color: 0x5fae3b, hardness: 0, opaque: false, solid: false, shape: 'cross', push: 'destroy', replaceable: true, tool: 'none', dropItem: null });
  add(BLOCK.DEEP_DARK_SCULK_SHRIEKER, 'minecraft:sculk_shrieker', 0x1e4a57, 3);
  add(BLOCK.OAK_SAPLING, 'minecraft:oak_sapling', 0x4f9b2b, 0, { shape: 'cross', opaque: false, solid: false, push: 'destroy', tool: 'none' });
  return r;
}

/** Shared default registry instance used by the client, server and tests. */
export const defaultRegistry: BlockRegistry = createDefaultRegistry();
