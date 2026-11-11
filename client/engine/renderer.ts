import * as THREE from 'three';
import { buildChunkMesh, type MeshLayer } from './mesher.js';
import type { Game, NpcView, RemotePlayer } from './game.js';
import type { ContentRegistry } from '../../shared/packs/registry.js';
import { CHUNK_SIZE, floorDiv, mod, type DimensionId } from '../../shared/world/dimension.js';
import type { RayHit } from './raycast.js';

/** Chunks rendered around the player in each direction. */
export const RENDER_DISTANCE = 4;
/** Chunk meshes rebuilt per frame; keeps frame time bounded when many chunks are dirty. */
const MAX_BUILDS_PER_FRAME = 3;

const SKY: Record<DimensionId, number> = {
  overworld: 0x7ec8f0,
  nether: 0x3a0d0d,
  the_end: 0x0b0716,
};

const MOB_COLORS: Record<string, number> = {
  'minecraft:pig': 0xf2a7b5,
  'minecraft:cow': 0x6b4a2b,
  'minecraft:zombie': 0x4f8a3c,
  'minecraft:warden': 0x0e3b43,
  'minecraft:villager': 0x8a6a4a,
};

function toGeometry(layer: MeshLayer): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(layer.positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(layer.normals, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(layer.colors, 3));
  g.setIndex(layer.indices);
  g.computeBoundingSphere();
  return g;
}

interface ChunkRender {
  opaque: THREE.Mesh;
  transparent: THREE.Mesh;
}

