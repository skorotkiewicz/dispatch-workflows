import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError, GitHubAdapter, lastRun, parseDispatchInputs, resolveAuth, validateInputs, validateRepository } from '../lib/github.mjs';
import { WorkflowRunner, readRepository } from '../lib/runner.mjs';
import { createApplication } from '../server.mjs';

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const SCHEMA = { dispatchable: true, inputs: [] };
const REQUIRED = { dispatchable: true, inputs: [{ name: 'version', description: '', type: 'string', required: true, default: null }] };

class FakeGitHub {
  constructor() {
    this.auth = 'environment'; this.workflows = [101, 102].map(id => ({ id, name: `Workflow ${id}`, path: `.github/workflows/${id}.yml`, state: 'active' }));
    this.schemas = new Map(); this.dispatched = []; this.runs = new Map(); this.events = []; this.details = true;
    this.conclusions = ['success', 'success']; this.polls = new Map(); this.now = () => Date.now(); this.activeChecks = 0;
  }
  sanitize(message) { return String(message).replaceAll('fake-token', '[redacted]'); }
  async getRepo(name) { return { fullName: name, url: `https://github.com/${name}`, defaultBranch: 'main' }; }
  async listWorkflows() { return this.workflows; }
  async latestRun() { return null; }
  async getInputs(repo, workflow) { return this.schemas.get(workflow.id) || SCHEMA; }
  async validateRef(repo, ref) { return { ref, sha: 'abc123' }; }
  async actor() { return 'operator'; }
  async activeRuns() { this.activeChecks++; this.events.push('idle-check'); return []; }
  async dispatchRuns(repo, workflowId, ref) { return [...this.runs.values()].filter(run => run.workflow_id === workflowId && run.head_branch === ref); }
  makeRun(id, workflowId, ref, extra = {}) {
    const timestamp = new Date(this.now()).toISOString();
    return { id, workflow_id: workflowId, event: 'workflow_dispatch', head_branch: ref, run_attempt: 1,
      actor: { login: 'operator' }, created_at: timestamp, run_started_at: timestamp, updated_at: timestamp,
      html_url: `https://github.com/acme/platform/actions/runs/${id}`, status: 'queued', conclusion: null, ...extra };
  }
  async dispatch(repo, workflowId, ref, inputs) {
    const id = 9000 + this.dispatched.length;
    this.dispatched.push({ workflowId, ref, inputs, id }); this.events.push(`dispatch:${workflowId}`);
    this.runs.set(id, this.makeRun(id, workflowId, ref));
    return this.details ? { id } : null;
  }
  async getRun(repo, id) {
    const poll = (this.polls.get(id) || 0) + 1; this.polls.set(id, poll);
    const run = this.runs.get(id);
    if (poll === 1) { this.events.push(`progress:${run.workflow_id}`); return { ...run, status: 'in_progress' }; }
    this.events.push(`completed:${run.workflow_id}`);
    return { ...run, status: 'completed', conclusion: this.conclusions[this.dispatched.findIndex(item => item.id === id)] || 'success' };
  }
}
function fixture(options = {}) {
  let clock = Date.parse('2026-10-20T12:00:00Z');
  const adapter = options.adapter || new FakeGitHub(); adapter.now = () => clock;
  const runner = new WorkflowRunner({ adapter, repository: 'acme/platform', configPath: '/unused/config.json',
    pollMs: 5, trackingTimeoutMs: 15, idleTimeoutMs: 30, runTimeoutMs: 50,
    now: () => clock, sleep: async ms => { clock += ms + 1; }, ...options });
  return { runner, adapter };
}
const batch = (ids = [101, 102], extra = {}) => ({ workflowIds: ids, ref: 'main', allowMultiple: ids.length > 1, inputs: {}, ...extra });

for (const repository of ['acme/platform', 'https://github.com/acme/platform', 'https://github.com/acme/platform/', 'https://github.com/acme/platform.git']) {
  test(`repository validation accepts ${repository}`, () => assert.equal(validateRepository(repository), 'acme/platform'));
}
for (const repository of ['http://github.com/acme/platform', 'https://evil.example/acme/platform', 'https://github.com@evil.example/acme/platform', 'https://user:secret@github.com/acme/platform', 'https://github.com:444/acme/platform', 'https://github.com/acme/platform?tab=actions', 'https://github.com/acme/platform#readme', 'acme/platform/actions', '../platform', 'acme/..', '-bad/repo', '', null]) {
  test(`repository validation rejects ${repository}`, () => assert.throws(() => validateRepository(repository), ApiError));
}

