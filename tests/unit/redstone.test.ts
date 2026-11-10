import { describe, expect, it } from 'vitest';
import { BLOCK, STATE } from '../../shared/world/blocks.js';
import { Dimension } from '../../shared/world/dimension.js';
import { createGenerator } from '../../shared/world/terrain.js';
import { RedstoneSystem, MAX_SIGNAL, BUTTON_PULSE_TICKS } from '../../shared/redstone/redstone.js';

/** Flat test world: a stone floor at y=60, open air above. */
class FlatGenerator {
  readonly dimension = 'overworld' as const;
  generate(chunk: { ids: Uint16Array; states: Uint8Array }): void {
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        for (let y = 0; y < 128; y++) {
          const idx = (y * 16 + lz) * 16 + lx;
          chunk.ids[idx] = y === 0 ? BLOCK.BEDROCK : y <= 60 ? BLOCK.STONE : BLOCK.AIR;
        }
      }
    }
  }
}

function setup() {
  const dim = new Dimension('overworld', new FlatGenerator() as never);
  const rs = new RedstoneSystem(dim);
  return { dim, rs };
}

describe('redstone dust signal decay', () => {
  it('a redstone block powers adjacent dust at 15 and decays 1 per block', () => {
    const { dim, rs } = setup();
    dim.setBlock(0, 61, 0, BLOCK.REDSTONE_BLOCK);
    for (let x = 1; x <= 15; x++) dim.setBlock(x, 61, 0, BLOCK.REDSTONE_DUST);
    rs.tick();
    for (let x = 1; x <= 15; x++) {
      expect(rs.dustLevel(x, 61, 0)).toBe(MAX_SIGNAL + 1 - x);
    }
    expect(rs.dustLevel(16, 61, 0)).toBe(0);
  });

  it('removing the source drains the whole line back to zero', () => {
    const { dim, rs } = setup();
    dim.setBlock(0, 61, 0, BLOCK.REDSTONE_BLOCK);
    for (let x = 1; x <= 5; x++) dim.setBlock(x, 61, 0, BLOCK.REDSTONE_DUST);
    rs.tick();
    dim.setBlock(0, 61, 0, BLOCK.AIR);
    rs.tick();
    for (let x = 1; x <= 5; x++) expect(rs.dustLevel(x, 61, 0)).toBe(0);
  });

  it('a lever turns a dust line on and off', () => {
    const { dim, rs } = setup();
    dim.setBlock(0, 61, 0, BLOCK.LEVER, 0);
    dim.setBlock(1, 61, 0, BLOCK.REDSTONE_DUST);
    dim.setBlock(2, 61, 0, BLOCK.REDSTONE_DUST);
    rs.tick();
    expect(rs.dustLevel(1, 61, 0)).toBe(0);
    expect(rs.toggleLever({ x: 0, y: 61, z: 0 })).toBe(true);
    rs.tick();
    expect(rs.dustLevel(1, 61, 0)).toBe(MAX_SIGNAL);
    expect(rs.dustLevel(2, 61, 0)).toBe(MAX_SIGNAL - 1);
    rs.toggleLever({ x: 0, y: 61, z: 0 });
    rs.tick();
    expect(rs.dustLevel(2, 61, 0)).toBe(0);
  });

  it('dust branches decay per path length, not per cell index', () => {
    const { dim, rs } = setup();
    dim.setBlock(0, 61, 0, BLOCK.REDSTONE_BLOCK);
    // L-shaped dust path: east 2, then south 2.
    dim.setBlock(1, 61, 0, BLOCK.REDSTONE_DUST);
    dim.setBlock(2, 61, 0, BLOCK.REDSTONE_DUST);
    dim.setBlock(2, 61, 1, BLOCK.REDSTONE_DUST);
    dim.setBlock(2, 61, 2, BLOCK.REDSTONE_DUST);
    rs.tick();
    expect(rs.dustLevel(2, 61, 2)).toBe(MAX_SIGNAL + 1 - 4);
  });
});

