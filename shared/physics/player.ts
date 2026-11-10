import { AABB, boxFromFeet, moveBox, collidesWithWorld, type SolidTest } from './aabb.js';

/**
 * Bedrock-style player dimensions (blocks) and movement constants (blocks/second).
 * Values follow the Bedrock Edition player (0.6 wide, 1.8 tall, eyes at 1.62).
 */
export const PLAYER = {
  width: 0.6,
  height: 1.8,
  sneakHeight: 1.5,
  crawlHeight: 0.6,
  eyeHeight: 1.62,
  walkSpeed: 4.317,
  sprintSpeed: 5.612,
  sneakSpeed: 1.31,
  swimSpeed: 2.2,
  swimSprintSpeed: 3.9,
  crawlSpeed: 1.0,
  gravity: 32,
  jumpVelocity: 8.4,
  terminalVelocity: 78.4,
  waterGravity: 4,
  waterDrag: 0.8,
  swimUpAccel: 14,
  glideGravity: 4,
  glideMaxSpeed: 40,
  airAccel: 6,
  groundAccel: 40,
  waterAccel: 8,
  safeFallDistance: 3,
} as const;

export interface PlayerState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Yaw in radians: 0 faces -Z (north). */
  yaw: number;
  /** Pitch in radians: positive looks down. */
  pitch: number;
  onGround: boolean;
  inWater: boolean;
  swimming: boolean;
  crawling: boolean;
  sneaking: boolean;
  gliding: boolean;
  fallDistance: number;
  /** Current collision box height (changes when sneaking or crawling). */
  height: number;
}

export interface MoveInput {
  /** -1..1, positive walks forward. */
  forward: number;
  /** -1..1, positive strafes right. */
  strafe: number;
  jump: boolean;
  sneak: boolean;
  sprint: boolean;
  /** Set to true while the player holds the glide key with an elytra equipped. */
  glide: boolean;
  hasElytra: boolean;
}

export interface PhysicsWorld {
  isSolid: SolidTest;
  /** True for water or waterlogged blocks. */
  isWater: (x: number, y: number, z: number) => boolean;
}

export interface StepResult {
  /** Damage to apply from a fall that just ended. 0 when none. */
  fallDamage: number;
  landed: boolean;
}

export function createPlayer(x: number, y: number, z: number): PlayerState {
  return {
    x,
    y,
    z,
    vx: 0,
    vy: 0,
    vz: 0,
    yaw: 0,
    pitch: 0,
    onGround: false,
    inWater: false,
    swimming: false,
    crawling: false,
    sneaking: false,
    gliding: false,
    fallDistance: 0,
    height: PLAYER.height,
  };
}

export function playerBox(state: PlayerState, height = state.height): AABB {
  return boxFromFeet(state.x, state.y, state.z, PLAYER.width, height);
}

/** Eye position in world space (used for raycasting). */
export function eyePosition(state: PlayerState): { x: number; y: number; z: number } {
  const eye = state.crawling ? 0.4 : state.sneaking ? 1.27 : PLAYER.eyeHeight;
  return { x: state.x, y: state.y + eye, z: state.z };
}

/** Unit vector the player is looking along. */
export function lookVector(yaw: number, pitch: number): { x: number; y: number; z: number } {
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp, y: -Math.sin(pitch), z: -Math.cos(yaw) * cp };
}

/** Whether the player's head is blocked at standing height (used to decide crawling). */
function headroomBlocked(state: PlayerState, world: PhysicsWorld, height: number): boolean {
  const box = boxFromFeet(state.x, state.y, state.z, PLAYER.width, height);
  return collidesWithWorld(box, world.isSolid);
}

/**
 * Advances the player by `dt` seconds. Large steps are split into substeps of at most 1/30 s
 * so that fast falls cannot tunnel through single blocks.
 */
export function stepPlayer(state: PlayerState, input: MoveInput, dt: number, world: PhysicsWorld): StepResult {
  const total = Math.min(Math.max(dt, 0), 0.25);
  const steps = Math.max(1, Math.ceil(total / (1 / 30)));
  const h = total / steps;
  let result: StepResult = { fallDamage: 0, landed: false };
  for (let i = 0; i < steps; i++) {
    const r = substep(state, input, h, world);
    if (r.fallDamage > 0) result = { fallDamage: result.fallDamage + r.fallDamage, landed: true };
    else if (r.landed) result = { ...result, landed: true };
  }
  return result;
}

