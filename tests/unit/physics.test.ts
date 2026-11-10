import { describe, expect, it } from 'vitest';
import { moveBox, boxFromFeet, collidesWithWorld } from '../../shared/physics/aabb.js';
import { PLAYER, createPlayer, stepPlayer, type MoveInput, type PhysicsWorld } from '../../shared/physics/player.js';

/** World with a flat floor at y < 10 (solid) and optional extra solids/water. */
function world(extra: (x: number, y: number, z: number) => boolean = () => false, water: (x: number, y: number, z: number) => boolean = () => false): PhysicsWorld {
  return {
    isSolid: (x, y, z) => y < 10 || extra(x, y, z),
    isWater: (x, y, z) => water(x, y, z),
  };
}

const idle: MoveInput = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, glide: false, hasElytra: false };
const run = (over: Partial<MoveInput> = {}): MoveInput => ({ ...idle, forward: 1, ...over });

function simulate(state: ReturnType<typeof createPlayer>, input: MoveInput, seconds: number, w: PhysicsWorld, dt = 1 / 60) {
  let damage = 0;
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) damage += stepPlayer(state, input, dt, w).fallDamage;
  return damage;
}

describe('AABB sweep', () => {
  it('stops a falling box on the floor', () => {
    const box = boxFromFeet(0.5, 12, 0.5, 0.6, 1.8);
    const r = moveBox(box, 0, -5, 0, (x, y, z) => y < 10 && x === 0 && z === 0 || y < 10);
    expect(r.collidedY).toBe(true);
    expect(r.box.minY).toBeCloseTo(10, 5);
  });

  it('does not let a box slide through a single-block wall', () => {
    const box = boxFromFeet(0.5, 11, 0.5, 0.6, 1.8);
    const solid = (x: number, y: number, z: number) => x === 2 && y >= 10 && y < 13 && z === 0;
    const r = moveBox(box, 5, 0, 0, solid);
    expect(r.collidedX).toBe(true);
    expect(r.box.maxX).toBeLessThanOrEqual(2 + 1e-6);
  });

  it('allows movement that stays clear of blocks', () => {
    const box = boxFromFeet(0.5, 11, 0.5, 0.6, 1.8);
    const r = moveBox(box, 1.25, 0, 0, () => false);
    expect(r.collidedX).toBe(false);
    expect(r.box.minX).toBeCloseTo(1.25 + 0.2, 6);
  });

  it('detects overlap with the world', () => {
    expect(collidesWithWorld(boxFromFeet(0.5, 9.5, 0.5, 0.6, 1.8), (x, y) => y < 10 && x === 0)).toBe(true);
    expect(collidesWithWorld(boxFromFeet(3.5, 12, 0.5, 0.6, 1.8), (x, y) => y < 10 && x === 0)).toBe(false);
  });
});

