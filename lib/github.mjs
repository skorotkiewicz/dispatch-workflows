import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse } from 'yaml';

const execFileAsync = promisify(execFile);
export class ApiError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'ApiError'; this.status = status; }
}

export function validateRepository(value) {
  if (typeof value !== 'string') throw new ApiError('Repository must be owner/repo or https://github.com/owner/repo.');
  const input = value.trim();
  let name = input;
  if (input.startsWith('https://')) {
    let url;
    try { url = new URL(input); } catch { throw new ApiError('Invalid repository URL.'); }
    if (url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash)
      throw new ApiError('Use a repository URL on https://github.com without credentials, query, or fragment.');
    name = url.pathname.replace(/^\//, '').replace(/\/$/, '');
  }
  name = name.replace(/\.git$/, '');
  const parts = name.split('/');
  if (parts.length !== 2 || !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(parts[0]) ||
      !/^[a-zA-Z0-9_.-]{1,100}$/.test(parts[1]) || ['.', '..'].includes(parts[1]))
    throw new ApiError('Repository must be owner/repo or https://github.com/owner/repo.');
  return parts.join('/');
}

export async function resolveAuth(env = process.env, exec = execFileAsync) {
  const token = env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim();
  if (token) return { token, source: 'environment' };
  try {
    const { stdout } = await exec('gh', ['auth', 'token', '--hostname', 'github.com'], { timeout: 5000, maxBuffer: 16384 });
    if (stdout.trim()) return { token: stdout.trim(), source: 'gh' };
  } catch { /* A missing CLI or login is an ordinary unauthenticated state. */ }
  return { token: null, source: 'none' };
}

export async function mapLimit(values, limit, operation) {
  const result = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) { const i = next++; result[i] = await operation(values[i], i); }
  }));
  return result;
}

export function lastRun(run) {
  if (!run) return null;
  const start = run.run_started_at || run.created_at;
  const end = run.status === 'completed' ? run.updated_at : new Date().toISOString();
  return {
    id: run.id, status: run.status, conclusion: run.conclusion ?? null,
    createdAt: run.created_at, startedAt: run.run_started_at ?? null, updatedAt: run.updated_at,
    url: safeGitHubUrl(run.html_url), branch: run.head_branch ?? '',
    duration: start && end ? Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 1000)) : null,
  };
}

export function safeGitHubUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'github.com' && !url.port && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}

export function parseDispatchInputs(source) {
  let yaml;
  try { yaml = parse(source, { maxAliasCount: 50, uniqueKeys: true }); }
  catch { throw new ApiError('The workflow YAML could not be parsed safely.', 422); }
  const on = yaml?.on;
  const dispatchable = on === 'workflow_dispatch' || (Array.isArray(on) && on.includes('workflow_dispatch')) ||
    (!!on && typeof on === 'object' && Object.hasOwn(on, 'workflow_dispatch'));
  if (!dispatchable) return { dispatchable: false, inputs: [] };
  const definitions = on && typeof on === 'object' && !Array.isArray(on) ? on.workflow_dispatch?.inputs : null;
  if (definitions == null) return { dispatchable: true, inputs: [] };
  if (typeof definitions !== 'object' || Array.isArray(definitions)) throw new ApiError('Invalid workflow_dispatch input definitions.', 422);
  const inputs = Object.entries(definitions).map(([name, definition]) => {
    const def = definition ?? {};
    if (typeof def !== 'object' || Array.isArray(def)) throw new ApiError(`Invalid definition for input ${name}.`, 422);
    const type = def.type || 'string';
    if (!['string', 'boolean', 'number', 'choice', 'environment'].includes(type)) throw new ApiError(`Unsupported input type for ${name}.`, 422);
    const input = { name, description: String(def.description ?? ''), type, required: def.required === true, default: def.default ?? null };
    if (type === 'choice') {
      if (!Array.isArray(def.options) || !def.options.length || def.options.some(option => typeof option !== 'string'))
        throw new ApiError(`Input ${name} has invalid choices.`, 422);
      input.options = def.options;
    }
    return input;
  });
  return { dispatchable: true, inputs };
}

export function validateInputs(schema, supplied = {}) {
  if (!schema.dispatchable) throw new ApiError('The selected workflow does not support workflow_dispatch.');
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) throw new ApiError('Workflow inputs must be an object.');
  const known = new Set(schema.inputs.map(input => input.name));
  for (const name of Object.keys(supplied)) if (!known.has(name)) throw new ApiError(`Unknown workflow input: ${name}.`);
  const result = Object.create(null);
  for (const input of schema.inputs) {
    const explicit = Object.hasOwn(supplied, input.name);
    let value = explicit ? supplied[input.name] : input.default;
    const absent = value == null || value === '';
    if (absent) {
      if (input.required) throw new ApiError(`Input ${input.name} is required.`);
      // Preserve an explicitly supplied empty string for optional text inputs.
      if (explicit && value === '' && ['string', 'environment'].includes(input.type)) result[input.name] = '';
      continue;
    }
    if (input.type === 'boolean') {
      if (value === 'true') value = true;
      if (value === 'false') value = false;
      if (typeof value !== 'boolean') throw new ApiError(`Input ${input.name} must be a boolean.`);
    } else if (input.type === 'number') {
      if (typeof value === 'string' && value.trim()) value = Number(value);
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new ApiError(`Input ${input.name} must be a finite number.`);
    } else {
      if (typeof value !== 'string') throw new ApiError(`Input ${input.name} must be a string.`);
      if (input.required && !value.trim()) throw new ApiError(`Input ${input.name} is required.`);
      if (input.type === 'choice' && !input.options.includes(value)) throw new ApiError(`Input ${input.name} must be one of its listed choices.`);
    }
    result[input.name] = value;
  }
  return result;
}

