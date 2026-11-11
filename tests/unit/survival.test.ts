import { describe, expect, it } from 'vitest';
import { applyDamage, createSurvival, reduceDamage, tickSurvival } from '../../shared/survival/stats.js';
import { Inventory, ARMOR_SLOTS } from '../../shared/survival/inventory.js';

const armorInfo = (id: string) => {
  if (id === 'minecraft:iron_chestplate') return { maxStackSize: 1, durability: 240, armor: { slot: 'chest' as const, protection: 6 } };
  if (id === 'minecraft:apple') return { maxStackSize: 64 };
  return { maxStackSize: 64 };
};

describe('armour damage reduction', () => {
  it('passes damage through unchanged with no armour', () => {
    expect(reduceDamage(10, 0)).toBe(10);
  });

  it('follows min(20, max(points/5, points - damage/2)) / 25', () => {
    // points 20, damage 10: max(4, 15) = 15 -> 10 * (1 - 15/25) = 4
    expect(reduceDamage(10, 20)).toBe(4);
    // points 10, damage 4: max(2, 8) = 8 -> 4 * (1 - 8/25) = 2.72 -> 2.7
    expect(reduceDamage(4, 10)).toBe(2.7);
  });

  it('never reduces by more than 80 percent (effective armour is capped at 20)', () => {
    expect(reduceDamage(100, 1000)).toBe(20);
  });

  it('peaceful difficulty ignores hostile damage but not falls', () => {
    const s = createSurvival();
    expect(applyDamage(s, 6, 0, 'peaceful').applied).toBe(0);
    expect(s.health).toBe(20);
    expect(applyDamage(s, 6, 0, 'peaceful', true).applied).toBe(6);
  });

  it('marks the player dead at zero health and stops further damage', () => {
    const s = createSurvival();
    const r = applyDamage(s, 999, 0, 'hard', true);
    expect(r.died).toBe(true);
    expect(s.dead).toBe(true);
    expect(applyDamage(s, 5, 0, 'hard').applied).toBe(0);
  });

  it('starvation cannot kill on easy or normal, but can on hard', () => {
    for (const difficulty of ['easy', 'normal'] as const) {
      const s = createSurvival();
      s.hunger = 0;
      s.health = 3;
      for (let i = 0; i < 2000; i++) tickSurvival(s, difficulty);
      expect(s.dead).toBe(false);
      expect(s.health).toBe(1);
    }
    const hard = createSurvival();
    hard.hunger = 0;
    hard.health = 3;
    for (let i = 0; i < 2000; i++) tickSurvival(hard, 'hard');
    expect(hard.dead).toBe(true);
  });
});

describe('armour durability and off-hand', () => {
  it('sums armour points from equipped pieces and wears them down', () => {
    const inv = new Inventory(armorInfo);
    expect(inv.equipArmor(ARMOR_SLOTS.chest, 'minecraft:iron_chestplate')).toBe(false); // not in the inventory yet
    inv.add('minecraft:iron_chestplate', 1);
    expect(inv.equipArmor(ARMOR_SLOTS.head, 'minecraft:iron_chestplate')).toBe(false); // wrong slot
    expect(inv.equipArmor(ARMOR_SLOTS.chest, 'minecraft:iron_chestplate')).toBe(true);
    expect(inv.armorPoints()).toBe(6);
    inv.damageArmor();
    expect(inv.slots[ARMOR_SLOTS.chest]?.damage).toBeGreaterThan(0);
  });

  it('stacks ordinary items up to the max stack size and reports leftovers', () => {
    const inv = new Inventory(armorInfo);
    expect(inv.add('minecraft:apple', 64)).toBe(0);
    expect(inv.add('minecraft:apple', 1)).toBe(0);
    expect(inv.countOf('minecraft:apple')).toBe(65);
  });
});
