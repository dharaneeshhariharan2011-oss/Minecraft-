import type { TradeTableSpec, RecipeIngredient } from '../packs/schema.js';

/** Anything that can pay for and receive trade items (the player's Inventory satisfies this). */
export interface TradeWallet {
  countOf(item: string): number;
  remove(item: string, count: number): boolean;
  add(item: string, count: number): number;
}

export const PROFESSIONS = ['none', 'fletcher', 'armorer', 'librarian'] as const;
export type Profession = (typeof PROFESSIONS)[number];

/** XP needed to reach each level (index = level - 1). */
export const LEVEL_XP = [0, 10, 70, 150, 250] as const;
export const MAX_LEVEL = 5;
/** Extra price added per use when a trade is in high demand. */
export const DEMAND_STEP_USES = 2;
export const MAX_DEMAND_BONUS = 4;

/** Workstation block identifiers that claim a profession for an unemployed villager. */
export const WORKSTATIONS: Record<string, Exclude<Profession, 'none'>> = {
  'minecraft:fletching_table': 'fletcher',
  'minecraft:blast_furnace': 'armorer',
  'minecraft:lectern': 'librarian',
};

export function professionForWorkstation(blockName: string): Profession {
  return WORKSTATIONS[blockName] ?? 'none';
}

export function levelForXp(xp: number): number {
  let level = 1;
  for (let i = 1; i < LEVEL_XP.length; i++) {
    if (xp >= LEVEL_XP[i]!) level = i + 1;
  }
  return Math.min(level, MAX_LEVEL);
}

export interface TradeOffer {
  /** Index into the villager's offers list. */
  index: number;
  wants: RecipeIngredient[];
  gives: RecipeIngredient;
  uses: number;
  maxUses: number;
  /** Extra items demanded because of recent demand. */
  demandBonus: number;
  sourceTable: string;
}

/**
 * Villager with a profession, XP-based levelling, and trades that unlock per level and restock daily.
 * Pure data & logic: rendering and inventory transfer are handled by the caller.
 */
export class Villager {
  profession: Profession;
  xp = 0;
  level = 1;
  offers: TradeOffer[] = [];
  lastRestockDay = -1;

  constructor(
    profession: Profession,
    private readonly tables: TradeTableSpec[],
    day = 0,
  ) {
    this.profession = profession;
    this.lastRestockDay = day;
    this.rebuildOffers();
  }

  /** Assigns a profession when the villager first uses a workstation. */
  claimWorkstation(profession: Profession): boolean {
    if (this.profession !== 'none' || profession === 'none') return false;
    this.profession = profession;
    this.rebuildOffers();
    return true;
  }

  /** Gains XP from trading. Returns true when the villager levels up. */
  addXp(amount: number): boolean {
    const before = this.level;
    this.xp += Math.max(0, amount);
    this.level = levelForXp(this.xp);
    if (this.level !== before) {
      this.rebuildOffers();
      return true;
    }
    return false;
  }

  private rebuildOffers(): void {
    const next: TradeOffer[] = [];
    for (const table of this.tables) {
      if (table.profession !== this.profession || table.level > this.level) continue;
      for (const t of table.trades) {
        next.push({
          index: next.length,
          wants: t.wants.map((w) => ({ ...w })),
          gives: { ...t.gives },
          uses: 0,
          maxUses: t.maxUses,
          demandBonus: 0,
          sourceTable: table.identifier,
        });
      }
    }
    // Keep previous usage for offers that still exist at the same position.
    for (const offer of next) {
      const prev = this.offers[offer.index];
      if (prev && prev.sourceTable === offer.sourceTable) {
        offer.uses = prev.uses;
        offer.demandBonus = prev.demandBonus;
      }
    }
    this.offers = next;
  }

  /** Required inputs including the demand bonus (applied to the first input only). */
  requiredFor(index: number): RecipeIngredient[] {
    const offer = this.offers[index];
    if (!offer) return [];
    return offer.wants.map((w, i) => ({ item: w.item, count: i === 0 ? w.count + offer.demandBonus : w.count }));
  }

  /** Whether the offer can still be used today. */
  available(index: number): boolean {
    const offer = this.offers[index];
    return !!offer && offer.uses < offer.maxUses;
  }

  /**
   * Executes a trade against the trader's inventory. The transaction is atomic: nothing changes
   * unless the player has every required input. Returns the output, or null when refused.
   * Demand: every DEMAND_STEP_USES uses adds one more required item (up to MAX_DEMAND_BONUS).
   */
  trade(index: number, wallet: TradeWallet): RecipeIngredient | null {
    const offer = this.offers[index];
    if (!offer || offer.uses >= offer.maxUses) return null;
    const required = this.requiredFor(index);
    if (!required.every((r) => wallet.countOf(r.item) >= r.count)) return null;
    for (const r of required) wallet.remove(r.item, r.count);
    const leftover = wallet.add(offer.gives.item, offer.gives.count);
    if (leftover > 0) {
      // No room for the result: put everything back so the trade is all-or-nothing.
      wallet.remove(offer.gives.item, offer.gives.count - leftover);
      for (const r of required) wallet.add(r.item, r.count);
      return null;
    }
    offer.uses++;
    if (offer.uses % DEMAND_STEP_USES === 0) offer.demandBonus = Math.min(MAX_DEMAND_BONUS, offer.demandBonus + 1);
    this.addXp(offer.uses === 1 ? 2 : 1);
    return { ...offer.gives };
  }

  /** Restocks all trades once per in-game day. Returns true if a restock happened. */
  restock(day: number): boolean {
    if (day <= this.lastRestockDay) return false;
    this.lastRestockDay = day;
    for (const o of this.offers) {
      o.uses = 0;
      o.demandBonus = 0;
    }
    return true;
  }
}
