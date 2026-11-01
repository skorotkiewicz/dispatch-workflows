import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { ApiError, validateRepository } from './github.mjs';
import { WorkflowRunner, persistConfiguration, validRef } from './runner.mjs';

const copy = value => structuredClone(value);
const sameRepository = (left, right) => left.toLowerCase() === right.toLowerCase();
const emptyConfig = () => ({ version: 2, activeWorkspaceId: null, workspaces: [] });

function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || config.version !== 2 ||
      !Array.isArray(config.workspaces) ||
      !(config.activeWorkspaceId === null || typeof config.activeWorkspaceId === 'string'))
    throw new Error('Expected version 2 workspace settings.');
  const ids = new Set(); const repositories = new Set();
  const workspaces = config.workspaces.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        typeof entry.id !== 'string' || !entry.id || entry.id.trim() !== entry.id ||
        entry.id.length > 255 || /[\x00-\x1f\x7f]/.test(entry.id))
      throw new Error('Every workspace needs a valid ID.');
    const repository = validateRepository(entry.repository);
    const branch = entry.branch === null ? null : validRef(entry.branch);
    if (ids.has(entry.id) || repositories.has(repository.toLowerCase()))
      throw new Error('Workspace IDs and repositories must be unique.');
    ids.add(entry.id); repositories.add(repository.toLowerCase());
    return { id: entry.id, repository, branch };
  });
  if (config.activeWorkspaceId !== null && !ids.has(config.activeWorkspaceId))
    throw new Error('The active workspace does not exist.');
  return { version: 2, activeWorkspaceId: config.activeWorkspaceId, workspaces };
}

