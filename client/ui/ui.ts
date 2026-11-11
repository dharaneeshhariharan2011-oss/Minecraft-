import type { GameApp, AppUi } from '../engine/app.js';
import type { Game, GameMode } from '../engine/game.js';
import type { LinkStatus, SessionInfo } from '../net/session.js';
import { loadStoredSession, clearStoredSession } from '../net/session.js';
import type { LinkKind } from '../net/mesh.js';
import { ARMOR_SLOTS, MAIN_SLOTS, OFFHAND_SLOT } from '../../shared/survival/inventory.js';
import { canModerate, type Role } from '../../shared/protocols/roles.js';
import { isValidJoinCode, normalizeJoinCode } from '../../shared/protocols/joinCode.js';
import { sanitizeName } from '../../shared/protocols/messages.js';
import type { Grid } from '../../shared/crafting/recipes.js';

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const label = (id: string): string => id.replace(/^[a-z_]+:/, '').replace(/_/g, ' ');

/** DOM overlay: menu, HUD, chat, roster, panels, touch controls. Reads state from the app; never mutates the simulation directly. */
export class UI implements AppUi {
  private panelKind: 'crafting' | 'trade' | 'inventory' | null = null;
  private panelData: { villagerId?: string; size?: number } = {};
  private grid: Grid = [
    [null, null, null],
    [null, null, null],
    [null, null, null],
  ];
  private gridSize = 2;
  private lastPanelRender = 0;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private damageTimer: ReturnType<typeof setTimeout> | null = null;
  private info: SessionInfo | null = null;
  private roleOf: Role = 'member';
  private rosterOpen = true;

  readonly root: HTMLElement;

  constructor(
    host: HTMLElement,
    private readonly getApp: () => GameApp,
  ) {
    this.root = host;
    this.root.innerHTML = `
      <div id="menu" class="overlay">
        <h1>Minecraft by DH</h1>
        <p class="sub">Bedrock Edition</p>
        <label>Name <input id="name" maxlength="16" value="${esc(localStorage.getItem('mcbh.name') ?? 'Steve')}" /></label>
        <div class="row">
          <button id="btn-single">Singleplayer</button>
          <button id="btn-host">Host session</button>
        </div>
        <div class="row">
          <input id="code" inputmode="numeric" maxlength="6" placeholder="6-digit code" />
          <button id="btn-join">Join</button>
        </div>
        <button id="btn-resume" class="hidden">Resume previous session</button>
        <p id="menu-msg" class="msg"></p>
        <p class="hint">Desktop: click to play, WASD move, mouse look, E inventory, T chat, F glide. Touch controls appear on phones.</p>
      </div>

      <div id="waiting" class="overlay hidden">
        <h2>Connecting to the host world...</h2>
        <p id="waiting-msg"></p>
        <button id="btn-leave-wait">Leave</button>
      </div>

      <div id="ended" class="overlay hidden">
        <h2>Session ended</h2>
        <p id="ended-msg"></p>
        <button id="btn-back">Back to menu</button>
      </div>

      <div id="hud" class="hidden">
        <div id="crosshair">+</div>
        <div id="status-top">
          <span id="dim-label"></span>
          <span id="link-label" class="badge"></span>
          <span id="room-label" class="badge"></span>
          <button id="btn-leave" class="small">Leave</button>
        </div>
        <div id="vitals">
          <div id="health" class="bar hearts"></div>
          <div id="hunger" class="bar food"></div>
        </div>
        <div id="hotbar"></div>
        <div id="roster" class="panel-box"></div>
        <div id="chat">
          <div id="chat-log"></div>
          <input id="chat-input" class="hidden" maxlength="200" placeholder="Say something..." />
        </div>
        <div id="toast"></div>
        <div id="damage" class="hidden"></div>
        <div id="death" class="overlay hidden">
          <h2>You died</h2>
          <button id="btn-respawn">Respawn</button>
        </div>
        <div id="touch" class="hidden">
          <div id="pad-move"><div id="knob"></div></div>
          <div id="pad-look"></div>
          <div id="touch-buttons">
            <button data-t="jump">Jump</button>
            <button data-t="sneak">Sneak</button>
            <button data-t="glide">Glide</button>
            <button data-t="break">Break</button>
            <button data-t="use">Use</button>
            <button data-t="inventory">Inv</button>
          </div>
        </div>
      </div>

      <div id="panel" class="overlay panel-overlay hidden">
        <div class="panel-card">
          <div class="panel-head"><span id="panel-title"></span><button id="btn-close" class="small">Close</button></div>
          <div id="panel-body"></div>
        </div>
      </div>`;
    this.bind();
  }