describe('player controller', () => {
  it('stands still on the ground without drifting', () => {
    const s = createPlayer(0.5, 10, 0.5);
    simulate(s, idle, 1, world());
    expect(s.onGround).toBe(true);
    expect(s.y).toBeCloseTo(10, 4);
    expect(Math.hypot(s.vx, s.vz)).toBeLessThan(1e-6);
  });

  it('walks at roughly Bedrock walking speed', () => {
    const s = createPlayer(0.5, 10, 0.5);
    s.yaw = Math.PI; // facing +Z
    simulate(s, run(), 2, world());
    const start = 0.5;
    expect(Math.abs(s.z - start)).toBeGreaterThan(PLAYER.walkSpeed * 2 * 0.9);
    expect(Math.abs(s.z - start)).toBeLessThan(PLAYER.walkSpeed * 2 * 1.05);
  });

  it('sprints faster than it walks', () => {
    const walk = createPlayer(0.5, 10, 0.5);
    const sprint = createPlayer(0.5, 10, 0.5);
    walk.yaw = sprint.yaw = Math.PI;
    simulate(walk, run(), 2, world());
    simulate(sprint, run({ sprint: true }), 2, world());
    expect(sprint.z).toBeGreaterThan(walk.z);
  });

  it('jumps to roughly the Bedrock jump height (about 1.25 blocks)', () => {
    const s = createPlayer(0.5, 10, 0.5);
    let peak = s.y;
    const dt = 1 / 60;
    simulate(s, idle, 0.2, world()); // settle onto the ground first
    expect(s.onGround).toBe(true);
    stepPlayer(s, run({ jump: true, forward: 0 }), dt, world());
    for (let i = 0; i < 60; i++) {
      stepPlayer(s, idle, dt, world());
      peak = Math.max(peak, s.y);
    }
    expect(peak - 10).toBeGreaterThan(1.1);
    expect(peak - 10).toBeLessThan(1.4);
  });

  it('cannot jump while airborne', () => {
    const s = createPlayer(0.5, 15, 0.5);
    stepPlayer(s, run({ jump: true, forward: 0 }), 1 / 60, world());
    expect(s.vy).toBeLessThanOrEqual(0);
  });

  it('takes fall damage beyond the safe distance', () => {
    const s = createPlayer(0.5, 25, 0.5);
    const damage = simulate(s, idle, 3, world());
    // Falling from y=25 to y=10 is 15 blocks: ceil(15 - 3) = 12 damage.
    expect(damage).toBe(12);
    expect(s.y).toBeCloseTo(10, 3);
  });

  it('takes no damage from a short fall', () => {
    const s = createPlayer(0.5, 12.5, 0.5);
    expect(simulate(s, idle, 1, world())).toBe(0);
  });

  it('swims slowly in water and rises when jumping', () => {
    const w = world(() => false, (_x, y) => y >= 10 && y < 14);
    const s = createPlayer(0.5, 10.2, 0.5);
    s.yaw = Math.PI;
    simulate(s, run(), 0.5, w);
    expect(s.inWater).toBe(true);
    expect(Math.abs(s.vz)).toBeLessThanOrEqual(PLAYER.swimSpeed + 0.2);
    const before = s.y;
    simulate(s, { ...idle, jump: true }, 0.5, w);
    expect(s.y).toBeGreaterThan(before);
  });

  it('sprint-swims faster than normal swimming', () => {
    const w = world(() => false, (_x, y) => y >= 10 && y < 14);
    const a = createPlayer(0.5, 10.2, 0.5);
    const b = createPlayer(0.5, 10.2, 0.5);
    a.yaw = b.yaw = Math.PI;
    simulate(a, run(), 1, w);
    simulate(b, run({ sprint: true }), 1, w);
    expect(b.swimming).toBe(true);
    expect(Math.abs(b.z)).toBeGreaterThan(Math.abs(a.z));
  });

  it('crawls through a 1-block tunnel while sneaking', () => {
    // Ceiling at y=11 means only 1 block of headroom above the floor at y=10: standing (1.8) is blocked.
    const ceiling = (_x: number, y: number) => y === 11;
    const w = world(ceiling);
    const s = createPlayer(0.5, 10, 0.5);
    simulate(s, { ...idle, sneak: true }, 0.2, w);
    expect(s.crawling).toBe(true);
    expect(s.height).toBeCloseTo(PLAYER.crawlHeight, 6);
  });

  it('stands up again when there is room', () => {
    const s = createPlayer(0.5, 10, 0.5);
    s.height = PLAYER.crawlHeight;
    simulate(s, idle, 0.1, world());
    expect(s.height).toBe(PLAYER.height);
    expect(s.crawling).toBe(false);
  });

  it('elytra glide falls slower than free fall and keeps forward speed', () => {
    const free = createPlayer(0.5, 80, 0.5);
    const glide = createPlayer(0.5, 80, 0.5);
    free.vy = glide.vy = -10;
    free.pitch = glide.pitch = 0.2; // looking slightly down
    glide.yaw = 0;
    const gi = { ...idle, glide: true, hasElytra: true, forward: 0 };
    stepPlayer(glide, gi, 1 / 60, world());
    expect(glide.gliding).toBe(true);
    simulate(free, idle, 1, world());
    simulate(glide, gi, 1, world());
    expect(glide.y).toBeGreaterThan(free.y);
    expect(Math.hypot(glide.vx, glide.vz)).toBeGreaterThan(3);
  });

  it('glide ends when the player lands', () => {
    const s = createPlayer(0.5, 12, 0.5);
    s.gliding = true;
    s.vy = -5;
    simulate(s, { ...idle, glide: true, hasElytra: true }, 3, world());
    expect(s.gliding).toBe(false);
    expect(s.onGround).toBe(true);
  });

  it('wall collision stops horizontal velocity', () => {
    const w = world((x, y) => x === 2 && y >= 10 && y < 12);
    const s = createPlayer(0.5, 10, 0.5);
    s.yaw = -Math.PI / 2; // facing +X
    simulate(s, run(), 2, w);
    expect(s.x + PLAYER.width / 2).toBeLessThanOrEqual(2 + 1e-6);
  });
});
