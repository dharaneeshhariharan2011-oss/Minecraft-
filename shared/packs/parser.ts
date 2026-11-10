import type {
  BlockSpec,
  EntityBehavior,
  EntitySpec,
  ItemSpec,
  PackError,
  PackManifest,
  ParsedPack,
  RecipeIngredient,
  RecipeSpec,
  TradeSpec,
  TradeTableSpec,
} from './schema.js';
import { SUPPORTED_FORMAT_MAJOR } from './schema.js';

const IDENTIFIER = /^[a-z][a-z0-9_]*:[a-z0-9_./-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Obj = Record<string, unknown>;

export class PackValidationError extends Error {}

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function req<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new PackValidationError(`missing ${what}`);
  return v;
}

function identifier(v: unknown, what = 'identifier'): string {
  if (typeof v !== 'string' || !IDENTIFIER.test(v)) {
    throw new PackValidationError(`invalid ${what}: ${String(v)}`);
  }
  return v;
}

function num(v: unknown, what: string, min = -Infinity, max = Infinity): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw new PackValidationError(`invalid ${what}`);
  }
  return v;
}

function int(v: unknown, what: string, min = -Infinity, max = Infinity): number {
  const n = num(v, what, min, max);
  if (!Number.isInteger(n)) throw new PackValidationError(`invalid ${what}`);
  return n;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function checkFormat(doc: Obj): void {
  const fv = doc.format_version;
  if (typeof fv !== 'string' || !/^\d+\.\d+\.\d+$/.test(fv)) {
    throw new PackValidationError('format_version must be "major.minor.patch"');
  }
  const major = Number(fv.split('.')[0]);
  if (major !== SUPPORTED_FORMAT_MAJOR) {
    throw new PackValidationError(`unsupported format_version ${fv}`);
  }
}

/** Parses a hex colour like "#RRGGBB" or "RRGGBB" into a number. */
export function parseColor(v: unknown): number {
  if (typeof v !== 'string' || !/^#?[0-9a-fA-F]{6}$/.test(v)) throw new PackValidationError('invalid map_color');
  return parseInt(v.replace('#', ''), 16);
}

export function parseManifest(doc: unknown): PackManifest {
  if (!isObj(doc)) throw new PackValidationError('manifest must be an object');
  checkFormat(doc);
  const header = req(doc.header, 'header');
  if (!isObj(header)) throw new PackValidationError('header must be an object');
  const name = req(header.name, 'header.name');
  if (typeof name !== 'string' || name.length === 0 || name.length > 64) throw new PackValidationError('invalid header.name');
  const uuid = req(header.uuid, 'header.uuid');
  if (typeof uuid !== 'string' || !UUID.test(uuid)) throw new PackValidationError('invalid header.uuid');
  const version = header.version;
  if (!Array.isArray(version) || version.length !== 3 || version.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new PackValidationError('invalid header.version');
  }
  const description = typeof header.description === 'string' ? header.description : '';
  return { name, uuid, version: version as [number, number, number], description };
}

export function parseBlock(doc: unknown): BlockSpec {
  if (!isObj(doc)) throw new PackValidationError('block must be an object');
  checkFormat(doc);
  const block = req(doc['minecraft:block'], 'minecraft:block');
  if (!isObj(block)) throw new PackValidationError('minecraft:block must be an object');
  const description = req(block.description, 'description');
  if (!isObj(description)) throw new PackValidationError('description must be an object');
  const components = isObj(block.components) ? block.components : {};

  const geometryRaw = components['minecraft:geometry'] ?? 'cube';
  const geometry = (['cube', 'slab', 'cross', 'liquid', 'none'] as const).find((g) => g === geometryRaw);
  if (!geometry) throw new PackValidationError(`invalid geometry ${String(geometryRaw)}`);

  const pistonRaw = components['minecraft:piston_behavior'] ?? 'normal';
  const piston = (['normal', 'immovable', 'destroy', 'sticky'] as const).find((p) => p === pistonRaw);
  if (!piston) throw new PackValidationError(`invalid piston_behavior ${String(pistonRaw)}`);

  const destroyTime = components['minecraft:destroy_time'] ?? 1;
  const drop = components['dh:drops'];
  return {
    identifier: identifier(description.identifier, 'block identifier'),
    color: components['minecraft:map_color'] === undefined ? 0x808080 : parseColor(components['minecraft:map_color']),
    hardness: num(destroyTime, 'destroy_time', -1, 1000),
    lightEmission: int(components['minecraft:light_emission'] ?? 0, 'light_emission', 0, 15),
    geometry,
    pistonBehavior: piston,
    waterloggable: bool(components['dh:waterloggable'], false),
    redstoneConductive: bool(components['dh:redstone_conductive'], false),
    ...(drop !== undefined ? { drop: identifier(drop, 'dh:drops') } : {}),
  };
}

export function parseItem(doc: unknown): ItemSpec {
  if (!isObj(doc)) throw new PackValidationError('item must be an object');
  checkFormat(doc);
  const item = req(doc['minecraft:item'], 'minecraft:item');
  if (!isObj(item)) throw new PackValidationError('minecraft:item must be an object');
  const description = req(item.description, 'description');
  if (!isObj(description)) throw new PackValidationError('description must be an object');
  const c = isObj(item.components) ? item.components : {};
  const out: ItemSpec = {
    identifier: identifier(description.identifier, 'item identifier'),
    maxStackSize: int(c['minecraft:max_stack_size'] ?? 64, 'max_stack_size', 1, 64),
  };
  if (c['minecraft:durability'] !== undefined) {
    const d = c['minecraft:durability'];
    if (!isObj(d)) throw new PackValidationError('durability must be an object');
    out.durability = int(d.max_durability, 'max_durability', 1, 1_000_000);
  }
  if (c['minecraft:armor'] !== undefined) {
    const a = c['minecraft:armor'];
    if (!isObj(a)) throw new PackValidationError('armor must be an object');
    const slot = a.slot;
    if (slot !== 'head' && slot !== 'chest' && slot !== 'legs' && slot !== 'feet' && slot !== 'offhand') {
      throw new PackValidationError('invalid armor slot');
    }
    out.armor = { slot, protection: int(a.protection, 'protection', 0, 30) };
  }
  if (c['minecraft:food'] !== undefined) {
    const f = c['minecraft:food'];
    if (!isObj(f)) throw new PackValidationError('food must be an object');
    out.foodValue = int(f.nutrition, 'nutrition', 0, 20);
  }
  return out;
}

export function parseEntity(doc: unknown): EntitySpec {
  if (!isObj(doc)) throw new PackValidationError('entity must be an object');
  checkFormat(doc);
  const entity = req(doc['minecraft:entity'], 'minecraft:entity');
  if (!isObj(entity)) throw new PackValidationError('minecraft:entity must be an object');
  const description = req(entity.description, 'description');
  if (!isObj(description)) throw new PackValidationError('description must be an object');
  const c = isObj(entity.components) ? entity.components : {};

  let maxHealth = 20;
  let health = 20;
  if (c['minecraft:health'] !== undefined) {
    const h = c['minecraft:health'];
    if (!isObj(h)) throw new PackValidationError('health must be an object');
    maxHealth = int(h.max ?? h.value ?? 20, 'health.max', 1, 1024);
    health = int(h.value ?? maxHealth, 'health.value', 1, 1024);
  }
  let movementSpeed = 0.25;
  if (c['minecraft:movement'] !== undefined) {
    const m = c['minecraft:movement'];
    if (!isObj(m)) throw new PackValidationError('movement must be an object');
    movementSpeed = num(m.value, 'movement.value', 0, 2);
  }

  const behaviors: EntityBehavior[] = [];
  for (const [key, value] of Object.entries(c)) {
    if (!key.startsWith('minecraft:behavior.')) continue;
    const v = isObj(value) ? value : {};
    const priority = int(v.priority ?? 5, `${key}.priority`, 0, 100);
    const speed = num(v.speed_multiplier ?? 1, `${key}.speed_multiplier`, 0, 5);
    switch (key) {
      case 'minecraft:behavior.random_stroll':
        behaviors.push({ kind: 'wander', priority, speedMultiplier: speed });
        break;
      case 'minecraft:behavior.panic':
        behaviors.push({ kind: 'flee', priority, speedMultiplier: speed });
        break;
      case 'minecraft:behavior.melee_attack':
        behaviors.push({ kind: 'attack', priority, damage: num(v.damage ?? 2, `${key}.damage`, 0, 100), speedMultiplier: speed });
        break;
      case 'minecraft:behavior.breed':
        behaviors.push({ kind: 'breed', priority });
        break;
      default:
        // Unknown behaviours are ignored so that newer packs still load.
        break;
    }
  }
  const hostile = c['minecraft:behavior.melee_attack'] !== undefined;
  return {
    identifier: identifier(description.identifier, 'entity identifier'),
    health,
    maxHealth,
    movementSpeed,
    isSpawnable: bool(description.is_spawnable, false),
    isHostile: hostile,
    behaviors: behaviors.sort((a, b) => a.priority - b.priority),
  };
}

function ingredient(v: unknown, what: string): RecipeIngredient {
  if (!isObj(v)) throw new PackValidationError(`${what} must be an object`);
  return { item: identifier(v.item, `${what}.item`), count: int(v.count ?? 1, `${what}.count`, 1, 64) };
}

export function parseRecipe(doc: unknown): RecipeSpec {
  if (!isObj(doc)) throw new PackValidationError('recipe must be an object');
  checkFormat(doc);
  const shaped = doc['minecraft:recipe_shaped'];
  const shapeless = doc['minecraft:recipe_shapeless'];
  if (isObj(shaped)) {
    const description = req(shaped.description, 'description');
    if (!isObj(description)) throw new PackValidationError('description must be an object');
    const pattern = req(shaped.pattern, 'pattern');
    if (!Array.isArray(pattern) || pattern.length < 1 || pattern.length > 3) throw new PackValidationError('pattern must have 1-3 rows');
    if (pattern.some((row) => typeof row !== 'string' || row.length < 1 || row.length > 3)) {
      throw new PackValidationError('pattern rows must be 1-3 characters');
    }
    const keyObj = req(shaped.key, 'key');
    if (!isObj(keyObj)) throw new PackValidationError('key must be an object');
    const key: Record<string, string> = {};
    for (const [k, v] of Object.entries(keyObj)) {
      if (k.length !== 1) throw new PackValidationError('key symbols must be single characters');
      if (!isObj(v)) throw new PackValidationError('key entry must be an object');
      key[k] = identifier(v.item, 'key item');
    }
    for (const row of pattern as string[]) {
      for (const ch of row) {
        if (ch !== ' ' && !(ch in key)) throw new PackValidationError(`pattern symbol '${ch}' has no key entry`);
      }
    }
    return {
      kind: 'shaped',
      identifier: identifier(description.identifier, 'recipe identifier'),
      pattern: pattern as string[],
      key,
      result: ingredient(req(shaped.result, 'result'), 'result'),
      tags: Array.isArray(shaped.tags) ? shaped.tags.filter((t): t is string => typeof t === 'string') : ['crafting_table'],
    };
  }
  if (isObj(shapeless)) {
    const description = req(shapeless.description, 'description');
    if (!isObj(description)) throw new PackValidationError('description must be an object');
    const ings = req(shapeless.ingredients, 'ingredients');
    if (!Array.isArray(ings) || ings.length < 1 || ings.length > 9) throw new PackValidationError('ingredients must have 1-9 entries');
    return {
      kind: 'shapeless',
      identifier: identifier(description.identifier, 'recipe identifier'),
      ingredients: ings.map((i, idx) => ingredient(i, `ingredients[${idx}]`).item),
      result: ingredient(req(shapeless.result, 'result'), 'result'),
      tags: Array.isArray(shapeless.tags) ? shapeless.tags.filter((t): t is string => typeof t === 'string') : ['crafting_table'],
    };
  }
  throw new PackValidationError('unknown recipe type');
}

export function parseTradeTable(doc: unknown): TradeTableSpec {
  if (!isObj(doc)) throw new PackValidationError('trade table must be an object');
  checkFormat(doc);
  const table = req(doc['dh:trade_table'], 'dh:trade_table');
  if (!isObj(table)) throw new PackValidationError('dh:trade_table must be an object');
  const trades = req(table.trades, 'trades');
  if (!Array.isArray(trades) || trades.length === 0) throw new PackValidationError('trades must be a non-empty array');
  const profession = req(table.profession, 'profession');
  if (typeof profession !== 'string' || !/^[a-z_]{3,24}$/.test(profession)) throw new PackValidationError('invalid profession');
  return {
    identifier: identifier(table.identifier ?? `dh:${profession}_level_${table.level ?? 1}`, 'trade table identifier'),
    profession,
    level: int(table.level ?? 1, 'level', 1, 5),
    trades: trades.map((t, i): TradeSpec => {
      if (!isObj(t)) throw new PackValidationError(`trades[${i}] must be an object`);
      const wants = req(t.wants, `trades[${i}].wants`);
      if (!Array.isArray(wants) || wants.length < 1 || wants.length > 2) {
        throw new PackValidationError(`trades[${i}].wants must have 1-2 entries`);
      }
      return {
        wants: wants.map((w, j) => ingredient(w, `trades[${i}].wants[${j}]`)),
        gives: ingredient(req(t.gives, `trades[${i}].gives`), `trades[${i}].gives`),
        maxUses: int(t.max_uses ?? 12, 'max_uses', 1, 1000),
      };
    }),
  };
}

type Classified = 'manifest' | 'block' | 'item' | 'entity' | 'recipe' | 'trade' | 'unknown';

function classify(path: string, doc: unknown): Classified {
  if (path === 'manifest.json') return 'manifest';
  if (!isObj(doc)) return 'unknown';
  if ('minecraft:block' in doc) return 'block';
  if ('minecraft:item' in doc) return 'item';
  if ('minecraft:entity' in doc) return 'entity';
  if ('minecraft:recipe_shaped' in doc || 'minecraft:recipe_shapeless' in doc) return 'recipe';
  if ('dh:trade_table' in doc) return 'trade';
  return 'unknown';
}

/**
 * Parses a whole behaviour pack from a map of path -> JSON text or already-parsed value.
 * Invalid files are reported in `errors` and skipped; the rest of the pack still loads.
 * Throws only when the manifest is missing or invalid.
 */
export function parsePack(files: Record<string, unknown>): ParsedPack {
  const errors: PackError[] = [];
  const docs: Record<string, unknown> = {};
  for (const [path, raw] of Object.entries(files)) {
    if (!path.endsWith('.json')) continue;
    if (typeof raw === 'string') {
      try {
        docs[path] = JSON.parse(raw);
      } catch {
        errors.push({ file: path, message: 'malformed JSON' });
      }
    } else {
      docs[path] = raw;
    }
  }
  const manifestDoc = docs['manifest.json'];
  if (manifestDoc === undefined) throw new PackValidationError('manifest.json is required');
  const manifest = parseManifest(manifestDoc);

  const out: ParsedPack = { manifest, blocks: [], items: [], entities: [], recipes: [], trades: [], errors };
  const seen = new Set<string>();
  for (const [path, doc] of Object.entries(docs)) {
    if (path === 'manifest.json') continue;
    const kind = classify(path, doc);
    try {
      switch (kind) {
        case 'block':
          out.blocks.push(parseBlock(doc));
          break;
        case 'item':
          out.items.push(parseItem(doc));
          break;
        case 'entity':
          out.entities.push(parseEntity(doc));
          break;
        case 'recipe':
          out.recipes.push(parseRecipe(doc));
          break;
        case 'trade':
          out.trades.push(parseTradeTable(doc));
          break;
        default:
          errors.push({ file: path, message: 'unrecognised document' });
          continue;
      }
    } catch (err) {
      errors.push({ file: path, message: err instanceof Error ? err.message : String(err) });
    }
  }
  // Duplicate identifiers within a pack are an error: keep the first.
  const dedupe = <T extends { identifier: string }>(list: T[], kindName: string): T[] =>
    list.filter((item) => {
      const key = `${kindName}:${item.identifier}`;
      if (seen.has(key)) {
        errors.push({ file: kindName, message: `duplicate identifier ${item.identifier}` });
        return false;
      }
      seen.add(key);
      return true;
    });
  out.blocks = dedupe(out.blocks, 'blocks');
  out.items = dedupe(out.items, 'items');
  out.entities = dedupe(out.entities, 'entities');
  return out;
}
