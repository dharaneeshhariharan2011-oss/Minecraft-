/**
 * Warden sensing model (Deep Dark). The Warden is blind and tracks players by
 * vibrations and by proximity. Sneaking halves the distance at which it can notice a player.
 */

export const WARDEN_NOTICE_RANGE = 16;
export const WARDEN_SNEAK_NOTICE_RANGE = 8;
export const WARDEN_SUSPICIOUS = 40;
export const WARDEN_ANGRY = 80;
export const WARDEN_MAX_ANGER = 150;
export const SONIC_BOOM_RANGE = 15;
export const SONIC_BOOM_COOLDOWN = 3;
export const SONIC_BOOM_DAMAGE = 10;
export const ANGER_DECAY_PER_SECOND = 5;

export type WardenMood = 'idle' | 'suspicious' | 'angry';

export interface WardenEvent {
  type: 'sonic_boom';
  targetId: string;
  damage: number;
}

export class Warden {
  anger = 0;
  target: string | null = null;
  private boomCooldown = 0;

  get mood(): WardenMood {
    if (this.anger >= WARDEN_ANGRY) return 'angry';
    if (this.anger >= WARDEN_SUSPICIOUS) return 'suspicious';
    return 'idle';
  }

  /** Detection range for a player depending on their pose. */
  static detectionRange(sneaking: boolean): number {
    return sneaking ? WARDEN_SNEAK_NOTICE_RANGE : WARDEN_NOTICE_RANGE;
  }

  /** A vibration (block break, placement, stepping) raises anger when close enough. */
  onVibration(distance: number, strength: number, targetId: string | null): void {
    if (distance > 16 + strength) return;
    this.anger = Math.min(WARDEN_MAX_ANGER, this.anger + strength * (1 - distance / (16 + strength)));
    if (targetId && this.anger >= WARDEN_SUSPICIOUS) this.target = targetId;
  }

  /** Called every frame for each player the Warden can see or hear. */
  onPlayerNearby(playerId: string, distance: number, sneaking: boolean, dt: number): void {
    if (distance > Warden.detectionRange(sneaking)) return;
    this.anger = Math.min(WARDEN_MAX_ANGER, this.anger + 12 * dt);
    if (this.anger >= WARDEN_SUSPICIOUS) this.target = playerId;
  }

  /** Time-based calm-down. Returns true when the Warden lost interest in its target. */
  tick(dt: number, targetDistance: number | null): WardenEvent | null {
    this.boomCooldown = Math.max(0, this.boomCooldown - dt);
    this.anger = Math.max(0, this.anger - ANGER_DECAY_PER_SECOND * dt);
    if (this.mood !== 'angry') this.target = this.anger >= WARDEN_SUSPICIOUS ? this.target : null;
    if (this.mood === 'angry' && this.target && targetDistance !== null && targetDistance <= SONIC_BOOM_RANGE && this.boomCooldown <= 0) {
      this.boomCooldown = SONIC_BOOM_COOLDOWN;
      return { type: 'sonic_boom', targetId: this.target, damage: SONIC_BOOM_DAMAGE };
    }
    return null;
  }
}
