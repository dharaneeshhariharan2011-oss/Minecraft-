import type { GameInput } from './game.js';

/** Radians of yaw/pitch per pixel of mouse movement. */
export const MOUSE_SENSITIVITY = 0.0022;

/** Desktop and touch input, reduced to one `GameInput` per frame. */
export class Input {
  private readonly keys = new Set<string>();
  private lookDx = 0;
  private lookDy = 0;
  private hotbarPick = -1;
  private usePressed = false;
  private leftHeld = false;
  private touchMove = { x: 0, y: 0 };
  private touchBreak = false;
  private touchJump = false;
  private touchSneak = false;
  private touchGlide = false;
  /** Set by the UI when a menu, chat box or panel owns the keyboard. */
  captureKeys = false;
  onInventory: (() => void) | null = null;
  onChat: (() => void) | null = null;
  onEscape: (() => void) | null = null;

  constructor(private readonly canvas: HTMLElement) {
    addEventListener('keydown', (e) => this.onKey(e, true));
    addEventListener('keyup', (e) => this.onKey(e, false));
    addEventListener('blur', () => this.keys.clear());
    canvas.addEventListener('mousedown', (e) => {
      if (!this.locked()) {
        void canvas.requestPointerLock?.();
        return;
      }
      if (e.button === 0) this.leftHeld = true;
      if (e.button === 2) this.usePressed = true;
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 0) this.leftHeld = false;
    });
    addEventListener('mousemove', (e) => {
      if (!this.locked()) return;
      this.lookDx += e.movementX * MOUSE_SENSITIVITY;
      this.lookDy += -e.movementY * MOUSE_SENSITIVITY;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', (e) => {
      this.hotbarPick = (((this.currentSlot + (e.deltaY > 0 ? 1 : -1)) % 9) + 9) % 9;
    }, { passive: true });
    document.addEventListener('pointerlockchange', () => {
      if (!this.locked()) this.leftHeld = false;
    });
  }

  /** Last hotbar slot selected through the keyboard, wheel or touch, used for wheel wrap-around. */
  currentSlot = 0;

  locked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  /** Wires touch controls. The DOM elements are created by the UI layer. */
  setTouchMove(x: number, y: number): void {
    this.touchMove = { x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)) };
  }

  addLook(dx: number, dy: number): void {
    this.lookDx += dx;
    this.lookDy += dy;
  }

  setTouchButton(name: 'break' | 'jump' | 'sneak' | 'glide', on: boolean): void {
    if (name === 'break') this.touchBreak = on;
    if (name === 'jump') this.touchJump = on;
    if (name === 'sneak') this.touchSneak = on;
    if (name === 'glide') this.touchGlide = on;
  }

  tapUse(): void {
    this.usePressed = true;
  }

  pickHotbar(slot: number): void {
    this.hotbarPick = slot;
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (down && this.captureKeys && e.code !== 'Escape') return;
    if (down) {
      if (e.code === 'KeyE' && !e.repeat) this.onInventory?.();
      if (e.code === 'KeyT' && !e.repeat) this.onChat?.();
      if (e.code === 'Escape' && !e.repeat) this.onEscape?.();
      const digit = /^Digit([1-9])$/.exec(e.code);
      if (digit) this.hotbarPick = Number(digit[1]) - 1;
      if (e.code === 'Space' || e.code.startsWith('Arrow') || e.code.startsWith('Key')) e.preventDefault();
      this.keys.add(e.code);
    } else {
      this.keys.delete(e.code);
    }
  }

  /** Samples the input for one frame. One-shot events (look deltas, use, hotbar) are consumed here. */
  sample(): GameInput {
    const k = (code: string) => this.keys.has(code);
    let forward = (k('KeyW') || k('ArrowUp') ? 1 : 0) - (k('KeyS') || k('ArrowDown') ? 1 : 0);
    let strafe = (k('KeyD') || k('ArrowRight') ? 1 : 0) - (k('KeyA') || k('ArrowLeft') ? 1 : 0);
    if (this.touchMove.x !== 0 || this.touchMove.y !== 0) {
      forward = -this.touchMove.y;
      strafe = this.touchMove.x;
    }
    const input: GameInput = {
      forward: Math.max(-1, Math.min(1, forward)),
      strafe: Math.max(-1, Math.min(1, strafe)),
      jump: k('Space') || this.touchJump,
      sneak: k('ShiftLeft') || k('ShiftRight') || this.touchSneak,
      sprint: k('ControlLeft') || k('ControlRight'),
      glide: k('KeyF') || this.touchGlide,
      hasElytra: true,
      lookDx: this.lookDx,
      lookDy: this.lookDy,
      breaking: this.leftHeld || this.touchBreak,
      use: this.usePressed,
      hotbar: this.hotbarPick,
    };
    if (this.hotbarPick >= 0) this.currentSlot = this.hotbarPick;
    this.lookDx = 0;
    this.lookDy = 0;
    this.usePressed = false;
    this.hotbarPick = -1;
    return input;
  }
}
