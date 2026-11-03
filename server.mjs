import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApplication } from './lib/application.mjs';

export { createApplication, checkHost, checkPost } from './lib/application.mjs';

export async function main(env = process.env) {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer between 0 and 65535.');
  const app = await createApplication({ env });
  await new Promise((resolveListen, reject) => {
    app.server.once('error', reject);
    app.server.listen(port, '127.0.0.1', resolveListen);
  });
  console.log(`Workflow runner at http://127.0.0.1:${app.server.address().port} (${app.runner.mode === 'setup' ? 'connect a repository to get started' : 'GitHub connected'})`);
  console.log('Queues are memory-only. Restarting loses monitoring; inspect GitHub before starting another batch.');
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
    if (closing) return; closing = true;
    await app.close();
    process.exitCode = 0;
  });
  return app;
}

if (import.meta.main ?? (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