  private $<T extends HTMLElement = HTMLElement>(id: string): T {
    const el = this.root.querySelector<HTMLElement>(`#${id}`);
    if (!el) throw new Error(`missing element #${id}`);
    return el as T;
  }

  private bind(): void {
    const app = () => this.getApp();
    const name = () => sanitizeName(this.$<HTMLInputElement>('name').value);
    const remember = () => localStorage.setItem('mcbh.name', name());
    this.$('btn-single').onclick = () => {
      remember();
      app().startSingle(name());
    };
    this.$('btn-host').onclick = () => {
      remember();
      this.menuBusy('Creating session...');
      app()
        .startHost({ name: name() })
        .then(() => this.menuBusy(''))
        .catch((e: Error) => this.menuBusy(e.message));
    };
    this.$('btn-join').onclick = () => {
      remember();
      const code = normalizeJoinCode(this.$<HTMLInputElement>('code').value);
      if (!isValidJoinCode(code)) {
        this.menuBusy('Enter the six-digit code from the host.');
        return;
      }
      this.menuBusy('Joining...');
      app()
        .startJoin(code, name())
        .then(() => this.menuBusy(''))
        .catch((e: Error) => this.menuBusy(e.message));
    };
    this.$('btn-resume').onclick = () => {
      const stored = loadStoredSession();
      if (!stored) return;
      this.menuBusy('Resuming...');
      app()
        .resumeStored(stored)
        .then(() => this.menuBusy(''))
        .catch((e: Error) => {
          clearStoredSession();
          this.menuBusy(e.message);
          this.$('btn-resume').classList.add('hidden');
        });
    };
    this.$('btn-leave-wait').onclick = () => app().leave();
    this.$('btn-leave').onclick = () => app().leave();
    this.$('btn-back').onclick = () => {
      this.showScreen('menu');
      this.refreshResume();
    };
    this.$('btn-respawn').onclick = () => {
      this.$('death').classList.add('hidden');
      app().respawn();
    };
    this.$('btn-close').onclick = () => this.panel(null);
    this.$('roster').onclick = (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('button[data-admin]');
      if (!btn) return;
      const [action, target, role] = [btn.dataset.admin!, btn.dataset.target!, btn.dataset.role];
      if (action === 'setRole' && role) app().net.admin('setRole', target, role as Role);
      else if (action === 'kick' || action === 'ban' || action === 'unban') app().net.admin(action, target);
    };
    this.$('panel-body').onclick = (e) => this.onPanelClick(e);
    this.$('hotbar').onclick = (e) => {
      const slot = (e.target as HTMLElement).closest<HTMLElement>('[data-slot]');
      if (slot) app().input.pickHotbar(Number(slot.dataset.slot));
    };

    const chatInput = this.$<HTMLInputElement>('chat-input');
    chatInput.onkeydown = (e) => {
      if (e.key === 'Enter') {
        app().sendChat(chatInput.value);
        chatInput.value = '';
        this.closeChat();
      } else if (e.key === 'Escape') {
        this.closeChat();
      }
      e.stopPropagation();
    };
    const touch = this.$('touch');
    if ('ontouchstart' in window || navigator.maxTouchPoints > 0) touch.classList.remove('hidden');
    this.bindTouch();
    this.refreshResume();
  }

