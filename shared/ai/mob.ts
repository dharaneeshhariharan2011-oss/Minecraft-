import type { EntitySpec, EntityBehavior } from '../packs/schema.js';
import { findPath, type GridPos, type PathWorld } from './pathfinding.js';
import { createPlayer, eyePosition, stepPlayer, type PhysicsWorld, type PlayerState } from '../physics/player.js';

export interface MobTarget {
  id: string;
  x: number;
  y: number;
  z: number;
}

export interface MobWorld extends PathWorld, PhysicsWorld {}

export interface MobContext {
  world: MobWorld;
  /** Players the mob may notice or attack. */
  players: MobTarget[];
  /** Other mobs of the same species nearby (for breeding). */
  mates: Array<{ id: string; x: number; y: number; z: number; inLove: boolean }>;
  random: () => number;
  /** Current game time in seconds. */
  now: number;
}

export type MobEvent =
  | { type: 'attack'; mobId: string; targetId: string; damage: number }
  | { type: 'breed'; mobId: string; mateId: string }
  | { type: 'death'; mobId: string };

export const MOB_ATTACK_RANGE = 1.6;
export const MOB_ATTACK_COOLDOWN = 1;
export const MOB_NOTICE_RANGE = 16;
export const BREED_TICKS = 5;

interface Goal {
  kind: EntityBehavior['kind'];
  priority: number;
  speed: number;
  canUse(mob: MobInstance, ctx: MobContext): boolean;
  start(mob: MobInstance, ctx: MobContext): void;
  tick(mob: MobInstance, ctx: MobContext, dt: number, events: MobEvent[]): boolean;
}

/** One live mob. Behaviours are chosen from the entity definition's components. */
export class MobInstance {
  readonly body: PlayerState;
  health: number;
  path: GridPos[] = [];
  target: GridPos | null = null;
  active: Goal | null = null;
  attackCooldown = 0;
  wanderCooldown = 0;
  breedProgress = 0;
  inLove = false;
  lastHurtBy: string | null = null;
  lastHurtAt = -Infinity;
  dead = false;
  private readonly goals: Goal[];

  constructor(
    readonly id: string,
    readonly spec: EntitySpec,
    x: number,
    y: number,
    z: number,
  ) {
    this.body = createPlayer(x, y, z);
    this.health = spec.health;
    this.goals = spec.behaviors.map((b) => makeGoal(b));
  }

  /** Records damage taken, so flee goals can react. */
  hurt(amount: number, byId: string | null, now: number): void {
    if (this.dead) return;
    this.health = Math.max(0, this.health - amount);
    this.lastHurtBy = byId;
    this.lastHurtAt = now;
    if (this.health <= 0) this.dead = true;
  }

  /** Advances the mob one step, returning any events it produced. */
  tick(dt: number, ctx: MobContext): MobEvent[] {
    const events: MobEvent[] = [];
    if (this.dead) return events;
    this.attackCooldown = Math.max(0, this.attackCooldown - dt);
    this.wanderCooldown = Math.max(0, this.wanderCooldown - dt);
    if (this.lastHurtBy !== null && ctx.now - this.lastHurtAt > 3) this.lastHurtBy = null;

    // Pick the highest-priority (lowest number) goal that can run, unless the current one is still running.
    if (this.active) {
      const keepGoing = this.active.tick(this, ctx, dt, events);
      if (!keepGoing) this.active = null;
    }
    if (!this.active) {
      for (const g of this.goals) {
        if (g.canUse(this, ctx)) {
          this.active = g;
          g.start(this, ctx);
          g.tick(this, ctx, dt, events);
          break;
        }
      }
    }
    if (!this.active) this.path = [];
    return events;
  }

  /** Walks along `path` using the shared player physics. Returns true when the path is finished. */
  followPath(dt: number, ctx: MobContext, speed: number): boolean {
    const b = this.body;
    if (this.path.length === 0) {
      this.moveInput(0, 0, false, dt, ctx);
      return true;
    }
    const next = this.path[0]!;
    const tx = next.x + 0.5;
    const tz = next.z + 0.5;
    const dx = tx - b.x;
    const dz = tz - b.z;
    if (Math.hypot(dx, dz) < 0.25 && Math.abs(next.y - b.y) < 1.1) {
      this.path.shift();
      if (this.path.length === 0) {
        this.moveInput(0, 0, false, dt, ctx);
        return true;
      }
      return false;
    }
    b.yaw = Math.atan2(-dx, -dz);
    const jump = next.y > b.y + 0.1 && b.onGround;
    this.moveInput(speed, 0, jump, dt, ctx);
    return false;
  }

  moveInput(forward: number, strafe: number, jump: boolean, dt: number, ctx: MobContext): void {
    stepPlayer(this.body, { forward, strafe, jump, sneak: false, sprint: false, glide: false, hasElytra: false }, dt, ctx.world);
  }

  /** Speed as a fraction of player walking speed, from the entity's movement value and goal multiplier. */
  speedFraction(multiplier: number): number {
    return Math.min(1, (this.spec.movementSpeed / 0.25) * multiplier * 0.35);
  }

  headPosition(): { x: number; y: number; z: number } {
    return eyePosition(this.body);
  }
}

function makeGoal(b: EntityBehavior): Goal {
  switch (b.kind) {
    case 'wander':
      return wanderGoal(b.priority, b.speedMultiplier);
    case 'flee':
      return fleeGoal(b.priority, b.speedMultiplier);
    case 'attack':
      return attackGoal(b.priority, b.speedMultiplier, b.damage);
    case 'breed':
      return breedGoal(b.priority);
  }
}

