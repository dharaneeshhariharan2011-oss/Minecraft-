import { defineConfig } from 'vite';

const signalingTarget = process.env.SIGNALING_URL ?? 'http://127.0.0.1:8080';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    // Allow the sandbox preview host (https://{port}-{sandbox}.e2b.app) to talk to the dev server.
    allowedHosts: true,
    proxy: {
      '/ws': { target: signalingTarget, ws: true, changeOrigin: true },
      '/healthz': { target: signalingTarget, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
});
