import { resolve } from 'node:path';
import { createApplication } from '../lib/application.mjs';
import { fetchGitHub } from './network.mjs';

export async function startDesktopServer({ rootDir, dataDir, env = process.env, ...options }) {
  const app = await createApplication({
    fetchImpl: fetchGitHub, ...options, rootDir, env: { ...env, DATA_DIR: resolve(dataDir) },
  });
  try {
    await new Promise((resolveListen, reject) => {
      app.server.once('error', reject);
      app.server.listen(0, '127.0.0.1', resolveListen);
    });
  } catch (error) {
    await app.close();
    throw error;
  }
  return { ...app, origin: `http://127.0.0.1:${app.server.address().port}` };
}