test('authentication prefers environment and never runs a shell', async () => {
  assert.deepEqual(await resolveAuth({ GH_TOKEN: ' one ', GITHUB_TOKEN: 'two' }, () => { throw new Error('not expected'); }), { token: 'one', source: 'environment' });
  assert.deepEqual(await resolveAuth({}, async (file, args, options) => {
    assert.equal(file, 'gh'); assert.deepEqual(args, ['auth', 'token', '--hostname', 'github.com']); assert.equal(options.timeout, 5000);
    return { stdout: ' cli-token\n' };
  }), { token: 'cli-token', source: 'gh' });
  assert.deepEqual(await resolveAuth({}, async () => { throw new Error('missing'); }), { token: null, source: 'none' });
});

test('YAML 1.2 on property and dispatch definitions are parsed correctly', () => {
  const result = parseDispatchInputs(`name: Deploy\non:\n  push:\n  workflow_dispatch:\n    inputs:\n      version:\n        description: Release tag\n        required: true\n      dry_run:\n        type: boolean\n        default: false\n      target:\n        type: choice\n        options: [staging, production]\n        default: staging\n`);
  assert.equal(result.dispatchable, true);
  assert.deepEqual(result.inputs[0], { name: 'version', description: 'Release tag', type: 'string', required: true, default: null });
  assert.equal(result.inputs[1].default, false);
  assert.deepEqual(result.inputs[2].options, ['staging', 'production']);
  assert.equal(parseDispatchInputs('on: [push, workflow_dispatch]').dispatchable, true);
  assert.equal(parseDispatchInputs('on: workflow_dispatch').dispatchable, true);
  assert.equal(parseDispatchInputs('on:\n  workflow_dispatch:').dispatchable, true);
  assert.equal(parseDispatchInputs('on: push').dispatchable, false);
  assert.throws(() => parseDispatchInputs('on: [oops'), /could not be parsed/);
  assert.throws(() => parseDispatchInputs('on:\n  workflow_dispatch:\n    inputs:\n      x:\n        type: choice'), /invalid choices/);
});

test('dispatch input validation covers required, unknown, defaults, types, choices, and false/zero', () => {
  const schema = { dispatchable: true, inputs: [
    { name: 'version', type: 'string', required: true, default: null },
    { name: 'approve', type: 'boolean', required: true, default: false },
    { name: 'count', type: 'number', required: true, default: 0 },
    { name: 'target', type: 'choice', required: false, default: 'staging', options: ['staging', 'production'] },
    { name: 'environment', type: 'environment', required: false, default: null },
  ] };
  const result = validateInputs(schema, { version: 'v1', approve: 'false', count: '0' });
  assert.deepEqual({ ...result }, { version: 'v1', approve: false, count: 0, target: 'staging' });
  for (const inputs of [{}, { version: '' }, { version: '  ' }, { version: 'v1', unknown: 'x' }, { version: 123 },
    { version: 'v1', approve: 'yes' }, { version: 'v1', count: 'Infinity' }, { version: 'v1', count: {} },
    { version: 'v1', target: 'bad' }, { version: 'v1', environment: {} }]) assert.throws(() => validateInputs(schema, inputs));
  assert.throws(() => validateInputs({ dispatchable: false, inputs: [] }, {}), /does not support/);
});

test('queue dispatch is sequential and waits for completion before next dispatch', async () => {
  const { runner, adapter } = fixture();
  await runner.startQueue(batch()); await runner.done;
  assert.deepEqual(adapter.dispatched.map(item => item.workflowId), [101, 102]);
  assert.ok(adapter.events.indexOf('completed:101') < adapter.events.indexOf('dispatch:102'));
  assert.ok(adapter.activeChecks >= 4);
  assert.equal(runner.queue.running, false); assert.equal(runner.queue.error, null);
  assert.deepEqual(runner.queue.items.map(item => item.status), ['completed', 'completed']);
});

test('failed first workflow stops the batch and marks pending workflows skipped', async () => {
  const { runner, adapter } = fixture(); adapter.conclusions[0] = 'failure';
  await runner.startQueue(batch()); await runner.done;
  assert.equal(adapter.dispatched.length, 1);
  assert.deepEqual(runner.queue.items.map(item => item.status), ['failed', 'skipped']);
  assert.equal(runner.queue.items[0].conclusion, 'failure'); assert.match(runner.queue.error, /finished with failure/);
});

