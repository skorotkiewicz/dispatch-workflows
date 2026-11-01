import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceManager, readWorkspaceConfig } from '../lib/workspaces.mjs';

function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const empty = () => ({ version: 2, activeWorkspaceId: null, workspaces: [] });
const batch = (workspaceId, extra = {}) => ({ workspaceId, workflowIds: [101], ref: 'release', inputs: {}, ...extra });
const status = expected => error => error.status === expected;

class FakeGitHub {
  constructor() {
    this.auth = 'environment'; this.dispatched = []; this.calls = []; this.runs = new Map();
    this.active = new Map(); this.monitorGate = null; this.enteredMonitor = deferred();
    this.canonical = new Map(); this.defaults = new Map(); this.conclusion = 'success';
  }
  sanitize(message) { return String(message).replaceAll('secret-token', '[redacted]'); }
  async getRepo(repository) {
    const fullName = this.canonical.get(repository.toLowerCase()) || repository;
    this.calls.push(['repo', repository]);
    return { fullName, url: `https://github.com/${fullName}`, defaultBranch: this.defaults.get(fullName) || 'trunk' };
  }
  async listWorkflows(repository) {
    this.calls.push(['workflows', repository]);
    return [101, 102].map(id => ({ id, name: `${repository} ${id}`, path: `.github/workflows/${id}.yml`, state: 'active' }));
  }
  async latestRun(repository, id) { this.calls.push(['latest', repository, id]); return null; }
  async getInputs(repository, workflow, ref) {
    this.calls.push(['inputs', repository, workflow.id, ref]);
    return { dispatchable: true, inputs: [{ name: 'target', type: 'string', required: false, default: repository }] };
  }
  async validateRef(repository, ref) { this.calls.push(['ref', repository, ref]); }
  async actor() { return 'operator'; }
  async activeRuns(repository) { this.calls.push(['active', repository]); return this.active.get(repository) || []; }
  async dispatchRuns(repository, workflowId, ref) {
    return [...this.runs.values()].filter(run => run.repository === repository && run.workflow_id === workflowId && run.head_branch === ref);
  }
  async dispatch(repository, workflowId, ref, inputs) {
    const id = 9000 + this.dispatched.length;
    this.dispatched.push({ repository, workflowId, ref, inputs, id });
    this.runs.set(id, { id, repository, workflow_id: workflowId, event: 'workflow_dispatch', head_branch: ref, run_attempt: 1,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(), status: 'completed', conclusion: this.conclusion });
    return { id };
  }
  async getRun(repository, id) {
    this.calls.push(['run', repository, id]); this.enteredMonitor.resolve();
    if (this.monitorGate) await this.monitorGate.promise;
    const run = this.runs.get(id);
    assert.equal(run.repository, repository);
    return run;
  }
}

async function fixture(t, initial = empty()) {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-workspaces-'));
  const configPath = join(directory, 'config.json');
  await writeFile(configPath, JSON.stringify(initial));
  const adapter = new FakeGitHub();
  const manager = new WorkspaceManager({ adapter, configPath, config: initial,
    runnerOptions: { pollMs: 1, sleep: async () => {} } });
  t.after(async () => {
    adapter.monitorGate?.resolve();
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { manager, adapter, directory, configPath };
}
async function addTwo(manager) {
  const first = await manager.configure('acme/alpha');
  const second = await manager.configure('acme/beta');
  return [first.workspaceId, second.workspaceId];
}

for (const legacy of [{ repository: 'Acme/Platform' }, { repository: null }, null, undefined]) {
  test(`legacy configuration migrates and restart preserves choices (${JSON.stringify(legacy)})`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'workflow-migration-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const configPath = join(directory, 'config.json');
    if (legacy !== undefined) await writeFile(configPath, JSON.stringify(legacy));
    const config = await readWorkspaceConfig(configPath, { GITHUB_REPO: 'env/fallback' });
    assert.equal(config.version, 2);
    assert.equal(config.workspaces[0].repository, legacy?.repository || 'env/fallback');
    assert.equal(config.workspaces[0].branch, null);
    assert.equal(config.activeWorkspaceId, config.workspaces[0].id);
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), config);
    assert.deepEqual(await readWorkspaceConfig(configPath, { GITHUB_REPO: 'env/ignored' }), config);
    const adapter = new FakeGitHub();
    const manager = new WorkspaceManager({ adapter, configPath, config });
    await manager.saveBranch(config.activeWorkspaceId, 'stable');
    await manager.close();
    const restarted = new WorkspaceManager({ adapter, configPath, config: await readWorkspaceConfig(configPath, {}) });
    assert.equal(restarted.snapshot().branch, 'stable');
    assert.deepEqual(restarted.queue.items, []);
    assert.equal(restarted.globalQueue, null);
    await restarted.close();
  });
}

