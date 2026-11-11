import { BLOCK, FACING_VECTORS, STATE, facingOf, defaultRegistry, type BlockRegistry } from '../world/blocks.js';
import type { BlockChange, Dimension } from '../world/dimension.js';

/** Redstone signal strength range: 0 (off) .. 15 (full). */
export const MAX_SIGNAL = 15;
/** Game ticks per second used by the redstone scheduler. Repeater delays are measured in these ticks. */
export const REDSTONE_TPS = 10;
export const BUTTON_PULSE_TICKS = 10;
export const MAX_PISTON_PUSH = 12;
const MAX_COMPONENT = 4096;

type Pos = { x: number; y: number; z: number };

export function posKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

export function parsePosKey(key: string): Pos {
  const [x, y, z] = key.split(',').map(Number) as [number, number, number];
  return { x, y, z };
}

export function neighbours(p: Pos): Pos[] {
  return FACING_VECTORS.map(([dx, , dz]) => ({ x: p.x + dx, y: p.y, z: p.z + dz }))
    .concat([
      { x: p.x, y: p.y + 1, z: p.z },
      { x: p.x, y: p.y - 1, z: p.z },
    ]);
}

interface Scheduled {
  due: number;
  seq: number;
  key: string;
  run: () => void;
}

/**
 * Deterministic redstone simulator. The host runs it once per game tick (10 Hz).
 *
 * - Dust carries a 0..15 level, decreasing by one per block away from a source.
 * - Strong sources: redstone block (15), lever/button when on, redstone torch when lit,
 *   repeater output when enabled.
 * - Redstone torches are inverters: they turn off when the block they stand on is powered.
 * - Repeaters delay their input by 1..4 ticks and restore the signal to 15.
 * - Lamps light up when powered; powered doors open; pistons extend and retract,
 *   sticky pistons pull the block in front back when retracting.
 */
export class RedstoneSystem {
  private readonly dirty = new Set<string>();
  private readonly levels = new Map<string, number>();
  private readonly scheduledKeys = new Map<string, number>();
  private scheduled: Scheduled[] = [];
  private seq = 0;
  tickCount = 0;
  private readonly unsubscribe: () => void;

  constructor(
    readonly dim: Dimension,
    private readonly registry: BlockRegistry = defaultRegistry,
    private readonly onChanged?: (change: BlockChange) => void,
  ) {
    this.unsubscribe = dim.onChange((c) => {
      if (c.dim !== dim.id) return;
      if (c.previousId === BLOCK.REDSTONE_DUST && c.id !== BLOCK.REDSTONE_DUST) this.levels.delete(posKey(c.x, c.y, c.z));
      this.markDirty(c.x, c.y, c.z);
      this.onChanged?.(c);
    });
  }

  dispose(): void {
    this.unsubscribe();
  }

  markDirty(x: number, y: number, z: number): void {
    this.dirty.add(posKey(x, y, z));
    for (const n of neighbours({ x, y, z })) this.dirty.add(posKey(n.x, n.y, n.z));
  }

  /** Current dust level at a position (0 for non-dust). */
  dustLevel(x: number, y: number, z: number): number {
    if (this.dim.getId(x, y, z) !== BLOCK.REDSTONE_DUST) return 0;
    return this.levels.get(posKey(x, y, z)) ?? 0;
  }

  /** Signal a block emits towards a neighbouring position `to`. */
  emitsTo(from: Pos, to: Pos): number {
    const b = this.dim.getBlock(from.x, from.y, from.z);
    switch (b.id) {
      case BLOCK.REDSTONE_DUST:
        return this.levels.get(posKey(from.x, from.y, from.z)) ?? 0;
      case BLOCK.REDSTONE_BLOCK:
        return MAX_SIGNAL;
      case BLOCK.LEVER:
      case BLOCK.STONE_BUTTON:
      case BLOCK.REDSTONE_TORCH:
        return b.state & STATE.ACTIVE ? MAX_SIGNAL : 0;
      case BLOCK.REPEATER: {
        if (!(b.state & STATE.ACTIVE)) return 0;
        const [dx, dy, dz] = FACING_VECTORS[facingOf(b.state)]!;
        return to.x === from.x + dx && to.y === from.y + dy && to.z === from.z + dz ? MAX_SIGNAL : 0;
      }
      default:
        return 0;
    }
  }

