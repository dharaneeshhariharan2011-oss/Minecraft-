import { BLOCK, STATE, facingOf, type BlockDef, type BlockRegistry } from '../../shared/world/blocks.js';
import { CHUNK_SIZE, Chunk, WORLD_HEIGHT, type Dimension } from '../../shared/world/dimension.js';

/** Raw geometry for one render layer. Positions are in world units; normals are unit vectors. */
export interface MeshLayer {
  positions: number[];
  normals: number[];
  colors: number[];
  indices: number[];
}

export interface ChunkMesh {
  opaque: MeshLayer;
  transparent: MeshLayer;
}

export function emptyLayer(): MeshLayer {
  return { positions: [], normals: [], colors: [], indices: [] };
}

/** Axis-aligned box in block-local coordinates (0..1 per axis). */
export type Box = [number, number, number, number, number, number];

/** Shading per face direction, a cheap stand-in for lighting. */
const FACE_SHADE = { px: 0.8, nx: 0.8, pz: 0.7, nz: 0.7, py: 1, ny: 0.5 } as const;

/** Adds a quad (4 corners in winding order) to a layer. */
export function addQuad(
  layer: MeshLayer,
  corners: ReadonlyArray<readonly [number, number, number]>,
  normal: readonly [number, number, number],
  color: readonly [number, number, number],
): void {
  const base = layer.positions.length / 3;
  for (const [x, y, z] of corners) {
    layer.positions.push(x, y, z);
    layer.normals.push(normal[0], normal[1], normal[2]);
    layer.colors.push(color[0], color[1], color[2]);
  }
  layer.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/** Splits a 0xRRGGBB colour into shaded floats. */
export function colorOf(hex: number, shade = 1): [number, number, number] {
  return [((hex >> 16) & 255) / 255 * shade, ((hex >> 8) & 255) / 255 * shade, (hex & 255) / 255 * shade];
}

/** Adds a box's six faces (no culling). Used for non-cube shapes. */
export function addBox(layer: MeshLayer, box: Box, ox: number, oy: number, oz: number, hex: number): void {
  const [x0, y0, z0, x1, y1, z1] = box;
  const X0 = ox + x0;
  const Y0 = oy + y0;
  const Z0 = oz + z0;
  const X1 = ox + x1;
  const Y1 = oy + y1;
  const Z1 = oz + z1;
  addQuad(layer, [[X1, Y0, Z0], [X1, Y1, Z0], [X1, Y1, Z1], [X1, Y0, Z1]], [1, 0, 0], colorOf(hex, FACE_SHADE.px));
  addQuad(layer, [[X0, Y0, Z1], [X0, Y1, Z1], [X0, Y1, Z0], [X0, Y0, Z0]], [-1, 0, 0], colorOf(hex, FACE_SHADE.nx));
  addQuad(layer, [[X0, Y1, Z1], [X1, Y1, Z1], [X1, Y1, Z0], [X0, Y1, Z0]], [0, 1, 0], colorOf(hex, FACE_SHADE.py));
  addQuad(layer, [[X0, Y0, Z0], [X1, Y0, Z0], [X1, Y0, Z1], [X0, Y0, Z1]], [0, -1, 0], colorOf(hex, FACE_SHADE.ny));
  addQuad(layer, [[X1, Y0, Z1], [X1, Y1, Z1], [X0, Y1, Z1], [X0, Y0, Z1]], [0, 0, 1], colorOf(hex, FACE_SHADE.pz));
  addQuad(layer, [[X0, Y0, Z0], [X0, Y1, Z0], [X1, Y1, Z0], [X1, Y0, Z0]], [0, 0, -1], colorOf(hex, FACE_SHADE.nz));
}

/** Boxes that approximate a non-cube block shape. Coordinates are block-local. */
export function shapeBoxes(def: BlockDef, state: number, neighbourFence?: { n: boolean; e: boolean; s: boolean; w: boolean }): Box[] {
  switch (def.shape) {
    case 'slab':
      return state & STATE.FLAG ? [[0, 0.5, 0, 1, 1, 1]] : [[0, 0, 0, 1, 0.5, 1]];
    case 'stairs':
      return [
        [0, 0, 0, 1, 0.5, 1],
        facingOf(state) === 0 ? [0, 0.5, 0, 1, 1, 0.5] : facingOf(state) === 2 ? [0, 0.5, 0.5, 1, 1, 1] : facingOf(state) === 1 ? [0.5, 0.5, 0, 1, 1, 1] : [0, 0.5, 0, 0.5, 1, 1],
      ];
    case 'fence': {
      const boxes: Box[] = [[0.375, 0, 0.375, 0.625, 1, 0.625]];
      const n = neighbourFence ?? { n: false, e: false, s: false, w: false };
      if (n.n) boxes.push([0.4375, 0.375, 0, 0.5625, 0.875, 0.375]);
      if (n.s) boxes.push([0.4375, 0.375, 0.625, 0.5625, 0.875, 1]);
      if (n.e) boxes.push([0.625, 0.375, 0.4375, 1, 0.875, 0.5625]);
      if (n.w) boxes.push([0, 0.375, 0.4375, 0.375, 0.875, 0.5625]);
      return boxes;
    }
    case 'door': {
      const open = (state & STATE.ACTIVE) !== 0;
      const f = facingOf(state);
      if (!open) return f % 2 === 0 ? [[0, 0, 0.84, 1, 1, 1]] : [[0.84, 0, 0, 1, 1, 1]];
      return f % 2 === 0 ? [[0, 0, 0, 0.16, 1, 1]] : [[0, 0, 0, 1, 1, 0.16]];
    }
    case 'torch':
      return [[0.4375, 0, 0.4375, 0.5625, 0.75, 0.5625]];
    case 'lever':
      return [[0.375, 0, 0.375, 0.625, 0.25, 0.625]];
    case 'button':
      return state & STATE.ACTIVE ? [[0.3125, 0.375, 0.375, 0.6875, 0.5, 0.625]] : [[0.3125, 0.375, 0.375, 0.6875, 0.5625, 0.625]];
    case 'repeater':
      return [[0, 0, 0, 1, 0.125, 1]];
    case 'piston':
    case 'piston_head':
      return [[0, 0, 0, 1, 1, 1]];
    case 'portal':
      return [[0.0, 0.0, 0.0, 1, 1, 1]];
    default:
      return [[0, 0, 0, 1, 1, 1]];
  }
}

/** Dust colour depends on its signal strength (0..15), as in Bedrock. */
export function dustColor(level: number): number {
  const t = Math.min(1, Math.max(0, level / 15));
  const r = Math.round(90 + 165 * t);
  const g = Math.round(20 * t);
  const b = 0;
  return (r << 16) | (g << 8) | b;
}

export interface MeshOptions {
  registry: BlockRegistry;
}

/** Builds render geometry for one chunk. Pure: no three.js, so it is unit-testable. */
export function buildChunkMesh(dim: Dimension, chunk: Chunk, options: MeshOptions): ChunkMesh {
  const opaque = emptyLayer();
  const transparent = emptyLayer();
  const { registry } = options;
  const baseX = chunk.cx * CHUNK_SIZE;
  const baseZ = chunk.cz * CHUNK_SIZE;
  const isFullOpaque = (id: number): boolean => {
    const d = registry.tryGet(id);
    return !!d && d.opaque && d.shape === 'cube';
  };

  for (let y = 0; y < WORLD_HEIGHT; y++) {
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const idx = Chunk.index(lx, y, lz);
        const id = chunk.ids[idx] ?? 0;
        if (id === BLOCK.AIR) continue;
        const def = registry.get(id);
        const state = chunk.states[idx] ?? 0;
        const x = baseX + lx;
        const z = baseZ + lz;
        const layer = def.opaque && def.shape === 'cube' ? opaque : transparent;

        if (def.shape === 'cube') {
          const hex = def.color;
          const faces: Array<{ dx: number; dy: number; dz: number; emit: () => void }> = [
            { dx: 1, dy: 0, dz: 0, emit: () => addFace(layer, 'px', x, y, z, hex) },
            { dx: -1, dy: 0, dz: 0, emit: () => addFace(layer, 'nx', x, y, z, hex) },
            { dx: 0, dy: 1, dz: 0, emit: () => addFace(layer, 'py', x, y, z, hex) },
            { dx: 0, dy: -1, dz: 0, emit: () => addFace(layer, 'ny', x, y, z, hex) },
            { dx: 0, dy: 0, dz: 1, emit: () => addFace(layer, 'pz', x, y, z, hex) },
            { dx: 0, dy: 0, dz: -1, emit: () => addFace(layer, 'nz', x, y, z, hex) },
          ];
          for (const f of faces) {
            const nid = dim.getId(x + f.dx, y + f.dy, z + f.dz);
            if (nid === id && !def.opaque) continue; // no internal faces inside glass/leaves
            if (isFullOpaque(nid)) continue;
            f.emit();
          }
          continue;
        }

        if (def.shape === 'liquid') {
          const above = dim.getId(x, y + 1, z);
          if (above !== id) {
            const top = def.id === BLOCK.LAVA ? 0.9 : 0.85;
            addQuad(transparent, [[x, y + top, z], [x, y + top, z + 1], [x + 1, y + top, z + 1], [x + 1, y + top, z]], [0, 1, 0], colorOf(def.color, FACE_SHADE.py));
          }
          continue;
        }

        if (def.shape === 'cross') {
          const c = colorOf(def.color, 1);
          addQuad(transparent, [[x, y, z], [x, y + 1, z], [x + 1, y + 1, z + 1], [x + 1, y, z + 1]], [0, 1, 0], c);
          addQuad(transparent, [[x + 1, y, z], [x + 1, y + 1, z], [x, y + 1, z + 1], [x, y, z + 1]], [0, 1, 0], c);
          continue;
        }

        if (def.shape === 'redstone') {
          // Dust stores its signal level (0..15) in the low bits of its state.
          const level = state & 0xf;
          const top = y + 0.0625;
          const color = colorOf(dustColor(level), FACE_SHADE.py);
          addQuad(transparent, [[x, top, z], [x, top, z + 1], [x + 1, top, z + 1], [x + 1, top, z]], [0, 1, 0], color);
          continue;
        }

        const fence = def.shape === 'fence'
          ? {
              n: dim.registry.tryGet(dim.getId(x, y, z - 1))?.shape === 'fence' || isFullOpaque(dim.getId(x, y, z - 1)),
              s: dim.registry.tryGet(dim.getId(x, y, z + 1))?.shape === 'fence' || isFullOpaque(dim.getId(x, y, z + 1)),
              e: dim.registry.tryGet(dim.getId(x + 1, y, z))?.shape === 'fence' || isFullOpaque(dim.getId(x + 1, y, z)),
              w: dim.registry.tryGet(dim.getId(x - 1, y, z))?.shape === 'fence' || isFullOpaque(dim.getId(x - 1, y, z)),
            }
          : undefined;
        const targetLayer = def.opaque ? opaque : transparent;
        for (const box of shapeBoxes(def, state, fence)) addBox(targetLayer, box, x, y, z, def.color);
      }
    }
  }
  return { opaque, transparent };
}