test('missing and cleared legacy settings bootstrap empty without an environment repository', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-empty-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, 'config.json');
  assert.deepEqual(await readWorkspaceConfig(configPath, {}), empty());
  await writeFile(configPath, JSON.stringify({ repository: null }));
  assert.deepEqual(await readWorkspaceConfig(configPath, {}), empty());
  // Versioned empty settings intentionally override environment bootstrap on restart.
  assert.deepEqual(await readWorkspaceConfig(configPath, { GITHUB_REPO: 'env/ignored' }), empty());
});

for (const config of [
  '{broken', '{}', '[]', '{"version":3,"repository":"acme/alpha"}',
  JSON.stringify({ ...empty(), workspaces: [{ id: 'a', repository: 'acme/alpha', branch: '../bad' }] }),
  JSON.stringify({ ...empty(), workspaces: [{ id: 'a', repository: 'acme/alpha', branch: null }, { id: 'a', repository: 'acme/beta', branch: null }] }),
  JSON.stringify({ ...empty(), workspaces: [{ id: 'a', repository: 'acme/alpha', branch: null }, { id: 'b', repository: 'ACME/ALPHA', branch: null }] }),
  JSON.stringify({ ...empty(), activeWorkspaceId: 'missing' }),
  JSON.stringify({ ...empty(), workspaces: [{ id: '', repository: 'acme/alpha', branch: null }] }),
  JSON.stringify({ ...empty(), workspaces: [{ id: 'a', repository: 'acme/alpha' }] }),
  JSON.stringify({ repository: 'not a repository' }),
]) test(`invalid settings are rejected without overwriting (${config})`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-invalid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, 'config.json'); await writeFile(configPath, config);
  await assert.rejects(readWorkspaceConfig(configPath, { GITHUB_REPO: 'env/fallback' }), status(500));
  assert.equal(await readFile(configPath, 'utf8'), config);
});

test('setup uses an empty runner and rejects queue launch', async t => {
  const { manager } = await fixture(t);
  assert.equal(manager.mode, 'setup');
  assert.deepEqual(manager.snapshot().workspaces, []);
  assert.equal(manager.snapshot().workspaceId, null);
  assert.equal(manager.snapshot().globalQueue, null);
  assert.deepEqual(await manager.refresh(), manager.snapshot());
  await assert.rejects(manager.startQueue(batch(undefined)), status(409));
});

test('configure persists the actual default and duplicate canonical names focus without resetting history', async t => {
  const { manager, adapter, configPath } = await fixture(t);
  adapter.canonical.set('acme/alpha', 'Acme/Alpha'); adapter.defaults.set('Acme/Alpha', 'develop');
  const first = await manager.configure('https://github.com/acme/alpha.git');
  assert.equal(first.branch, 'develop'); assert.equal(first.repo.defaultBranch, 'develop');
  await manager.saveBranch(first.workspaceId, 'feature/preserved');
  await manager.startQueue(batch(first.workspaceId)); await manager.runners.get(first.workspaceId).done;
  const runner = manager.runners.get(first.workspaceId);
  const history = runner.snapshot().queue;
  await manager.configure('acme/beta');
  const duplicate = await manager.configure('ACME/ALPHA');
  assert.equal(duplicate.workspaceId, first.workspaceId);
  assert.equal(duplicate.workspaces.length, 2); assert.equal(duplicate.branch, 'feature/preserved');
  assert.equal(manager.runners.get(first.workspaceId), runner);
  assert.deepEqual(duplicate.queue, history);
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), manager.config);
});

