import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const liveGitHub = process.env.DISPATCH_TEST_LIVE_GITHUB === '1';

test('packaged Linux desktop renders in the native webview and handles repository settings', {
  skip: process.platform !== 'linux', timeout: 180000,
}, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'dispatch-native-'));
  let driver, sessionPath;
  t.after(async () => {
    if (driver) {
      if (sessionPath) await fetch(`http://127.0.0.1:${port}${sessionPath}`, {
        method: 'DELETE', signal: AbortSignal.timeout(2000),
      }).catch(() => {});
      try { process.kill(-driver.pid, 'SIGTERM'); } catch { /* Already exited. */ }
      driver.stdout.destroy(); driver.stderr.destroy();
    }
    await rm(temp, { recursive: true, force: true });
  });
  const dataDir = join(temp, 'settings');
  const environment = {
    HOME: temp, XDG_DATA_HOME: join(temp, 'share'),
    XDG_CONFIG_HOME: join(temp, 'config'), XDG_CACHE_HOME: join(temp, 'cache'),
    DATA_DIR: dataDir, GH_CONFIG_DIR: join(temp, 'gh'),
    GH_TOKEN: '', GITHUB_TOKEN: '', GITHUB_REPO: '',
  };
  // Extract the exact release payload without launching the interactive installer.
  const resources = join(root, 'build', `stable-linux-${process.arch}`, 'Dispatch/Resources');
  const archive = (await readdir(resources)).find(name => name.endsWith('.tar.zst'));
  assert.ok(archive, 'Build the desktop release before running this test.');
  await promisify(execFile)('tar', ['--zstd', '-xf', join(resources, archive), '-C', temp]);
  const installed = join(temp, 'Dispatch/bin/launcher');
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  driver = spawn('WebKitWebDriver', [`--port=${port}`, '--host=127.0.0.1'], {
    stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    env: { ...process.env, ...environment },
  });
  let log = '';
  driver.stdout.on('data', chunk => { log += chunk; });
  driver.stderr.on('data', chunk => { log += chunk; });
  const exited = once(driver, 'exit');
  // Prevent a missing WebKitWebDriver binary from becoming an unhandled rejection.
  exited.catch(() => {});
  const endpoint = `http://127.0.0.1:${port}`;
  async function command(path, method = 'GET', body) {
    const response = await fetch(`${endpoint}${path}`, {
      method, headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(90000),
    }).catch(error => { throw new Error(`${method} ${path}: ${error.message}\n${log}`); });
    const result = await response.json();
    assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(result)}\n${log}`);
    return result.value;
  }
  let available = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { await command('/status'); available = true; break; }
    catch { await delay(100); }
  }
  assert.ok(available, `WebKitWebDriver did not start. Install it to run this test.\n${log}`);
  const session = await command('/session', 'POST', {
    capabilities: { alwaysMatch: {
      'webkitgtk:browserOptions': {
        binary: installed,
        args: ['--automation'],
      },
    } },
  });
  sessionPath = `/session/${session.sessionId}`;
  const execute = script => command(`${sessionPath}/execute/sync`, 'POST', { script, args: [] });
  let view;
  for (let attempt = 0; attempt < 100; attempt++) {
    view = await execute(`return {
      title: document.title,
      connected: document.getElementById('connection')?.textContent.trim(),
      setup: document.getElementById('setup-screen')?.hidden === false,
      styled: getComputedStyle(document.documentElement).getPropertyValue('--teal').trim().length > 0,
      origin: location.origin
    };`);
    if (view.setup && view.connected === 'Not connected') break;
    await delay(100);
  }
  assert.match(view.title, /Dispatch/);
  assert.equal(view.setup, true, JSON.stringify(view));
  assert.equal(view.connected, 'Not connected');
  assert.equal(view.styled, true);
  assert.match(view.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(await execute("return new URL(location.href).searchParams.get('desktop');"), '1');
  assert.equal(await execute("return document.querySelector('.brand').getAttribute('href');"), '/?desktop=1');
  await execute("document.getElementById('connect-repo').click();");
  assert.equal(await execute("return document.getElementById('settings-dialog').open;"), true);
  await execute(`
    document.getElementById('repository').value = 'https://example.invalid/project';
    document.getElementById('settings-form').requestSubmit();
  `);
  let error = '';
  for (let attempt = 0; attempt < 50; attempt++) {
    error = await execute("return document.getElementById('settings-error').textContent;");
    if (error) break;
    await delay(100);
  }
  assert.match(error, /owner\/repo|github.com/i);
  if (liveGitHub) {
    await execute(`
      document.getElementById('repository').value = 'octocat/Hello-World';
      document.getElementById('settings-form').requestSubmit();
    `);
    let connection;
    for (let attempt = 0; attempt < 200; attempt++) {
      connection = await execute(`return {
        connected: document.getElementById('connection').textContent.trim(),
        repository: document.getElementById('breadcrumb-repo').textContent,
        error: document.getElementById('settings-error').hidden ? '' : document.getElementById('settings-error').textContent,
      };`);
      if (connection.connected === 'GitHub connected' || connection.error) break;
      await delay(100);
    }
    assert.equal(connection.connected, 'GitHub connected', JSON.stringify(connection));
    assert.equal(connection.repository, 'octocat/Hello-World');
    console.log('Packaged desktop connected to public GitHub over verified HTTPS without credentials.');
  }
  await execute("document.querySelector('#settings-dialog .close-dialog').click();");
  assert.equal(await execute("return document.getElementById('settings-dialog').open;"), false);
  const config = JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf8'));
  if (liveGitHub) {
    assert.equal(config.workspaces.length, 1);
    assert.equal(config.workspaces[0].repository, 'octocat/Hello-World');
  } else {
    assert.deepEqual(config, { version: 2, activeWorkspaceId: null, workspaces: [] });
  }
  await mkdir(join(root, 'artifacts'), { recursive: true });
  const screenshot = await command(`${sessionPath}/screenshot`);
  await writeFile(join(root, 'artifacts/electrobun-desktop.png'), Buffer.from(screenshot, 'base64'));
  console.log('Native WebKit desktop, API, styles, settings dialog, and input validation passed.');
});
