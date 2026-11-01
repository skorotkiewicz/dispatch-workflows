import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiError, lastRun, mapLimit, validateInputs, validateRepository } from './github.mjs';

export async function readRepository(configPath, env = process.env) {
  try {
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    if (config.repository === null) return env.GITHUB_REPO ? validateRepository(env.GITHUB_REPO) : null;
    return validateRepository(config.repository);
  } catch (error) {
    if (error.code === 'ENOENT') return env.GITHUB_REPO ? validateRepository(env.GITHUB_REPO) : null;
    if (error instanceof ApiError) throw error;
    throw new ApiError('Could not read .data/config.json. Fix or remove that file before restarting.', 500);
  }
}

export async function persistRepository(configPath, repository) {
  return persistConfiguration(configPath, { repository });
}

export async function persistConfiguration(configPath, configuration) {
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  const temp = `${configPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(configuration, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temp, configPath);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw new ApiError('Could not save repository configuration.', 500);
  }
}

function copy(value) { return structuredClone(value); }
export function validRef(ref) {
  if (typeof ref !== 'string' || !ref || ref.length > 255 || ref.trim() !== ref ||
      /[\s\x00-\x1f\x7f~^:?*\[\\]/.test(ref) || ref.includes('..') || ref.includes('@{') ||
      ref.startsWith('/') || ref.endsWith('/') || ref.endsWith('.') || ref.includes('//') ||
      ref.split('/').some(part => part.startsWith('.') || part.endsWith('.lock')))
    throw new ApiError('Choose a valid branch name.');
  return ref.replace(/^refs\/heads\//, '');
}

export class WorkflowRunner {
  constructor({ adapter, configPath, repository = null, pollMs = 10000,
    refreshMs = 30000,
    trackingTimeoutMs = 120000, idleTimeoutMs = 1800000, runTimeoutMs = 86400000,
    now = Date.now, sleep = delay, beforeDispatch = null } = {}) {
    this.adapter = adapter; this.configPath = configPath; this.repository = repository;
    this.mode = repository ? 'github' : 'setup';
    this.repo = repository ? { fullName: repository, url: `https://github.com/${repository}`, defaultBranch: 'main' } : { fullName: '', url: null, defaultBranch: 'main' };
    this.pollMs = pollMs; this.trackingTimeoutMs = trackingTimeoutMs;
    this.idleTimeoutMs = idleTimeoutMs; this.runTimeoutMs = runTimeoutMs; this.now = now; this.sleep = sleep;
    this.workflows = [];
    this.queue = { running: false, items: [], error: null };
    this.changing = false; this.stopRequested = false; this.closed = false; this.revision = 0;
    this.refreshing = null; this.done = Promise.resolve(); this.abort = new AbortController();
    this.refreshMs = refreshMs; this.refreshedAt = null; this.updatedAt = this.now();
    this.beforeDispatch = beforeDispatch;
  }
  auth() { return this.adapter?.auth || 'none'; }
  snapshot() {
    return copy({ mode: this.mode, repo: this.repo, workflows: this.workflows, queue: this.queue,
      updatedAt: new Date(this.updatedAt).toISOString(), auth: this.auth() });
  }
  message(error) { return this.adapter?.sanitize ? this.adapter.sanitize(error?.message || 'Unexpected backend error.') : String(error?.message || 'Unexpected backend error.'); }
  async refresh({ force = false } = {}) {
    if (!this.repository) return this.snapshot();
    // Local status checks must not fan out to every workflow on every browser poll.
    const lifetime = Math.max(this.refreshMs, this.workflows.length * 3000);
    if (!force && this.refreshedAt !== null && this.now() - this.refreshedAt < lifetime) return this.snapshot();
    if (!this.refreshing) {
      const repoName = this.repository;
      const revision = this.revision;
      const refresh = (async () => {
        const [repo, workflows] = await Promise.all([this.adapter.getRepo(repoName), this.adapter.listWorkflows(repoName)]);
        const rows = await mapLimit(workflows, 4, async workflow => ({
          id: workflow.id, name: workflow.name, path: workflow.path, state: workflow.state,
          lastRun: lastRun(await this.adapter.latestRun(repoName, workflow.id)),
        }));
        if (revision === this.revision) {
          this.repo = repo; this.workflows = rows;
          this.refreshedAt = this.now(); this.updatedAt = this.refreshedAt;
        }
      })();
      this.refreshing = refresh;
      refresh.finally(() => { if (this.refreshing === refresh) this.refreshing = null; }).catch(() => {});
    }
    await this.refreshing;
    return this.snapshot();
  }
  ensureIdle() {
    if (this.closed) throw new ApiError('The server is shutting down.', 503);
    if (this.queue.running || this.changing) throw new ApiError('A queue or configuration change is already active.', 409);
  }
  async configure(repository) {
    this.ensureIdle();
    this.changing = true; // Lock before any asynchronous access or disk operation.
    try {
      const name = validateRepository(repository);
      const repo = await this.adapter.getRepo(name);
      await this.adapter.listWorkflows(repo.fullName); // Confirm Actions visibility as well as repository access.
      await persistRepository(this.configPath, repo.fullName);
      this.revision++; this.repository = repo.fullName; this.repo = repo; this.mode = 'github';
      this.workflows = []; this.refreshing = null; this.refreshedAt = null; this.updatedAt = this.now();
      this.queue = { running: false, items: [], error: null };
      return this.snapshot();
    } finally { this.changing = false; }
  }
  ensureConfigured() {
    if (!this.repository) throw new ApiError('Connect a GitHub repository before running workflows.', 409);
  }
  async inputs(workflowId, ref) {
    this.ensureConfigured();
    if (!Number.isSafeInteger(workflowId) || workflowId <= 0) throw new ApiError('Invalid workflow ID.');
    const branch = validRef(ref || this.repo.defaultBranch);
    const repository = this.repository;
    const workflows = await this.adapter.listWorkflows(repository);
    const workflow = workflows.find(item => item.id === workflowId);
    if (!workflow) throw new ApiError('Workflow not found.', 404);
    return this.adapter.getInputs(repository, workflow, branch);
  }
  async startQueue(request) {
    this.ensureIdle();
    this.ensureConfigured();
    // This is deliberately synchronous and before all awaits: two POSTs cannot dispatch concurrently.
    const previous = this.queue;
    this.queue = { running: true, items: [], error: null }; this.stopRequested = false;
    try {
      const { workflowIds, allowMultiple = false, inputs = {} } = request || {};
      const ref = validRef(request?.ref);
      if (!Array.isArray(workflowIds) || !workflowIds.length || workflowIds.some(id => !Number.isSafeInteger(id) || id <= 0))
        throw new ApiError('Select at least one valid workflow ID.');
      if (new Set(workflowIds).size !== workflowIds.length) throw new ApiError('Workflow IDs must be unique.');
      if (typeof allowMultiple !== 'boolean' || (workflowIds.length > 1 && allowMultiple !== true))
        throw new ApiError('Enable allowMultiple before selecting more than one workflow.');
      if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) throw new ApiError('Inputs must be keyed by workflow ID.');
      if (Object.keys(inputs).some(key => !workflowIds.some(id => String(id) === key))) throw new ApiError('Inputs contain an unselected workflow ID.');
      const workflows = await this.adapter.listWorkflows(this.repository);
      const selected = workflowIds.map(id => {
        const workflow = workflows.find(item => item.id === id);
        if (!workflow) throw new ApiError(`Workflow ${id} was not found.`);
        if (workflow.state !== 'active') throw new ApiError(`Workflow ${workflow.name} is not active.`);
        return workflow;
      });
      await this.adapter.validateRef(this.repository, ref);
      // Every schema and input is validated before the first dispatch, not lazily per item.
      const prepared = await mapLimit(selected, 4, async workflow => {
        const schema = await this.adapter.getInputs(this.repository, workflow, ref);
        return { workflow, inputs: validateInputs(schema, inputs[workflow.id] ?? {}) };
      });
      const actor = await this.adapter.actor();
      this.queue.items = prepared.map(({ workflow }) => ({
        id: randomUUID(), workflowId: workflow.id, name: workflow.name, ref,
        status: this.stopRequested ? 'skipped' : 'pending',
      }));
      // In-memory only: restarting never resumes or re-dispatches a previous queue.
      this.done = this.execute(prepared, ref, actor);
      return this.snapshot();
    } catch (error) {
      this.queue = previous;
      throw error;
    }
  }
  stop() {
    this.stopRequested = true;
    for (const item of this.queue.items) if (item.status === 'pending') item.status = 'skipped';
    return this.snapshot();
  }
  async wait(ms = this.pollMs) {
    if (this.closed) throw new ApiError('Server stopped monitoring. Any dispatched GitHub run may still be active.', 503);
    await this.sleep(ms, undefined, { signal: this.abort.signal });
    if (this.closed) throw new ApiError('Server stopped monitoring. Any dispatched GitHub run may still be active.', 503);
  }
  async execute(prepared, ref, actor) {
    try {
      for (let i = 0; i < prepared.length; i++) {
        const item = this.queue.items[i];
        if (this.stopRequested || this.closed || item.status === 'skipped') { item.status = 'skipped'; continue; }
        try {
          await this.runGitHub(item, prepared[i].inputs, ref, actor);
          if (item.status === 'skipped') continue;
          if (item.conclusion !== 'success') throw new ApiError(`Workflow ${item.name} finished with ${item.conclusion || 'no conclusion'}. Batch stopped.`, 409);
        } catch (error) {
          item.status = 'failed'; item.error = this.message(error); this.queue.error = item.error;
          for (const pending of this.queue.items.slice(i + 1)) if (pending.status === 'pending') pending.status = 'skipped';
          break;
        }
      }
    } catch (error) { this.queue.error = this.message(error); }
    finally {
      for (const item of this.queue.items) if (item.status === 'pending') item.status = 'skipped';
      this.queue.running = false;
    }
  }
  async waitUntilIdle(item) {
    const deadline = this.now() + this.idleTimeoutMs;
    while (true) {
      if (this.stopRequested) { item.status = 'skipped'; return false; }
      const active = await this.adapter.activeRuns(this.repository);
      if (this.stopRequested) { item.status = 'skipped'; return false; }
      if (!active.length) return true;
      if (this.now() >= deadline) throw new ApiError('Timed out waiting for existing repository runs. Nothing new was dispatched.', 504);
      await this.wait();
    }
  }
  async runGitHub(item, inputs, ref, actor) {
    if (!await this.waitUntilIdle(item)) return;
    // Snapshot all matching IDs, including completed and rerun IDs, before sending a single POST.
    const before = await this.adapter.dispatchRuns(this.repository, item.workflowId, ref);
    const known = new Set(before.map(run => run.id));
    // Snapshotting can take time; recheck the repository immediately before dispatch.
    if (!await this.waitUntilIdle(item)) return;
    if (this.beforeDispatch) await this.beforeDispatch();
    if (this.stopRequested || this.closed) { item.status = 'skipped'; return; }
    item.status = 'dispatching';
    const startedAt = this.now();
    const detail = await this.adapter.dispatch(this.repository, item.workflowId, ref, inputs);
    item.status = 'waiting';
    let runId = detail?.id;
    if (detail?.url) item.runUrl = detail.url;
    if (!runId) {
      const deadline = this.now() + this.trackingTimeoutMs;
      while (!runId) {
        const runs = await this.adapter.dispatchRuns(this.repository, item.workflowId, ref);
        const candidates = runs.filter(run => !known.has(run.id) && run.event === 'workflow_dispatch' &&
          run.workflow_id === item.workflowId && run.head_branch === ref && (run.run_attempt ?? 1) === 1 &&
          Number.isFinite(Date.parse(run.created_at)) && Date.parse(run.created_at) >= startedAt - 2000 &&
          (!actor || (run.actor?.login?.toLowerCase() === actor.toLowerCase())));
        // Even a different actor/attempt with a new ID is not mistaken for our dispatch.
        if (candidates.length > 1) throw new ApiError('Dispatch tracking is ambiguous: multiple matching runs appeared. Inspect GitHub; no further workflows will be dispatched.', 409);
        if (candidates.length === 1) runId = candidates[0].id;
        else {
          if (this.now() >= deadline) throw new ApiError('Could not reliably identify the dispatched run. Inspect GitHub; the dispatch will not be retried and the batch is stopped.', 504);
          await this.wait();
        }
      }
    }
    const deadline = this.now() + this.runTimeoutMs;
    while (true) {
      const run = await this.adapter.getRun(this.repository, runId);
      if (run.id !== runId || run.workflow_id !== item.workflowId || run.event !== 'workflow_dispatch' ||
          run.head_branch !== ref || (run.run_attempt ?? 1) !== 1)
        throw new ApiError('GitHub returned mismatched or rerun run details. Batch stopped to avoid tracking the wrong run.', 502);
      const mapped = lastRun(run);
      if (mapped.url) item.runUrl = mapped.url;
      const workflow = this.workflows.find(value => value.id === item.workflowId);
      if (workflow) workflow.lastRun = mapped;
      if (run.status === 'completed') {
        item.status = 'completed'; item.conclusion = run.conclusion ?? 'unknown'; return;
      }
      item.status = run.status === 'in_progress' ? 'in_progress' : 'waiting';
      if (this.now() >= deadline) throw new ApiError('Timed out monitoring the dispatched run. It may still be running on GitHub; batch stopped.', 504);
      await this.wait();
    }
  }
  async close() {
    this.closed = true; this.stop(); this.abort.abort();
    await this.done;
  }
}
