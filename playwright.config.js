import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default defineConfig({
  testDir: './test/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  use: { baseURL: 'http://127.0.0.1:3107', viewport: { width: 1440, height: 1100 }, trace: 'retain-on-failure' },
  webServer: {
    command: 'node test/support/browser-server.mjs',
    url: 'http://127.0.0.1:3107',
    env: { PORT: '3107', DATA_DIR: mkdtempSync(join(tmpdir(), 'dispatch-browser-')), GITHUB_REPO: '' },
    reuseExistingServer: false
  }
});