test('null migration branches use fetched default, including inputs, without changing branch choices on refresh', async t => {
  const config = { version: 2, activeWorkspaceId: 'alpha', workspaces: [{ id: 'alpha', repository: 'acme/alpha', branch: null }] };
  const { manager, adapter } = await fixture(t, config);
  adapter.defaults.set('acme/alpha', 'develop');
  assert.equal(manager.snapshot().branch, null);
  await manager.inputs(101, undefined, 'alpha');
  assert.deepEqual(adapter.calls.find(call => call[0] === 'inputs'), ['inputs', 'acme/alpha', 101, 'develop']);
  assert.equal(manager.snapshot().branch, 'develop');
  await manager.saveBranch('alpha', 'stable'); await manager.refresh({ force: true });
  assert.equal(manager.snapshot().branch, 'stable');
});

test('switching preserves independent branch, workflow collision data, input targets, queue history and restart selection', async t => {
  const { manager, adapter, configPath } = await fixture(t);
  const [alpha, beta] = await addTwo(manager);
  await manager.saveBranch(alpha, 'alpha-choice'); await manager.saveBranch(beta, 'beta-choice');
  await manager.refresh({ workspaceId: alpha }); await manager.refresh({ workspaceId: beta });
  assert.match(manager.snapshot(alpha).workflows[0].name, /alpha/);
  assert.match(manager.snapshot(beta).workflows[0].name, /beta/);
  assert.equal((await manager.inputs(101, undefined, alpha)).inputs[0].default, 'acme/alpha');
  assert.equal((await manager.inputs(101, undefined, beta)).inputs[0].default, 'acme/beta');
  await manager.select(alpha); assert.equal(manager.snapshot().branch, 'alpha-choice');
  await manager.startQueue(batch(undefined, { ref: 'alpha-choice' })); await manager.runners.get(alpha).done;
  await manager.select(beta); assert.equal(manager.snapshot().branch, 'beta-choice');
  assert.deepEqual(manager.queue.items, []); assert.equal(manager.snapshot(alpha).queue.items.length, 1);
  assert.equal(adapter.dispatched[0].repository, 'acme/alpha');
  const restarted = new WorkspaceManager({ adapter, configPath, config: await readWorkspaceConfig(configPath, {}) });
  assert.equal(restarted.snapshot().workspaceId, beta); assert.equal(restarted.snapshot(alpha).branch, 'alpha-choice');
  assert.deepEqual(restarted.snapshot(alpha).queue.items, []); await restarted.close();
});

test('refresh passes through the runner cache and captured responses remain tied to their workspace under switches', async t => {
  const { manager, adapter } = await fixture(t); const [alpha, beta] = await addTwo(manager);
  const gate = deferred(); const entered = deferred(); const original = adapter.getRepo.bind(adapter);
  adapter.getRepo = async repository => {
    if (repository === 'acme/alpha') { entered.resolve(); await gate.promise; }
    return original(repository);
  };
  const pending = manager.refresh({ workspaceId: alpha }); await entered.promise;
  await manager.select(beta); gate.resolve();
  const response = await pending;
  assert.equal(response.workspaceId, alpha); assert.match(response.repo.fullName, /alpha/);
  assert.equal(manager.snapshot().workspaceId, beta);
  const count = adapter.calls.length; await manager.refresh({ workspaceId: alpha }); assert.equal(adapter.calls.length, count);
  await manager.refresh({ workspaceId: alpha, force: true }); assert.ok(adapter.calls.length > count);
});