  /** Strongest signal reaching block position p from any neighbour. */
  receivedPower(p: Pos): number {
    let best = 0;
    for (const n of neighbours(p)) {
      const v = this.emitsTo(n, p);
      if (v > best) best = v;
    }
    return best;
  }

  /** Power a torch's support block receives, ignoring the torch itself. */
  private supportPower(torch: Pos): number {
    const support = { x: torch.x, y: torch.y - 1, z: torch.z };
    let best = 0;
    for (const n of neighbours(support)) {
      if (n.x === torch.x && n.y === torch.y && n.z === torch.z) continue;
      best = Math.max(best, this.emitsTo(n, support));
    }
    return best;
  }

  private schedule(delay: number, key: string, run: () => void): void {
    if (this.scheduledKeys.has(key)) return;
    const due = this.tickCount + Math.max(1, delay);
    this.scheduledKeys.set(key, due);
    this.scheduled.push({ due, seq: this.seq++, key, run });
  }

  /** Advances the simulator by one game tick. */
  tick(): void {
    this.tickCount++;
    this.runScheduled();
    if (this.dirty.size === 0) return;
    const batch = [...this.dirty].map(parsePosKey);
    this.dirty.clear();
    this.solve(batch);
  }

  /** Runs `ticks` consecutive ticks. Useful in tests and for catching up. */
  advance(ticks: number): void {
    for (let i = 0; i < ticks; i++) this.tick();
  }

  private runScheduled(): void {
    if (this.scheduled.length === 0) return;
    const due = this.scheduled.filter((s) => s.due <= this.tickCount).sort((a, b) => a.due - b.due || a.seq - b.seq);
    if (due.length === 0) return;
    this.scheduled = this.scheduled.filter((s) => s.due > this.tickCount);
    for (const s of due) {
      this.scheduledKeys.delete(s.key);
      s.run();
    }
  }

  private solve(batch: Pos[]): void {
    // 1. Collect the dust components touched by this batch.
    const component = new Map<string, Pos>();
    const queue: Pos[] = [];
    const seedDust = (p: Pos): void => {
      if (this.dim.getId(p.x, p.y, p.z) !== BLOCK.REDSTONE_DUST) return;
      const k = posKey(p.x, p.y, p.z);
      if (!component.has(k)) {
        component.set(k, p);
        queue.push(p);
      }
    };
    for (const p of batch) {
      seedDust(p);
      for (const n of neighbours(p)) seedDust(n);
    }
    for (let qi = 0; qi < queue.length && component.size < MAX_COMPONENT; qi++) {
      const p = queue[qi]!;
      for (const n of neighbours(p)) {
        if (this.dim.getId(n.x, n.y, n.z) === BLOCK.REDSTONE_DUST) {
          const k = posKey(n.x, n.y, n.z);
          if (!component.has(k)) {
            component.set(k, n);
            queue.push(n);
          }
        }
      }
    }

    // 2. Compute levels: start from strong sources adjacent to each dust cell, then decay outward.
    const buckets: string[][] = Array.from({ length: MAX_SIGNAL + 1 }, () => []);
    const newLevels = new Map<string, number>();
    for (const [k, p] of component) {
      let base = 0;
      for (const n of neighbours(p)) {
        if (this.dim.getId(n.x, n.y, n.z) === BLOCK.REDSTONE_DUST) continue;
        base = Math.max(base, this.emitsTo(n, p));
      }
      if (base > 0) {
        newLevels.set(k, base);
        buckets[base]!.push(k);
      }
    }
    for (let level = MAX_SIGNAL; level >= 1; level--) {
      for (const k of buckets[level]!) {
        if (newLevels.get(k) !== level) continue;
        const p = parsePosKey(k);
        for (const n of neighbours(p)) {
          const nk = posKey(n.x, n.y, n.z);
          if (!component.has(nk)) continue;
          if ((newLevels.get(nk) ?? 0) < level - 1) {
            newLevels.set(nk, level - 1);
            buckets[level - 1]!.push(nk);
          }
        }
      }
    }
    for (const [k, p] of component) {
      const v = newLevels.get(k) ?? 0;
      if (v > 0) this.levels.set(k, v);
      else this.levels.delete(k);
      // Mirror the level into the dust's block state so every peer can render it.
      const current = this.dim.getBlock(p.x, p.y, p.z);
      if (current.id === BLOCK.REDSTONE_DUST && current.state !== v) {
        this.dim.setBlock(p.x, p.y, p.z, BLOCK.REDSTONE_DUST, v);
      }
    }

    // 3. Update consumers next to the batch and the component.
    const consumers = new Map<string, Pos>();
    const addConsumer = (p: Pos) => {
      if (this.dim.getId(p.x, p.y, p.z) !== BLOCK.REDSTONE_DUST) consumers.set(posKey(p.x, p.y, p.z), p);
    };
    for (const p of batch) {
      addConsumer(p);
      for (const n of neighbours(p)) addConsumer(n);
    }
    for (const p of component.values()) for (const n of neighbours(p)) addConsumer(n);
    for (const p of consumers.values()) this.updateConsumer(p);
  }