for (const [name, request] of [
  ['empty selection', batch([])], ['duplicate selection', batch([101, 101])], ['unknown ID', batch([999])],
  ['multiple without opt-in', batch([101, 102], { allowMultiple: false })], ['non-boolean opt-in', batch([101], { allowMultiple: 'true' })],
  ['non-numeric ID', batch(['101'])], ['bad ref', batch([101], { ref: '../main' })],
  ['empty ref', batch([101], { ref: '' })], ['unselected inputs', batch([101], { inputs: { 102: {} } })],
]) test(`selection validation: ${name}`, async () => {
  const { runner, adapter } = fixture();
  await assert.rejects(runner.startQueue(request), ApiError);
  assert.equal(adapter.dispatched.length, 0); assert.equal(runner.queue.running, false);
});

test('ALL workflow schemas and inputs are validated before ANY dispatch', async () => {
  const { runner, adapter } = fixture(); adapter.schemas.set(102, REQUIRED);
  await assert.rejects(runner.startQueue(batch()), /version is required/);
  assert.equal(adapter.dispatched.length, 0);
  await runner.startQueue(batch([101, 102], { inputs: { 102: { version: 'v1.2.3' } } })); await runner.done;
  assert.equal(adapter.dispatched[1].inputs.version, 'v1.2.3');
});

test('disabled and non-dispatchable workflows are rejected before dispatch', async () => {
  const { runner, adapter } = fixture(); adapter.workflows[1].state = 'disabled_manually';
  await assert.rejects(runner.startQueue(batch()), /not active/);
  adapter.workflows[1].state = 'active'; adapter.schemas.set(102, { dispatchable: false, inputs: [] });
  await assert.rejects(runner.startQueue(batch()), /does not support/);
  assert.equal(adapter.dispatched.length, 0);
});

test('queue lock is acquired before the first await and excludes config/demo changes', async () => {
  const { runner, adapter } = fixture(); const gate = deferred();
  adapter.listWorkflows = async () => { await gate.promise; return adapter.workflows; };
  const first = runner.startQueue(batch([101]));
  await assert.rejects(runner.startQueue(batch([102])), error => error.status === 409);
  await assert.rejects(runner.configure('other/repo'), error => error.status === 409);
  await assert.rejects(runner.demo(), error => error.status === 409);
  gate.resolve(); await first; await runner.done;
  assert.equal(adapter.dispatched.length, 1);
});

test('stop skips pending workflows but continues monitoring the dispatched run', async () => {
  const sleeping = deferred(), release = deferred();
  const { runner, adapter } = fixture({ sleep: async () => { sleeping.resolve(); await release.promise; } });
  await runner.startQueue(batch()); await sleeping.promise;
  const state = runner.stop();
  assert.equal(state.queue.running, true); assert.equal(state.queue.items[1].status, 'skipped');
  release.resolve(); await runner.done;
  assert.equal(adapter.dispatched.length, 1); assert.equal(runner.queue.items[0].status, 'completed');
  assert.ok(adapter.events.includes('completed:101'));
});

test('stop during prevalidation skips the entire batch without dispatching', async () => {
  const { runner, adapter } = fixture(); const gate = deferred();
  adapter.getInputs = async () => { await gate.promise; return SCHEMA; };
  const started = runner.startQueue(batch()); runner.stop(); gate.resolve(); await started; await runner.done;
  assert.equal(adapter.dispatched.length, 0);
  assert.deepEqual(runner.queue.items.map(item => item.status), ['skipped', 'skipped']);
});

test('pre-existing repository runs block dispatch; stopping that wait dispatches nothing', async () => {
  const sleeping = deferred(), release = deferred();
  const { runner, adapter } = fixture({ sleep: async () => { sleeping.resolve(); await release.promise; } });
  adapter.activeRuns = async () => [{ id: 700, status: 'in_progress' }];
  await runner.startQueue(batch()); await sleeping.promise;
  assert.equal(adapter.dispatched.length, 0); runner.stop(); release.resolve(); await runner.done;
  assert.deepEqual(runner.queue.items.map(item => item.status), ['skipped', 'skipped']);
  assert.equal(adapter.dispatched.length, 0);
});