function substep(s: PlayerState, input: MoveInput, dt: number, world: PhysicsWorld): StepResult {
  // Pose: sneaking lowers the box; crawling is used when sneaking is held in a space that is too low to stand.
  const feetBlock = world.isWater(Math.floor(s.x), Math.floor(s.y + 0.1), Math.floor(s.z));
  const bodyBlock = world.isWater(Math.floor(s.x), Math.floor(s.y + 0.9), Math.floor(s.z));
  s.inWater = feetBlock || bodyBlock;
  s.sneaking = input.sneak && !s.gliding;

  const standingBlocked = headroomBlocked(s, world, PLAYER.height);
  s.crawling = false;
  if (input.sneak && s.onGround && standingBlocked && headroomBlocked(s, world, PLAYER.sneakHeight)) {
    s.crawling = true;
  }
  if (s.crawling) s.height = PLAYER.crawlHeight;
  else if (s.sneaking) s.height = PLAYER.sneakHeight;
  else s.height = PLAYER.height;
  if (!input.sneak && !s.crawling && headroomBlocked(s, world, PLAYER.height)) {
    // Cannot stand up yet: keep the lowest pose that fits.
    s.height = headroomBlocked(s, world, PLAYER.sneakHeight) ? PLAYER.crawlHeight : PLAYER.sneakHeight;
  }

  // Desired horizontal direction from yaw.
  const sin = Math.sin(s.yaw);
  const cos = Math.cos(s.yaw);
  let wishX = -sin * input.forward + cos * input.strafe;
  let wishZ = -cos * input.forward - sin * input.strafe;
  const wishLen = Math.hypot(wishX, wishZ);
  if (wishLen > 1) {
    wishX /= wishLen;
    wishZ /= wishLen;
  }

  s.swimming = s.inWater && input.sprint && input.forward > 0;

  // Elytra gliding: starts when jumping in the air with an elytra and the glide key held.
  if (s.gliding) {
    if (s.onGround || s.inWater) s.gliding = false;
  } else if (input.hasElytra && input.glide && !s.onGround && !s.inWater && s.vy < 0 && !input.jump) {
    s.gliding = true;
  }

  let speed: number;
  if (s.swimming) speed = PLAYER.swimSprintSpeed;
  else if (s.inWater) speed = PLAYER.swimSpeed;
  else if (s.crawling) speed = PLAYER.crawlSpeed;
  else if (s.sneaking) speed = PLAYER.sneakSpeed;
  else if (input.sprint && input.forward > 0) speed = PLAYER.sprintSpeed;
  else speed = PLAYER.walkSpeed;

  let landed = false;
  let fallDamage = 0;

  if (s.gliding) {
    stepGlide(s, dt);
  } else if (s.inWater) {
    // Water: slow fall, drag, and swim upwards when jumping.
    const accel = PLAYER.waterAccel * dt;
    s.vx += (wishX * speed - s.vx) * Math.min(1, accel);
    s.vz += (wishZ * speed - s.vz) * Math.min(1, accel);
    s.vy -= PLAYER.waterGravity * dt;
    if (input.jump) s.vy += PLAYER.swimUpAccel * dt;
    const drag = Math.pow(PLAYER.waterDrag, dt * 20);
    s.vy *= drag;
  } else {
    const accel = (s.onGround ? PLAYER.groundAccel : PLAYER.airAccel) * dt;
    const k = Math.min(1, accel / Math.max(speed, 0.001));
    s.vx += (wishX * speed - s.vx) * k;
    s.vz += (wishZ * speed - s.vz) * k;
    s.vy = Math.max(-PLAYER.terminalVelocity, s.vy - PLAYER.gravity * dt);
    if (input.jump && s.onGround && !s.sneaking) {
      s.vy = PLAYER.jumpVelocity;
      s.onGround = false;
    }
  }

  // Move with collisions.
  const box = boxFromFeet(s.x, s.y, s.z, PLAYER.width, s.height);
  const move = moveBox(box, s.vx * dt, s.vy * dt, s.vz * dt, world.isSolid);
  s.x = (move.box.minX + move.box.maxX) / 2;
  s.y = move.box.minY;
  s.z = (move.box.minZ + move.box.maxZ) / 2;
  if (move.collidedX) s.vx = 0;
  if (move.collidedZ) s.vz = 0;

  const wasOnGround = s.onGround;
  if (move.collidedY && s.vy < 0) {
    s.onGround = true;
    s.vy = 0;
  } else if (move.collidedY) {
    // Hit a ceiling.
    s.onGround = false;
    s.vy = 0;
  } else {
    s.onGround = false;
  }
  landed = s.onGround && !wasOnGround;

  // Fall distance accumulates while airborne; landing converts it into damage.
  if (s.inWater || s.gliding) {
    s.fallDistance = 0;
  } else if (!s.onGround && s.vy < 0) {
    s.fallDistance += -s.vy * dt;
  } else if (landed) {
    const damage = Math.max(0, Math.ceil(s.fallDistance - PLAYER.safeFallDistance));
    fallDamage = damage;
    s.fallDistance = 0;
  } else if (s.onGround) {
    s.fallDistance = 0;
  }
  return { fallDamage, landed };
}

function stepGlide(s: PlayerState, dt: number): void {
  // Speed along the look direction. Diving (pitch down) converts height into speed.
  const look = lookVector(s.yaw, s.pitch);
  const horizontal = Math.hypot(look.x, look.z) || 1;
  const hx = look.x / horizontal;
  const hz = look.z / horizontal;
  const curHs = Math.hypot(s.vx, s.vz);
  const dive = Math.sin(s.pitch);
  let hs = curHs;
  let vy = s.vy - PLAYER.glideGravity * dt;
  if (dive > 0) {
    hs += dive * 30 * dt;
    vy -= dive * 12 * dt;
  } else {
    // Pulling up trades speed for height.
    const climb = -dive;
    hs = Math.max(0, hs - climb * 22 * dt);
    vy += climb * 22 * dt;
  }
  hs *= Math.pow(0.998, dt * 20);
  hs = Math.min(hs, PLAYER.glideMaxSpeed);
  // Keep a minimum forward speed so gliding never stalls completely.
  hs = Math.max(hs, 4);
  s.vx = hx * hs;
  s.vz = hz * hs;
  s.vy = Math.max(-PLAYER.terminalVelocity, vy);
}