test('queue monitoring remains on captured repository while switching, adding, saving branches and removing another workspace', async t => {
  const { manager, adapter } = await fixture(t); const [alpha, beta] = await addTwo(manager);
  adapter.monitorGate = deferred();
  await manager.startQueue(batch(alpha, { workflowIds: [101, 102], allowMultiple: true })); await adapter.enteredMonitor.promise;
  await manager.select(beta); await manager.saveBranch(beta, 'other-choice');
  const gamma = await manager.configure('acme/gamma');
  assert.equal(manager.snapshot().workspaceId, gamma.workspaceId);
  assert.deepEqual(manager.snapshot().globalQueue, { workspaceId: alpha, repository: 'acme/alpha' });
  assert.equal(manager.snapshot().workspaces.find(entry => entry.id === alpha).running, true);
  await manager.remove(gamma.workspaceId);
  assert.equal(manager.snapshot().workspaceId, alpha);
  await assert.rejects(manager.startQueue(batch(beta)), status(409));
  adapter.monitorGate.resolve(); await manager.runners.get(alpha).done;
  assert.deepEqual(adapter.dispatched.map(value => value.repository), ['acme/alpha', 'acme/alpha']);
  assert.equal(manager.snapshot(beta).queue.items.length, 0);
  assert.equal(manager.snapshot(alpha).queue.items[0].ref, 'release');
  assert.equal(manager.globalQueue, null);
});

test('global reservation is visible and excludes every concurrent start before any awaited validation', async t => {
  const { manager, adapter } = await fixture(t); const [alpha, beta] = await addTwo(manager);
  const gate = deferred(); const entered = deferred();
  const original = adapter.activeRuns.bind(adapter);
  adapter.activeRuns = async repository => {
    if (repository === 'acme/beta') { entered.resolve(); await gate.promise; }
    return original(repository);
  };
  const first = manager.startQueue(batch(alpha)); await entered.promise;
  assert.deepEqual(manager.snapshot(beta).globalQueue, { workspaceId: alpha, repository: 'acme/alpha' });
  await assert.rejects(manager.startQueue(batch(beta)), status(409));
  await assert.rejects(manager.startQueue(batch(alpha)), status(409));
  await assert.rejects(manager.remove(alpha), status(409));
  gate.resolve(); await first; await manager.runners.get(alpha).done;
  assert.equal(manager.globalQueue, null); assert.equal(adapter.dispatched.length, 1);
});

test('global reservation also excludes starts during runner prevalidation and releases after validation failure', async t => {
  const { manager, adapter } = await fixture(t); const [alpha, beta] = await addTwo(manager);
  const gate = deferred(); const entered = deferred(); const original = adapter.getInputs.bind(adapter);
  adapter.getInputs = async (...args) => { entered.resolve(); await gate.promise; return original(...args); };
  const first = manager.startQueue(batch(alpha)); await entered.promise;
  await assert.rejects(manager.startQueue(batch(beta)), status(409));
  gate.reject(new Error('schema unavailable')); await assert.rejects(first, /schema unavailable/);
  assert.equal(manager.globalQueue, null); assert.equal(manager.snapshot(alpha).queue.running, false);
  assert.equal(adapter.dispatched.length, 0);
  adapter.getInputs = original; await manager.startQueue(batch(beta)); await manager.runners.get(beta).done;
  assert.equal(adapter.dispatched.length, 1);
});

test('stop only affects the requested workspace, never the queue currently hidden by selection', async t => {
  const { manager, adapter } = await fixture(t); const [alpha, beta] = await addTwo(manager);
  adapter.monitorGate = deferred();
  await manager.startQueue(batch(alpha, { workflowIds: [101, 102], allowMultiple: true })); await adapter.enteredMonitor.promise;
  await manager.select(beta); manager.stop();
  assert.equal(manager.runners.get(alpha).stopRequested, false);
  assert.equal(manager.runners.get(beta).stopRequested, true);
  manager.stop(alpha); assert.equal(manager.snapshot(alpha).queue.items[1].status, 'skipped');
  assert.deepEqual(manager.globalQueue, { workspaceId: alpha, repository: 'acme/alpha' });
  adapter.monitorGate.resolve(); await manager.runners.get(alpha).done;
  assert.equal(adapter.dispatched.length, 1); assert.equal(manager.globalQueue, null);
});