export class GitHubAdapter {
  constructor({ token = null, source = 'none', fetchImpl = fetch, timeoutMs = 15000 } = {}) {
    // Credentials remain private to this adapter; never put them in state/config/errors.
    this.token = token; this.auth = source; this.fetch = fetchImpl; this.timeoutMs = timeoutMs;
  }
  sanitize(message) { return this.token ? String(message).replaceAll(this.token, '[redacted]') : String(message); }
  async request(path, { method = 'GET', body } = {}) {
    if (!path.startsWith('/') || path.startsWith('//')) throw new ApiError('Invalid GitHub API path.', 500);
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'local-workflow-runner' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await this.fetch(`https://api.github.com${path}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error',
      });
    } catch (error) {
      const message = error.name === 'TimeoutError' || error.name === 'AbortError' ? 'GitHub request timed out.' : 'Could not reach GitHub.';
      throw new ApiError(method === 'POST' ? `${message} Dispatch outcome is uncertain; it will not be retried.` : message, 502);
    }
    let data;
    try {
      const text = await response.text();
      data = text ? JSON.parse(text) : null;
    } catch { throw new ApiError(method === 'POST' ? 'GitHub returned an unreadable dispatch response. Dispatch outcome is uncertain; it will not be retried.' : 'GitHub returned an unreadable response.', 502); }
    if (!response.ok) {
      const hint = response.status === 401 ? ' Check GH_TOKEN/GITHUB_TOKEN or gh auth login.' : response.status === 403 ? ' Check Actions permissions and API rate limits.' : '';
      throw new ApiError(this.sanitize(`GitHub ${response.status}: ${String(data?.message || response.statusText).slice(0, 300)}.${hint}`), response.status === 404 ? 404 : 502);
    }
    return data;
  }
  repoPath(repo) { return `/repos/${validateRepository(repo)}`; }
  async getRepo(repo) {
    const result = await this.request(this.repoPath(repo));
    return { fullName: validateRepository(result.full_name), url: `https://github.com/${result.full_name}`, defaultBranch: result.default_branch };
  }
  async pages(path, property) {
    const all = [];
    for (let page = 1; page <= 100; page++) {
      const data = await this.request(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const list = data?.[property];
      if (!Array.isArray(list)) throw new ApiError('GitHub returned an invalid list response.', 502);
      all.push(...list);
      if (list.length < 100 || (Number.isFinite(data.total_count) && all.length >= data.total_count)) return all;
    }
    throw new ApiError('GitHub pagination exceeded its safety limit; no incomplete list will be used.', 502);
  }
  listWorkflows(repo) { return this.pages(`${this.repoPath(repo)}/actions/workflows`, 'workflows'); }
  async latestRun(repo, workflowId) {
    const data = await this.request(`${this.repoPath(repo)}/actions/workflows/${workflowId}/runs?per_page=1`);
    if (!Array.isArray(data?.workflow_runs)) throw new ApiError('GitHub returned invalid workflow runs.', 502);
    return data.workflow_runs[0] ?? null;
  }
  async getInputs(repo, workflow, ref) {
    const path = workflow.path?.split('/').map(encodeURIComponent).join('/');
    if (!path || !workflow.path.startsWith('.github/workflows/')) throw new ApiError('Invalid workflow file path.', 422);
    const data = await this.request(`${this.repoPath(repo)}/contents/${path}?ref=${encodeURIComponent(ref)}`);
    if (data?.encoding !== 'base64' || typeof data.content !== 'string' || data.size > 1024 * 1024)
      throw new ApiError('GitHub did not return a readable workflow file (maximum 1 MB).', 422);
    return parseDispatchInputs(Buffer.from(data.content, 'base64').toString('utf8'));
  }
  async validateRef(repo, ref) {
    const branch = await this.request(`${this.repoPath(repo)}/branches/${encodeURIComponent(ref)}`);
    return { ref: branch.name, sha: branch.commit?.sha };
  }
  async actor() {
    if (!this.token) return null;
    // Installation tokens need not have /user access; correlation still uses ref/time/workflow.
    try { return (await this.request('/user'))?.login ?? null; }
    catch (error) { if (/GitHub (401|403|404):/.test(error.message)) return null; throw error; }
  }
  async activeRuns(repo) {
    const groups = await mapLimit(['in_progress', 'queued', 'waiting', 'requested', 'pending'], 3,
      status => this.pages(`${this.repoPath(repo)}/actions/runs?status=${status}`, 'workflow_runs'));
    return [...new Map(groups.flat().filter(run => run.status !== 'completed').map(run => [run.id, run])).values()];
  }
  dispatchRuns(repo, workflowId, ref) {
    return this.pages(`${this.repoPath(repo)}/actions/workflows/${workflowId}/runs?event=workflow_dispatch&branch=${encodeURIComponent(ref)}`, 'workflow_runs');
  }
  async dispatch(repo, workflowId, ref, inputs) {
    if (!this.token) throw new ApiError('Authentication is required to dispatch workflows. Set GH_TOKEN/GITHUB_TOKEN or run gh auth login.', 401);
    const data = await this.request(`${this.repoPath(repo)}/actions/workflows/${workflowId}/dispatches`, {
      method: 'POST', body: { ref, inputs, return_run_details: true },
    });
    // Both the documented return_run_details response and legacy 204 are supported.
    const id = data?.workflow_run_id ?? data?.id;
    if (id != null && (!Number.isSafeInteger(id) || id <= 0)) throw new ApiError('GitHub returned an invalid dispatch run ID; the dispatch will not be retried.', 502);
    return id ? { id, url: safeGitHubUrl(data.html_url) } : null;
  }
  getRun(repo, runId) { return this.request(`${this.repoPath(repo)}/actions/runs/${runId}`); }
}