/** Renders the player's world with Three.js. It reads game state and never mutates it. */
export class Renderer {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.05, 500);
  private readonly gl: THREE.WebGLRenderer;
  private readonly opaqueMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  private readonly transparentMat = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.72, depthWrite: false });
  private readonly chunks = new Map<string, ChunkRender>();
  private readonly dirty = new Set<string>();
  private dimId: DimensionId | null = null;
  private readonly mobGroup = new THREE.Group();
  private readonly playerGroup = new THREE.Group();
  private readonly mobMeshes = new Map<string, THREE.Mesh>();
  private readonly playerMeshes = new Map<string, THREE.Group>();
  private readonly selection: THREE.LineSegments;
  private readonly breakOverlay: THREE.Mesh;
  private readonly sun: THREE.DirectionalLight;
  private readonly ambient: THREE.AmbientLight;
  private readonly boxGeometry = new THREE.BoxGeometry(1, 1, 1);
  private readonly mobGeometry = new THREE.BoxGeometry(0.6, 1.2, 0.6);
  private readonly unsubscribe: () => void;

  constructor(canvas: HTMLCanvasElement, private readonly content: ContentRegistry, game: Game) {
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.gl.setSize(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight, false);
    this.scene.add(this.mobGroup, this.playerGroup);
    this.ambient = new THREE.AmbientLight(0xffffff, 0.55);
    this.sun = new THREE.DirectionalLight(0xffffff, 0.8);
    this.sun.position.set(0.4, 1, 0.3);
    this.scene.add(this.ambient, this.sun);
    this.scene.fog = new THREE.Fog(SKY.overworld, 40, 90);

    const edges = new THREE.EdgesGeometry(this.boxGeometry);
    this.selection = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.6 }));
    this.selection.visible = false;
    this.breakOverlay = new THREE.Mesh(this.boxGeometry, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25, depthWrite: false }));
    this.breakOverlay.visible = false;
    this.scene.add(this.selection, this.breakOverlay);

    // Any block change in any dimension marks its chunk (and the neighbour on a border) for rebuild.
    this.unsubscribe = game.world.onBlockChange((change) => {
      const cx = floorDiv(change.x, CHUNK_SIZE);
      const cz = floorDiv(change.z, CHUNK_SIZE);
      this.markDirty(change.dim, cx, cz);
      const lx = mod(change.x, CHUNK_SIZE);
      const lz = mod(change.z, CHUNK_SIZE);
      if (lx === 0) this.markDirty(change.dim, cx - 1, cz);
      if (lx === CHUNK_SIZE - 1) this.markDirty(change.dim, cx + 1, cz);
      if (lz === 0) this.markDirty(change.dim, cx, cz - 1);
      if (lz === CHUNK_SIZE - 1) this.markDirty(change.dim, cx, cz + 1);
    });
    this.camera.rotation.order = 'YXZ';
  }

  dispose(): void {
    this.unsubscribe();
    this.gl.dispose();
  }

  resize(width: number, height: number): void {
    this.gl.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  private markDirty(dim: DimensionId, cx: number, cz: number): void {
    this.dirty.add(`${dim}|${cx},${cz}`);
  }

  private key(dim: DimensionId, cx: number, cz: number): string {
    return `${dim}|${cx},${cz}`;
  }

  /** Streams chunk meshes around the player and places the camera. */
  render(game: Game, selected: RayHit | null, breakProgress: number): void {
    if (this.dimId !== game.dimId) this.switchDimension(game.dimId);
    const dim = game.dim;
    const pcx = floorDiv(Math.floor(game.player.x), CHUNK_SIZE);
    const pcz = floorDiv(Math.floor(game.player.z), CHUNK_SIZE);

    // Build meshes for chunks inside the render distance, nearest first.
    const wanted: Array<[number, number]> = [];
    for (let dx = -RENDER_DISTANCE; dx <= RENDER_DISTANCE; dx++) {
      for (let dz = -RENDER_DISTANCE; dz <= RENDER_DISTANCE; dz++) wanted.push([pcx + dx, pcz + dz]);
    }
    wanted.sort((a, b) => Math.abs(a[0] - pcx) + Math.abs(a[1] - pcz) - (Math.abs(b[0] - pcx) + Math.abs(b[1] - pcz)));
    let builds = 0;
    for (const [cx, cz] of wanted) {
      const k = this.key(game.dimId, cx, cz);
      if (this.chunks.has(k) && !this.dirty.has(k)) continue;
      if (builds >= MAX_BUILDS_PER_FRAME) break;
      const chunk = dim.getChunk(cx, cz);
      this.rebuild(game.dimId, k, dim, chunk);
      this.dirty.delete(k);
      builds++;
    }
    // Unload meshes outside the render distance (with a hysteresis margin).
    for (const [k, mesh] of this.chunks) {
      if (!k.startsWith(`${game.dimId}|`)) continue;
      const [cx, cz] = k.split('|')[1]!.split(',').map(Number) as [number, number];
      if (Math.abs(cx - pcx) > RENDER_DISTANCE + 1 || Math.abs(cz - pcz) > RENDER_DISTANCE + 1) {
        this.scene.remove(mesh.opaque, mesh.transparent);
        mesh.opaque.geometry.dispose();
        mesh.transparent.geometry.dispose();
        this.chunks.delete(k);
      }
    }

    this.updateCamera(game);
    this.updateSelection(selected, breakProgress);
    this.updateEntities(game);
    this.updateSky(game);
    this.gl.render(this.scene, this.camera);
  }

  private switchDimension(id: DimensionId): void {
    for (const mesh of this.chunks.values()) {
      this.scene.remove(mesh.opaque, mesh.transparent);
      mesh.opaque.geometry.dispose();
      mesh.transparent.geometry.dispose();
    }
    this.chunks.clear();
    this.dirty.clear();
    this.dimId = id;
  }

  private rebuild(dimId: DimensionId, k: string, dim: Parameters<typeof buildChunkMesh>[0], chunk: Parameters<typeof buildChunkMesh>[1]): void {
    const old = this.chunks.get(k);
    if (old) {
      this.scene.remove(old.opaque, old.transparent);
      old.opaque.geometry.dispose();
      old.transparent.geometry.dispose();
    }
    const built = buildChunkMesh(dim, chunk, { registry: this.content.blocks });
    const opaque = new THREE.Mesh(toGeometry(built.opaque), this.opaqueMat);
    const transparent = new THREE.Mesh(toGeometry(built.transparent), this.transparentMat);
    opaque.visible = built.opaque.indices.length > 0;
    transparent.visible = built.transparent.indices.length > 0;
    this.scene.add(opaque, transparent);
    this.chunks.set(k, { opaque, transparent });
    void dimId;
  }

  private updateCamera(game: Game): void {
    const eye = game.eye;
    this.camera.position.set(eye.x, eye.y, eye.z);
    this.camera.rotation.set(-game.player.pitch, game.player.yaw, 0, 'YXZ');
  }

  private updateSelection(hit: RayHit | null, progress: number): void {
    if (!hit) {
      this.selection.visible = false;
      this.breakOverlay.visible = false;
      return;
    }
    this.selection.visible = true;
    this.selection.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
    this.breakOverlay.visible = progress > 0;
    this.breakOverlay.position.copy(this.selection.position);
    this.breakOverlay.scale.setScalar(1 + Math.min(progress, 1) * 0.02);
  }

  private updateEntities(game: Game): void {
    const npcs: NpcView[] = game.renderNpcs;
    const seenMobs = new Set<string>();
    for (const npc of npcs) {
      seenMobs.add(npc.id);
      let mesh = this.mobMeshes.get(npc.id);
      if (!mesh) {
        const color = MOB_COLORS[npc.type] ?? 0xcccccc;
        mesh = new THREE.Mesh(this.mobGeometry, new THREE.MeshLambertMaterial({ color }));
        this.mobMeshes.set(npc.id, mesh);
        this.mobGroup.add(mesh);
      }
      mesh.visible = npc.dim === game.dimId;
      mesh.position.set(npc.x, npc.y + 0.6, npc.z);
      mesh.rotation.y = npc.yaw;
    }
    for (const [id, mesh] of this.mobMeshes) {
      if (!seenMobs.has(id)) {
        this.mobGroup.remove(mesh);
        this.mobMeshes.delete(id);
      }
    }

    const seenPlayers = new Set<string>();
    for (const r of game.remote.values()) {
      if (r.dim !== game.dimId) continue;
      seenPlayers.add(r.id);
      let g = this.playerMeshes.get(r.id);
      if (!g) {
        g = this.makePlayerMesh(r);
        this.playerMeshes.set(r.id, g);
        this.playerGroup.add(g);
      }
      g.visible = true;
      g.position.set(r.x, r.y, r.z);
      g.rotation.y = r.yaw;
    }
    for (const [id, g] of this.playerMeshes) {
      if (!seenPlayers.has(id)) {
        this.playerGroup.remove(g);
        g.traverse((o) => {
          if (o instanceof THREE.Sprite) (o.material as THREE.SpriteMaterial).map?.dispose();
        });
        this.playerMeshes.delete(id);
      }
    }
  }

  private makePlayerMesh(r: RemotePlayer): THREE.Group {
    const g = new THREE.Group();
    const body = new THREE.Mesh(this.mobGeometry, new THREE.MeshLambertMaterial({ color: 0x3a7bd5 }));
    body.position.y = 0.9;
    body.scale.set(1, 1.5, 1);
    g.add(body);
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 48;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(0, 0, 256, 48);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 28px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(r.name.slice(0, 16), 128, 34);
    }
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false }));
    sprite.scale.set(1.6, 0.3, 1);
    sprite.position.y = 2.3;
    g.add(sprite);
    return g;
  }

  private updateSky(game: Game): void {
    const day = (game.time % 1200) / 1200;
    const daylight = game.dimId === 'overworld' ? Math.max(0.25, 0.5 + 0.5 * Math.cos(day * Math.PI * 2)) : 0.5;
    const base = new THREE.Color(SKY[game.dimId]);
    const scale = game.dimId === 'overworld' ? daylight : 1;
    this.scene.background = base.clone().multiplyScalar(scale);
    (this.scene.fog as THREE.Fog).color.copy(this.scene.background as THREE.Color);
    this.ambient.intensity = 0.25 + 0.5 * scale;
    this.sun.intensity = 0.2 + 0.7 * scale;
  }
}