test('stop during manager preflight never launches a workflow', async t => {
  const { manager, adapter } = await fixture(t); const [alpha] = await addTwo(manager);
  const gate = deferred(); const entered = deferred();
  adapter.activeRuns = async () => { entered.resolve(); await gate.promise; return []; };
  const pending = manager.startQueue(batch(alpha)); await entered.promise;
  manager.stop(alpha); gate.resolve();
  await assert.rejects(pending, status(409)); assert.equal(adapter.dispatched.length, 0); assert.equal(manager.globalQueue, null);
});

test('running workspace removal is rejected but inactive removal only changes local settings and selects first/setup', async t => {
  const { manager, adapter } = await fixture(t); const [alpha, beta] = await addTwo(manager);
  adapter.monitorGate = deferred();
  await manager.startQueue(batch(alpha)); await adapter.enteredMonitor.promise;
  await assert.rejects(manager.remove(alpha), status(409));
  await manager.remove(beta);
  assert.equal(manager.snapshot().workspaceId, alpha); assert.equal(manager.runners.has(beta), false);
  assert.equal(manager.snapshot().globalQueue.workspaceId, alpha);
  adapter.monitorGate.resolve(); await manager.runners.get(alpha).done;
  const runner = manager.runners.get(alpha); await manager.remove(alpha);
  assert.equal(runner.closed, true); assert.equal(manager.mode, 'setup'); assert.deepEqual(manager.snapshot().workspaces, []);
  assert.ok(!adapter.calls.some(call => call[0] === 'delete'));
});

for (const id of ['stale-id', null, '', 123]) {
  test(`explicit unknown ID ${JSON.stringify(id)} never falls back to active`, async t => {
    const { manager, adapter } = await fixture(t); await manager.configure('acme/alpha');
    const before = adapter.calls.length;
    assert.throws(() => manager.snapshot(id), status(404));
    assert.throws(() => manager.stop(id), status(404));
    await assert.rejects(manager.refresh({ workspaceId: id }), status(404));
    await assert.rejects(manager.inputs(101, 'main', id), status(404));
    await assert.rejects(manager.select(id), status(404));
    await assert.rejects(manager.saveBranch(id, 'main'), status(404));
    await assert.rejects(manager.remove(id), status(404));
    await assert.rejects(manager.startQueue(batch(id)), status(404));
    assert.equal(adapter.calls.length, before); assert.equal(manager.globalQueue, null);
  });
}

test('configuration mutex excludes starts and other changes before network/persistence completes', async t => {
  const { manager, adapter } = await fixture(t); const [alpha, beta] = await addTwo(manager);
  const gate = deferred(); const entered = deferred();
  adapter.validateRef = async () => { entered.resolve(); await gate.promise; };
  const pending = manager.saveBranch(alpha, 'new-branch'); await entered.promise;
  await assert.rejects(manager.startQueue(batch(beta)), status(409));
  await assert.rejects(manager.select(beta), status(409));
  await assert.rejects(manager.configure('acme/gamma'), status(409));
  await assert.rejects(manager.remove(beta), status(409));
  assert.equal(manager.snapshot(alpha).branch, 'trunk');
  gate.resolve(); await pending; assert.equal(manager.snapshot(alpha).branch, 'new-branch');
});

