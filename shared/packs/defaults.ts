import type { EntitySpec, ItemSpec, RecipeSpec, TradeTableSpec } from './schema.js';

const item = (identifier: string, maxStackSize = 64, extra: Partial<ItemSpec> = {}): ItemSpec => ({
  identifier,
  maxStackSize,
  ...extra,
});

/** Built-in items. Block identifiers are implicitly items too (see ContentRegistry). */
export function defaultItems(): ItemSpec[] {
  return [
    item('minecraft:stick'),
    item('minecraft:coal'),
    item('minecraft:iron_ingot'),
    item('minecraft:diamond'),
    item('minecraft:emerald'),
    item('minecraft:redstone'),
    item('minecraft:glowstone_dust'),
    item('minecraft:flint'),
    item('minecraft:paper'),
    item('minecraft:book'),
    item('minecraft:arrow'),
    item('minecraft:string'),
    item('minecraft:feather'),
    item('minecraft:slime_ball'),
    item('minecraft:cobblestone'),
    item('minecraft:bucket', 16),
    item('minecraft:apple', 64, { foodValue: 4 }),
    item('minecraft:bread', 64, { foodValue: 5 }),
    item('minecraft:cooked_porkchop', 64, { foodValue: 8 }),
    item('minecraft:porkchop', 64, { foodValue: 3 }),
    item('minecraft:elytra', 1, { durability: 432, armor: { slot: 'chest', protection: 0 } }),
    item('minecraft:wooden_pickaxe', 1, { durability: 59 }),
    item('minecraft:stone_pickaxe', 1, { durability: 131 }),
    item('minecraft:iron_pickaxe', 1, { durability: 250 }),
    item('minecraft:iron_sword', 1, { durability: 250 }),
    item('minecraft:shield', 1, { durability: 336, armor: { slot: 'offhand', protection: 0 } }),
    item('minecraft:iron_helmet', 1, { durability: 165, armor: { slot: 'head', protection: 2 } }),
    item('minecraft:iron_chestplate', 1, { durability: 240, armor: { slot: 'chest', protection: 6 } }),
    item('minecraft:iron_leggings', 1, { durability: 225, armor: { slot: 'legs', protection: 5 } }),
    item('minecraft:iron_boots', 1, { durability: 195, armor: { slot: 'feet', protection: 2 } }),
    item('minecraft:flint_and_steel', 1, { durability: 64 }),
  ];
}

const shaped = (
  identifier: string,
  pattern: string[],
  key: Record<string, string>,
  result: string,
  count = 1,
  tags: string[] = ['crafting_table'],
): RecipeSpec => ({
  kind: 'shaped',
  identifier,
  pattern,
  key,
  result: { item: result, count },
  tags,
});

const shapeless = (
  identifier: string,
  ingredients: string[],
  result: string,
  count = 1,
  tags: string[] = ['crafting_table'],
): RecipeSpec => ({ kind: 'shapeless', identifier, ingredients, result: { item: result, count }, tags });

/** Built-in recipes, roughly matching the Bedrock recipe book for the features implemented here. */
export function defaultRecipes(): RecipeSpec[] {
  const P = 'minecraft:oak_planks';
  const S = 'minecraft:stick';
  const C = 'minecraft:cobblestone';
  const I = 'minecraft:iron_ingot';
  const R = 'minecraft:redstone';
  return [
    shapeless('minecraft:oak_planks_from_log', ['minecraft:oak_log'], P, 4, ['inventory', 'crafting_table']),
    shaped('minecraft:stick', ['P', 'P'], { P }, S, 4, ['inventory', 'crafting_table']),
    shaped('minecraft:crafting_table', ['PP', 'PP'], { P }, 'minecraft:crafting_table', 1),
    shaped('minecraft:wooden_pickaxe', ['PPP', ' S ', ' S '], { P, S }, 'minecraft:wooden_pickaxe', 1),
    shaped('minecraft:stone_pickaxe', ['CCC', ' S ', ' S '], { C, S }, 'minecraft:stone_pickaxe', 1),
    shaped('minecraft:iron_pickaxe', ['III', ' S ', ' S '], { I, S }, 'minecraft:iron_pickaxe', 1),
    shaped('minecraft:iron_sword', ['I', 'I', 'S'], { I, S }, 'minecraft:iron_sword', 1),
    shaped('minecraft:iron_helmet', ['III', 'I I'], { I }, 'minecraft:iron_helmet', 1),
    shaped('minecraft:iron_chestplate', ['I I', 'III', 'III'], { I }, 'minecraft:iron_chestplate', 1),
    shaped('minecraft:iron_leggings', ['III', 'I I', 'I I'], { I }, 'minecraft:iron_leggings', 1),
    shaped('minecraft:iron_boots', ['I I', 'I I'], { I }, 'minecraft:iron_boots', 1),
    shaped('minecraft:oak_door', ['PP', 'PP', 'PP'], { P }, 'minecraft:oak_door', 3),
    shaped('minecraft:oak_fence', ['PSP', 'PSP'], { P, S }, 'minecraft:oak_fence', 3),
    shaped('minecraft:oak_slab', ['PPP'], { P }, 'minecraft:oak_slab', 6),
    shaped('minecraft:oak_stairs', ['P  ', 'PP ', 'PPP'], { P }, 'minecraft:oak_stairs', 4),
    shaped('minecraft:redstone_torch', ['R', 'S'], { R, S }, 'minecraft:redstone_torch', 4),
    shaped('minecraft:lever', ['S', 'C'], { S, C }, 'minecraft:lever', 1),
    shaped('minecraft:stone_button', ['C'], { C }, 'minecraft:stone_button', 1),
    shaped('minecraft:repeater', ['TRT', 'SSS'], { T: 'minecraft:redstone_torch', R, S: C }, 'minecraft:unpowered_repeater', 1),
    shaped('minecraft:piston', ['PPP', 'CIC', 'CRC'], { P, C, I, R }, 'minecraft:piston', 1),
    shapeless('minecraft:sticky_piston', ['minecraft:slime_ball', 'minecraft:piston'], 'minecraft:sticky_piston', 1),
    shaped('minecraft:redstone_lamp', [' G ', 'GRG', ' G '], { G: 'minecraft:glowstone_dust', R }, 'minecraft:redstone_lamp', 1),
    shaped('minecraft:redstone_block', ['RR', 'RR'], { R }, 'minecraft:redstone_block', 1),
    shaped('minecraft:glowstone', ['GG', 'GG'], { G: 'minecraft:glowstone_dust' }, 'minecraft:glowstone', 1),
    shaped('minecraft:fletching_table', ['FF', 'PP'], { F: 'minecraft:flint', P }, 'minecraft:fletching_table', 1),
    shaped('minecraft:bucket', ['I I', ' I '], { I }, 'minecraft:bucket', 1),
    shapeless('minecraft:flint_and_steel', [I, 'minecraft:flint'], 'minecraft:flint_and_steel', 1),
  ];
}

