/**
 * Data-driven behavior pack schema (JSON). Mirrors Bedrock's `minecraft:*` component model,
 * with `dh:*` extension components for things Bedrock does not expose directly.
 *
 * A pack is a map of file path -> JSON document, for example:
 *   manifest.json
 *   blocks/ruby_ore.json          { "format_version": "1.21.0", "minecraft:block": {...} }
 *   items/ruby.json               { "minecraft:item": {...} }
 *   entities/glow_pig.json        { "minecraft:entity": {...} }
 *   recipes/ruby_block.json       { "minecraft:recipe_shaped": {...} }
 *   trades/fletcher.json          { "dh:trade_table": {...} }
 */

export const SUPPORTED_FORMAT_MAJOR = 1;

export interface PackManifest {
  name: string;
  uuid: string;
  version: [number, number, number];
  description: string;
}

export interface BlockSpec {
  identifier: string;
  color: number;
  hardness: number;
  lightEmission: number;
  geometry: 'cube' | 'slab' | 'cross' | 'liquid' | 'none';
  pistonBehavior: 'normal' | 'immovable' | 'destroy' | 'sticky';
  waterloggable: boolean;
  redstoneConductive: boolean;
  drop?: string;
}

export interface ItemSpec {
  identifier: string;
  maxStackSize: number;
  durability?: number;
  armor?: { slot: 'head' | 'chest' | 'legs' | 'feet' | 'offhand'; protection: number };
  foodValue?: number;
}

export type EntityBehavior =
  | { kind: 'wander'; priority: number; speedMultiplier: number }
  | { kind: 'flee'; priority: number; speedMultiplier: number }
  | { kind: 'attack'; priority: number; damage: number; speedMultiplier: number }
  | { kind: 'breed'; priority: number };

export interface EntitySpec {
  identifier: string;
  health: number;
  maxHealth: number;
  movementSpeed: number;
  isSpawnable: boolean;
  isHostile: boolean;
  behaviors: EntityBehavior[];
}

export interface RecipeIngredient {
  item: string;
  count: number;
}

export interface ShapedRecipeSpec {
  kind: 'shaped';
  identifier: string;
  pattern: string[];
  key: Record<string, string>;
  result: RecipeIngredient;
  tags: string[];
}

export interface ShapelessRecipeSpec {
  kind: 'shapeless';
  identifier: string;
  ingredients: string[];
  result: RecipeIngredient;
  tags: string[];
}

export type RecipeSpec = ShapedRecipeSpec | ShapelessRecipeSpec;

export interface TradeSpec {
  wants: RecipeIngredient[];
  gives: RecipeIngredient;
  maxUses: number;
}

export interface TradeTableSpec {
  identifier: string;
  profession: string;
  level: number;
  trades: TradeSpec[];
}

export interface PackError {
  file: string;
  message: string;
}

export interface ParsedPack {
  manifest: PackManifest;
  blocks: BlockSpec[];
  items: ItemSpec[];
  entities: EntitySpec[];
  recipes: RecipeSpec[];
  trades: TradeTableSpec[];
  errors: PackError[];
}