for (const operation of ['configure', 'select', 'saveBranch', 'remove']) {
  test(`failed ${operation} persistence leaves config and runner state unchanged`, async t => {
    const { manager, directory, configPath } = await fixture(t); const [alpha, beta] = await addTwo(manager);
    const disk = await readFile(configPath, 'utf8'); const state = manager.snapshot(); const config = structuredClone(manager.config);
    const runners = [...manager.runners.entries()];
    const blocker = join(directory, 'not-a-directory'); await writeFile(blocker, 'block');
    manager.configPath = join(blocker, 'config.json');
    const change = {
      configure: () => manager.configure('acme/gamma'), select: () => manager.select(alpha),
      saveBranch: () => manager.saveBranch(beta, 'new-branch'), remove: () => manager.remove(beta),
    }[operation];
    await assert.rejects(change());
    assert.deepEqual(manager.config, config); assert.deepEqual(manager.snapshot(), state);
    assert.deepEqual([...manager.runners.entries()], runners); assert.ok(runners.every(([, runner]) => !runner.closed));
    assert.equal(await readFile(configPath, 'utf8'), disk); assert.equal(manager.changing, false);
    manager.configPath = configPath;
    await manager.select(alpha); assert.equal(manager.snapshot().workspaceId, alpha);
  });
}

test('configuration publishes config and runner mappings atomically after persistence', async t => {
  const { manager } = await fixture(t); const [alpha, beta] = await addTwo(manager);
  const original = manager.commit.bind(manager); let before;
  manager.commit = async config => {
    await original(config);
    assert.deepEqual(manager.snapshot(), before);
    assert.ok(manager.config.workspaces.every(entry => manager.runners.has(entry.id)));
  };
  for (const operation of [
    () => manager.configure('acme/gamma'), () => manager.select(alpha),
    () => manager.saveBranch(beta, 'new-choice'), () => manager.remove(alpha),
  ]) {
    before = manager.snapshot(); await operation();
  }
});

test('failed branch validation and repository access do not change persisted selection or memory', async t => {
  const { manager, adapter, configPath } = await fixture(t); const [alpha] = await addTwo(manager);
  const before = manager.snapshot(); const disk = await readFile(configPath, 'utf8');
  await assert.rejects(manager.saveBranch(alpha, '../bad'));
  adapter.validateRef = async () => { throw new Error('branch unavailable'); };
  await assert.rejects(manager.saveBranch(alpha, 'unavailable'), /branch unavailable/);
  adapter.getRepo = async () => { throw new Error('repository unavailable'); };
  await assert.rejects(manager.configure('acme/gamma'), /repository unavailable/);
  assert.deepEqual(manager.snapshot(), before); assert.equal(await readFile(configPath, 'utf8'), disk);
});

test('existing active runs in another saved repository block dispatch, with useful repository name', async t => {
  const { manager, adapter } = await fixture(t); const [alpha, beta] = await addTwo(manager);
  adapter.active.set('acme/beta', [{ id: 42, status: 'in_progress' }]);
  await assert.rejects(manager.startQueue(batch(alpha)), error => error.status === 409 && /acme\/beta/.test(error.message));
  assert.equal(manager.globalQueue, null); assert.equal(adapter.dispatched.length, 0);
  adapter.active.clear(); await manager.startQueue(batch(alpha)); await manager.runners.get(alpha).done;
  assert.equal(adapter.dispatched.length, 1);
  assert.equal(manager.snapshot(beta).queue.items.length, 0);
});

test('current repository active runs are left to the existing runner waiting behavior', async t => {
  const { manager, adapter } = await fixture(t); const [alpha] = await addTwo(manager);
  let currentChecks = 0;
  adapter.activeRuns = async repository => repository === 'acme/alpha' && ++currentChecks === 1 ? [{ id: 42 }] : [];
  await manager.startQueue(batch(alpha)); await manager.runners.get(alpha).done;
  assert.ok(currentChecks >= 3); assert.equal(adapter.dispatched.length, 1);
});