test('pre-existing runs must finish before a new dispatch and idle timeout fails safely', async () => {
  const { runner, adapter } = fixture(); let checks = 0;
  adapter.activeRuns = async () => ++checks < 3 ? [{ id: 7, status: 'queued' }] : [];
  await runner.startQueue(batch([101])); await runner.done;
  assert.ok(checks >= 4); assert.equal(adapter.dispatched.length, 1);
  const second = fixture(); second.adapter.activeRuns = async () => [{ id: 7, status: 'waiting' }];
  await second.runner.startQueue(batch()); await second.runner.done;
  assert.equal(second.adapter.dispatched.length, 0); assert.match(second.runner.queue.error, /Timed out waiting for existing/);
});

test('GitHub polling errors fail closed and never dispatch the next workflow', async () => {
  const { runner, adapter } = fixture();
  adapter.getRun = async () => { throw new ApiError('GitHub request timed out.', 502); };
  await runner.startQueue(batch()); await runner.done;
  assert.equal(adapter.dispatched.length, 1); assert.deepEqual(runner.queue.items.map(item => item.status), ['failed', 'skipped']);
  assert.match(runner.queue.error, /timed out/);
});

test('uncertain dispatch POST failure is never retried', async () => {
  const { runner, adapter } = fixture(); let attempts = 0;
  adapter.dispatch = async () => { attempts++; throw new ApiError('Dispatch outcome is uncertain; it will not be retried.', 502); };
  await runner.startQueue(batch()); await runner.done;
  assert.equal(attempts, 1); assert.match(runner.queue.error, /uncertain/); assert.equal(runner.queue.items[1].status, 'skipped');
});

test('legacy 204 dispatch snapshots IDs and correlates only a new workflow/ref/time/actor run', async () => {
  const { runner, adapter } = fixture(); adapter.details = false;
  adapter.runs.set(42, adapter.makeRun(42, 101, 'main', { run_attempt: 2, created_at: '2020-01-01T00:00:00Z' }));
  await runner.startQueue(batch([101])); await runner.done;
  assert.equal(runner.queue.items[0].status, 'completed');
  assert.match(runner.queue.items[0].runUrl, /9000$/); assert.equal(adapter.polls.has(42), false);
});

test('ambiguous legacy dispatch correlation stops without advancing', async () => {
  const { runner, adapter } = fixture(); adapter.details = false;
  const dispatch = adapter.dispatch.bind(adapter);
  adapter.dispatch = async (...args) => {
    await dispatch(...args); adapter.runs.set(9999, adapter.makeRun(9999, 101, 'main')); return null;
  };
  await runner.startQueue(batch()); await runner.done;
  assert.match(runner.queue.error, /ambiguous/); assert.equal(adapter.dispatched.length, 1);
  assert.equal(runner.queue.items[1].status, 'skipped');
});

for (const [name, change] of [
  ['rerun', { run_attempt: 2 }], ['old timestamp', { created_at: '2020-01-01T00:00:00Z' }],
  ['other actor', { actor: { login: 'someone-else' } }], ['other branch', { head_branch: 'another' }],
]) test(`legacy dispatch does not confuse a ${name} with its own run`, async () => {
  const { runner, adapter } = fixture(); adapter.details = false;
  const dispatch = adapter.dispatch.bind(adapter);
  adapter.dispatch = async (...args) => { await dispatch(...args); Object.assign(adapter.runs.get(9000), change); return null; };
  await runner.startQueue(batch()); await runner.done;
  assert.match(runner.queue.error, /Could not reliably identify/); assert.equal(adapter.dispatched.length, 1);
});

test('authoritative run details are checked against workflow and ref', async () => {
  const { runner, adapter } = fixture();
  adapter.getRun = async () => adapter.makeRun(9000, 999, 'other');
  await runner.startQueue(batch()); await runner.done;
  assert.match(runner.queue.error, /mismatched/); assert.equal(adapter.dispatched.length, 1);
});