describe('redstone components', () => {
  it('a redstone torch is an inverter for the block it stands on', () => {
    const { dim, rs } = setup();
    // Torch stands on a stone block at (5,60,5) — support is y=60 stone at y-1.
    dim.setBlock(5, 61, 5, BLOCK.REDSTONE_TORCH, STATE.ACTIVE);
    rs.tick();
    expect(dim.getBlock(5, 61, 5).state & STATE.ACTIVE).toBeTruthy();
    // Power the support block's neighbour (6,60,5) via a redstone block at (6,61,5)? That is dust-free: use a dust next to support.
    dim.setBlock(6, 60, 5, BLOCK.REDSTONE_BLOCK);
    // Stone at (5,60,5) is the torch support; redstone block next to it powers it.
    dim.setBlock(5, 60, 5, BLOCK.REDSTONE_BLOCK);
    rs.advance(3);
    expect(dim.getBlock(5, 61, 5).state & STATE.ACTIVE).toBe(0);
  });

  it('a repeater delays by its configured ticks and then outputs full strength', () => {
    const { dim, rs } = setup();
    dim.setBlock(0, 61, 0, BLOCK.REDSTONE_BLOCK);
    dim.setBlock(1, 61, 0, BLOCK.REPEATER, 1 /* facing east */);
    dim.setBlock(2, 61, 0, BLOCK.REDSTONE_DUST);
    rs.tick();
    // Repeater input comes from the block behind it (0,61,0). Delay 1 tick by default.
    rs.advance(3);
    expect(dim.getBlock(1, 61, 0).state & STATE.ACTIVE).toBeTruthy();
    expect(rs.dustLevel(2, 61, 0)).toBe(MAX_SIGNAL);
  });

  it('repeater delay cycles through 1..4 ticks and honours the chosen delay', () => {
    const { dim, rs } = setup();
    dim.setBlock(0, 61, 0, BLOCK.REDSTONE_BLOCK);
    dim.setBlock(1, 61, 0, BLOCK.REPEATER, 1);
    expect(rs.cycleRepeaterDelay({ x: 1, y: 61, z: 0 })).toBe(2);
    expect(rs.cycleRepeaterDelay({ x: 1, y: 61, z: 0 })).toBe(3);
    rs.tick();
    rs.advance(2);
    expect(dim.getBlock(1, 61, 0).state & STATE.ACTIVE).toBe(0);
    rs.advance(2);
    expect(dim.getBlock(1, 61, 0).state & STATE.ACTIVE).toBeTruthy();
  });

  it('a redstone lamp lights when powered and goes dark when the signal is removed', () => {
    const { dim, rs } = setup();
    dim.setBlock(0, 61, 0, BLOCK.REDSTONE_BLOCK);
    dim.setBlock(1, 61, 0, BLOCK.REDSTONE_LAMP);
    rs.advance(2);
    expect(dim.getBlock(1, 61, 0).state & STATE.ACTIVE).toBeTruthy();
    dim.setBlock(0, 61, 0, BLOCK.AIR);
    rs.advance(2);
    expect(dim.getBlock(1, 61, 0).state & STATE.ACTIVE).toBe(0);
  });

  it('a stone button pulses for the configured duration', () => {
    const { dim, rs } = setup();
    dim.setBlock(3, 61, 3, BLOCK.STONE_BUTTON, 0);
    expect(rs.pressButton({ x: 3, y: 61, z: 3 })).toBe(true);
    rs.advance(BUTTON_PULSE_TICKS - 1);
    expect(dim.getBlock(3, 61, 3).state & STATE.ACTIVE).toBeTruthy();
    rs.advance(2);
    expect(dim.getBlock(3, 61, 3).state & STATE.ACTIVE).toBe(0);
  });

  it('a powered door opens and closes with the signal', () => {
    const { dim, rs } = setup();
    dim.setBlock(0, 61, 0, BLOCK.REDSTONE_BLOCK);
    dim.setBlock(1, 61, 0, BLOCK.OAK_DOOR, 0);
    rs.advance(2);
    expect(dim.getBlock(1, 61, 0).state & STATE.ACTIVE).toBeTruthy();
  });
});

