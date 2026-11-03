import Electrobun, { BrowserWindow, Utils, PATHS } from 'electrobun/main';
import { join, resolve } from 'node:path';
import { startDesktopServer } from './server.mjs';
import { createQuitController } from './lifecycle.mjs';

async function start() {
  const app = await startDesktopServer({
    rootDir: join(PATHS.RESOURCES_FOLDER, 'app'),
    dataDir: process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : Utils.paths.userData,
  });
  const window = new BrowserWindow({
    title: 'Dispatch', url: `${app.origin}/?desktop=1`,
    frame: { width: 1440, height: 1000 },
    renderer: 'native', sandbox: true,
    allowedProtocols: { views: false, appData: false },
  });

  // Run links belong in the user's browser, never in another privileged app view.
  Electrobun.events.on('new-window-open', event => {
    const detail = event.data.detail;
    const url = typeof detail === 'string' ? detail : detail.url;
    try {
      const target = new URL(url);
      if (target.protocol === 'https:' && target.hostname === 'github.com') Utils.openExternal(target.href);
    } catch { /* Ignore malformed navigation requests. */ }
  });

  const lifecycle = createQuitController({
    hasQueue: () => Boolean(app.runner.globalQueue),
    confirmClose: async () => {
      const { response } = await Utils.showMessageBox({
        type: 'warning', title: 'Close Dispatch?',
        message: 'A workflow queue is still running.',
        detail: 'Closing skips pending workflows and stops monitoring. Workflows already started on GitHub continue running.',
        buttons: ['Keep open', 'Close Dispatch'], defaultId: 0, cancelId: 0,
      });
      return response === 1;
    },
    close: () => app.close(),
    quit: () => { Utils.quit(); },
    onError: error => { console.error('Could not close Dispatch:', error); },
  });
  window.on('will-close', lifecycle.handleEvent);
  Electrobun.events.on('before-quit', lifecycle.handleEvent);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void lifecycle.request(false); });
  console.log(`Dispatch desktop at ${app.origin}`);
}

start().catch(async error => {
  console.error('Could not start Dispatch:', error);
  await Utils.showMessageBox({ type: 'error', title: 'Could not start Dispatch', message: error.message });
  Utils.quit(1);
});