  private updateConsumer(p: Pos): void {
    const b = this.dim.getBlock(p.x, p.y, p.z);
    switch (b.id) {
      case BLOCK.REDSTONE_LAMP: {
        const lit = this.receivedPower(p) > 0;
        this.setActive(p, lit);
        break;
      }
      case BLOCK.OAK_DOOR: {
        const powered = this.receivedPower(p) > 0;
        this.setActive(p, powered);
        break;
      }
      case BLOCK.REDSTONE_TORCH: {
        const wantLit = this.supportPower(p) === 0;
        const isLit = (b.state & STATE.ACTIVE) !== 0;
        if (wantLit !== isLit) {
          this.schedule(1, `torch:${posKey(p.x, p.y, p.z)}`, () => {
            const current = this.dim.getBlock(p.x, p.y, p.z);
            if (current.id !== BLOCK.REDSTONE_TORCH) return;
            const shouldLit = this.supportPower(p) === 0;
            this.setActive(p, shouldLit);
          });
        }
        break;
      }
      case BLOCK.REPEATER: {
        const facing = facingOf(b.state);
        const [dx, dy, dz] = FACING_VECTORS[facing]!;
        const back = { x: p.x - dx, y: p.y - dy, z: p.z - dz };
        const input = this.emitsTo(back, p) > 0;
        const isOn = (b.state & STATE.ACTIVE) !== 0;
        const delay = (((b.state & STATE.DELAY_MASK) >> STATE.DELAY_SHIFT) & 3) + 1;
        if (input !== isOn) {
          this.schedule(delay, `rep:${posKey(p.x, p.y, p.z)}`, () => {
            const current = this.dim.getBlock(p.x, p.y, p.z);
            if (current.id !== BLOCK.REPEATER) return;
            const [cx, cy, cz] = FACING_VECTORS[facingOf(current.state)]!;
            const inputNow = this.emitsTo({ x: p.x - cx, y: p.y - cy, z: p.z - cz }, p) > 0;
            this.setActive(p, inputNow);
          });
        }
        break;
      }
      case BLOCK.PISTON:
      case BLOCK.STICKY_PISTON: {
        const powered = this.receivedPower(p) > 0;
        const extended = (b.state & STATE.ACTIVE) !== 0;
        const facing = facingOf(b.state);
        if (powered && !extended) this.extendPiston(p, facing);
        else if (!powered && extended) this.retractPiston(p, facing);
        break;
      }
      default:
        break;
    }
  }

  private setActive(p: Pos, active: boolean): void {
    const b = this.dim.getBlock(p.x, p.y, p.z);
    const state = active ? b.state | STATE.ACTIVE : b.state & ~STATE.ACTIVE;
    if (state !== b.state) this.dim.setBlock(p.x, p.y, p.z, b.id, state);
  }

  /** Player interaction: toggles a lever. Returns the new state, or null when not a lever. */
  toggleLever(p: Pos): boolean | null {
    const b = this.dim.getBlock(p.x, p.y, p.z);
    if (b.id !== BLOCK.LEVER) return null;
    const on = (b.state & STATE.ACTIVE) === 0;
    this.setActive(p, on);
    return on;
  }

