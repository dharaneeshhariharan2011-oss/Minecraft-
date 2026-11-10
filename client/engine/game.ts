import { ContentRegistry } from '../../shared/packs/registry.js';
import { findRecipe, type Grid } from '../../shared/crafting/recipes.js';
import { BLOCK, STATE, FACING_VECTORS, type BlockDef } from '../../shared/world/blocks.js';
import type { BlockChange, DimensionId } from '../../shared/world/dimension.js';
import { WorldState } from '../../shared/world/worldState.js';
import { detectPortalFrame, buildReturnPortal, findSafeSpawn, ignitePortal, scalePosition } from '../../shared/world/portal.js';
import { Inventory, ARMOR_SLOTS } from '../../shared/survival/inventory.js';
import { applyDamage, addExhaustion, createSurvival, eat, respawn, tickSurvival, type Survival, type Difficulty } from '../../shared/survival/stats.js';
import { createPlayer, eyePosition, lookVector, playerBox, stepPlayer, type PlayerState, type MoveInput } from '../../shared/physics/player.js';
import { MobInstance, type MobContext, type MobEvent, type MobTarget } from '../../shared/ai/mob.js';
import { Warden } from '../../shared/ai/warden.js';
import { Villager, type Profession, professionForWorkstation } from '../../shared/economy/villager.js';
import type { GameMessage, MobSnapshot, PlayerSnapshot } from '../../shared/protocols/messages.js';
import type { Role } from '../../shared/protocols/roles.js';
import { RedstoneSystem, REDSTONE_TPS } from '../../shared/redstone/redstone.js';
import { raycastWorld, type RayHit } from './raycast.js';

export type GameMode = 'single' | 'host' | 'client';

/** Per-frame player intent produced by the input layer. */
export interface GameInput extends MoveInput {
  lookDx: number;
  lookDy: number;
  /** Left button / trigger held: break blocks. */
  breaking: boolean;
  /** Right button / trigger pressed this frame: place, interact, or use item. */
  use: boolean;
  /** Hotbar slot picked this frame, or -1. */
  hotbar: number;
}

export interface NpcView {
  id: string;
  type: string;
  dim: DimensionId;
  x: number;
  y: number;
  z: number;
  yaw: number;
  hp: number;
  profession?: Profession;
}

export interface NpcEntry {
  mob: MobInstance;
  dim: DimensionId;
  villager?: Villager;
  warden?: Warden;
}

export interface RemotePlayer {
  id: string;
  name: string;
  role: Role;
  dim: DimensionId;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  seenAt: number;
}

export interface GameCallbacks {
  message(text: string): void;
  openPanel(panel: 'crafting' | 'trade' | 'inventory', data?: { villagerId?: string; size?: number }): void;
  damaged(amount: number): void;
  died(): void;
  dimensionChanged(id: DimensionId): void;
  /** Every block change made on this client. Hosts broadcast it; clients send it to the host as an edit. */
  blockChanged?(change: BlockChange): void;
}

export interface GameOptions {
  content: ContentRegistry;
  mode: GameMode;
  seed: number;
  name: string;
  difficulty?: Difficulty;
  callbacks: GameCallbacks;
  /** Clients start empty until the host's world sync arrives. */
  deferWorld?: boolean;
}

const PORTAL_TIME = 1.2;
const PORTAL_COOLDOWN = 5;
const DAY_LENGTH = 1200;
const REACH = 5;

/** Converts a yaw into the closest horizontal facing (0=N 1=E 2=S 3=W). */
export function facingFromYaw(yaw: number, towardPlayer = false): number {
  const look = lookVector(yaw, 0);
  let best = 0;
  let bestDot = -Infinity;
  FACING_VECTORS.forEach(([dx, , dz], i) => {
    const d = dx * look.x + dz * look.z;
    if (d > bestDot) {
      bestDot = d;
      best = i;
    }
  });
  return towardPlayer ? (best + 2) & 3 : best;
}

