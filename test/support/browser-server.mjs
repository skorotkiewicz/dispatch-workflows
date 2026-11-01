// Test-only GitHub adapter. Production startup never imports this file.
import { createApplication } from '../../server.mjs';
import { ApiError } from '../../lib/github.mjs';

const definitions = [
  ['CI pipeline', 'ci.yml', 'success', 10 * 60000],
  ['Deploy staging', 'deploy-staging.yml', 'success', 45 * 60000],
  ['Deploy production', 'deploy-production.yml', 'success', 5 * 3600000],
  ['Database migrations', 'migrations.yml', 'failure', 26 * 3600000],
  ['Security audit', 'security.yml', 'success', 2 * 3600000],
  ['Release package', 'release.yml', 'cancelled', 9 * 86400000],
  ['End-to-end tests', 'e2e.yml', 'failure', 75 * 60000],
  ['Docs preview', 'docs.yml', null, 0],
];
class BrowserGitHub {
  constructor() {
    this.auth = 'environment';
    this.workflows = definitions.map(([name, filename], index) => ({ id: index + 1, name, path: `.github/workflows/${filename}`, state: 'active' }));
    this.runs = new Map();
    this.nextId = 10000;
    this.initialRuns = definitions.map(([, , conclusion, age], index) => conclusion ? this.makeRun(index + 100, index + 1, 'main', Date.now() - age, 'completed', conclusion) : null);
  }
  makeRun(id, workflowId, ref, created, status = 'in_progress', conclusion = null) {
    const timestamp = new Date(created).toISOString();
    return { id, workflow_id: workflowId, event: 'workflow_dispatch', head_branch: ref, run_attempt: 1,
      created_at: timestamp, run_started_at: timestamp, updated_at: timestamp, status, conclusion,
      actor: { login: 'test-operator' }, html_url: `https://github.com/test-org/workflows/actions/runs/${id}` };
  }
  async getRepo(name) {
    if (name !== 'test-org/workflows') throw new ApiError('Test repository not found.', 404);
    return { fullName: name, url: `https://github.com/${name}`, defaultBranch: 'main' };
  }
  async listWorkflows() { return this.workflows; }
  async latestRun(repo, id) { return [...this.runs.values()].filter(run => run.workflow_id === id).at(-1) || this.initialRuns[id - 1]; }
  async getInputs(repo, workflow) {
    return { dispatchable: true, inputs: workflow.id === 3 ? [
      { name: 'version', description: 'Version to deploy', type: 'string', required: true, default: null },
      { name: 'dry_run', description: 'Validate before deploying', type: 'boolean', required: false, default: true },
    ] : [] };
  }
  async validateRef(repo, ref) { return { ref, sha: 'test-commit' }; }
  async actor() { return 'test-operator'; }
  async activeRuns() { return [...this.runs.values()].filter(run => run.status !== 'completed'); }
  async dispatchRuns(repo, workflowId, ref) { return [...this.runs.values()].filter(run => run.workflow_id === workflowId && run.head_branch === ref); }
  async dispatch(repo, workflowId, ref) {
    const id = this.nextId++;
    this.runs.set(id, this.makeRun(id, workflowId, ref, Date.now()));
    return { id };
  }
  async getRun(repo, id) {
    const run = this.runs.get(id);
    if (Date.now() - Date.parse(run.created_at) >= 2000) Object.assign(run, { status: 'completed', conclusion: 'success', updated_at: new Date().toISOString() });
    return { ...run };
  }
}

const app = await createApplication({ adapter: new BrowserGitHub(), runnerOptions: { pollMs: 100 } });
await new Promise(resolve => app.server.listen(Number(process.env.PORT || 3107), '127.0.0.1', resolve));
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await app.close(); });
