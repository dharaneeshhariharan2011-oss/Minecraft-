import { Game, type GameInput, type GameMode } from './game.js';
import { Renderer } from './renderer.js';
import { Input } from './input.js';
import { NetSession, accountId, type SessionInfo, type StoredSession, type LinkStatus } from '../net/session.js';
import { PeerMesh, type LinkKind } from '../net/mesh.js';
import type { ContentRegistry } from '../../shared/packs/registry.js';
import type { GameMessage, PlayerSnapshot, RtcPayload } from '../../shared/protocols/messages.js';
import type { Role } from '../../shared/protocols/roles.js';
import { canEditBlocks } from '../../shared/protocols/roles.js';
import { DIMENSION_IDS, WORLD_HEIGHT, type DimensionId } from '../../shared/world/dimension.js';
import type { Difficulty } from '../../shared/survival/stats.js';

/** Host-side limits for accepting block edits from clients. */
const MAX_EDIT_REACH = 16;
const POS_INTERVAL = 0.1;
const PLAYERS_INTERVAL = 0.1;
const MOBS_INTERVAL = 0.2;

const NEUTRAL: GameInput = {
  forward: 0,
  strafe: 0,
  jump: false,
  sneak: false,
  sprint: false,
  glide: false,
  hasElytra: false,
  lookDx: 0,
  lookDy: 0,
  breaking: false,
  use: false,
  hotbar: -1,
};

/** Everything the UI needs to show. The app pushes these; the UI never reaches into the game. */
export interface AppUi {
  toast(text: string): void;
  status(status: LinkStatus, detail?: string): void;
  roster(info: SessionInfo): void;
  chat(name: string, text: string): void;
  panel(kind: 'crafting' | 'trade' | 'inventory' | null, data?: { villagerId?: string; size?: number }): void;
  hud(game: Game, mode: GameMode, link: LinkKind | null): void;
  died(): void;
  screen(name: 'menu' | 'play' | 'waiting' | 'ended', detail?: string): void;
  damaged(amount: number): void;
  panelOpen(): boolean;
  openChat(): void;
}

export interface HostOptions {
  name: string;
  difficulty?: Difficulty;
  seed?: number;
}

/**
 * Wires the simulation, renderer, input, networking and UI together. A single class owns the
 * game loop so the three modes (single player, host, joiner) share one code path.
 */
export class GameApp {
  game: Game | null = null;
  mode: GameMode = 'single';
  mesh: PeerMesh | null = null;
  readonly net: NetSession;
  readonly input: Input;
  private renderer: Renderer | null = null;
  private info: SessionInfo | null = null;
  private names = new Map<string, { name: string; role: Role }>();
  private known = new Set<string>();
  private linkKinds = new Map<string, LinkKind>();
  private posTimer = 0;
  private playersTimer = 0;
  private mobsTimer = 0;
  private last = 0;
  private running = false;
  private localName = 'Player';
  private difficulty: Difficulty = 'normal';
  private pendingSync: GameMessage[] = [];

  constructor(
    private readonly content: ContentRegistry,
    private readonly canvas: HTMLCanvasElement,
    private readonly ui: AppUi,
  ) {
    this.input = new Input(canvas);
    this.net = new NetSession(this.signalUrl(), {
      status: (s, d) => {
        this.ui.status(s, d);
        if (s === 'ended') this.stop(d ?? 'the session ended');
      },
      roster: (info) => this.onRoster(info),
      rtc: (from, payload) => void this.mesh?.handleRtc(from, payload as RtcPayload),
      game: (from, payload) => this.onGame(from, payload),
      chat: (from, name, text) => this.onChat(from, name, text),
      removed: (reason) => this.stop(reason === 'banned' ? 'You were banned from this session' : reason === 'kicked' ? 'You were removed by the host' : 'The session was closed'),
      error: (code, message) => {
        if (code !== 'unknown_player') this.ui.toast(message);
      },
    });
    this.input.onInventory = () => this.togglePanel('inventory');
    this.input.onChat = () => this.ui.openChat();
    this.input.onEscape = () => {
      if (this.ui.panelOpen()) this.ui.panel(null);
      else if (document.pointerLockElement) document.exitPointerLock();
    };
  }

