/** A stack of items. `damage` is consumed durability for tools and armour. */
export interface ItemStack {
  id: string;
  count: number;
  damage: number;
}

export interface ItemInfo {
  maxStackSize: number;
  durability?: number;
  armor?: { slot: 'head' | 'chest' | 'legs' | 'feet' | 'offhand'; protection: number };
}

export type ItemLookup = (id: string) => ItemInfo | undefined;

export const MAIN_SLOTS = 36;
export const ARMOR_SLOTS = { head: 36, chest: 37, legs: 38, feet: 39 } as const;
export const OFFHAND_SLOT = 40;
export const TOTAL_SLOTS = 41;

/**
 * Player inventory: 36 main slots (hotbar 0..8), four armour slots and one off-hand slot.
 * Stacks respect each item's max stack size; durable items never stack above 1.
 */
export class Inventory {
  readonly slots: Array<ItemStack | null> = Array.from({ length: TOTAL_SLOTS }, () => null);

  constructor(private readonly lookup: ItemLookup) {}

  info(id: string): ItemInfo {
    return this.lookup(id) ?? { maxStackSize: 64 };
  }

  /** Adds items, returning how many could not fit. */
  add(id: string, count: number): number {
    let remaining = count;
    const info = this.info(id);
    for (let i = 0; i < MAIN_SLOTS && remaining > 0; i++) {
      const s = this.slots[i];
      if (s && s.id === id && s.count < info.maxStackSize && s.damage === 0) {
        const move = Math.min(remaining, info.maxStackSize - s.count);
        s.count += move;
        remaining -= move;
      }
    }
    for (let i = 0; i < MAIN_SLOTS && remaining > 0; i++) {
      if (this.slots[i] === null) {
        const move = Math.min(remaining, info.maxStackSize);
        this.slots[i] = { id, count: move, damage: 0 };
        remaining -= move;
      }
    }
    return remaining;
  }

  countOf(id: string): number {
    return this.slots.reduce((n, s) => (s && s.id === id ? n + s.count : n), 0);
  }

  /** Removes items from anywhere in the inventory. Returns false (and changes nothing) if not enough. */
  remove(id: string, count: number): boolean {
    if (this.countOf(id) < count) return false;
    let remaining = count;
    for (let i = 0; i < TOTAL_SLOTS && remaining > 0; i++) {
      const s = this.slots[i];
      if (!s || s.id !== id) continue;
      const take = Math.min(remaining, s.count);
      s.count -= take;
      remaining -= take;
      if (s.count === 0) this.slots[i] = null;
    }
    return true;
  }

  /** Applies durability damage to a slot; breaks (removes) the item at zero durability. */
  damageSlot(slot: number, amount = 1): boolean {
    const s = this.slots[slot];
    if (!s) return false;
    const max = this.info(s.id).durability;
    if (max === undefined) return false;
    s.damage += amount;
    if (s.damage >= max) {
      this.slots[slot] = null;
      return true;
    }
    return false;
  }

  /** Total armour protection points from the worn armour. */
  armorPoints(): number {
    let total = 0;
    for (const slot of [ARMOR_SLOTS.head, ARMOR_SLOTS.chest, ARMOR_SLOTS.legs, ARMOR_SLOTS.feet]) {
      const s = this.slots[slot];
      if (!s) continue;
      total += this.info(s.id).armor?.protection ?? 0;
    }
    return total;
  }

  /** Damages every worn armour piece by one point (called when the player takes damage). */
  damageArmor(): number {
    let broken = 0;
    for (const slot of [ARMOR_SLOTS.head, ARMOR_SLOTS.chest, ARMOR_SLOTS.legs, ARMOR_SLOTS.feet]) {
      if (this.damageSlot(slot, 1)) broken++;
    }
    return broken;
  }

  /** Puts an armour item into its slot. Returns false when the item is not armour for that slot. */
  equipArmor(slot: number, id: string): boolean {
    const armor = this.info(id).armor;
    const expected = slot === ARMOR_SLOTS.head ? 'head' : slot === ARMOR_SLOTS.chest ? 'chest' : slot === ARMOR_SLOTS.legs ? 'legs' : slot === ARMOR_SLOTS.feet ? 'feet' : null;
    if (!armor || armor.slot !== expected) return false;
    if (this.countOf(id) < 1) return false;
    this.remove(id, 1);
    this.slots[slot] = { id, count: 1, damage: 0 };
    return true;
  }
}