export async function readWorkspaceConfig(configPath, env = process.env) {
  let stored;
  try { stored = JSON.parse(await readFile(configPath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT')
      throw new ApiError('Could not read workspace configuration. Fix or remove .data/config.json before restarting.', 500);
  }
  let config;
  try {
    if (stored && Object.hasOwn(stored, 'version')) return validateConfig(stored);
    if (stored !== undefined && stored !== null &&
        (typeof stored !== 'object' || Array.isArray(stored) || !Object.hasOwn(stored, 'repository')))
      throw new Error('Expected repository or versioned workspace settings.');
    const repository = stored?.repository ?? (env.GITHUB_REPO || null);
    config = emptyConfig();
    if (repository !== null) {
      const name = validateRepository(repository);
      const id = `workspace-${createHash('sha256').update(name.toLowerCase()).digest('hex').slice(0, 20)}`;
      config.workspaces.push({ id, repository: name, branch: null });
      config.activeWorkspaceId = id;
    }
  } catch (error) {
    throw new ApiError(`Invalid workspace configuration: ${error.message}`, 500);
  }
  // Migration is committed only after the entire old configuration has validated.
  await persistConfiguration(configPath, config);
  return config;
}

export class WorkspaceManager {
  constructor({ adapter, configPath, config, runnerOptions = {} }) {
    this.adapter = adapter; this.configPath = configPath;
    this.config = validateConfig(config); this.runnerOptions = runnerOptions;
    this.runners = new Map(); this.defaults = new Map();
    this.changing = false; this.pendingChange = null; this.closed = false; this.globalLock = null;
    this.setupRunner = this.makeRunner(null);
    for (const entry of this.config.workspaces) this.runners.set(entry.id, this.makeRunner(entry.repository));
  }
  makeRunner(repository) {
    return new WorkflowRunner({ ...this.runnerOptions, adapter: this.adapter, configPath: this.configPath, repository,
      beforeDispatch: repository ? () => this.checkOtherRuns(repository) : null });
  }
  target(workspaceId) {
    const id = workspaceId === undefined ? this.config.activeWorkspaceId : workspaceId;
    if (id === null && workspaceId === undefined) return { entry: null, runner: this.setupRunner };
    const entry = this.config.workspaces.find(value => value.id === id);
    if (!entry) {
      const error = new ApiError('Workspace not found.', 404);
      error.code = 'WORKSPACE_NOT_FOUND';
      throw error;
    }
    return { entry, runner: this.runners.get(id) };
  }
  branch(entry) { return entry ? entry.branch ?? this.defaults.get(entry.id) ?? null : null; }
  get mode() { return this.target().runner.mode; }
  get queue() { return this.target().runner.queue; }
  get globalQueue() {
    return this.globalLock ? { workspaceId: this.globalLock.workspaceId, repository: this.globalLock.repository } : null;
  }
  snapshotFor({ entry, runner }) {
    const current = this.config.workspaces.find(value => value.id === entry?.id) ?? entry;
    return { ...runner.snapshot(), workspaceId: entry?.id ?? null, branch: this.branch(current),
      workspaces: this.config.workspaces.map(value => ({ ...value, branch: this.branch(value),
        running: this.globalLock?.workspaceId === value.id || this.runners.get(value.id).queue.running })),
      globalQueue: this.globalQueue };
  }
  snapshot(workspaceId) { return this.snapshotFor(this.target(workspaceId)); }
  async refresh({ workspaceId, force = false } = {}) {
    const target = this.target(workspaceId);
    await target.runner.refresh({ force });
    if (target.entry && this.runners.get(target.entry.id) === target.runner && target.runner.refreshedAt !== null)
      this.defaults.set(target.entry.id, target.runner.repo.defaultBranch);
    return this.snapshotFor(target);
  }
  async inputs(workflowId, ref, workspaceId) {
    const target = this.target(workspaceId);
    let branch = ref === undefined ? this.branch(target.entry) : validRef(ref);
    if (target.entry && branch === null) {
      await target.runner.refresh();
      branch = target.runner.repo.defaultBranch;
      if (this.runners.get(target.entry.id) === target.runner) this.defaults.set(target.entry.id, branch);
    }
    return target.runner.inputs(workflowId, branch);
  }
  ensureOpen() {
    if (this.closed) throw new ApiError('The server is shutting down.', 503);
  }
  async change(operation) {
    this.ensureOpen();
    if (this.changing) throw new ApiError('A workspace configuration change is already active.', 409);
    this.changing = true;
    const pending = Promise.resolve().then(operation);
    this.pendingChange = pending;
    try { return await pending; }
    finally { this.changing = false; this.pendingChange = null; }
  }
  async commit(config) {
    this.ensureOpen();
    await persistConfiguration(this.configPath, config);
  }
  async configure(repository) {
    return this.change(async () => {
      const name = validateRepository(repository);
      let existing = this.config.workspaces.find(entry => sameRepository(entry.repository, name));
      let repo;
      if (!existing || existing.branch === null) {
        repo = await this.adapter.getRepo(name);
        const canonical = validateRepository(repo.fullName);
        validRef(repo.defaultBranch);
        await this.adapter.listWorkflows(canonical);
        existing = this.config.workspaces.find(entry => sameRepository(entry.repository, canonical));
      }
      const config = copy(this.config);
      const entry = existing ? config.workspaces.find(value => value.id === existing.id) : {
        id: randomUUID(), repository: validateRepository(repo.fullName), branch: validRef(repo.defaultBranch),
      };
      if (existing && entry.branch === null) entry.branch = validRef(repo.defaultBranch);
      if (!existing) config.workspaces.push(entry);
      config.activeWorkspaceId = entry.id;
      const runner = existing ? this.runners.get(entry.id) : this.makeRunner(entry.repository);
      await this.commit(config);
      // Publish the config and runner together, without an intervening await.
      if (!existing) this.runners.set(entry.id, runner);
      if (repo) {
        runner.repo = repo;
        this.defaults.set(entry.id, repo.defaultBranch);
      }
      this.config = config;
      return this.snapshot(entry.id);
    });
  }
  async select(workspaceId) {
    return this.change(async () => {
      const { entry } = this.target(workspaceId);
      if (!entry) throw new ApiError('Workspace not found.', 404);
      const config = copy(this.config); config.activeWorkspaceId = entry.id;
      await this.commit(config);
      this.config = config;
      return this.snapshot(entry.id);
    });
  }
  async saveBranch(workspaceId, branch) {
    return this.change(async () => {
      const { entry } = this.target(workspaceId);
      if (!entry) throw new ApiError('Workspace not found.', 404);
      const ref = validRef(branch);
      await this.adapter.validateRef(entry.repository, ref);
      const config = copy(this.config);
      config.workspaces.find(value => value.id === entry.id).branch = ref;
      await this.commit(config);
      this.config = config;
      return this.snapshot(entry.id);
    });
  }
  async remove(workspaceId) {
    return this.change(async () => {
      const { entry, runner } = this.target(workspaceId);
      if (!entry) throw new ApiError('Workspace not found.', 404);
      if (this.globalLock?.workspaceId === entry.id || runner.queue.running)
        throw new ApiError('Stop and finish monitoring this workspace queue before removing it.', 409);
      const config = copy(this.config);
      config.workspaces = config.workspaces.filter(value => value.id !== entry.id);
      if (config.activeWorkspaceId === entry.id) config.activeWorkspaceId = config.workspaces[0]?.id ?? null;
      await this.commit(config);
      this.runners.delete(entry.id); this.defaults.delete(entry.id);
      this.config = config;
      await runner.close();
      return this.snapshot();
    });
  }
  async checkOtherRuns(repository) {
    const checked = new Set();
    // Include workspaces added while GitHub checks or launch validation are awaiting.
    while (true) {
      const other = this.config.workspaces.find(value => !sameRepository(value.repository, repository) && !checked.has(value.id));
      if (!other) return;
      checked.add(other.id);
      const active = await this.adapter.activeRuns(other.repository);
      if (active.length) throw new ApiError(`Repository ${other.repository} has active workflow runs. Wait for them to finish before starting a batch.`, 409);
    }
  }
  async startQueue(request) {
    this.ensureOpen();
    const { entry, runner } = this.target(request?.workspaceId);
    if (!entry) throw new ApiError('Connect a GitHub repository before running workflows.', 409);
    if (this.changing || this.globalLock)
      throw new ApiError('A workspace queue or configuration change is already active.', 409);
    // Reserve globally before even validation/network access. Selection remains independent.
    let release;
    const lock = { workspaceId: entry.id, repository: entry.repository, stopRequested: false,
      done: new Promise(resolve => { release = resolve; }) };
    this.globalLock = lock;
    const unlock = () => { if (this.globalLock === lock) this.globalLock = null; release(); };
    try {
      validRef(request?.ref);
      await this.checkOtherRuns(entry.repository);
      if (lock.stopRequested || this.closed) throw new ApiError('The workspace batch was stopped before launch.', 409);
      await runner.startQueue(request);
      // Keep the token through monitoring (including uncertainty/failure), never just through launch.
      runner.done.then(unlock, unlock);
      return this.snapshotFor({ entry, runner });
    } catch (error) {
      unlock();
      throw error;
    }
  }
  stop(workspaceId) {
    const target = this.target(workspaceId);
    if (this.globalLock?.workspaceId === target.entry?.id) this.globalLock.stopRequested = true;
    target.runner.stop();
    return this.snapshotFor(target);
  }
  message(error) { return this.setupRunner.message(error); }
  async close() {
    this.closed = true;
    const lock = this.globalLock;
    if (lock) lock.stopRequested = true;
    if (this.pendingChange) await this.pendingChange.catch(() => {});
    await Promise.all([this.setupRunner, ...this.runners.values()].map(runner => runner.close()));
    if (lock) await lock.done;
  }
}
