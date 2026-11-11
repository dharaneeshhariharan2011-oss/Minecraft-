import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { createSignalingServer } from './signaling/server.js';

/** Entry point: `npm start` serves the built client and the /ws signalling endpoint. */
const here = dirname(fileURLToPath(import.meta.url));
// dist-server/server/index.js -> project root is two levels up; in dev the same layout applies.
const projectRoot = join(here, '..', '..');
const distDir = join(projectRoot, 'dist');

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? '0.0.0.0';

createSignalingServer({
  port,
  host,
  distDir,
  log: (line) => console.error(`[signaling] ${line}`),
})
  .then((server) => {
    const address = server.http.address();
    const shown = typeof address === 'object' && address ? address.port : port;
    console.log(`Minecraft by DH signalling server listening on http://${host}:${shown}`);
    console.log(existsSync(distDir) ? `Serving client from ${distDir}` : 'No client build found; run `npm run build` to serve the game');
    const shutdown = () => {
      void server.close().then(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
