import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end multi-client tests. The game server (which also serves the built client)
 * is started on E2E_PORT. Set CHROMIUM_EXECUTABLE to use a custom Chromium binary.
 */
const port = Number(process.env.E2E_PORT ?? 5180);
const executablePath = process.env.CHROMIUM_EXECUTABLE || undefined;

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    launchOptions: {
      executablePath,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `node dist-server/server/index.js`,
    url: `http://127.0.0.1:${port}/healthz`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: { PORT: String(port), HOST: '127.0.0.1' },
  },
});