  private signalUrl(): string {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  // ---------------------------------------------------------------- session start

  /** Solo world, no networking. */
  startSingle(name: string, difficulty: Difficulty = 'normal'): void {
    this.localName = name;
    this.difficulty = difficulty;
    this.mode = 'single';
    this.createGame(Math.floor(Math.random() * 0x7fffffff), 'single', 'local');
    this.beginPlay();
  }

  /** Creates a session on the signaling server and becomes its authoritative host. */
  async startHost(opts: HostOptions): Promise<void> {
    this.localName = opts.name;
    this.difficulty = opts.difficulty ?? 'normal';
    this.mode = 'host';
    const info = await this.net.host(opts.name, accountId());
    this.info = info;
    const seed = opts.seed ?? Math.floor(Math.random() * 0x7fffffff);
    this.createGame(seed, 'host', info.playerId);
    this.mesh = new PeerMesh(this.net, info.playerId, true, info.playerId, (from, msg) => this.onGame(from, msg), undefined, (id, kind) => this.onLink(id, kind));
    this.known = new Set(info.roster.map((r) => r.playerId));
    this.beginPlay();
  }

  /** Joins an existing session. Play starts when the host's world arrives. */
  async startJoin(code: string, name: string): Promise<void> {
    this.localName = name;
    this.mode = 'client';
    const info = await this.net.join(code, name, accountId());
    this.afterJoin(info);
  }

  /** Resumes a seat stored in this tab (reload or reconnect). */
  async resumeStored(stored: StoredSession): Promise<void> {
    this.localName = stored.name;
    const info = await this.net.resumeStored(stored);
    this.mode = info.playerId === info.hostId ? 'host' : 'client';
    this.afterJoin(info);
  }

  private afterJoin(info: SessionInfo): void {
    this.info = info;
    this.mesh = new PeerMesh(this.net, info.playerId, info.playerId === info.hostId, info.hostId, (from, msg) => this.onGame(from, msg), undefined, (id, kind) => this.onLink(id, kind));
    this.known = new Set(info.roster.map((r) => r.playerId));
    this.mesh.connectToHost();
    if (this.mode === 'host') {
      // Resumed as host: the in-memory world is gone, so the session ends rather than diverging.
      this.stop('the host world was lost; start a new session');
      return;
    }
    this.ui.screen('waiting');
    this.ui.toast('Connected. Waiting for the host world...');
  }

  private createGame(seed: number, mode: GameMode, localId: string): void {
    const game = new Game({
      content: this.content,
      mode,
      seed,
      name: this.localName,
      difficulty: this.difficulty,
      deferWorld: mode === 'client',
      callbacks: {
        message: (text) => this.ui.toast(text),
        openPanel: (kind, data) => this.ui.panel(kind, data),
        damaged: (amount) => this.ui.damaged(amount),
        died: () => this.onDeath(),
        dimensionChanged: (id) => this.ui.toast(`Dimension: ${id}`),
        blockChanged: (change) => this.onBlockChanged(change),
      },
    });
    game.localId = localId;
    this.game = game;
    if (this.renderer) this.renderer.dispose();
    this.renderer = new Renderer(this.canvas, this.content, game);
    this.resize();
  }

  private beginPlay(): void {
    this.running = true;
    this.ui.screen('play');
    this.last = performance.now();
    // A new loop id retires any frame callback still queued by a previous game.
    const id = ++this.loopId;
    requestAnimationFrame((t) => this.frame(t, id));
  }

  private loopId = 0;

  resize(): void {
    const w = this.canvas.clientWidth || innerWidth;
    const h = this.canvas.clientHeight || innerHeight;
    this.renderer?.resize(w, h);
  }

  /** Leaves the current game and returns to the menu. */
  stop(detail?: string): void {
    this.running = false;
    this.mesh?.close();
    this.mesh = null;
    this.renderer?.dispose();
    this.renderer = null;
    this.game = null;
    this.info = null;
    this.ui.screen('ended', detail);
  }

  leave(): void {
    this.net.leave();
    this.stop('You left the session');
  }

  // ---------------------------------------------------------------- roster and game traffic

  private onRoster(info: SessionInfo): void {
    this.info = info;
    this.names = new Map(info.roster.map((r) => [r.playerId, { name: r.name, role: r.role }]));
    this.ui.roster(info);
    if (this.mode === 'host' && this.mesh) {
      // Send the full world to every newly seen player (the host's copy is authoritative).
      for (const r of info.roster) {
        if (r.playerId === info.playerId || this.known.has(r.playerId)) continue;
        this.known.add(r.playerId);
        for (const msg of this.game?.world.syncMessages() ?? []) this.mesh.send(r.playerId, msg);
      }
      this.mesh.retain(info.roster.map((r) => r.playerId));
      for (const id of [...this.known]) if (!info.roster.some((r) => r.playerId === id)) this.known.delete(id);
    }
  }

  private onLink(id: string, kind: LinkKind): void {
    this.linkKinds.set(id, kind);
  }

  /** Current transport to the host (client) or to the given peer (host). */
  linkToHost(): LinkKind | null {
    if (!this.info || !this.mesh) return null;
    if (this.mode === 'host') return null;
    return this.mesh.kindOf(this.info.hostId);
  }

  private onChat(from: string, name: string, text: string): void {
    this.game?.pushChat(name, text);
    this.ui.chat(name, text);
    void from;
  }

  /** Sends a chat line to the room (and echoes it locally). */
  sendChat(text: string): void {
    const clean = text.trim().slice(0, 200);
    if (!clean) return;
    if (this.mode === 'single') {
      this.ui.chat(this.localName, clean);
      return;
    }
    this.net.chat(clean);
  }

  private onGame(from: string, msg: GameMessage): void {
    if (this.mode === 'host') {
      this.hostHandle(from, msg);
      return;
    }
    if (msg.t === 'worldSync') {
      this.pendingSync.push(msg);
      if (!this.game) {
        // First world sync creates the client world with the host's seed, then applies every edit.
        const seed = msg.seed;
        this.createGame(seed, 'client', this.info?.playerId ?? '');
        for (const m of this.pendingSync) this.game!.handleNetMessage(this.info?.hostId ?? '', this.nameOf(this.info?.hostId ?? ''), 'host', m);
        this.pendingSync = [];
        this.game!.initialize();
        this.beginPlay();
        this.ui.toast('World received');
      } else {
        this.game.handleNetMessage(from, this.nameOf(from), this.roleOf(from), msg);
      }
      return;
    }
    if (!this.game) return;
    this.game.handleNetMessage(from, this.nameOf(from), this.roleOf(from), msg);
  }

  private nameOf(id: string): string {
    return this.names.get(id)?.name ?? (id === this.info?.hostId ? 'Host' : 'Player');
  }

  private roleOf(id: string): Role {
    return this.names.get(id)?.role ?? 'member';
  }

  /** Host: validates and applies messages from clients, then answers with authoritative state. */
  private hostHandle(from: string, msg: GameMessage): void {
    const game = this.game;
    if (!game) return;
    switch (msg.t) {
      case 'pos':
        game.handleNetMessage(from, this.nameOf(from), this.roleOf(from), msg);
        return;
      case 'blockEdit': {
        if (!canEditBlocks(this.roleOf(from) as Role)) return;
        if (!DIMENSION_IDS.includes(msg.dim as DimensionId)) return;
        if (msg.y < 0 || msg.y >= WORLD_HEIGHT || !this.content.blocks.tryGet(msg.id)) return;
        const remote = game.remote.get(from);
        if (remote && Math.hypot(remote.x - msg.x, remote.y - msg.y, remote.z - msg.z) > MAX_EDIT_REACH) return;
        // Applying through the world listener also broadcasts the authoritative update.
        game.world.dimension(msg.dim as DimensionId).setBlock(msg.x, msg.y, msg.z, msg.id, msg.state);
        return;
      }
      default:
        return;
    }
  }

  /** Local block change: hosts broadcast it, clients send it to the host as an edit. */
  private onBlockChanged(change: { dim: DimensionId; x: number; y: number; z: number; id: number; state: number }): void {
    if (!this.mesh || !this.info) return;
    if (this.mode === 'client') {
      this.mesh.send(this.info.hostId, { t: 'blockEdit', dim: change.dim, x: change.x, y: change.y, z: change.z, id: change.id, state: change.state });
      return;
    }
    if (this.mode === 'host') {
      this.mesh.broadcast({ t: 'blockUpdate', dim: change.dim, x: change.x, y: change.y, z: change.z, id: change.id, state: change.state, by: this.info.playerId });
    }
  }

  // ---------------------------------------------------------------- loop

  private togglePanel(kind: 'inventory'): void {
    if (this.ui.panelOpen()) this.ui.panel(null);
    else this.ui.panel(kind);
  }

  private frame(now: number, id: number): void {
    if (!this.running || id !== this.loopId) return;
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const game = this.game;
    if (game) {
      const panelOpen = this.ui.panelOpen();
      const sampled = this.input.sample();
      const input = panelOpen || game.dead ? { ...NEUTRAL, lookDx: 0, lookDy: 0 } : sampled;
      if (!panelOpen) game.update(dt, input);
      game.maybeSummonWarden();
      game.pruneRemote();
      this.flushOutbox(game);
      this.netTick(dt, game);
      const hit = game.hitTest();
      this.renderer?.render(game, hit, game.breakProgress);
      this.ui.hud(game, this.mode, this.mode === 'client' ? this.linkToHost() : null);
    } else {
      this.input.sample();
    }
    requestAnimationFrame((t) => this.frame(t, id));
  }

  private flushOutbox(game: Game): void {
    if (!this.mesh) return;
    for (const msg of game.outbox.splice(0)) {
      if (msg.t === 'hurt') this.mesh.send(msg.target, msg);
    }
  }

  /** Periodic network traffic: positions from clients; player and mob snapshots from the host. */
  private netTick(dt: number, game: Game): void {
    if (!this.mesh || !this.info) return;
    this.posTimer += dt;
    this.playersTimer += dt;
    this.mobsTimer += dt;
    if (this.posTimer >= POS_INTERVAL) {
      this.posTimer = 0;
      const p = game.player;
      const pos: GameMessage = { t: 'pos', dim: game.dimId, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: Math.max(-90, Math.min(90, (p.pitch * 180) / Math.PI)) };
      if (this.mode === 'client') this.mesh.send(this.info.hostId, pos);
    }
    if (this.mode !== 'host') return;
    if (this.playersTimer >= PLAYERS_INTERVAL) {
      this.playersTimer = 0;
      const p = game.player;
      const list: PlayerSnapshot[] = [
        { id: this.info.playerId, name: this.localName, role: 'host', dim: game.dimId, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: (p.pitch * 180) / Math.PI },
      ];
      for (const [id, r] of game.remote) {
        list.push({ id, name: r.name, role: r.role, dim: r.dim, x: r.x, y: r.y, z: r.z, yaw: r.yaw, pitch: (r.pitch * 180) / Math.PI });
      }
      this.mesh.broadcast({ t: 'players', list });
    }
    if (this.mobsTimer >= MOBS_INTERVAL) {
      this.mobsTimer = 0;
      this.mesh.broadcast({ t: 'mobs', dim: game.dimId, list: game.mobSnapshot() });
    }
  }

  private onDeath(): void {
    this.ui.died();
  }

  respawn(): void {
    this.game?.respawn();
    this.ui.toast('You respawned');
  }

  get sessionInfo(): SessionInfo | null {
    return this.info;
  }
}

export { NEUTRAL };