const trade = (wants: Array<[string, number]>, gives: [string, number], maxUses: number) => ({
  wants: wants.map(([item, count]) => ({ item, count })),
  gives: { item: gives[0], count: gives[1] },
  maxUses,
});

/** Built-in villager trades per profession and level (Fletcher, Armorer, Librarian). */
export function defaultTradeTables(): TradeTableSpec[] {
  return [
    {
      identifier: 'dh:fletcher_1',
      profession: 'fletcher',
      level: 1,
      trades: [
        trade([['minecraft:stick', 1]], ['minecraft:emerald', 1], 16),
        trade([['minecraft:emerald', 1]], ['minecraft:arrow', 16], 12),
      ],
    },
    {
      identifier: 'dh:fletcher_2',
      profession: 'fletcher',
      level: 2,
      trades: [trade([['minecraft:flint', 26]], ['minecraft:emerald', 1], 12)],
    },
    {
      identifier: 'dh:armorer_1',
      profession: 'armorer',
      level: 1,
      trades: [trade([['minecraft:coal', 15]], ['minecraft:emerald', 1], 12)],
    },
    {
      identifier: 'dh:armorer_2',
      profession: 'armorer',
      level: 2,
      trades: [trade([['minecraft:emerald', 4]], ['minecraft:iron_helmet', 1], 3)],
    },
    {
      identifier: 'dh:librarian_1',
      profession: 'librarian',
      level: 1,
      trades: [
        trade([['minecraft:paper', 24]], ['minecraft:emerald', 1], 12),
        trade([['minecraft:emerald', 5]], ['minecraft:book', 1], 12),
      ],
    },
    {
      identifier: 'dh:librarian_2',
      profession: 'librarian',
      level: 2,
      trades: [trade([['minecraft:emerald', 2]], ['minecraft:feather', 1], 12)],
    },
  ];
}

const entity = (
  identifier: string,
  o: Partial<EntitySpec> & Pick<EntitySpec, 'health' | 'behaviors'>,
): EntitySpec => ({
  identifier,
  maxHealth: o.health,
  movementSpeed: 0.25,
  isSpawnable: true,
  isHostile: false,
  ...o,
});

/**
 * Built-in entity definitions. They use the same component model as behaviour packs, so the
 * data-driven AI is exercised by the default game too.
 */
export function defaultEntities(): EntitySpec[] {
  return [
    entity('minecraft:pig', { health: 10, movementSpeed: 0.25, behaviors: [{ kind: 'flee', priority: 1, speedMultiplier: 1.25 }, { kind: 'wander', priority: 6, speedMultiplier: 1 }, { kind: 'breed', priority: 4 }] }),
    entity('minecraft:cow', { health: 10, movementSpeed: 0.2, behaviors: [{ kind: 'flee', priority: 1, speedMultiplier: 1.2 }, { kind: 'wander', priority: 6, speedMultiplier: 1 }, { kind: 'breed', priority: 4 }] }),
    entity('minecraft:zombie', { health: 20, movementSpeed: 0.23, isHostile: true, behaviors: [{ kind: 'attack', priority: 2, damage: 3, speedMultiplier: 1.1 }, { kind: 'wander', priority: 7, speedMultiplier: 0.8 }] }),
    entity('minecraft:warden', { health: 500, movementSpeed: 0.3, isHostile: true, isSpawnable: false, behaviors: [{ kind: 'attack', priority: 1, damage: 16, speedMultiplier: 1 }] }),
    entity('minecraft:villager', { health: 20, movementSpeed: 0.2, isSpawnable: true, behaviors: [{ kind: 'wander', priority: 6, speedMultiplier: 0.6 }] }),
  ];
}