function addFace(layer: MeshLayer, face: keyof typeof FACE_SHADE, x: number, y: number, z: number, hex: number): void {
  const shade = FACE_SHADE[face];
  const c = colorOf(hex, shade);
  switch (face) {
    case 'px':
      addQuad(layer, [[x + 1, y, z], [x + 1, y + 1, z], [x + 1, y + 1, z + 1], [x + 1, y, z + 1]], [1, 0, 0], c);
      break;
    case 'nx':
      addQuad(layer, [[x, y, z + 1], [x, y + 1, z + 1], [x, y + 1, z], [x, y, z]], [-1, 0, 0], c);
      break;
    case 'py':
      addQuad(layer, [[x, y + 1, z + 1], [x + 1, y + 1, z + 1], [x + 1, y + 1, z], [x, y + 1, z]], [0, 1, 0], c);
      break;
    case 'ny':
      addQuad(layer, [[x, y, z], [x + 1, y, z], [x + 1, y, z + 1], [x, y, z + 1]], [0, -1, 0], c);
      break;
    case 'pz':
      addQuad(layer, [[x + 1, y, z + 1], [x + 1, y + 1, z + 1], [x, y + 1, z + 1], [x, y, z + 1]], [0, 0, 1], c);
      break;
    case 'nz':
      addQuad(layer, [[x, y, z], [x, y + 1, z], [x + 1, y + 1, z], [x + 1, y, z]], [0, 0, -1], c);
      break;
  }
}