test('monitor uncertainty stops the queue without retry and subsequent batches recheck other repositories', async t => {
  const { manager, adapter } = await fixture(t); const [alpha, beta] = await addTwo(manager);
  adapter.getRun = async () => { throw new Error('monitor uncertainty'); };
  await manager.startQueue(batch(alpha, { workflowIds: [101, 102], allowMultiple: true }));
  await manager.runners.get(alpha).done;
  assert.equal(adapter.dispatched.length, 1); assert.deepEqual(manager.snapshot(alpha).queue.items.map(item => item.status), ['failed', 'skipped']);
  assert.equal(manager.globalQueue, null);
  adapter.active.set('acme/alpha', [{ id: 9000 }]);
  await assert.rejects(manager.startQueue(batch(beta)), error => error.status === 409 && /acme\/alpha/.test(error.message));
  assert.equal(adapter.dispatched.length, 1);
});

test('invalid explicit refs release the global lock without network access', async t => {
  const { manager, adapter } = await fixture(t); const [alpha] = await addTwo(manager);
  const before = adapter.calls.length;
  for (const ref of [undefined, '', null, '../main']) {
    await assert.rejects(manager.startQueue(batch(alpha, { ref })));
    assert.equal(manager.globalQueue, null);
  }
  assert.equal(adapter.calls.length, before);
});

test('duplicate configure fills a migrated null default without replacing its runner', async t => {
  const config = { version: 2, activeWorkspaceId: 'alpha', workspaces: [{ id: 'alpha', repository: 'acme/alpha', branch: null }] };
  const { manager, adapter, configPath } = await fixture(t, config);
  const runner = manager.runners.get('alpha'); adapter.defaults.set('acme/alpha', 'develop');
  const snapshot = await manager.configure('acme/alpha');
  assert.equal(snapshot.branch, 'develop'); assert.equal(snapshot.repo.defaultBranch, 'develop');
  assert.equal(manager.runners.get('alpha'), runner);
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).workspaces[0].branch, 'develop');
});

test('inputs in flight retain their repository and branch when selection and preferences change', async t => {
  const { manager, adapter } = await fixture(t); const [alpha, beta] = await addTwo(manager);
  await manager.saveBranch(alpha, 'old-choice'); await manager.select(alpha);
  const gate = deferred(); const entered = deferred(); const original = adapter.getInputs.bind(adapter);
  adapter.getInputs = async (...args) => { entered.resolve(); await gate.promise; return original(...args); };
  const pending = manager.inputs(101); await entered.promise;
  await manager.select(beta); await manager.saveBranch(alpha, 'new-choice'); gate.resolve();
  assert.equal((await pending).inputs[0].default, 'acme/alpha');
  assert.deepEqual(adapter.calls.find(call => call[0] === 'inputs'), ['inputs', 'acme/alpha', 101, 'old-choice']);
  assert.equal(manager.snapshot(alpha).branch, 'new-choice'); assert.equal(manager.snapshot().workspaceId, beta);
});

test('sequential workspace queues with colliding workflow IDs retain isolated histories', async t => {
  const { manager, adapter } = await fixture(t); const [alpha, beta] = await addTwo(manager);
  await manager.refresh({ workspaceId: alpha }); await manager.refresh({ workspaceId: beta });
  await manager.startQueue(batch(alpha)); await manager.runners.get(alpha).done;
  const first = manager.snapshot(alpha);
  await manager.startQueue(batch(beta, { ref: 'other-branch' })); await manager.runners.get(beta).done;
  assert.deepEqual(manager.snapshot(alpha).queue, first.queue);
  assert.equal(manager.snapshot(alpha).workflows[0].lastRun.branch, 'release');
  assert.equal(manager.snapshot(beta).workflows[0].lastRun.branch, 'other-branch');
  assert.deepEqual(adapter.dispatched.map(value => value.repository), ['acme/alpha', 'acme/beta']);
  assert.notEqual(manager.runners.get(alpha).queue, manager.runners.get(beta).queue);
});

test('repositories added while global preflight awaits are also checked before launch', async t => {
  const { manager, adapter } = await fixture(t); const [alpha] = await addTwo(manager);
  const gate = deferred(); const entered = deferred(); const original = adapter.activeRuns.bind(adapter);
  adapter.activeRuns = async repository => {
    if (repository === 'acme/beta') { entered.resolve(); await gate.promise; }
    return original(repository);
  };
  const pending = manager.startQueue(batch(alpha)); await entered.promise;
  await manager.configure('acme/gamma'); adapter.active.set('acme/gamma', [{ id: 42 }]); gate.resolve();
  await assert.rejects(pending, error => error.status === 409 && /acme\/gamma/.test(error.message));
  assert.equal(adapter.dispatched.length, 0); assert.equal(manager.globalQueue, null);
});

