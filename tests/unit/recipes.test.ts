import { describe, expect, it } from 'vitest';
import { findRecipe, trimGrid, type Grid } from '../../shared/crafting/recipes.js';
import { defaultRecipes } from '../../shared/packs/defaults.js';

const P = 'minecraft:oak_planks';
const S = 'minecraft:stick';
const C = 'minecraft:cobblestone';
const recipes = defaultRecipes();

function grid3(rows: string[]): Grid {
  return rows.map((r) => [...r].map((ch) => (ch === ' ' ? null : ch === 'P' ? P : ch === 'S' ? S : ch === 'C' ? C : ch)));
}

describe('recipe matching', () => {
  it('matches a vertical pair of planks to four sticks in the inventory grid', () => {
    const r = findRecipe(recipes, [[P], [P]], 'inventory');
    expect(r?.result.item).toBe(S);
    expect(r?.result.count).toBe(4);
  });

  it('matches shaped recipes regardless of where the pattern sits in a larger grid', () => {
    const pattern = grid3(['PPP', ' S ', ' S ']);
    const shifted: Grid = [
      [null, null, null],
      [null, P, P],
      [null, null, P],
    ];
    expect(findRecipe(recipes, pattern, 'crafting_table')?.result.item).toBe('minecraft:wooden_pickaxe');
    // A pattern that is not contiguous must not match.
    expect(findRecipe(recipes, shifted, 'crafting_table')).toBeNull();
  });

  it('requires a crafting table for three-by-three recipes', () => {
    const pickaxe = grid3(['CCC', ' S ', ' S ']);
    expect(findRecipe(recipes, pickaxe, 'inventory')).toBeNull();
    expect(findRecipe(recipes, pickaxe, 'crafting_table')?.result.item).toBe('minecraft:stone_pickaxe');
  });

  it('matches shapeless recipes in any cell', () => {
    const r = findRecipe(recipes, [[null, null], [null, 'minecraft:oak_log']], 'inventory');
    expect(r?.result.item).toBe(P);
    expect(r?.result.count).toBe(4);
  });

  it('returns null for empty or unknown grids', () => {
    expect(findRecipe(recipes, [[null]], 'crafting_table')).toBeNull();
    expect(findRecipe(recipes, [['minecraft:dirt']], 'crafting_table')).toBeNull();
  });

  it('trims empty rows and columns', () => {
    const t = trimGrid([
      [null, null, null],
      [null, P, null],
      [null, null, null],
    ]);
    expect(t).toEqual([[P]]);
  });
});
