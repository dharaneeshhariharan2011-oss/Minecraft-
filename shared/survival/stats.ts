/** Survival stats: health, hunger, saturation and damage. Mirrors the Bedrock formulas. */

export const MAX_HEALTH = 20;
export const MAX_HUNGER = 20;
export const HEAL_INTERVAL_TICKS = 80;
export const STARVE_INTERVAL_TICKS = 80;

export type Difficulty = 'peaceful' | 'easy' | 'normal' | 'hard';

export interface Survival {
  health: number;
  hunger: number;
  saturation: number;
  /** Accumulates exhaustion from actions; each 4.0 exhaustion costs one saturation or hunger point. */
  exhaustion: number;
  /** Ticks since last natural heal or starvation tick. */
  timer: number;
  dead: boolean;
}

export function createSurvival(): Survival {
  return { health: MAX_HEALTH, hunger: MAX_HUNGER, saturation: 5, exhaustion: 0, timer: 0, dead: false };
}

/**
 * Damage reduction from armour points. Bedrock: reduction = min(20, max(points/5, points - damage/2)) / 25.
 * Returns the damage after reduction, rounded to the nearest 0.1 and never negative.
 */
export function reduceDamage(damage: number, armorPoints: number): number {
  if (damage <= 0) return 0;
  const effective = Math.min(20, Math.max(armorPoints / 5, armorPoints - damage / 2));
  const reduced = damage * (1 - effective / 25);
  return Math.max(0, Math.round(reduced * 10) / 10);
}

export interface DamageResult {
  applied: number;
  armorDamaged: boolean;
  died: boolean;
}

/** Applies damage. Peaceful difficulty ignores hostile damage; hard keeps all damage. */
export function applyDamage(
  s: Survival,
  rawDamage: number,
  armorPoints: number,
  difficulty: Difficulty = 'normal',
  fall = false,
): DamageResult {
  if (s.dead || rawDamage <= 0) return { applied: 0, armorDamaged: false, died: false };
  if (difficulty === 'peaceful' && !fall) return { applied: 0, armorDamaged: false, died: false };
  const applied = fall ? rawDamage : reduceDamage(rawDamage, armorPoints);
  s.health = Math.max(0, s.health - applied);
  if (s.health <= 0) s.dead = true;
  return { applied, armorDamaged: applied > 0, died: s.dead };
}

/** Adds exhaustion (e.g. 0.1 per block walked, 0.005 per block sprinted). */
export function addExhaustion(s: Survival, amount: number): void {
  s.exhaustion += amount;
  while (s.exhaustion >= 4) {
    s.exhaustion -= 4;
    if (s.saturation > 0) s.saturation = Math.max(0, s.saturation - 1);
    else s.hunger = Math.max(0, s.hunger - 1);
  }
}

/** Eats a food item: restores hunger and saturation (saturation capped at hunger). */
export function eat(s: Survival, nutrition: number, saturationRatio = 0.6): void {
  s.hunger = Math.min(MAX_HUNGER, s.hunger + nutrition);
  s.saturation = Math.min(s.hunger, s.saturation + nutrition * saturationRatio * 2);
}

/** Advances timers by one game tick: natural regeneration when fed, starvation when hungry. */
export function tickSurvival(s: Survival, difficulty: Difficulty = 'normal'): { healed: number; starved: number } {
  if (s.dead) return { healed: 0, starved: 0 };
  s.timer++;
  let healed = 0;
  let starved = 0;
  if (s.hunger >= 18 && s.health < MAX_HEALTH && s.timer >= HEAL_INTERVAL_TICKS) {
    s.timer = 0;
    s.health = Math.min(MAX_HEALTH, s.health + 1);
    healed = 1;
  } else if (s.hunger === 0 && s.timer >= STARVE_INTERVAL_TICKS) {
    s.timer = 0;
    // Starvation cannot kill on easy or normal difficulty.
    const floor = difficulty === 'hard' ? 0 : 1;
    if (s.health > floor) {
      s.health = Math.max(floor, s.health - 1);
      starved = 1;
      if (s.health <= 0) s.dead = true;
    }
  }
  return { healed, starved };
}

export function respawn(s: Survival): void {
  s.health = MAX_HEALTH;
  s.hunger = MAX_HUNGER;
  s.saturation = 5;
  s.exhaustion = 0;
  s.timer = 0;
  s.dead = false;
}