test('state refresh uses every workflow’s latest run with limited concurrency', async () => {
  const { runner, adapter } = fixture(); let active = 0, peak = 0;
  adapter.workflows = Array.from({ length: 13 }, (_, index) => ({ id: index + 1, name: `Workflow ${index}`, path: '.github/workflows/ci.yml', state: 'active' }));
  adapter.latestRun = async (repo, workflowId) => {
    peak = Math.max(peak, ++active); await new Promise(resolve => setImmediate(resolve)); active--;
    return workflowId === 13 ? null : adapter.makeRun(workflowId * 100, workflowId, 'main', { status: 'completed', conclusion: 'success' });
  };
  const state = await runner.refresh();
  assert.equal(state.workflows.length, 13); assert.ok(peak <= 4 && peak > 1);
  assert.equal(state.workflows[7].lastRun.id, 800); assert.equal(state.workflows[12].lastRun, null);
  assert.equal(state.workflows[0].lastRun.branch, 'main'); assert.ok(Object.hasOwn(state.workflows[0].lastRun, 'createdAt'));
});

test('GitHub pagination retrieves later workflow pages and dispatch requests prefer return_run_details', async () => {
  const calls = [];
  const adapter = new GitHubAdapter({ token: 'top-secret', source: 'environment', fetchImpl: async (url, options) => {
    calls.push({ url, options });
    assert.ok(url.startsWith('https://api.github.com/')); assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
    if (options.method === 'POST') return Response.json({ workflow_run_id: 123, run_url: 'https://api.github.com/repos/acme/platform/actions/runs/123', html_url: 'https://github.com/acme/platform/actions/runs/123' });
    const page = new URL(url).searchParams.get('page');
    return Response.json({ total_count: 101, workflows: page === '1' ? Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })) : [{ id: 101 }] });
  } });
  const workflows = await adapter.listWorkflows('acme/platform'); assert.equal(workflows.length, 101);
  const result = await adapter.dispatch('acme/platform', 101, 'main', { dry_run: false }); assert.equal(result.id, 123);
  assert.equal(JSON.parse(calls.at(-1).options.body).return_run_details, true);
  assert.equal(calls.at(-1).options.headers.Authorization, 'Bearer top-secret');
  assert.equal(calls.filter(call => call.url.includes('/actions/workflows?')).length, 2);
});

test('GitHub adapter supports 204 fallback, redacts credentials, and gives timeout errors', async () => {
  const adapter = new GitHubAdapter({ token: 'top-secret', fetchImpl: async () => new Response(null, { status: 204 }) });
  assert.equal(await adapter.dispatch('acme/platform', 1, 'main', {}), null);
  adapter.fetch = async () => Response.json({ message: 'forbidden top-secret' }, { status: 403 });
  await assert.rejects(adapter.getRepo('acme/platform'), error => !error.message.includes('top-secret') && error.message.includes('[redacted]'));
  adapter.fetch = async () => { throw new DOMException('Timeout', 'TimeoutError'); };
  await assert.rejects(adapter.dispatch('acme/platform', 1, 'main', {}), /outcome is uncertain/);
  await assert.rejects(adapter.request('//evil.example/path'), /Invalid GitHub API path/);
});

test('lastRun metadata is camelCase, duration is seconds, and links cannot escape github.com', () => {
  assert.deepEqual(lastRun({ id: 1, status: 'completed', conclusion: 'success', created_at: '2026-01-01T00:00:00Z',
    run_started_at: '2026-01-01T00:00:02Z', updated_at: '2026-01-01T00:00:12Z', html_url: 'https://evil.example/run', head_branch: 'main' }), {
    id: 1, status: 'completed', conclusion: 'success', createdAt: '2026-01-01T00:00:00Z', startedAt: '2026-01-01T00:00:02Z',
    updatedAt: '2026-01-01T00:00:12Z', url: null, branch: 'main', duration: 10,
  });
});

test('config stores repository only, explicit demo survives restart, env is bootstrap only', async t => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-config-')); t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, '.data/config.json'); const { runner } = fixture({ configPath });
  assert.equal(await readRepository(configPath, { GITHUB_REPO: 'acme/env' }), 'acme/env');
  await runner.configure('https://github.com/acme/configured');
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), { repository: 'acme/configured' });
  assert.equal(await readRepository(configPath, { GITHUB_REPO: 'acme/env' }), 'acme/configured');
  await runner.demo(); assert.equal(await readRepository(configPath, { GITHUB_REPO: 'acme/env' }), null);
  assert.equal(runner.mode, 'demo'); assert.equal(runner.repo.fullName, 'acme/platform');
});