/** The authoritative-or-replicated game state. Rendering and DOM concerns live elsewhere. */
export class Game {
  readonly content: ContentRegistry;
  readonly world: WorldState;
  readonly mode: GameMode;
  readonly name: string;
  readonly difficulty: Difficulty;
  dimId: DimensionId = 'overworld';
  player: PlayerState;
  inventory: Inventory;
  survival: Survival = createSurvival();
  selected = 0;
  time = 0;
  readonly remote = new Map<string, RemotePlayer>();
  readonly npcs = new Map<string, NpcEntry>();
  readonly chat: Array<{ name: string; text: string; at: number }> = [];
  breakTarget: RayHit | null = null;
  breakProgress = 0;
  dead = false;
  private readonly callbacks: GameCallbacks;
  private redstoneAcc = 0;
  private portalTimer = 0;
  private portalCooldown = 0;
  private nextNpcId = 1;
  private spawn = { x: 0.5, y: 80, z: 0.5 };
  private sculkWardenSpawned = new Set<DimensionId>();
  private rng = mulberry(0x9e37);
  initialized = false;

  constructor(opts: GameOptions) {
    this.content = opts.content;
    this.mode = opts.mode;
    this.name = opts.name;
    this.difficulty = opts.difficulty ?? 'normal';
    this.callbacks = opts.callbacks;
    this.world = new WorldState(opts.seed, this.content.blocks, opts.mode !== 'client');
    this.inventory = new Inventory((id) => {
      const spec = this.content.items.get(id);
      return spec ? { maxStackSize: spec.maxStackSize, durability: spec.durability, armor: spec.armor } : undefined;
    });
    this.player = createPlayer(this.spawn.x, this.spawn.y, this.spawn.z);
    this.world.onBlockChange((change) => {
      if (this.applyingRemote) return;
      this.callbacks.blockChanged?.(change);
    });
    if (!opts.deferWorld) this.initialize();
  }

  /** Generates spawn, places starter NPCs and the starter kit. Host and single player only. */
  initialize(): void {
    if (this.initialized) return;
    this.initialized = true;
    const dim = this.world.dimension('overworld');
    const spawn = findSafeSpawn(dim, 0, 0, 100);
    if (spawn) this.spawn = spawn;
    this.player.x = this.spawn.x;
    this.player.y = this.spawn.y;
    this.player.z = this.spawn.z;
    if (this.mode !== 'client') {
      this.spawnNpc('minecraft:pig', 'overworld', this.spawn.x + 4, this.spawn.z + 3);
      this.spawnNpc('minecraft:cow', 'overworld', this.spawn.x - 4, this.spawn.z + 2);
      this.spawnVillager('fletcher', this.spawn.x + 2, this.spawn.z - 4);
      this.spawnVillager('librarian', this.spawn.x - 2, this.spawn.z - 4);
    }
    this.giveStarterKit();
  }

  private giveStarterKit(): void {
    const kit: Array<[string, number]> = [
      ['minecraft:wooden_pickaxe', 1],
      ['minecraft:oak_planks', 32],
      ['minecraft:cobblestone', 32],
      ['minecraft:redstone', 16],
      ['minecraft:redstone_torch', 8],
      ['minecraft:lever', 2],
      ['minecraft:stone_button', 2],
      ['minecraft:unpowered_repeater', 2],
      ['minecraft:piston', 2],
      ['minecraft:sticky_piston', 1],
      ['minecraft:redstone_lamp', 2],
      ['minecraft:slime_ball', 2],
      ['minecraft:oak_door', 1],
      ['minecraft:apple', 8],
      ['minecraft:bucket', 1],
      ['minecraft:flint_and_steel', 1],
      ['minecraft:flint', 4],
      ['minecraft:crafting_table', 1],
      ['minecraft:fletching_table', 1],
      ['minecraft:elytra', 1],
    ];
    for (const [id, count] of kit) this.inventory.add(id, count);
  }

  // ---------------------------------------------------------------- queries

  get dim() {
    return this.world.dimension(this.dimId);
  }

  get eye() {
    return eyePosition(this.player);
  }

  get heldItem(): { id: string; count: number } | null {
    const s = this.inventory.slots[this.selected];
    return s ? { id: s.id, count: s.count } : null;
  }

  /** Block or NPC currently under the crosshair. */
  hitTest(): RayHit | null {
    const look = lookVector(this.player.yaw, this.player.pitch);
    return raycastWorld(this.dim, this.eye, look, REACH, (id) => id !== BLOCK.AIR && this.content.blocks.get(id).shape !== 'portal' && id !== BLOCK.WATER && id !== BLOCK.LAVA);
  }