  private bindTouch(): void {
    const input = () => this.getApp().input;
    const move = this.$('pad-move');
    const knob = this.$('knob');
    let origin: { x: number; y: number } | null = null;
    move.addEventListener('pointerdown', (e) => {
      origin = { x: e.clientX, y: e.clientY };
      move.setPointerCapture(e.pointerId);
    });
    move.addEventListener('pointermove', (e) => {
      if (!origin) return;
      const dx = (e.clientX - origin.x) / 50;
      const dy = (e.clientY - origin.y) / 50;
      input().setTouchMove(dx, dy);
      knob.style.transform = `translate(${Math.max(-1, Math.min(1, dx)) * 40}px, ${Math.max(-1, Math.min(1, dy)) * 40}px)`;
    });
    const endMove = () => {
      origin = null;
      input().setTouchMove(0, 0);
      knob.style.transform = '';
    };
    move.addEventListener('pointerup', endMove);
    move.addEventListener('pointercancel', endMove);

    const look = this.$('pad-look');
    let last: { x: number; y: number; t: number; moved: number } | null = null;
    look.addEventListener('pointerdown', (e) => {
      last = { x: e.clientX, y: e.clientY, t: performance.now(), moved: 0 };
      look.setPointerCapture(e.pointerId);
    });
    look.addEventListener('pointermove', (e) => {
      if (!last) return;
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      input().addLook(dx * 0.004, -dy * 0.004);
      last.moved += Math.abs(dx) + Math.abs(dy);
      last.x = e.clientX;
      last.y = e.clientY;
    });
    look.addEventListener('pointerup', () => {
      // A short tap without drag uses the held item or interacts with the target.
      if (last && last.moved < 8 && performance.now() - last.t < 250) input().tapUse();
      last = null;
    });
    look.addEventListener('pointercancel', () => (last = null));

    this.root.querySelectorAll<HTMLButtonElement>('#touch-buttons button').forEach((btn) => {
      const kind = btn.dataset.t!;
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (kind === 'use') input().tapUse();
        else if (kind === 'inventory') this.panel(this.panelKind === 'inventory' ? null : 'inventory');
        else input().setTouchButton(kind as 'break' | 'jump' | 'sneak' | 'glide', true);
      });
      const release = () => {
        if (kind !== 'use' && kind !== 'inventory') input().setTouchButton(kind as 'break' | 'jump' | 'sneak' | 'glide', false);
      };
      btn.addEventListener('pointerup', release);
      btn.addEventListener('pointercancel', release);
      btn.addEventListener('pointerleave', release);
    });
  }

  private refreshResume(): void {
    this.$('btn-resume').classList.toggle('hidden', !loadStoredSession());
  }

  private menuBusy(text: string): void {
    this.$('menu-msg').textContent = text;
  }

  private showScreen(name: 'menu' | 'play' | 'waiting' | 'ended'): void {
    this.$('menu').classList.toggle('hidden', name !== 'menu');
    this.$('waiting').classList.toggle('hidden', name !== 'waiting');
    this.$('ended').classList.toggle('hidden', name !== 'ended');
    this.$('hud').classList.toggle('hidden', name !== 'play');
    if (name !== 'play') this.panel(null);
  }

  // ---------------------------------------------------------------- AppUi

  screen(name: 'menu' | 'play' | 'waiting' | 'ended', detail?: string): void {
    if (name === 'ended') this.$('ended-msg').textContent = detail ?? '';
    if (name === 'waiting') this.$('waiting-msg').textContent = 'Your session is connected. The host sends the world on join.';
    this.showScreen(name);
    if (name === 'menu') this.refreshResume();
    if (name === 'menu' && detail) this.menuBusy(detail);
  }

  panelOpen(): boolean {
    return this.panelKind !== null;
  }

  panel(kind: 'crafting' | 'trade' | 'inventory' | null, data: { villagerId?: string; size?: number } = {}): void {
    this.panelKind = kind;
    this.panelData = data;
    if (kind === 'crafting' && data.size) this.gridSize = data.size;
    if (kind === 'inventory') this.gridSize = 2;
    if (kind && document.pointerLockElement) document.exitPointerLock();
    this.$('panel').classList.toggle('hidden', kind === null);
    this.renderPanel(true);
  }

  toast(text: string): void {
    const el = this.$('toast');
    el.textContent = text;
    el.classList.add('show');
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  damaged(amount: number): void {
    if (amount <= 0) return;
    const el = this.$('damage');
    el.classList.remove('hidden');
    if (this.damageTimer) clearTimeout(this.damageTimer);
    this.damageTimer = setTimeout(() => el.classList.add('hidden'), 220);
  }

  died(): void {
    this.$('death').classList.remove('hidden');
    if (document.pointerLockElement) document.exitPointerLock();
  }

  status(status: LinkStatus, detail?: string): void {
    const el = this.$('room-label');
    const map: Record<LinkStatus, string> = {
      offline: '',
      connecting: 'connecting',
      online: this.info ? `Code ${this.info.code}` : 'online',
      reconnecting: 'reconnecting',
      ended: 'ended',
    };
    el.textContent = map[status];
    el.classList.toggle('warn', status === 'reconnecting');
    if (status === 'reconnecting' && detail) this.toast(detail);
  }

  roster(info: SessionInfo): void {
    this.info = info;
    const badge = this.$('room-label');
    if (badge.textContent === 'online' || badge.textContent?.startsWith('Code')) badge.textContent = `Code ${info.code}`;
    const me = info.roster.find((r) => r.playerId === info.playerId);
    this.roleOf = me?.role ?? 'member';
    const list = info.roster
      .map((r) => {
        const isMe = r.playerId === info.playerId;
        const controls =
          !isMe && canModerate(this.roleOf, r.role)
            ? `<span class="admin">
                 <button class="small" data-admin="kick" data-target="${esc(r.playerId)}">Kick</button>
                 <button class="small" data-admin="ban" data-target="${esc(r.playerId)}">Ban</button>
                 <button class="small" data-admin="setRole" data-role="operator" data-target="${esc(r.playerId)}">Op</button>
                 <button class="small" data-admin="setRole" data-role="member" data-target="${esc(r.playerId)}">Member</button>
                 <button class="small" data-admin="setRole" data-role="visitor" data-target="${esc(r.playerId)}">Visitor</button>
               </span>`
            : '';
        return `<li><b>${esc(r.name)}</b> <span class="role">${esc(r.role)}</span>${isMe ? ' (you)' : ''}${controls}</li>`;
      })
      .join('');
    this.$('roster').innerHTML = `<div class="roster-head">Players (${info.roster.length}) <code>${esc(info.code)}</code></div><ul>${list}</ul>`;
    this.$('roster').classList.toggle('hidden', !this.rosterOpen);
  }

  chat(name: string, text: string): void {
    const log = this.$('chat-log');
    const line = document.createElement('div');
    line.className = 'chat-line';
    line.innerHTML = `<b>${esc(name)}</b>: ${esc(text)}`;
    log.appendChild(line);
    while (log.childElementCount > 40) log.firstElementChild?.remove();
    log.scrollTop = log.scrollHeight;
  }

  /** Opens the chat line (T key or the Chat button). */
  openChat(): void {
    const input = this.$<HTMLInputElement>('chat-input');
    input.classList.remove('hidden');
    input.focus();
    this.getApp().input.captureKeys = true;
  }

  private closeChat(): void {
    const input = this.$<HTMLInputElement>('chat-input');
    input.classList.add('hidden');
    input.blur();
    this.getApp().input.captureKeys = false;
  }

  hud(game: Game, mode: GameMode, link: LinkKind | null): void {
    this.$('dim-label').textContent = `${game.dimId.replace('_', ' ')} · ${Math.floor(game.player.x)}, ${Math.floor(game.player.y)}, ${Math.floor(game.player.z)}`;
    const linkEl = this.$('link-label');
    linkEl.textContent = mode === 'single' ? 'local' : mode === 'host' ? 'hosting' : link === 'rtc' ? 'direct' : 'relay';
    linkEl.classList.toggle('warn', mode === 'client' && link === 'relay');
    const h = Math.max(0, Math.ceil(game.survival.health));
    const f = Math.max(0, Math.ceil(game.survival.hunger));
    this.$('health').innerHTML = Array.from({ length: 10 }, (_, i) => `<i class="${h >= (i + 1) * 2 ? 'full' : h >= i * 2 + 1 ? 'half' : 'empty'}"></i>`).join('');
    this.$('hunger').innerHTML = Array.from({ length: 10 }, (_, i) => `<i class="${f >= (i + 1) * 2 ? 'full' : 'empty'}"></i>`).join('');
    this.renderHotbar(game);
    if (this.panelKind) this.renderPanel(false);
  }

  private renderHotbar(game: Game): void {
    const el = this.$('hotbar');
    const slots = Array.from({ length: 9 }, (_, i) => {
      const stack = game.inventory.slots[i];
      const sel = game.selected === i ? ' sel' : '';
      const text = stack ? `${label(stack.id)}${stack.count > 1 ? ` ×${stack.count}` : ''}` : '';
      return `<div class="slot${sel}" data-slot="${i}"><span>${esc(text)}</span></div>`;
    });
    if (el.dataset.sig !== slots.join('')) {
      el.innerHTML = slots.join('');
      el.dataset.sig = slots.join('');
    }
  }

  // ---------------------------------------------------------------- panels

  private renderPanel(force: boolean): void {
    const now = performance.now();
    if (!force && now - this.lastPanelRender < 150) return;
    this.lastPanelRender = now;
    const app = this.getApp();
    const game = app.game;
    if (!this.panelKind || !game) return;
    const body = this.$('panel-body');
    const title = this.$('panel-title');
    if (this.panelKind === 'trade') {
      title.textContent = 'Villager trades';
      const npc = this.panelData.villagerId ? game.npcs.get(this.panelData.villagerId) : undefined;
      if (!npc?.villager) {
        body.innerHTML = '<p>That villager is gone.</p>';
        return;
      }
      const v = npc.villager;
      body.innerHTML = `<p>Profession: <b>${esc(v.profession)}</b> · level ${v.level} · xp ${v.xp}</p>` +
        v.offers
          .map((o) => {
            const wants = o.wants.map((w) => `${w.count} ${esc(label(w.item))}`).join(' + ');
            const sold = o.uses >= o.maxUses ? ' (sold out)' : '';
            return `<div class="trade"><span>${wants} → ${o.gives.count} ${esc(label(o.gives.item))}${sold}</span>
                    <button data-trade="${o.index}" ${o.uses >= o.maxUses ? 'disabled' : ''}>Trade</button></div>`;
          })
          .join('');
      return;
    }
    if (this.panelKind === 'crafting' || this.panelKind === 'inventory') {
      title.textContent = this.panelKind === 'crafting' ? 'Crafting table' : 'Inventory';
      body.innerHTML = this.inventoryHtml(game) + this.craftHtml(game);
      return;
    }
  }

  private inventoryHtml(game: Game): string {
    const cell = (i: number) => {
      const s = game.inventory.slots[i];
      const text = s ? `${label(s.id)}${s.count > 1 ? ` ×${s.count}` : ''}` : '';
      return `<div class="slot" data-inv="${i}" title="${esc(text)}"><span>${esc(text)}</span></div>`;
    };
    const main = Array.from({ length: MAIN_SLOTS }, (_, i) => cell(i)).join('');
    const armor = [ARMOR_SLOTS.head, ARMOR_SLOTS.chest, ARMOR_SLOTS.legs, ARMOR_SLOTS.feet, OFFHAND_SLOT].map((i) => cell(i)).join('');
    return `<div class="armor">${armor}</div><div class="inv-grid">${main}</div>`;
  }

  private craftHtml(game: Game): string {
    const size = this.gridSize;
    const cells: string[] = [];
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const id = this.grid[r]?.[c] ?? null;
        cells.push(`<div class="slot grid-cell" data-cell="${r},${c}"><span>${id ? esc(label(id)) : ''}</span></div>`);
      }
    }
    const preview = game.previewCraft(this.trimmedGrid(size), size);
    const result = preview ? `${preview.count} ${esc(label(preview.item))}` : 'no recipe';
    return `<div class="craft"><div class="craft-grid" style="grid-template-columns: repeat(${size}, 1fr)">${cells.join('')}</div>
      <div class="craft-out"><span>→ ${result}</span>
      <button data-act="craft" ${preview ? '' : 'disabled'}>Craft</button>
      <button data-act="clear">Clear</button></div>
      <p class="hint">Click an item in your inventory, then a grid cell: items are placed in the first empty cell (or click a cell to remove it).</p></div>`;
  }

  private trimmedGrid(size: number): Grid {
    const g: Grid = [];
    for (let r = 0; r < size; r++) {
      const row: Array<string | null> = [];
      for (let c = 0; c < size; c++) row.push(this.grid[r]?.[c] ?? null);
      g.push(row);
    }
    return g;
  }

  private onPanelClick(e: Event): void {
    const app = this.getApp();
    const game = app.game;
    if (!game) return;
    const target = e.target as HTMLElement;
    const trade = target.closest<HTMLElement>('[data-trade]');
    if (trade && this.panelData.villagerId) {
      const msg = game.trade(this.panelData.villagerId, Number(trade.dataset.trade));
      this.toast(msg ?? 'Trade failed: missing items');
      this.renderPanel(true);
      return;
    }
    const act = target.closest<HTMLElement>('[data-act]');
    if (act?.dataset.act === 'clear') {
      this.grid = this.grid.map((row) => row.map(() => null));
      this.renderPanel(true);
      return;
    }
    if (act?.dataset.act === 'craft') {
      const ok = game.craft(this.trimmedGrid(this.gridSize), this.gridSize);
      this.toast(ok ? 'Crafted' : 'Missing ingredients');
      this.renderPanel(true);
      return;
    }
    const cell = target.closest<HTMLElement>('[data-cell]');
    if (cell) {
      const [r, c] = cell.dataset.cell!.split(',').map(Number) as [number, number];
      this.grid[r]![c] = null;
      this.renderPanel(true);
      return;
    }
    const inv = target.closest<HTMLElement>('[data-inv]');
    if (inv) {
      const slot = Number(inv.dataset.inv);
      const stack = game.inventory.slots[slot];
      if (!stack) return;
      if (slot >= MAIN_SLOTS) {
        // Armour and off-hand unequip back into the main inventory.
        const moved = game.inventory.add(stack.id, 1);
        if (moved === 0) game.inventory.slots[slot] = stack.count > 1 ? { ...stack, count: stack.count - 1 } : null;
        this.renderPanel(true);
        return;
      }
      if (this.panelKind === 'inventory' || this.panelKind === 'crafting') {
        const size = this.gridSize;
        for (let r = 0; r < size; r++) {
          for (let c = 0; c < size; c++) {
            if (!this.grid[r]![c]) {
              this.grid[r]![c] = stack.id;
              this.renderPanel(true);
              return;
            }
          }
        }
        this.toast('The crafting grid is full');
      }
    }
  }

  // ---------------------------------------------------------------- helpers

  /** Shows or hides the player list (Tab). */
  toggleRoster(): void {
    this.rosterOpen = !this.rosterOpen;
    this.$('roster').classList.toggle('hidden', !this.rosterOpen);
  }
}
