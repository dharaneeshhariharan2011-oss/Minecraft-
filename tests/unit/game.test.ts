import { describe, expect, it, vi } from 'vitest';
import { Game, breakTime, dropFor, facingFromYaw } from '../../client/engine/game.js';
import { createDefaultContent } from '../../shared/packs/registry.js';
import { BLOCK } from '../../shared/world/blocks.js';
import type { BlockDef } from '../../shared/world/blocks.js';

function makeGame(mode: 'host' | 'client' | 'single', blockChanged?: (c: unknown) => void, deferWorld = false) {
  const content = createDefaultContent();
  const game = new Game({
    content,
    mode,
    seed: 1234,
    name: 'Tester',
    deferWorld,
    callbacks: {
      message: () => {},
      openPanel: () => {},
      damaged: () => {},
      died: () => {},
      dimensionChanged: () => {},
      blockChanged: blockChanged as never,
    },
  });
  return { game, content };
}

describe('block changes and networking echo rules', () => {
  it('reports local edits once to the networking layer', () => {
    const spy = vi.fn();
    const { game } = makeGame('single', spy);
    game.setBlockLocal(3, 120, 3, BLOCK.COBBLESTONE, 0);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatchObject({ dim: 'overworld', x: 3, y: 120, z: 3, id: BLOCK.COBBLESTONE });
  });

  it('applies a remote update without echoing it back (no network loops)', () => {
    const spy = vi.fn();
    const { game } = makeGame('client', spy, true);
    game.applyRemoteBlock('overworld', 4, 120, 4, BLOCK.STONE, 0);
    expect(game.dim.getId(4, 120, 4)).toBe(BLOCK.STONE);
    expect(spy).not.toHaveBeenCalled();
  });

  it('a client builds its world from the host sync, including edits', () => {
    const { game } = makeGame('client', undefined, true);
    game.handleNetMessage('host', 'Host', 'host', {
      t: 'worldSync',
      seed: 99,
      dim: 'overworld',
      edits: [{ dim: 'overworld', x: 7, y: 121, z: 7, id: BLOCK.GLOWSTONE, state: 0 }],
    });
    expect(game.dim.getId(7, 121, 7)).toBe(BLOCK.GLOWSTONE);
  });

  it('host redstone changes are mirrored to block state so joiners can render them', () => {
    const spy = vi.fn();
    const { game } = makeGame('host', spy);
    const y = 120;
    game.setBlockLocal(20, y, 20, BLOCK.REDSTONE_BLOCK, 0);
    game.setBlockLocal(21, y, 20, BLOCK.REDSTONE_DUST, 0);
    game.setBlockLocal(22, y, 20, BLOCK.REDSTONE_DUST, 0);
    for (let i = 0; i < 4; i++) game.world.tickRedstone();
    // Dust touching a redstone block is at full power; the next dust along decays by one.
    expect(game.dim.getBlock(21, y, 20).state).toBe(15);
    expect(game.dim.getBlock(22, y, 20).state).toBe(14);
    expect(spy.mock.calls.some((c) => c[0].id === BLOCK.REDSTONE_DUST && c[0].x === 21)).toBe(true);
  });

  it('a host redstone change, applied on a joiner, does not echo back', () => {
    const { game } = makeGame('client', undefined, true);
    game.handleNetMessage('host', 'Host', 'host', { t: 'blockUpdate', dim: 'overworld', x: 9, y: 121, z: 9, id: BLOCK.REDSTONE_DUST, state: 13, by: 'host' });
    expect(game.dim.getBlock(9, 121, 9)).toMatchObject({ id: BLOCK.REDSTONE_DUST, state: 13 });
  });
});

describe('crafting against the inventory', () => {
  it('crafts sticks from two planks and consumes exactly the ingredients', () => {
    const { game } = makeGame('single');
    game.inventory.slots.fill(null);
    game.inventory.add('minecraft:oak_planks', 2);
    expect(game.craft([['minecraft:oak_planks'], ['minecraft:oak_planks']], 2)).toBe(true);
    expect(game.inventory.countOf('minecraft:stick')).toBe(4);
    expect(game.inventory.countOf('minecraft:oak_planks')).toBe(0);
  });

  it('refuses to craft when an ingredient is missing and changes nothing', () => {
    const { game } = makeGame('single');
    game.inventory.slots.fill(null);
    game.inventory.add('minecraft:oak_planks', 1);
    expect(game.craft([['minecraft:oak_planks'], ['minecraft:oak_planks']], 2)).toBe(false);
    expect(game.inventory.countOf('minecraft:oak_planks')).toBe(1);
  });
});

describe('portal travel', () => {
  it('scales overworld coordinates by 1/8 entering the nether and returns to the overworld', () => {
    const { game } = makeGame('single');
    game.player.x = 80.5;
    game.player.z = -40.5;
    game.player.y = 70;
    game.travelThroughPortal();
    expect(game.dimId).toBe('nether');
    expect(Math.abs(game.player.x - 10.5)).toBeLessThanOrEqual(1);
    expect(Math.abs(game.player.z - -5.5)).toBeLessThanOrEqual(1);
    game.travelThroughPortal();
    expect(game.dimId).toBe('overworld');
  });
});

describe('small helpers', () => {
  it('facingFromYaw returns one of the four horizontal directions', () => {
    const values = new Set([0, 1, 2, 3].map((k) => facingFromYaw(k * (Math.PI / 2))));
    expect(values.size).toBe(4);
    expect(facingFromYaw(0, true)).toBe((facingFromYaw(0) + 2) & 3);
  });

  it('breakTime is infinite for unbreakable blocks and faster with the right tool', () => {
    const stone = { name: 's', hardness: 1.5, tool: 'pickaxe' } as BlockDef;
    expect(breakTime({ ...stone, hardness: -1 } as BlockDef)).toBe(Infinity);
    expect(breakTime(stone, 'minecraft:iron_pickaxe')).toBeLessThan(breakTime(stone));
    expect(breakTime(stone, 'minecraft:wooden_pickaxe')).toBeLessThan(breakTime(stone));
  });

  it('dropFor returns the redstone item from dust and nothing from leaves', () => {
    expect(dropFor({ id: BLOCK.REDSTONE_DUST, name: 'x' } as BlockDef)).toBe('minecraft:redstone');
    expect(dropFor({ id: BLOCK.OAK_LEAVES, name: 'x', dropItem: null } as BlockDef)).toBeNull();
  });
});