  /** Nearest NPC in front of the player within reach, or null. */
  npcInFront(): { id: string; npc: NpcEntry } | null {
    const look = lookVector(this.player.yaw, this.player.pitch);
    let best: { id: string; npc: NpcEntry } | null = null;
    let bestDist = 3.5;
    for (const [id, npc] of this.npcs) {
      if (npc.dim !== this.dimId || npc.mob.dead) continue;
      const dx = npc.mob.body.x - this.player.x;
      const dy = npc.mob.body.y + 0.9 - this.eye.y;
      const dz = npc.mob.body.z - this.player.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > bestDist) continue;
      const dot = (dx * look.x + dy * look.y + dz * look.z) / (dist || 1);
      if (dot > 0.85) {
        best = { id, npc };
        bestDist = dist;
      }
    }
    return best;
  }

  isWaterAt(x: number, y: number, z: number): boolean {
    const b = this.dim.getBlock(x, y, z);
    if (b.id === BLOCK.WATER) return true;
    return (b.state & STATE.WATERLOGGED) !== 0 && this.content.blocks.get(b.id).waterloggable === true;
  }

  // ---------------------------------------------------------------- update

  /** Advances the simulation. `dt` is seconds. */
  update(dt: number, input: GameInput): void {
    if (this.dead) return;
    const stepDt = Math.min(dt, 0.1);
    this.time += stepDt;
    this.portalCooldown = Math.max(0, this.portalCooldown - stepDt);

    // Look.
    this.player.yaw -= input.lookDx;
    this.player.pitch = Math.max(-1.45, Math.min(1.45, this.player.pitch + input.lookDy));
    if (input.hotbar >= 0 && input.hotbar < 9) this.selected = input.hotbar;

    // Movement with the shared physics. Elytra glide key only matters if the chest slot holds one.
    const chest = this.inventory.slots[ARMOR_SLOTS.chest];
    const hasElytra = chest?.id === 'minecraft:elytra';
    const result = stepPlayer(this.player, { ...input, hasElytra }, stepDt, {
      isSolid: (x, y, z) => this.isSolidAt(x, y, z),
      isWater: (x, y, z) => this.isWaterAt(x, y, z),
    });
    const travelled = Math.hypot(this.player.vx, this.player.vz) * stepDt;
    if (this.player.onGround && travelled > 0) addExhaustion(this.survival, travelled * (input.sprint ? 0.01 : 0.002));
    if (result.fallDamage > 0) this.damagePlayer(result.fallDamage, true);
    if (this.dead) return;

    this.updateBreaking(stepDt, input);
    if (input.use && !input.breaking) this.useAction();

    this.updatePortal(stepDt);
    this.updateSurvival();

    // Redstone runs at a fixed 10 Hz on the host / single player.
    if (this.mode !== 'client') {
      this.redstoneAcc += stepDt;
      const step = 1 / REDSTONE_TPS;
      while (this.redstoneAcc >= step) {
        this.redstoneAcc -= step;
        this.world.tickRedstone();
      }
      this.updateNpcs(stepDt);
      this.maybeSpawnHostiles();
    }
  }

  private isSolidAt(x: number, y: number, z: number): boolean {
    const b = this.dim.getBlock(x, y, z);
    const def = this.content.blocks.get(b.id);
    if (def.shape === 'door') return (b.state & STATE.ACTIVE) === 0 && def.solid;
    return def.solid;
  }

  private updateSurvival(): void {
    const { healed, starved } = tickSurvival(this.survival, this.difficulty);
    void healed;
    if (starved > 0) this.callbacks.damaged(starved);
    if (this.survival.dead) this.die();
  }

  /** Damage from falls and mobs, reduced by armour. Returns damage applied. */
  damagePlayer(amount: number, fall = false): number {
    const armor = this.inventory.armorPoints();
    const result = applyDamage(this.survival, amount, armor, this.difficulty, fall);
    if (result.armorDamaged && !fall) this.inventory.damageArmor();
    if (result.applied > 0) this.callbacks.damaged(result.applied);
    if (result.died) this.die();
    return result.applied;
  }

  private die(): void {
    if (this.dead) return;
    this.dead = true;
    this.callbacks.died();
  }

  /** Respawns the player at the world spawn with a full health bar (drops are not implemented). */
  respawn(): void {
    respawn(this.survival);
    this.dead = false;
    this.dimId = 'overworld';
    this.player = createPlayer(this.spawn.x, this.spawn.y, this.spawn.z);
    this.callbacks.dimensionChanged('overworld');
  }

  private updateBreaking(dt: number, input: GameInput): void {
    if (!input.breaking) {
      this.breakTarget = null;
      this.breakProgress = 0;
      return;
    }
    const hit = this.hitTest();
    if (!hit) {
      this.breakTarget = null;
      this.breakProgress = 0;
      return;
    }
    if (!this.breakTarget || this.breakTarget.x !== hit.x || this.breakTarget.y !== hit.y || this.breakTarget.z !== hit.z) {
      this.breakTarget = hit;
      this.breakProgress = 0;
    }
    const def = this.content.blocks.get(this.dim.getId(hit.x, hit.y, hit.z));
    const time = breakTime(def, this.heldItem?.id);
    if (!Number.isFinite(time)) return;
    this.breakProgress += dt / time;
    if (this.breakProgress >= 1) {
      this.breakProgress = 0;
      this.breakBlock(hit);
      this.breakTarget = null;
      addExhaustion(this.survival, 0.005);
    }
  }

  /** Breaking a block: drops items into the inventory and writes air. */
  breakBlock(hit: RayHit): boolean {
    const id = this.dim.getId(hit.x, hit.y, hit.z);
    const def = this.content.blocks.get(id);
    if (def.hardness < 0 || id === BLOCK.AIR) return false;
    const drop = dropFor(def);
    if (drop) {
      const leftover = this.inventory.add(drop, 1);
      if (leftover > 0) this.callbacks.message('Inventory full');
    }
    this.setBlockLocal(hit.x, hit.y, hit.z, BLOCK.AIR, 0);
    return true;
  }

  /** Right-click: interact with the targeted block or NPC, otherwise use the held item. */
  private useAction(): void {
    const npc = this.npcInFront();
    if (npc && npc.npc.villager) {
      this.callbacks.openPanel('trade', { villagerId: npc.id });
      return;
    }
    const hit = this.hitTest();
    if (hit && this.interactBlock(hit)) return;
    this.useItem(hit);
  }

  /** Blocks that react to right-click. Returns true when the click was consumed. */
  private interactBlock(hit: RayHit): boolean {
    const id = this.dim.getId(hit.x, hit.y, hit.z);
    const rs = this.redstone();
    switch (id) {
      case BLOCK.LEVER:
        rs?.toggleLever({ x: hit.x, y: hit.y, z: hit.z });
        return true;
      case BLOCK.STONE_BUTTON:
        rs?.pressButton({ x: hit.x, y: hit.y, z: hit.z });
        return true;
      case BLOCK.REPEATER: {
        const delay = rs?.cycleRepeaterDelay({ x: hit.x, y: hit.y, z: hit.z });
        if (delay) this.callbacks.message(`Repeater delay: ${delay} tick${delay > 1 ? 's' : ''}`);
        return true;
      }
      case BLOCK.OAK_DOOR:
        rs?.toggleDoor({ x: hit.x, y: hit.y, z: hit.z });
        return true;
      case BLOCK.CRAFTING_TABLE:
        this.callbacks.openPanel('crafting', { size: 3 });
        return true;
      case BLOCK.FLETCHING_TABLE:
      case BLOCK.BLAST_FURNACE:
      case BLOCK.LECTERN:
        this.callbacks.message(`Workstation: ${professionForWorkstation(this.content.blocks.get(id).name)}`);
        return true;
      default:
        return false;
    }
  }

  private redstone(): RedstoneSystem | undefined {
    return this.world.redstone.get(this.dimId);
  }

  /** Using a held item: food, armour, flint and steel (portals), or placing a block. */
  private useItem(hit: RayHit | null): void {
    const held = this.heldItem;
    if (!held) return;
    const spec = this.content.items.get(held.id);
    if (spec?.foodValue !== undefined) {
      if (this.survival.hunger >= 20 && this.survival.health >= 20) return;
      eat(this.survival, spec.foodValue);
      this.inventory.remove(held.id, 1);
      return;
    }
    if (spec?.armor) {
      const slot = { head: 36, chest: 37, legs: 38, feet: 39, offhand: 40 }[spec.armor.slot];
      if (slot !== undefined && spec.armor.slot !== 'offhand') {
        const previous = this.inventory.slots[slot];
        if (this.inventory.equipArmor(slot, held.id)) {
          if (previous) this.inventory.add(previous.id, previous.count);
        }
      }
      return;
    }
    if (!hit) return;
    if (held.id === 'minecraft:flint_and_steel') {
      const p = { x: hit.px, y: hit.py, z: hit.pz };
      const frame = detectPortalFrame(this.dim, p);
      if (frame) {
        ignitePortal(this.dim, frame);
        this.inventory.damageSlot(this.selected, 1);
        this.callbacks.message('Portal lit');
      }
      return;
    }
    this.placeBlock(hit, held.id);
  }

  /** Places the block item `itemId` on the hit face. Returns true when placed. */
  placeBlock(hit: RayHit, itemId: string): boolean {
    const blockName = itemId === 'minecraft:redstone' ? 'minecraft:redstone_wire' : itemId;
    const def = this.content.blocks.byIdentifier(blockName);
    if (!def || def.id === BLOCK.AIR) return false;
    const px = hit.px;
    const py = hit.py;
    const pz = hit.pz;
    if (py < 0 || py > 127) return false;
    const target = this.dim.getBlock(px, py, pz);
    const targetDef = this.content.blocks.get(target.id);
    if (!targetDef.replaceable && target.id !== BLOCK.WATER && target.id !== BLOCK.AIR) return false;
    if (def.shape === 'torch' && this.dim.getId(px, py - 1, pz) === BLOCK.AIR) return false;
    if (def.solid && intersectsCell(playerBox(this.player), px, py, pz)) return false;
    let state = 0;
    switch (def.shape) {
      case 'slab':
        if (hit.ny < 0) state |= STATE.FLAG;
        break;
      case 'piston':
      case 'repeater':
        state = facingFromYaw(this.player.yaw, false);
        break;
      case 'stairs':
      case 'door':
        state = facingFromYaw(this.player.yaw, true);
        break;
      default:
        break;
    }
    if (def.shape === 'redstone' || def.id === BLOCK.REDSTONE_DUST) state = 0;
    if (target.id === BLOCK.WATER && def.waterloggable) state |= STATE.WATERLOGGED;
    if (!this.consumeOne(itemId)) return false;
    this.setBlockLocal(px, py, pz, def.id, state);
    addExhaustion(this.survival, 0.005);
    return true;
  }

  private consumeOne(itemId: string): boolean {
    return this.inventory.remove(itemId, 1);
  }

  /** Writes a block for the local player. The world listener reports it to the networking layer. */
  setBlockLocal(x: number, y: number, z: number, id: number, state: number): void {
    this.dim.setBlock(x, y, z, id, state);
  }

  /** Applies a block update received from the host without echoing it back. */
  applyRemoteBlock(dim: DimensionId, x: number, y: number, z: number, id: number, state: number): void {
    if (!this.content.blocks.tryGet(id)) return;
    this.applyingRemote = true;
    try {
      this.world.dimension(dim).setBlock(x, y, z, id, state);
    } finally {
      this.applyingRemote = false;
    }
  }

  private applyingRemote = false;

  // ---------------------------------------------------------------- portals

  private updatePortal(dt: number): void {
    const feet = this.dim.getId(Math.floor(this.player.x), Math.floor(this.player.y + 0.5), Math.floor(this.player.z));
    if (feet !== BLOCK.NETHER_PORTAL || this.portalCooldown > 0) {
      this.portalTimer = Math.max(0, this.portalTimer - dt * 2);
      return;
    }
    this.portalTimer += dt;
    if (this.portalTimer >= PORTAL_TIME) {
      this.portalTimer = 0;
      this.travelThroughPortal();
    }
  }

  /** Overworld <-> Nether, with X/Z scaled by 8. Builds a return portal if none is nearby. */
  travelThroughPortal(): void {
    const to: DimensionId = this.dimId === 'overworld' ? 'nether' : 'overworld';
    const scaled = scalePosition(this.dimId, to, { x: this.player.x, y: this.player.y, z: this.player.z });
    if (!scaled) return;
    const target = this.world.dimension(to);
    let spot = findSafeSpawn(target, Math.floor(scaled.x), Math.floor(scaled.z), Math.floor(scaled.y));
    if (!spot) spot = { x: scaled.x, y: 64, z: scaled.z };
    const frameBase = { x: Math.floor(spot.x), y: Math.floor(spot.y), z: Math.floor(spot.z) };
    buildReturnPortal(target, frameBase.x, frameBase.y, frameBase.z);
    this.dimId = to;
    this.player = createPlayer(frameBase.x + 0.5, frameBase.y, frameBase.z + 0.5);
    this.portalCooldown = PORTAL_COOLDOWN;
    this.callbacks.dimensionChanged(to);
    this.callbacks.message(to === 'nether' ? 'Entered the Nether' : 'Returned to the Overworld');
  }

  // ---------------------------------------------------------------- crafting

  /** Crafts once using the given grid (ids per cell). Consumes ingredients from the inventory. */
  craft(grid: Grid, size: number): boolean {
    const recipe = findRecipe(this.content.recipes, grid, size >= 3 ? 'crafting_table' : 'inventory');
    if (!recipe) return false;
    // Check that the inventory holds the ingredients (counting each grid cell once).
    const needed = new Map<string, number>();
    for (const row of grid) for (const cell of row) if (cell) needed.set(cell, (needed.get(cell) ?? 0) + 1);
    for (const [id, n] of needed) if (this.inventory.countOf(id) < n) return false;
    for (const [id, n] of needed) this.inventory.remove(id, n);
    this.inventory.add(recipe.result.item, recipe.result.count);
    return true;
  }

  /** Checks whether `grid` would match a recipe (used to preview output). */
  previewCraft(grid: Grid, size: number): { item: string; count: number } | null {
    const recipe = findRecipe(this.content.recipes, grid, size >= 3 ? 'crafting_table' : 'inventory');
    return recipe ? { item: recipe.result.item, count: recipe.result.count } : null;
  }

  // ---------------------------------------------------------------- villagers and mobs

  spawnNpc(type: string, dim: DimensionId, x: number, z: number, profession?: Profession): string | null {
    const spec = this.content.entities.get(type);
    if (!spec) return null;
    const d = this.world.dimension(dim);
    const top = d.topBlockY(Math.floor(x), Math.floor(z));
    if (top < 0) return null;
    const mob = new MobInstance(`n${this.nextNpcId++}`, spec, x + 0.5, top + 1, z + 0.5);
    const entry: NpcEntry = { mob, dim };
    if (type === 'minecraft:villager') {
      entry.villager = new Villager(profession ?? 'none', this.content.tradeTables(), Math.floor(this.time / DAY_LENGTH));
    }
    if (type === 'minecraft:warden') entry.warden = new Warden();
    this.npcs.set(mob.id, entry);
    return mob.id;
  }

  private spawnVillager(profession: Profession, x: number, z: number): void {
    this.spawnNpc('minecraft:villager', 'overworld', this.spawn.x + (x - this.spawn.x), this.spawn.z + (z - this.spawn.z), profession);
  }

  /** Trade with a villager: returns the trade result text, or null. */
  trade(villagerId: string, index: number): string | null {
    const npc = this.npcs.get(villagerId);
    if (!npc?.villager) return null;
    const out = npc.villager.trade(index, this.inventory);
    if (!out) return null;
    return `Received ${out.count} ${out.item.replace('minecraft:', '')}`;
  }

  private mobContext(): MobContext {
    const players: MobTarget[] = [{ id: 'local', x: this.player.x, y: this.player.y, z: this.player.z }];
    for (const r of this.remote.values()) {
      if (r.dim === this.dimId) players.push({ id: r.id, x: r.x, y: r.y, z: r.z });
    }
    return {
      world: {
        isSolid: (x, y, z) => this.isSolidAt(x, y, z),
        isWater: (x, y, z) => this.isWaterAt(x, y, z),
        passable: (x, y, z) => {
          const def = this.content.blocks.get(this.dim.getId(x, y, z));
          return !def.solid && def.shape !== 'liquid';
        },
        solid: (x, y, z) => this.isSolidAt(x, y, z),
      },
      players,
      mates: [...this.npcs.values()].filter((n) => n.dim === this.dimId).map((n) => ({ id: n.mob.id, x: n.mob.body.x, y: n.mob.body.y, z: n.mob.body.z, inLove: n.mob.inLove })),
      random: () => this.rng(),
      now: this.time,
    };
  }

  private updateNpcs(dt: number): void {
    const ctx = this.mobContext();
    for (const [id, npc] of this.npcs) {
      // Only NPCs in the player's dimension are simulated; others wait until the player returns.
      if (npc.dim !== this.dimId) continue;
      const events = npc.mob.tick(dt, ctx);
      for (const ev of events) this.handleMobEvent(ev);
      if (npc.warden) {
        const dist = Math.hypot(this.player.x - npc.mob.body.x, this.player.z - npc.mob.body.z);
        npc.warden.onPlayerNearby('local', dist, this.player.sneaking, dt);
        const boom = npc.warden.tick(dt, dist);
        if (boom) this.damagePlayer(boom.damage);
      }
      if (npc.mob.dead) this.npcs.delete(id);
    }
  }

  private handleMobEvent(ev: MobEvent): void {
    if (ev.type === 'attack') {
      if (ev.targetId === 'local') {
        this.damagePlayer(ev.damage);
        addExhaustion(this.survival, 0.1);
      } else {
        // A remote player was hit: tell them over the network so their client applies the damage.
        this.outbox.push({ t: 'hurt', target: ev.targetId, amount: ev.damage });
      }
    }
    if (ev.type === 'breed') {
      const parent = this.npcs.get(ev.mobId);
      if (parent) this.spawnNpc(parent.mob.spec.identifier, parent.dim, parent.mob.body.x, parent.mob.body.z);
    }
  }

  /** Spawns hostile mobs at night in the overworld, at a distance from the player. */
  private maybeSpawnHostiles(): void {
    if (this.dimId !== 'overworld') return;
    const night = (this.time % DAY_LENGTH) / DAY_LENGTH > 0.6;
    if (!night) return;
    const hostiles = [...this.npcs.values()].filter((n) => n.dim === 'overworld' && n.mob.spec.isHostile && n.mob.spec.identifier !== 'minecraft:warden').length;
    if (hostiles >= 4 || this.rng() > 0.01) return;
    const angle = this.rng() * Math.PI * 2;
    const dist = 18 + this.rng() * 6;
    this.spawnNpc('minecraft:zombie', 'overworld', this.player.x + Math.cos(angle) * dist, this.player.z + Math.sin(angle) * dist);
  }

  /** Deep Dark: standing on sculk summons a Warden nearby (once per dimension). */
  maybeSummonWarden(): void {
    if (this.dimId !== 'overworld' || this.sculkWardenSpawned.has(this.dimId)) return;
    if (this.dim.getId(Math.floor(this.player.x), Math.floor(this.player.y) - 1, Math.floor(this.player.z)) !== BLOCK.SCULK) return;
    this.sculkWardenSpawned.add(this.dimId);
    this.spawnNpc('minecraft:warden', this.dimId, this.player.x + 10, this.player.z + 10);
  }

  // ---------------------------------------------------------------- networking

  /** Snapshot of NPCs in the current dimension, broadcast by the host. */
  mobSnapshot(): MobSnapshot[] {
    const out: MobSnapshot[] = [];
    for (const [id, npc] of this.npcs) {
      if (npc.dim !== this.dimId) continue;
      out.push({ id, type: npc.mob.spec.identifier, x: npc.mob.body.x, y: npc.mob.body.y, z: npc.mob.body.z, yaw: npc.mob.body.yaw, hp: npc.mob.health });
    }
    return out;
  }

  /** Mob views for rendering (both host and clients use this). */
  npcViews(): NpcView[] {
    const views: NpcView[] = [];
    for (const [id, npc] of this.npcs) {
      views.push({ id, type: npc.mob.spec.identifier, dim: npc.dim, x: npc.mob.body.x, y: npc.mob.body.y, z: npc.mob.body.z, yaw: npc.mob.body.yaw, hp: npc.mob.health, profession: npc.villager?.profession });
    }
    return views;
  }

  /** Handles a game message that arrived from another player. */
  handleNetMessage(from: string, fromName: string, fromRole: Role, msg: GameMessage): void {
    switch (msg.t) {
      case 'pos': {
        const r = this.remote.get(from) ?? { id: from, name: fromName, role: fromRole, dim: 'overworld' as DimensionId, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, seenAt: 0 };
        Object.assign(r, { dim: msg.dim as DimensionId, x: msg.x, y: msg.y, z: msg.z, yaw: msg.yaw, pitch: msg.pitch, seenAt: this.time, name: fromName, role: fromRole });
        this.remote.set(from, r);
        break;
      }
      case 'chat':
        this.pushChat(msg.name, msg.text);
        break;
      case 'blockUpdate':
        this.applyRemoteBlock(msg.dim as DimensionId, msg.x, msg.y, msg.z, msg.id, msg.state);
        break;
      case 'worldSync':
        for (const e of msg.edits) this.applyRemoteBlock(e.dim as DimensionId, e.x, e.y, e.z, e.id, e.state);
        break;
      case 'mobs':
        this.applyMobSnapshot(msg.dim as DimensionId, msg.list);
        break;
      case 'players':
        this.applyPlayerList(msg.list);
        break;
      case 'hurt':
        if (msg.target === this.localId) this.damagePlayer(msg.amount);
        break;
      default:
        break;
    }
  }

  private mobViews = new Map<string, NpcView>();
  /** Messages the networking layer should deliver to specific players (e.g. damage from mobs). */
  readonly outbox: GameMessage[] = [];
  /** This player's id in the session ('local' in single player). */
  localId = 'local';

  /** Clients mirror host NPCs using snapshots. */
  private applyMobSnapshot(dim: DimensionId, list: MobSnapshot[]): void {
    const seen = new Set<string>();
    for (const m of list) {
      seen.add(m.id);
      this.mobViews.set(m.id, { id: m.id, type: m.type, dim, x: m.x, y: m.y, z: m.z, yaw: m.yaw, hp: m.hp });
    }
    for (const [id, v] of this.mobViews) {
      if (v.dim === dim && !seen.has(id)) this.mobViews.delete(id);
    }
  }

  /** Mob views for a client (snapshots) or host (simulated). */
  get renderNpcs(): NpcView[] {
    if (this.mode === 'client') return [...this.mobViews.values()].filter((v) => v.dim === this.dimId);
    return this.npcViews();
  }

  pushChat(name: string, text: string): void {
    this.chat.push({ name, text, at: this.time });
    if (this.chat.length > 100) this.chat.shift();
  }

  /** Replaces the remote-player table with the host's authoritative list (clients only). */
  private applyPlayerList(list: PlayerSnapshot[]): void {
    const seen = new Set<string>();
    for (const p of list) {
      if (p.id === this.localId) continue;
      seen.add(p.id);
      this.remote.set(p.id, { id: p.id, name: p.name, role: p.role as Role, dim: p.dim as DimensionId, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, seenAt: this.time });
    }
    for (const id of [...this.remote.keys()]) if (!seen.has(id)) this.remote.delete(id);
  }

  /** Removes remote players that stopped sending position updates. */
  pruneRemote(maxAge = 10): void {
    for (const [id, r] of this.remote) if (this.time - r.seenAt > maxAge) this.remote.delete(id);
  }

  /** Canonical description of the current state for debugging and tests. */
  describe(): Record<string, unknown> {
    return {
      dim: this.dimId,
      pos: [this.player.x, this.player.y, this.player.z].map((v) => Math.round(v * 100) / 100),
      health: this.survival.health,
      hunger: this.survival.hunger,
      npcs: this.npcs.size,
      remote: this.remote.size,
    };
  }
}

