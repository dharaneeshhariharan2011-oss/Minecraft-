import type { BlockEdit, GameMessage } from '../protocols/messages.js';
import { defaultRegistry, type BlockRegistry } from './blocks.js';
import { Dimension, DIMENSION_IDS, type BlockChange, type DimensionId } from './dimension.js';
import { createGenerator } from './terrain.js';
import { RedstoneSystem } from '../redstone/redstone.js';

/**
 * The shared world: one seed, lazily generated dimensions, and the list of player edits.
 * The host runs with `simulate: true` (redstone ticks and emits block updates);
 * joiners apply authoritative updates received over the network.
 */
export class WorldState {
  readonly dims = new Map<DimensionId, Dimension>();
  readonly redstone = new Map<DimensionId, RedstoneSystem>();
  private readonly listeners = new Set<(change: BlockChange) => void>();

  constructor(
    readonly seed: number,
    readonly registry: BlockRegistry = defaultRegistry,
    private readonly simulate = false,
  ) {}

  dimension(id: DimensionId): Dimension {
    let dim = this.dims.get(id);
    if (!dim) {
      dim = new Dimension(id, createGenerator(id, this.seed), this.registry);
      this.dims.set(id, dim);
      if (this.simulate) {
        this.redstone.set(id, new RedstoneSystem(dim, this.registry));
      }
      dim.onChange((c) => {
        for (const l of this.listeners) l(c);
      });
    }
    return dim;
  }

  /** Subscribes to every change in any dimension (used by the host to broadcast block updates). */
  onBlockChange(listener: (change: BlockChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Advances redstone in every loaded dimension by one tick. Only meaningful on the host. */
  tickRedstone(): void {
    for (const rs of this.redstone.values()) rs.tick();
  }

  /** Applies an edit received from the network. Returns true if the world changed. */
  applyEdit(edit: BlockEdit): boolean {
    if (!DIMENSION_IDS.includes(edit.dim as DimensionId)) return false;
    if (!this.registry.tryGet(edit.id)) return false;
    return this.dimension(edit.dim as DimensionId).setBlock(edit.x, edit.y, edit.z, edit.id, edit.state);
  }

  /** All edits made so far, across dimensions. Used to bring a new joiner up to date. */
  exportEdits(): BlockEdit[] {
    const out: BlockEdit[] = [];
    for (const [id, dim] of this.dims) {
      for (const e of dim.allEdits()) out.push({ dim: id, ...e });
    }
    return out;
  }

  /** The messages a host sends to a player who just joined: seed and all edits per dimension. */
  syncMessages(): GameMessage[] {
    const messages: GameMessage[] = [];
    for (const id of DIMENSION_IDS) {
      const edits = this.exportEdits().filter((e) => e.dim === id);
      messages.push({ t: 'worldSync', seed: this.seed, dim: id, edits });
    }
    return messages;
  }

  /** Applies a `worldSync` message to a joiner's world. */
  static fromSync(messages: GameMessage[], registry = defaultRegistry): WorldState {
    const sync = messages.find((m): m is Extract<GameMessage, { t: 'worldSync' }> => m.t === 'worldSync');
    if (!sync) throw new Error('no worldSync message');
    const world = new WorldState(sync.seed, registry, false);
    for (const m of messages) {
      if (m.t === 'worldSync') for (const e of m.edits) world.applyEdit(e);
    }
    return world;
  }

  /** Convenience for tests: block id at a position in the overworld. */
  idAt(dim: DimensionId, x: number, y: number, z: number): number {
    return this.dimension(dim).getId(x, y, z);
  }

  dispose(): void {
    for (const rs of this.redstone.values()) rs.dispose();
    this.redstone.clear();
    this.listeners.clear();
  }
}