test('demo has eight realistic workflows and simulated sequential runs never call GitHub', async () => {
  const adapter = new Proxy({ auth: 'none' }, { get(target, property) { if (property in target) return target[property]; if (property === 'sanitize') return undefined; return () => { throw new Error(`Unexpected GitHub call: ${String(property)}`); }; } });
  const { runner } = fixture({ adapter, repository: null, demoDurationMs: 3 });
  const state = await runner.refresh(); assert.equal(state.mode, 'demo'); assert.equal(state.workflows.length, 8);
  assert.equal(state.repo.url, null); assert.ok(state.workflows.some(workflow => workflow.lastRun === null));
  assert.ok(state.workflows.every(workflow => workflow.lastRun?.url == null));
  await runner.startQueue(batch([1, 2])); await runner.done;
  assert.deepEqual(runner.queue.items.map(item => item.status), ['completed', 'completed']);
  assert.equal(runner.workflows[0].lastRun.duration, 0); // Accelerated test clock; production uses ~3 seconds.
});

async function httpFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'workflow-http-'));
  await mkdir(join(root, 'public')); await writeFile(join(root, 'public/index.html'), '<!doctype html><title>Runner</title>');
  await writeFile(join(root, 'private.txt'), 'server-only-secret'); await symlink(join(root, 'private.txt'), join(root, 'public/leak.txt'));
  const { runner } = fixture({ repository: null, configPath: join(root, '.data/config.json'), demoDurationMs: 1 });
  const app = await createApplication({ rootDir: root, runner });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port; const origin = `http://127.0.0.1:${port}`;
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const post = (path, body = {}, headers = {}) => fetch(`${origin}${path}`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { app, origin, port, post, root };
}
function rawRequest(port, path, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: response.headers }));
    }); req.on('error', reject); req.end();
  });
}

test('HTTP contract serves demo state, YAML input metadata, queues and stop', async t => {
  const { origin, post, app } = await httpFixture(t);
  const response = await fetch(`${origin}/api/state`); assert.equal(response.status, 200);
  const state = await response.json();
  assert.deepEqual(Object.keys(state).sort(), ['auth', 'mode', 'queue', 'repo', 'updatedAt', 'workflows']);
  assert.equal(state.mode, 'demo'); assert.equal(state.workflows.length, 8); assert.equal(state.queue.error, null);
  const inputs = await (await fetch(`${origin}/api/workflows/3/inputs?ref=main`)).json();
  assert.equal(inputs.dispatchable, true); assert.equal(inputs.inputs[0].name, 'version');
  const started = await post('/api/queue', batch([1, 2])); assert.equal(started.status, 202);
  assert.ok((await started.json()).queue);
  assert.equal((await post('/api/queue/stop')).status, 200); await app.runner.done;
  assert.equal((await post('/api/demo')).status, 200);
});

test('HTTP security rejects foreign hosts/origins/content types and malformed JSON', async t => {
  const { origin, port, post } = await httpFixture(t);
  assert.equal((await rawRequest(port, '/api/state', { Host: `evil.example:${port}` })).status, 403);
  assert.equal((await rawRequest(port, '/api/state', { Host: '127.0.0.1:1' })).status, 403);
  assert.equal((await rawRequest(port, '/api/state', { Host: `localhost:${port}` })).status, 200);
  assert.equal((await post('/api/demo', {}, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/demo', {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await fetch(`${origin}/api/demo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await fetch(`${origin}/api/demo`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  const invalid = await post('/api/config', { repository: 'https://evil.example/owner/repo' });
  assert.equal(invalid.status, 400); assert.equal(typeof (await invalid.json()).error, 'string');
  assert.equal((await post('/api/demo', 'x'.repeat(66000))).status, 413);
});

test('static mapping serves only public regular files and rejects traversal and escaping symlinks', async t => {
  const { origin, port } = await httpFixture(t);
  const index = await fetch(origin); assert.equal(index.status, 200); assert.match(await index.text(), /<title>Runner/);
  assert.match(index.headers.get('content-type'), /text\/html/); assert.equal(index.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await fetch(origin, { method: 'HEAD' })).status, 200);
  for (const path of ['/../private.txt', '/%2e%2e/private.txt', '/%2e%2e%2fprivate.txt', '/%00', '/%5c..%5cprivate.txt', '/leak.txt']) {
    const result = await rawRequest(port, path); assert.equal(result.status, 403, path); assert.ok(!result.body.includes('server-only-secret'));
  }
  assert.equal((await fetch(`${origin}/server.mjs`)).status, 404);
  assert.equal((await fetch(`${origin}/.data/config.json`)).status, 404);
});