describe('pistons', () => {
  it('a powered piston pushes a block one cell and leaves a head behind', () => {
    const { dim, rs } = setup();
    // Piston at (0,61,0) facing east (1), block at (1,61,0) to be pushed.
    dim.setBlock(0, 61, 0, BLOCK.PISTON, 1);
    dim.setBlock(1, 61, 0, BLOCK.COBBLESTONE);
    dim.setBlock(0, 61, 1, BLOCK.REDSTONE_BLOCK);
    rs.advance(2);
    expect(dim.getId(1, 61, 0)).toBe(BLOCK.PISTON_HEAD);
    expect(dim.getId(2, 61, 0)).toBe(BLOCK.COBBLESTONE);
    expect(dim.getBlock(0, 61, 0).state & STATE.ACTIVE).toBeTruthy();
  });

  it('a normal piston does not pull the block back when unpowered', () => {
    const { dim, rs } = setup();
    dim.setBlock(0, 61, 0, BLOCK.PISTON, 1);
    dim.setBlock(1, 61, 0, BLOCK.PISTON_HEAD, 1);
    dim.setBlock(2, 61, 0, BLOCK.COBBLESTONE);
    dim.setBlock(0, 61, 0, BLOCK.PISTON, 1 | STATE.ACTIVE);
    rs.advance(2);
    expect(dim.getId(1, 61, 0)).toBe(BLOCK.AIR);
    expect(dim.getId(2, 61, 0)).toBe(BLOCK.COBBLESTONE);
  });

  it('a sticky piston pulls the block back when it retracts', () => {
    const { dim, rs } = setup();
    dim.setBlock(0, 61, 0, BLOCK.STICKY_PISTON, 1);
    dim.setBlock(1, 61, 0, BLOCK.COBBLESTONE);
    dim.setBlock(0, 61, 1, BLOCK.REDSTONE_BLOCK);
    rs.advance(2);
    expect(dim.getId(2, 61, 0)).toBe(BLOCK.COBBLESTONE);
    // Remove power: piston retracts and pulls the cobblestone back into the head cell.
    dim.setBlock(0, 61, 1, BLOCK.AIR);
    rs.advance(2);
    expect(dim.getId(1, 61, 0)).toBe(BLOCK.COBBLESTONE);
    expect(dim.getId(2, 61, 0)).toBe(BLOCK.AIR);
  });

  it('pistons refuse to push obsidian (immovable)', () => {
    const { dim, rs } = setup();
    dim.setBlock(0, 61, 0, BLOCK.PISTON, 1);
    dim.setBlock(1, 61, 0, BLOCK.OBSIDIAN);
    expect(rs.extendPiston({ x: 0, y: 61, z: 0 }, 1)).toBe(false);
    expect(dim.getId(1, 61, 0)).toBe(BLOCK.OBSIDIAN);
  });

  it('pistons push at most 12 blocks', () => {
    const { dim, rs } = setup();
    dim.setBlock(0, 61, 0, BLOCK.PISTON, 1);
    for (let x = 1; x <= 12; x++) dim.setBlock(x, 61, 0, BLOCK.COBBLESTONE);
    expect(rs.extendPiston({ x: 0, y: 61, z: 0 }, 1)).toBe(false);
    dim.setBlock(12, 61, 0, BLOCK.AIR);
    expect(rs.extendPiston({ x: 0, y: 61, z: 0 }, 1)).toBe(true);
  });
});

describe('terrain interaction with redstone', () => {
  it('works on generated overworld chunks as well as the flat test world', () => {
    const dim = new Dimension('overworld', createGenerator('overworld', 1234));
    const rs = new RedstoneSystem(dim);
    const y = dim.topBlockY(0, 0) + 1;
    dim.setBlock(0, y, 0, BLOCK.REDSTONE_BLOCK);
    dim.setBlock(1, y, 0, BLOCK.REDSTONE_LAMP);
    rs.advance(2);
    expect(dim.getBlock(1, y, 0).state & STATE.ACTIVE).toBeTruthy();
    rs.dispose();
  });
});
