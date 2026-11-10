import type { RecipeSpec, ShapedRecipeSpec, ShapelessRecipeSpec, RecipeIngredient } from '../packs/schema.js';

/** A crafting grid cell: item identifier, or null/empty for an empty cell. */
export type GridCell = string | null;
export type Grid = GridCell[][];

/** Shrinks a grid to the bounding box of its non-empty cells. */
export function trimGrid(grid: Grid): Grid {
  let minR = Infinity;
  let maxR = -1;
  let minC = Infinity;
  let maxC = -1;
  grid.forEach((row, r) =>
    row.forEach((cell, c) => {
      if (cell) {
        minR = Math.min(minR, r);
        maxR = Math.max(maxR, r);
        minC = Math.min(minC, c);
        maxC = Math.max(maxC, c);
      }
    }),
  );
  if (maxR < 0) return [];
  const out: Grid = [];
  for (let r = minR; r <= maxR; r++) {
    const row: GridCell[] = [];
    for (let c = minC; c <= maxC; c++) row.push(grid[r]?.[c] ?? null);
    out.push(row);
  }
  return out;
}

/** Shaped recipes match anywhere in the grid (translation invariant), exact pattern otherwise. */
export function matchShaped(recipe: ShapedRecipeSpec, grid: Grid): boolean {
  const trimmed = trimGrid(grid);
  if (trimmed.length === 0) return false;
  const pattern = trimPattern(recipe.pattern);
  if (pattern.length !== trimmed.length || pattern[0]!.length !== trimmed[0]!.length) return false;
  for (let r = 0; r < pattern.length; r++) {
    for (let c = 0; c < pattern[0]!.length; c++) {
      const symbol = pattern[r]![c]!;
      const cell = trimmed[r]![c] ?? null;
      if (symbol === ' ') {
        if (cell !== null) return false;
      } else if (cell !== (recipe.key[symbol] ?? null)) {
        return false;
      }
    }
  }
  return true;
}

function trimPattern(rows: string[]): string[][] {
  const grid: Grid = rows.map((row) => [...row].map((ch) => (ch === ' ' ? null : ch)));
  // Use symbols instead of identifiers: trim with a sentinel and map back to the same symbols.
  let minR = Infinity;
  let maxR = -1;
  let minC = Infinity;
  let maxC = -1;
  grid.forEach((row, r) =>
    row.forEach((cell, c) => {
      if (cell !== null) {
        minR = Math.min(minR, r);
        maxR = Math.max(maxR, r);
        minC = Math.min(minC, c);
        maxC = Math.max(maxC, c);
      }
    }),
  );
  if (maxR < 0) return [];
  const out: string[][] = [];
  for (let r = minR; r <= maxR; r++) {
    const row: string[] = [];
    for (let c = minC; c <= maxC; c++) row.push(grid[r]?.[c] ?? ' ');
    out.push(row);
  }
  return out;
}

/** Shapeless recipes match when the multiset of items equals the ingredient list. */
export function matchShapeless(recipe: ShapelessRecipeSpec, grid: Grid): boolean {
  const have = grid.flat().filter((c): c is string => c !== null).sort();
  const want = [...recipe.ingredients].sort();
  return have.length === want.length && have.every((v, i) => v === want[i]);
}

export function matches(recipe: RecipeSpec, grid: Grid): boolean {
  return recipe.kind === 'shaped' ? matchShaped(recipe, grid) : matchShapeless(recipe, grid);
}

/** Returns the first recipe (in order) matching the grid, or null. */
export function findRecipe(recipes: readonly RecipeSpec[], grid: Grid, station = 'crafting_table'): RecipeSpec | null {
  for (const r of recipes) {
    if (!r.tags.includes(station) && !r.tags.includes('inventory')) continue;
    if (matches(r, grid)) return r;
  }
  return null;
}

/** Converts a result ingredient to an item stack description. */
export function resultOf(recipe: RecipeSpec): RecipeIngredient {
  return { ...recipe.result };
}
