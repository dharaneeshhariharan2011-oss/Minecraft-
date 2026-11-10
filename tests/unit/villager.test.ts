import { describe, expect, it } from 'vitest';
import { MAX_DEMAND_BONUS, Villager, levelForXp, type TradeWallet } from '../../shared/economy/villager.js';
import { defaultTradeTables } from '../../shared/packs/defaults.js';

/** Simple wallet with an optional capacity (number of distinct items that fit). */
class Wallet implements TradeWallet {
  readonly items = new Map<string, number>();
  constructor(
    init: Record<string, number>,
    private readonly capacity = Infinity,
  ) {
    for (const [k, v] of Object.entries(init)) this.items.set(k, v);
  }
  countOf(item: string): number {
    return this.items.get(item) ?? 0;
  }
  remove(item: string, count: number): boolean {
    if (count === 0) return true;
    if (this.countOf(item) < count) return false;
    this.items.set(item, this.countOf(item) - count);
    return true;
  }
  add(item: string, count: number): number {
    const room = this.items.has(item) || this.items.size < this.capacity ? Infinity : 0;
    if (room === 0) return count;
    this.items.set(item, this.countOf(item) + count);
    return 0;
  }
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.items);
  }
}

function fletcher(): Villager {
  return new Villager('fletcher', defaultTradeTables(), 0);
}

describe('villager trading', () => {
  it('offers the profession trades with at least one unlocked at level 1', () => {
    const v = fletcher();
    expect(v.offers.length).toBeGreaterThan(0);
    expect(v.level).toBe(1);
  });

  it('moves items atomically: inputs leave and the result arrives in one step', () => {
    const v = fletcher();
    const offer = v.offers[0]!;
    const need: Record<string, number> = {};
    for (const r of v.requiredFor(0)) need[r.item] = r.count;
    const wallet = new Wallet(need);
    const out = v.trade(0, wallet);
    expect(out).not.toBeNull();
    expect(out?.item).toBe(offer.gives.item);
    for (const item of Object.keys(need)) expect(wallet.countOf(item)).toBe(0);
    expect(wallet.countOf(offer.gives.item)).toBe(offer.gives.count);
  });

  it('refuses a trade without touching anything when one input is missing', () => {
    const v = fletcher();
    const required = v.requiredFor(0);
    const short: Record<string, number> = {};
    required.forEach((r, i) => (short[r.item] = i === 0 ? Math.max(0, r.count - 1) : r.count));
    const wallet = new Wallet(short);
    const before = wallet.snapshot();
    expect(v.trade(0, wallet)).toBeNull();
    expect(wallet.snapshot()).toEqual(before);
  });

  it('rolls back inputs when the result does not fit in the inventory', () => {
    const v = fletcher();
    const required = v.requiredFor(0);
    const init: Record<string, number> = {};
    for (const r of required) init[r.item] = r.count;
    // Capacity is the number of distinct stacks: the inputs fill it, so the result has nowhere to go.
    const wallet = new Wallet(init, required.length);
    const before = wallet.snapshot();
    expect(v.trade(0, wallet)).toBeNull();
    expect(wallet.snapshot()).toEqual(before);
  });

  it('raises the demand bonus every two uses, capped', () => {
    const v = fletcher();
    const offer = v.offers[0]!;
    offer.maxUses = 100;
    for (let i = 0; i < 20; i++) {
      const need: Record<string, number> = {};
      for (const r of v.requiredFor(0)) need[r.item] = (need[r.item] ?? 0) + r.count;
      v.trade(0, new Wallet(Object.fromEntries(Object.entries(need).map(([k, n]) => [k, n * 10]))));
    }
    expect(offer.demandBonus).toBe(MAX_DEMAND_BONUS);
  });

  it('gains xp per trade and levels up at the XP thresholds', () => {
    expect(levelForXp(0)).toBe(1);
    expect(levelForXp(10)).toBe(2);
    expect(levelForXp(69)).toBe(2);
    expect(levelForXp(70)).toBe(3);
    expect(levelForXp(149)).toBe(3);
    expect(levelForXp(150)).toBe(4);
  });
});
