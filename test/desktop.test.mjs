import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDesktopServer } from '../desktop/server.mjs';
import { createQuitController } from '../desktop/lifecycle.mjs';

test('desktop serves packaged assets on an available loopback port and saves settings outside the bundle', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dispatch-desktop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rootDir = join(root, 'app'), dataDir = join(root, 'user-data');
  await mkdir(join(rootDir, 'public'), { recursive: true });
  await writeFile(join(rootDir, 'public/index.html'), '<!doctype html><title>Dispatch desktop</title>');
  const app = await startDesktopServer({
    rootDir, dataDir, env: { PORT: 'invalid', GITHUB_REPO: '' },
    adapter: { auth: 'none', sanitize: value => value },
  });
  t.after(() => app.close());
  assert.equal(app.server.address().address, '127.0.0.1');
  assert.ok(app.server.address().port > 0);
  assert.match(await (await fetch(app.origin)).text(), /Dispatch desktop/);
  const state = await (await fetch(`${app.origin}/api/state`)).json();
  assert.equal(state.mode, 'setup');
  assert.deepEqual(state.workspaces, []);
  assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf8')), {
    version: 2, activeWorkspaceId: null, workspaces: [],
  });
  await assert.rejects(readFile(join(rootDir, '.data/config.json')), { code: 'ENOENT' });
  assert.equal((await fetch(`${app.origin}/../config.json`)).status, 404);
});

test('canceling desktop quit leaves a running queue and its monitoring untouched', async () => {
  let confirmed = 0, closed = 0, exited = 0;
  const lifecycle = createQuitController({
    hasQueue: () => true,
    confirmClose: async () => { confirmed++; return false; },
    close: async () => { closed++; }, quit: () => { exited++; },
  });
  const event = {};
  lifecycle.handleEvent(event);
  await lifecycle.request();
  assert.deepEqual(event.response, { allow: false });
  assert.equal(confirmed, 1); assert.equal(closed, 0); assert.equal(exited, 0);
});

test('overlapping desktop quit requests drain once and wait before allowing native exit', async () => {
  let finish;
  const drained = new Promise(resolve => { finish = resolve; });
  let confirmed = 0, closed = 0, exited = 0;
  const lifecycle = createQuitController({
    hasQueue: () => true,
    confirmClose: async () => { confirmed++; return true; },
    close: async () => { closed++; await drained; }, quit: () => { exited++; },
  });
  const first = lifecycle.request();
  assert.strictEqual(lifecycle.request(), first);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(confirmed, 1); assert.equal(closed, 1); assert.equal(exited, 0);
  const duringDrain = {};
  lifecycle.handleEvent(duringDrain);
  assert.deepEqual(duringDrain.response, { allow: false });
  finish(); await first;
  assert.equal(exited, 1);
  const afterDrain = {};
  lifecycle.handleEvent(afterDrain);
  assert.equal(afterDrain.response, undefined);
});

test('desktop termination signals skip the dialog and still drain the queue', async () => {
  const calls = [];
  const lifecycle = createQuitController({
    hasQueue: () => true,
    confirmClose: async () => { throw new Error('Unexpected dialog'); },
    close: async () => { calls.push('close'); }, quit: () => { calls.push('quit'); },
  });
  await lifecycle.request(false);
  assert.deepEqual(calls, ['close', 'quit']);
});

test('a failed desktop shutdown keeps native exit blocked and permits a retry', async () => {
  const failure = new Error('Could not drain');
  const errors = [];
  let attempts = 0, exited = 0;
  const lifecycle = createQuitController({
    hasQueue: () => false,
    close: async () => { if (++attempts === 1) throw failure; },
    quit: () => { exited++; }, onError: error => { errors.push(error); },
  });
  await lifecycle.request();
  assert.deepEqual(errors, [failure]); assert.equal(exited, 0);
  await lifecycle.request();
  assert.equal(attempts, 2); assert.equal(exited, 1);
});
