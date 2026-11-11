import { createDefaultContent } from '../shared/packs/registry.js';
import { GameApp } from './engine/app.js';
import { UI } from './ui/ui.js';
import './ui/styles.css';

/** Loads the built-in content plus the bundled sample behaviour pack. A broken pack never stops the game. */
async function loadContent() {
  const content = createDefaultContent();
  try {
    const res = await fetch('/packs/dh_sample/pack.json');
    if (res.ok) {
      const warnings = content.loadPackFiles((await res.json()) as Record<string, unknown>);
      for (const w of warnings) console.warn(`[pack] ${w}`);
    }
  } catch (err) {
    console.warn('[pack] sample pack not loaded', err);
  }
  return content;
}

async function boot(): Promise<void> {
  const content = await loadContent();
  const root = document.getElementById('app');
  const canvas = document.getElementById('game');
  if (!root || !(canvas instanceof HTMLCanvasElement)) throw new Error('missing app root or canvas');
  let app: GameApp | undefined;
  const ui = new UI(root, () => {
    if (!app) throw new Error('app not ready');
    return app;
  });
  app = new GameApp(content, canvas, ui);
  addEventListener('resize', () => app?.resize());
  (window as unknown as { __mcbh: unknown }).__mcbh = { app, content };
}

boot().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend', `<pre style="color:#fff;padding:1rem">Failed to start: ${String(err)}</pre>`);
});
