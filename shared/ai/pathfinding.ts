/**
 * Grid A* for walking mobs and players. Nodes are block positions where an entity of 1x2 size can
 * stand. Moves: 4 horizontal directions, step up 1 (jump), or drop up to 3 blocks.
 */

export interface GridPos {
  x: number;
  y: number;
  z: number;
}

export interface PathWorld {
  /** True when the cell can be occupied (air, water, etc.). */
  passable: (x: number, y: number, z: number) => boolean;
  /** True when the cell is a solid floor an entity can stand on. */
  solid: (x: number, y: number, z: number) => boolean;
}

export interface PathOptions {
  maxNodes?: number;
  maxRange?: number;
}

const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export function isWalkable(world: PathWorld, x: number, y: number, z: number): boolean {
  return world.passable(x, y, z) && world.passable(x, y + 1, z) && world.solid(x, y - 1, z);
}

const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;

/** Min-heap keyed on a numeric priority. */
class MinHeap<T> {
  private readonly items: Array<{ p: number; v: T }> = [];
  get size(): number {
    return this.items.length;
  }
  push(p: number, v: T): void {
    this.items.push({ p, v });
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[parent]!.p <= this.items[i]!.p) break;
      [this.items[parent], this.items[i]] = [this.items[i]!, this.items[parent]!];
      i = parent;
    }
  }
  pop(): T | undefined {
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0 && last) {
      this.items[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.items.length && this.items[l]!.p < this.items[m]!.p) m = l;
        if (r < this.items.length && this.items[r]!.p < this.items[m]!.p) m = r;
        if (m === i) break;
        [this.items[m], this.items[i]] = [this.items[i]!, this.items[m]!];
        i = m;
      }
    }
    return top?.v;
  }
}

/**
 * Finds a walkable path from `start` to `goal`, excluding the start. Returns null if none exists
 * within the search budget. An unreachable or unwalkable goal returns null.
 */
export function findPath(world: PathWorld, start: GridPos, goal: GridPos, options: PathOptions = {}): GridPos[] | null {
  const maxNodes = options.maxNodes ?? 2000;
  const maxRange = options.maxRange ?? 24;
  if (!isWalkable(world, goal.x, goal.y, goal.z)) return null;
  if (start.x === goal.x && start.y === goal.y && start.z === goal.z) return [];
  if (Math.max(Math.abs(goal.x - start.x), Math.abs(goal.z - start.z)) > maxRange) return null;

  const h = (x: number, y: number, z: number): number =>
    Math.abs(goal.x - x) + Math.abs(goal.z - z) + Math.abs(goal.y - y) * 0.5;

  const open = new MinHeap<GridPos>();
  const gScore = new Map<string, number>();
  const cameFrom = new Map<string, GridPos>();
  const closed = new Set<string>();
  const startKey = key(start.x, start.y, start.z);
  gScore.set(startKey, 0);
  open.push(h(start.x, start.y, start.z), { ...start });

  let expanded = 0;
  while (open.size > 0) {
    const cur = open.pop()!;
    const ck = key(cur.x, cur.y, cur.z);
    if (closed.has(ck)) continue;
    closed.add(ck);
    if (cur.x === goal.x && cur.y === goal.y && cur.z === goal.z) {
      return reconstruct(cameFrom, cur, startKey);
    }
    if (++expanded > maxNodes) return null;

    const g = gScore.get(ck) ?? Infinity;
    for (const [dx, dz] of DIRS) {
      const nx = cur.x + dx;
      const nz = cur.z + dz;
      if (Math.max(Math.abs(nx - start.x), Math.abs(nz - start.z)) > maxRange) continue;
      // Candidate moves: level, step up, drop down 1..3.
      const candidates: Array<{ y: number; cost: number }> = [];
      if (isWalkable(world, nx, cur.y, nz)) candidates.push({ y: cur.y, cost: 1 });
      if (world.passable(cur.x, cur.y + 2, cur.z) && isWalkable(world, nx, cur.y + 1, nz)) {
        candidates.push({ y: cur.y + 1, cost: 1.6 });
      }
      for (let d = 1; d <= 3; d++) {
        const ty = cur.y - d;
        if (!world.passable(nx, cur.y, nz)) break;
        if (isWalkable(world, nx, ty, nz)) {
          candidates.push({ y: ty, cost: 1 + d * 0.3 });
          break;
        }
      }
      for (const c of candidates) {
        const nk = key(nx, c.y, nz);
        if (closed.has(nk)) continue;
        const tentative = g + c.cost;
        if (tentative < (gScore.get(nk) ?? Infinity)) {
          gScore.set(nk, tentative);
          cameFrom.set(nk, cur);
          open.push(tentative + h(nx, c.y, nz), { x: nx, y: c.y, z: nz });
        }
      }
    }
  }
  return null;
}

function reconstruct(cameFrom: Map<string, GridPos>, end: GridPos, startKey: string): GridPos[] {
  const path: GridPos[] = [];
  let cur: GridPos | undefined = end;
  while (cur) {
    const k = key(cur.x, cur.y, cur.z);
    if (k === startKey) break;
    path.push(cur);
    cur = cameFrom.get(k);
  }
  return path.reverse();
}
