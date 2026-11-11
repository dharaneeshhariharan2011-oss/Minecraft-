import { BlockRegistry, type BlockDef, type BlockShape, type PushBehavior, createDefaultRegistry, defaultRegistry as defaultBlocks } from '../world/blocks.js';
import type { BlockSpec, EntitySpec, ItemSpec, ParsedPack, RecipeSpec, TradeTableSpec } from './schema.js';
import { parsePack } from './parser.js';
import { defaultRecipes, defaultItems, defaultTradeTables, defaultEntities } from './defaults.js';

/**
 * Runtime content database: blocks, items, entities, recipes and trade tables.
 * Built-in content is loaded first; behaviour packs add to it (and may not redefine built-ins).
 */
export class ContentRegistry {
  readonly blocks: BlockRegistry;
  readonly items = new Map<string, ItemSpec>();
  readonly entities = new Map<string, EntitySpec>();
  readonly recipes: RecipeSpec[] = [];
  readonly trades = new Map<string, TradeTableSpec>();
  readonly packs: Array<{ name: string; uuid: string; errors: number }> = [];

  constructor(blocks: BlockRegistry = createDefaultRegistry()) {
    this.blocks = blocks;
    for (const item of defaultItems()) this.items.set(item.identifier, item);
    for (const r of defaultRecipes()) this.recipes.push(r);
    for (const t of defaultTradeTables()) this.trades.set(t.identifier, t);
    for (const e of defaultEntities()) this.entities.set(e.identifier, e);
  }

  /** Loads a parsed pack. Duplicate identifiers of existing content are reported and skipped. */
  loadPack(pack: ParsedPack): string[] {
    const warnings: string[] = pack.errors.map((e) => `${e.file}: ${e.message}`);
    for (const b of pack.blocks) {
      if (this.blocks.byIdentifier(b.identifier)) {
        warnings.push(`block ${b.identifier} already exists`);
        continue;
      }
      this.blocks.register(blockDefFromSpec(b));
      if (!this.items.has(b.identifier)) {
        this.items.set(b.identifier, { identifier: b.identifier, maxStackSize: 64 });
      }
    }
    for (const it of pack.items) {
      if (this.items.has(it.identifier) && !pack.blocks.some((b) => b.identifier === it.identifier)) {
        warnings.push(`item ${it.identifier} already exists`);
        continue;
      }
      this.items.set(it.identifier, it);
    }
    for (const e of pack.entities) {
      if (this.entities.has(e.identifier)) {
        warnings.push(`entity ${e.identifier} already exists`);
        continue;
      }
      this.entities.set(e.identifier, e);
    }
    for (const r of pack.recipes) this.recipes.push(r);
    for (const t of pack.trades) this.trades.set(t.identifier, t);
    this.packs.push({ name: pack.manifest.name, uuid: pack.manifest.uuid, errors: pack.errors.length });
    return warnings;
  }

  /** Parses and loads a pack from a file map in one step. */
  loadPackFiles(files: Record<string, unknown>): string[] {
    return this.loadPack(parsePack(files));
  }

  /** All loaded trade tables (used when spawning villagers). */
  tradeTables(): TradeTableSpec[] {
    return [...this.trades.values()];
  }

  tradesFor(profession: string, level: number): TradeTableSpec[] {
    return [...this.trades.values()].filter((t) => t.profession === profession && t.level <= level);
  }
}

const SHAPE_FROM_GEOMETRY: Record<BlockSpec['geometry'], BlockShape> = {
  cube: 'cube',
  slab: 'slab',
  cross: 'cross',
  liquid: 'liquid',
  none: 'none',
};

export function blockDefFromSpec(b: BlockSpec): Omit<BlockDef, 'id'> {
  const push: PushBehavior = b.pistonBehavior === 'sticky' ? 'normal' : b.pistonBehavior;
  const shape = SHAPE_FROM_GEOMETRY[b.geometry];
  const opaque = shape === 'cube';
  return {
    name: b.identifier,
    color: b.color,
    hardness: b.hardness,
    opaque,
    solid: shape === 'cube' || shape === 'slab',
    shape,
    push,
    ...(b.pistonBehavior === 'sticky' ? { sticky: 'slime' as const } : {}),
    ...(b.lightEmission > 0 ? { light: b.lightEmission } : {}),
    ...(b.waterloggable ? { waterloggable: true } : {}),
    ...(b.redstoneConductive ? { conductsRedstone: true } : {}),
    ...(b.drop ? { drop: b.drop } : {}),
    tool: 'pickaxe',
  };
}

/** Process-wide default content (built-ins only). Tests create isolated instances. */
export function createDefaultContent(): ContentRegistry {
  return new ContentRegistry(defaultBlocks);
}