/** Finds a standable cell near (x,z) within `radius` of the mob, or null. */
function randomWalkable(mob: MobInstance, ctx: MobContext, radius: number, away?: { x: number; z: number }): GridPos | null {
  for (let attempt = 0; attempt < 12; attempt++) {
    let dx = Math.floor((ctx.random() * 2 - 1) * radius);
    let dz = Math.floor((ctx.random() * 2 - 1) * radius);
    if (away) {
      const ax = Math.sign(mob.body.x - away.x) || 1;
      const az = Math.sign(mob.body.z - away.z) || 1;
      dx = Math.abs(dx) * ax;
      dz = Math.abs(dz) * az;
    }
    const x = Math.floor(mob.body.x) + dx;
    const z = Math.floor(mob.body.z) + dz;
    for (let y = Math.floor(mob.body.y) + 2; y >= Math.floor(mob.body.y) - 3; y--) {
      if (ctx.world.solid(x, y - 1, z) && ctx.world.passable(x, y, z) && ctx.world.passable(x, y + 1, z)) {
        return { x, y, z };
      }
    }
  }
  return null;
}

function wanderGoal(priority: number, speed: number): Goal {
  return {
    kind: 'wander',
    priority,
    speed,
    canUse(mob, ctx) {
      return mob.wanderCooldown <= 0 && mob.lastHurtBy === null && ctx.random() < 0.02;
    },
    start(mob, ctx) {
      mob.path = [];
      const goal = randomWalkable(mob, ctx, 8);
      if (goal) {
        mob.target = goal;
        mob.path = findPath(ctx.world, cellOf(mob), goal, { maxRange: 12 }) ?? [];
      }
      mob.wanderCooldown = 2 + ctx.random() * 3;
    },
    tick(mob, ctx, dt) {
      if (mob.path.length === 0) return false;
      const done = mob.followPath(dt, ctx, mob.speedFraction(speed));
      return !done;
    },
  };
}

function fleeGoal(priority: number, speed: number): Goal {
  return {
    kind: 'flee',
    priority,
    speed,
    canUse(mob, ctx) {
      // Passive mobs run away from whoever hurt them, for a few seconds after the hit.
      return mob.lastHurtBy !== null && ctx.now - mob.lastHurtAt <= 3;
    },
    start(mob, ctx) {
      const threat = ctx.players.find((p) => p.id === mob.lastHurtBy) ?? ctx.players[0];
      const goal = randomWalkable(mob, ctx, 10, threat ? { x: threat.x, z: threat.z } : undefined);
      mob.path = goal ? findPath(ctx.world, cellOf(mob), goal, { maxRange: 16 }) ?? [] : [];
    },
    tick(mob, ctx, dt) {
      if (mob.path.length === 0) return false;
      return !mob.followPath(dt, ctx, mob.speedFraction(speed));
    },
  };
}

function attackGoal(priority: number, speed: number, damage: number): Goal {
  let repathTimer = 0;
  return {
    kind: 'attack',
    priority,
    speed,
    canUse(mob, ctx) {
      return ctx.players.some((p) => Math.hypot(p.x - mob.body.x, p.z - mob.body.z) <= MOB_NOTICE_RANGE);
    },
    start() {
      repathTimer = 0;
    },
    tick(mob, ctx, dt, events) {
      const target = nearestPlayer(mob, ctx);
      if (!target) return false;
      const dist = Math.hypot(target.x - mob.body.x, target.z - mob.body.z);
      if (dist <= MOB_ATTACK_RANGE && Math.abs(target.y - mob.body.y) < 2) {
        if (mob.attackCooldown <= 0) {
          mob.attackCooldown = MOB_ATTACK_COOLDOWN;
          events.push({ type: 'attack', mobId: mob.id, targetId: target.id, damage });
        }
        mob.path = [];
        mob.moveInput(0, 0, false, dt, ctx);
        return true;
      }
      repathTimer -= dt;
      if (repathTimer <= 0 || mob.path.length === 0) {
        repathTimer = 0.5;
        const goal = { x: Math.floor(target.x), y: Math.floor(target.y), z: Math.floor(target.z) };
        mob.path = findPath(ctx.world, cellOf(mob), goal, { maxRange: 24 }) ?? [];
      }
      if (mob.path.length === 0) {
        // No route: stand still rather than walking into walls.
        mob.moveInput(0, 0, false, dt, ctx);
        return true;
      }
      mob.followPath(dt, ctx, mob.speedFraction(speed));
      return true;
    },
  };
}

function breedGoal(priority: number): Goal {
  return {
    kind: 'breed',
    priority,
    speed: 1,
    canUse(mob, ctx) {
      return mob.inLove && ctx.mates.some((m) => m.inLove && Math.hypot(m.x - mob.body.x, m.z - mob.body.z) < 8);
    },
    start(mob) {
      mob.breedProgress = 0;
    },
    tick(mob, ctx, dt, events) {
      mob.breedProgress += dt;
      const mate = ctx.mates.find((m) => m.inLove && Math.hypot(m.x - mob.body.x, m.z - mob.body.z) < 8);
      if (!mate) return false;
      if (mob.breedProgress >= BREED_TICKS) {
        mob.inLove = false;
        mob.breedProgress = 0;
        events.push({ type: 'breed', mobId: mob.id, mateId: mate.id });
        return false;
      }
      mob.moveInput(0, 0, false, dt, ctx);
      return true;
    },
  };
}

function nearestPlayer(mob: MobInstance, ctx: MobContext): MobTarget | null {
  let best: MobTarget | null = null;
  let bestDist = MOB_NOTICE_RANGE;
  for (const p of ctx.players) {
    const d = Math.hypot(p.x - mob.body.x, p.z - mob.body.z);
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return best;
}

function cellOf(mob: MobInstance): GridPos {
  return { x: Math.floor(mob.body.x), y: Math.floor(mob.body.y + 0.01), z: Math.floor(mob.body.z) };
}