test('repositories added during schema validation are checked again at dispatch', async t => {
  const { manager, adapter } = await fixture(t); const [alpha] = await addTwo(manager);
  const gate = deferred(); const entered = deferred(); const original = adapter.getInputs.bind(adapter);
  adapter.getInputs = async (...args) => { entered.resolve(); await gate.promise; return original(...args); };
  const pending = manager.startQueue(batch(alpha)); await entered.promise;
  await manager.configure('acme/gamma'); adapter.active.set('acme/gamma', [{ id: 42 }]);
  gate.resolve(); await pending; await manager.runners.get(alpha).done;
  assert.equal(adapter.dispatched.length, 0);
  assert.match(manager.snapshot(alpha).queue.error, /acme\/gamma/);
  assert.equal(manager.globalQueue, null);
});

test('active runs in a workspace added during monitoring stop later dispatches', async t => {
  const { manager, adapter } = await fixture(t); const [alpha] = await addTwo(manager);
  adapter.monitorGate = deferred();
  await manager.startQueue(batch(alpha, { workflowIds: [101, 102], allowMultiple: true })); await adapter.enteredMonitor.promise;
  await manager.configure('acme/gamma'); adapter.active.set('acme/gamma', [{ id: 42 }]);
  adapter.monitorGate.resolve(); await manager.runners.get(alpha).done;
  assert.equal(adapter.dispatched.length, 1);
  assert.deepEqual(manager.snapshot(alpha).queue.items.map(item => item.status), ['completed', 'failed']);
  assert.match(manager.snapshot(alpha).queue.error, /acme\/gamma/);
  assert.equal(manager.globalQueue, null);
});

test('close during an awaited configuration cannot create an unclosed workspace after shutdown', async t => {
  const { manager, adapter, configPath } = await fixture(t); await manager.configure('acme/alpha');
  const before = await readFile(configPath, 'utf8'); const gate = deferred(); const entered = deferred();
  const original = adapter.getRepo.bind(adapter);
  adapter.getRepo = async repository => { entered.resolve(); await gate.promise; return original(repository); };
  const pending = manager.configure('acme/beta'); await entered.promise;
  const rejected = assert.rejects(pending, status(503));
  const closing = manager.close(); gate.resolve(); await rejected; await closing;
  assert.equal(manager.runners.size, 1); assert.ok([...manager.runners.values()].every(runner => runner.closed));
  assert.equal(await readFile(configPath, 'utf8'), before);
});

test('close during preflight waits for launch reservation to settle and never dispatches', async t => {
  const { manager, adapter } = await fixture(t); const [alpha] = await addTwo(manager);
  const gate = deferred(); const entered = deferred();
  adapter.activeRuns = async () => { entered.resolve(); await gate.promise; return []; };
  const pending = manager.startQueue(batch(alpha)); await entered.promise;
  const rejected = assert.rejects(pending, status(409));
  const closing = manager.close(); gate.resolve(); await rejected; await closing;
  assert.equal(manager.globalQueue, null); assert.equal(adapter.dispatched.length, 0);
});

test('close stops every runner and rejects new starts or settings writes', async t => {
  const { manager } = await fixture(t); const [alpha] = await addTwo(manager);
  const runners = [...manager.runners.values()]; await manager.close();
  assert.ok(runners.every(runner => runner.closed)); assert.equal(manager.setupRunner.closed, true);
  await assert.rejects(manager.startQueue(batch(alpha)), status(503));
  await assert.rejects(manager.select(alpha), status(503));
  assert.equal(manager.message(new Error('secret-token failed')), '[redacted] failed');
});