  /** Player interaction: presses a stone button; it releases automatically after BUTTON_PULSE_TICKS. */
  pressButton(p: Pos): boolean {
    const b = this.dim.getBlock(p.x, p.y, p.z);
    if (b.id !== BLOCK.STONE_BUTTON || b.state & STATE.ACTIVE) return false;
    this.setActive(p, true);
    this.schedule(BUTTON_PULSE_TICKS, `btn:${posKey(p.x, p.y, p.z)}`, () => {
      if (this.dim.getId(p.x, p.y, p.z) === BLOCK.STONE_BUTTON) this.setActive(p, false);
    });
    return true;
  }

  /** Player interaction: cycles a repeater delay 1 -> 2 -> 3 -> 4 -> 1 ticks. */
  cycleRepeaterDelay(p: Pos): number | null {
    const b = this.dim.getBlock(p.x, p.y, p.z);
    if (b.id !== BLOCK.REPEATER) return null;
    const delay = ((b.state & STATE.DELAY_MASK) >> STATE.DELAY_SHIFT) & 3;
    const next = (delay + 1) & 3;
    const state = (b.state & ~STATE.DELAY_MASK) | (next << STATE.DELAY_SHIFT);
    this.dim.setBlock(p.x, p.y, p.z, b.id, state);
    return next + 1;
  }

  /** Player interaction: opens or closes a door manually. */
  toggleDoor(p: Pos): boolean | null {
    const b = this.dim.getBlock(p.x, p.y, p.z);
    if (b.id !== BLOCK.OAK_DOOR) return null;
    const open = (b.state & STATE.ACTIVE) === 0;
    this.setActive(p, open);
    return open;
  }

  /** Attempts to extend a piston at `base` in direction `facing`. Returns true if it moved. */
  extendPiston(base: Pos, facing: number): boolean {
    const [dx, dy, dz] = FACING_VECTORS[facing]!;
    const at = (i: number): Pos => ({ x: base.x + dx * i, y: base.y + dy * i, z: base.z + dz * i });
    const chain: Pos[] = [];
    let i = 1;
    for (; i <= MAX_PISTON_PUSH; i++) {
      const p = at(i);
      const id = this.dim.getId(p.x, p.y, p.z);
      const def = this.registry.get(id);
      if (def.push === 'immovable') return false;
      if (def.push === 'destroy' || id === BLOCK.AIR) break;
      chain.push(p);
    }
    if (i > MAX_PISTON_PUSH) return false;
    // Shift the chain outwards, starting from the far end.
    for (let k = chain.length - 1; k >= 0; k--) {
      const from = chain[k]!;
      const to = at(i - chain.length + k + 1);
      const moving = this.dim.getBlock(from.x, from.y, from.z);
      this.dim.setBlock(to.x, to.y, to.z, moving.id, moving.state);
      this.dim.setBlock(from.x, from.y, from.z, BLOCK.AIR, 0);
    }
    const head = at(1);
    this.dim.setBlock(head.x, head.y, head.z, BLOCK.PISTON_HEAD, facing);
    const baseBlock = this.dim.getBlock(base.x, base.y, base.z);
    this.dim.setBlock(base.x, base.y, base.z, baseBlock.id, facing | STATE.ACTIVE);
    return true;
  }

  /** Retracts a piston. Sticky pistons pull back the block in front of them. */
  retractPiston(base: Pos, facing: number): void {
    const [dx, dy, dz] = FACING_VECTORS[facing]!;
    const at = (i: number): Pos => ({ x: base.x + dx * i, y: base.y + dy * i, z: base.z + dz * i });
    const baseBlock = this.dim.getBlock(base.x, base.y, base.z);
    const head = at(1);
    if (this.dim.getId(head.x, head.y, head.z) === BLOCK.PISTON_HEAD) {
      this.dim.setBlock(head.x, head.y, head.z, BLOCK.AIR, 0);
    }
    if (baseBlock.id === BLOCK.STICKY_PISTON) {
      const pull = at(2);
      const pulled = this.dim.getBlock(pull.x, pull.y, pull.z);
      const def = this.registry.get(pulled.id);
      if (pulled.id !== BLOCK.AIR && def.push === 'normal') {
        this.dim.setBlock(head.x, head.y, head.z, pulled.id, pulled.state);
        this.dim.setBlock(pull.x, pull.y, pull.z, BLOCK.AIR, 0);
      }
    }
    this.dim.setBlock(base.x, base.y, base.z, baseBlock.id, facing);
  }
}