function intersectsCell(box: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }, x: number, y: number, z: number): boolean {
  return box.minX < x + 1 && box.maxX > x && box.minY < y + 1 && box.maxY > y && box.minZ < z + 1 && box.maxZ > z;
}

/** Seconds to break a block with the held item (Infinity = unbreakable). */
export function breakTime(def: BlockDef, heldId?: string): number {
  if (def.hardness < 0) return Infinity;
  let speed = 1;
  if (heldId && def.tool && def.tool !== 'none') {
    if (heldId.endsWith(`_${def.tool}`) || (def.tool === 'pickaxe' && heldId.endsWith('_pickaxe'))) {
      speed = heldId.includes('iron') ? 6 : heldId.includes('stone') ? 4 : 2;
    }
  }
  return Math.max(0.05, (def.hardness * 1.5) / speed);
}

/** Item dropped when a block breaks (null for nothing). */
export function dropFor(def: BlockDef): string | null {
  if (def.dropItem === null) return null;
  if (def.dropItem !== undefined) return def.dropItem;
  if (def.id === BLOCK.REDSTONE_DUST) return 'minecraft:redstone';
  if (def.id === BLOCK.OAK_LEAVES) return null;
  if (def.id === BLOCK.OAK_DOOR) return 'minecraft:oak_door';
  return def.drop ?? def.name;
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

