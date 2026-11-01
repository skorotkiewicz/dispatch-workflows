import { recency, relativeTime, escapeHTML as esc, runDate, filteredWorkflows } from './model.mjs';

const $ = id => document.getElementById(id);
const paths = {
  workflow: '<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/><path d="M6 9v9h9M9 6h9v9"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  github: '<path d="M9 19c-4 1-4-2-6-2m12 5v-4a3.5 3.5 0 0 0-1-2.5c3-.3 6-1.5 6-6A4.7 4.7 0 0 0 19 6c.3-1 .3-2-.2-3 0 0-1.2-.4-3.8 1a13 13 0 0 0-6 0C6.4 2.6 5.2 3 5.2 3c-.5 1-.5 2-.2 3a4.7 4.7 0 0 0-1 3.5c0 4.5 3 5.7 6 6A3.5 3.5 0 0 0 9 18v4"/>',
  settings: '<path d="m10 3-.7 2.2-2 .9L5 5.7 2.7 9l1.6 1.8v2.4L2.7 15 5 18.3l2.3-.4 2 .9L10 21h4l.7-2.2 2-.9 2.3.4 2.3-3.3-1.6-1.8v-2.4L21.3 9 19 5.7l-2.3.4-2-.9L14 3z"/><circle cx="12" cy="12" r="3"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 6a8 8 0 0 1 13 3M5 15a8 8 0 0 0 13 3"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  branch: '<circle cx="6" cy="4" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="6" cy="20" r="2"/><path d="M6 6v12m12-10c0 7-12 2-12 9"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  play: '<path d="m8 4 12 8-12 8z"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="m8 12 3 3 5-6"/>',
  queue: '<rect x="3" y="3" width="6" height="6" rx="1.5"/><rect x="15" y="15" width="6" height="6" rx="1.5"/><path d="M6 9v7a2 2 0 0 0 2 2h7M15 6h6m-3-3v6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  cross: '<path d="m6 6 12 12M6 18 18 6"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.clock}</svg>`;
document.querySelectorAll('[data-icon]').forEach(element => { element.innerHTML = icon(element.dataset.icon); });
let state = null;
let selected = [];
let busy = false;
let page = 'workflows';
let refreshPromise;
let tableSignature = '';
let queueSignature = '';
let schemas = new Map();
let inputValues = {};
let dialogWorkflows = [];
let runAfterInputs = false;
let initialized = false;
let queueActionsVisible = false;
function renderMobileBar() {
  $('mobile-run-bar').hidden = !selected.length || Boolean(state?.queue.running) || queueActionsVisible;
  $('mobile-run').disabled = blocked() || !$('branch').value.trim();
  $('mobile-run').textContent = busy ? 'Preparing…' : `Run ${selected.length === 1 ? 'workflow' : `${selected.length} workflows`}`;
  $('mobile-review').textContent = `${selected.length} selected · Review queue`;
}
new IntersectionObserver(entries => { queueActionsVisible = entries[0].isIntersecting; renderMobileBar(); }).observe(document.querySelector('.queue-actions'));

function announce(message) { $('announcement').textContent = message; }
function error(message) { $('error-message').textContent = message; $('error-banner').hidden = false; }
function clearError() { $('error-banner').hidden = true; }
async function api(path, body) {
  const response = await fetch(path, {
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(90_000)
  });
  let data;
  try { data = await response.json(); } catch { throw new Error('The local server did not respond. Check that it is still running.'); }
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}
function blocked() { return busy || state?.queue.running; }
function safeUrl(url) { try { const parsed = new URL(url); return parsed.protocol === 'https:' && parsed.hostname === 'github.com' ? esc(parsed.href) : ''; } catch { return ''; } }
function lastRunMarkup(run) {
  if (!run) return '<span class="last-run muted">Never run<small>No run history</small></span>';
  const date = runDate(run);
  const exact = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(date));
  const duration = Number.isFinite(run.duration) ? ` · ${run.duration >= 60 ? `${Math.floor(run.duration / 60)}m ${Math.floor(run.duration % 60)}s` : `${Math.floor(run.duration)}s`}` : '';
  const label = `${esc(relativeTime(date))}<small>${esc(run.branch || '—')}${duration}</small>`;
  const url = safeUrl(run.url);
  return url ? `<a class="last-run run-link" href="${url}" target="_blank" rel="noreferrer" title="${esc(exact)} · View run on GitHub">${label}</a>` : `<span class="last-run" title="${esc(exact)}">${label}</span>`;
}
function resultMarkup(run) {
  if (!run) return '<span class="result other">—</span>';
  const status = run.status === 'completed' ? run.conclusion || 'completed' : run.status;
  const label = ({ success: 'Passed', failure: 'Failed', in_progress: 'Running', queued: 'Queued', waiting: 'Waiting', cancelled: 'Cancelled', skipped: 'Skipped', timed_out: 'Timed out', action_required: 'Needs action', completed: 'Finished', pending: 'Pending' })[status] || status?.replaceAll('_', ' ') || 'Unknown';
  const style = ['success', 'failure', 'in_progress', 'queued', 'waiting', 'cancelled', 'timed_out', 'action_required'].includes(status) ? status : 'other';
  return `<span class="result ${style}">${icon(status === 'success' ? 'check' : status === 'failure' ? 'cross' : 'clock')}${esc(label)}</span>`;
}
function visibleWorkflows() {
  let workflows = filteredWorkflows(state.workflows, { search: $('search').value, filter: $('recency-filter').value, sort: $('sort').value });
  if (page === 'activity') workflows = workflows.filter(workflow => workflow.lastRun).sort((a, b) => Date.parse(runDate(b.lastRun)) - Date.parse(runDate(a.lastRun)));
  return workflows;
}
function renderTable(force = false) {
  if (!state) return;
  const workflows = visibleWorkflows();
  const signature = JSON.stringify([workflows, selected, blocked(), page, Math.floor(Date.now() / 60_000)]);
  if (signature === tableSignature && !force) return;
  tableSignature = signature;
  const focusId = document.activeElement?.id;
  $('table-container').setAttribute('aria-busy', 'false');
  $('result-count').textContent = `${workflows.length} of ${state.workflows.length} workflows`;
  if (!workflows.length) {
    const message = !state.workflows.length ? 'No workflows in this repository' : page === 'activity' && !$('search').value ? 'No runs yet' : 'No matching workflows';
    $('table-container').innerHTML = `<div class="empty-results"><strong>${message}</strong><p>${!state.workflows.length ? 'Add a GitHub Actions workflow with a workflow_dispatch trigger, then refresh.' : 'Try a different search or last-run filter.'}</p>${state.workflows.length ? '<button class="text-button" id="clear-filters">Clear filters</button>' : ''}</div>`;
    return;
  }
  $('table-container').innerHTML = `<table aria-label="${page === 'activity' ? 'Latest workflow runs' : 'Repository workflows'}"><thead><tr><th class="check-col" scope="col"><span class="sr-only">Select</span></th><th scope="col">Workflow</th><th class="last-col" scope="col">Last run</th><th class="result-col" scope="col">Result</th><th class="run-col" scope="col"><span class="sr-only">Run workflow</span></th></tr></thead><tbody>${workflows.map(workflow => {
    const unavailable = workflow.state !== 'active';
    return `<tr class="${selected.includes(workflow.id) ? 'selected' : ''}"><td class="check-cell"><label><input type="checkbox" id="select-${workflow.id}" data-select="${workflow.id}" aria-label="Select ${esc(workflow.name)}" ${selected.includes(workflow.id) ? 'checked' : ''} ${blocked() || unavailable ? 'disabled' : ''}></label></td><td><span class="workflow-name ${recency(runDate(workflow.lastRun))}">${esc(workflow.name)}</span><span class="workflow-path" title="${esc(workflow.path)}">${esc(workflow.path.replace('.github/workflows/', ''))}${unavailable ? ' · Disabled in GitHub' : ''}</span><span class="mobile-result">${resultMarkup(workflow.lastRun)}</span></td><td>${lastRunMarkup(workflow.lastRun)}</td><td class="result-cell">${resultMarkup(workflow.lastRun)}</td><td><button id="run-${workflow.id}" class="row-run" data-run="${workflow.id}" aria-label="Run ${esc(workflow.name)}" title="${blocked() ? 'Wait for the current queue to finish' : unavailable ? 'Enable this workflow on GitHub first' : `Run ${esc(workflow.name)}`}" ${blocked() || unavailable ? 'disabled' : ''}>${icon('play')}</button></td></tr>`;
  }).join('')}</tbody></table>`;
  if (focusId && $(focusId)) $(focusId).focus({ preventScroll: true });
}
function renderQueue(force = false) {
  if (!state) return;
  const queued = state.queue;
  const showingSelection = selected.length > 0 && !queued.running;
  const items = showingSelection ? selected.map(id => ({ workflowId: id, name: state.workflows.find(workflow => workflow.id === id)?.name, status: 'selected', ref: $('branch').value })) : queued.items;
  const signature = JSON.stringify([items, selected, blocked(), queued.error, showingSelection, Object.keys(inputValues)]);
  if (signature === queueSignature && !force) { renderMobileBar(); return; }
  queueSignature = signature;
  const focusId = document.activeElement?.id;
  $('queue-count').textContent = items.length;
  $('queue-label').textContent = queued.running ? 'IN PROGRESS' : showingSelection ? 'UP NEXT · SELECTION ORDER' : items.length ? 'LAST QUEUE' : 'UP NEXT';
  $('clear-selection').hidden = !showingSelection;
  $('clear-selection').disabled = busy;
  $('stop-queue').hidden = !queued.running;
  $('stop-queue').disabled = busy || !queued.items.some(item => item.status === 'pending');
  $('stop-queue').textContent = queued.items.some(item => item.status === 'pending') ? 'Stop after current workflow' : 'Current workflow will finish';
  const queueHTML = items.length ? `<ol class="queue-list">${items.map((item, index) => {
    const url = safeUrl(item.runUrl);
    const status = item.status === 'completed' ? item.conclusion || 'completed' : item.status;
    return `<li><span class="queue-index">${item.status === 'completed' && item.conclusion === 'success' ? '✓' : index + 1}</span><div class="queue-item-body"><strong>${esc(item.name)}</strong><p>${showingSelection ? (index === 0 ? 'Starts first' : `After workflow ${index}`) : esc(status?.replaceAll('_', ' '))}${!showingSelection && item.ref ? ` · ${esc(item.ref)}` : ''}</p>${item.error ? `<p class="queue-error">${esc(item.error)}</p>` : ''}${url ? `<a href="${url}" target="_blank" rel="noreferrer">View run on GitHub ↗</a>` : ''}${showingSelection ? `<div class="queue-item-controls"><button id="up-${item.workflowId}" data-move="${item.workflowId}" data-direction="-1" aria-label="Move ${esc(item.name)} earlier" ${index === 0 ? 'disabled' : ''}>↑</button><button id="down-${item.workflowId}" data-move="${item.workflowId}" data-direction="1" aria-label="Move ${esc(item.name)} later" ${index === items.length - 1 ? 'disabled' : ''}>↓</button><button id="remove-${item.workflowId}" data-remove="${item.workflowId}" aria-label="Remove ${esc(item.name)}">×</button><button class="options-button" id="options-${item.workflowId}" data-options="${item.workflowId}">Run options${inputValues[item.workflowId] ? ' · saved' : ''}</button></div>` : ''}</div></li>`;
  }).join('')}</ol>` : `<div class="queue-empty"><span class="empty-path">${icon('queue')}</span><strong>A little less clicking.</strong><p>Select a workflow to add it here.<br>Ready when you are.</p></div>`;
  $('queue-items').innerHTML = queueHTML + (queued.error ? `<p class="queue-error" role="status">${esc(queued.error)}</p>` : '');
  $('run-selected').disabled = !selected.length || blocked() || !$('branch').value.trim();
  $('run-label').textContent = busy ? 'Preparing workflows…' : queued.running ? 'Queue is running' : `Run ${selected.length ? selected.length === 1 ? 'workflow' : `${selected.length} workflows` : 'selected'}`;
  $('run-help').textContent = queued.running ? 'You can close this tab. Keep the local server running.' : busy ? 'Checking workflow options. Nothing has been dispatched yet.' : !$('branch').value.trim() ? 'Enter a branch to run on.' : selected.length ? state.mode === 'demo' ? 'Simulated runs only. No GitHub actions.' : `${selected.length === 1 ? 'Runs' : 'Runs sequentially'} on ${$('branch').value.trim()}.` : 'Select a workflow to get started.';
  $('allow-multiple').disabled = blocked();
  $('branch').disabled = blocked();
  renderMobileBar();
  if (focusId && $(focusId)) $(focusId).focus({ preventScroll: true });
}
function updateState(next) {
  if (!next?.workflows || !next.queue) return;
  const repoChanged = state?.repo.fullName !== next.repo.fullName || state?.mode !== next.mode;
  state = next;
  if (!initialized || repoChanged) {
    $('branch').value = state.repo.defaultBranch || 'main';
    $('repository').value = state.mode === 'github' ? state.repo.url || state.repo.fullName : '';
    selected = []; schemas.clear(); inputValues = {}; initialized = true;
  }
  selected = selected.filter(id => state.workflows.some(workflow => workflow.id === id && workflow.state === 'active'));
  $('sidebar-repo').textContent = state.repo.fullName.split('/').at(-1);
  $('breadcrumb-repo').textContent = state.repo.fullName;
  $('nav-count').textContent = state.workflows.length;
  $('workflow-count').textContent = state.workflows.length;
  $('demo-banner').hidden = state.mode !== 'demo';
  $('connection').innerHTML = `<span class="dot ${state.mode === 'github' ? 'green' : 'neutral'}"></span>${state.mode === 'demo' ? 'Demo workspace' : 'GitHub connected'}`;
  $('auth-label').textContent = state.auth === 'gh' ? 'Authenticated with GitHub CLI' : state.auth === 'environment' ? 'Authenticated with environment token' : 'Server-side authentication';
  $('github-link').hidden = state.mode !== 'github' || !safeUrl(state.repo.url);
  if (!$('github-link').hidden) $('github-link').href = `${state.repo.url}/actions`;
  $('sync-label').textContent = `Last synced ${new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(state.updatedAt || Date.now()))} · Auto-refresh every 5s`;
  renderTable(); renderQueue();
}
async function refresh(manual = false) {
  if (refreshPromise) return refreshPromise;
  if (manual) { $('refresh').disabled = true; $('refresh').classList.add('spin'); }
  refreshPromise = (async () => {
    try { updateState(await api(manual ? '/api/state?refresh=1' : '/api/state')); if (manual) { clearError(); announce('Workflows refreshed.'); } }
    catch (failure) {
      error(`${failure.message} ${state ? 'Showing the last synced data; automatic refresh will retry.' : 'Start the local server and refresh to try again.'}`);
      $('connection').innerHTML = '<span class="dot red"></span>Connection interrupted';
      if (!state) { $('table-container').innerHTML = '<div class="empty-results"><strong>Could not load workflows</strong><p>Check your connection and use Refresh to retry.</p></div>'; $('table-container').setAttribute('aria-busy', 'false'); }
    } finally { $('refresh').disabled = false; $('refresh').classList.remove('spin'); refreshPromise = null; }
  })();
  return refreshPromise;
}
function selectWorkflow(id) {
  if (blocked()) return;
  selected = selected.includes(id) ? selected.filter(value => value !== id) : $('allow-multiple').checked ? [...selected, id] : [id];
  renderTable(); renderQueue();
  announce(`${selected.length} ${selected.length === 1 ? 'workflow' : 'workflows'} selected.`);
}
async function getSchema(id) {
  const key = `${id}:${$('branch').value.trim()}`;
  if (!schemas.has(key)) schemas.set(key, await api(`/api/workflows/${id}/inputs?ref=${encodeURIComponent($('branch').value.trim())}`));
  return schemas.get(key);
}
async function showInputs(ids, shouldRun = false) {
  const results = await Promise.all(ids.map(getSchema));
  for (let i = 0; i < ids.length; i++) if (!results[i].dispatchable) throw new Error(`${state.workflows.find(workflow => workflow.id === ids[i])?.name} cannot be started manually on this ref. Add a workflow_dispatch trigger on the default branch.`);
  if (shouldRun && results.every(schema => schema.inputs.length === 0)) return dispatch(ids);
  dialogWorkflows = ids; runAfterInputs = shouldRun;
  $('inputs-title').textContent = shouldRun ? 'Review run options' : 'Workflow run options';
  $('inputs-description').textContent = `Branch: ${$('branch').value.trim()}. ${shouldRun ? 'These workflows will run in the order shown, one at a time.' : 'Options are kept for this branch until you reload the page.'}`;
  $('save-inputs').textContent = shouldRun ? `Run ${ids.length === 1 ? 'workflow' : `${ids.length} workflows`}` : 'Save options';
  $('inputs-error').hidden = true;
  $('input-fields').innerHTML = ids.map((id, index) => {
    const workflow = state.workflows.find(value => value.id === id);
    return `<fieldset class="input-group"><legend>${esc(workflow.name)}</legend>${results[index].inputs.length ? results[index].inputs.map((field, fieldIndex) => {
      const fieldId = `input-${id}-${fieldIndex}`;
      const value = inputValues[id]?.[field.name] ?? field.default ?? '';
      let control;
      const common = `id="${fieldId}" data-workflow="${id}" data-name="${esc(field.name)}" ${field.required ? 'required' : ''} aria-describedby="${fieldId}-help"`;
      if (field.type === 'boolean') control = `<select ${common}><option value="false" ${value === false || value === 'false' || value === '' ? 'selected' : ''}>False</option><option value="true" ${value === true || value === 'true' ? 'selected' : ''}>True</option></select>`;
      else if (field.type === 'choice') control = `<select ${common}>${!value ? '<option value="">Choose an option</option>' : ''}${(field.options || []).map(option => `<option value="${esc(option)}" ${String(option) === String(value) ? 'selected' : ''}>${esc(option)}</option>`).join('')}</select>`;
      else control = `<input ${common} type="${field.type === 'number' ? 'number' : 'text'}" ${field.type === 'number' ? 'step="any"' : ''} value="${esc(value)}" autocomplete="off">`;
      return `<div class="dispatch-field"><label for="${fieldId}">${esc(field.name)}${field.required ? ' *' : ' (optional)'}</label>${control}<p id="${fieldId}-help">${esc(field.description || (field.type === 'environment' ? 'Enter an existing GitHub environment name.' : field.type === 'boolean' ? 'Choose true or false.' : ''))}</p></div>`;
    }).join('') : '<p class="field-help">No inputs needed for this workflow.</p>'}</fieldset>`;
  }).join('');
  $('inputs-dialog').showModal();
}
async function dispatch(ids) {
  clearError();
  const result = await api('/api/queue', { workflowIds: ids, ref: $('branch').value.trim(), allowMultiple: $('allow-multiple').checked, inputs: Object.fromEntries(ids.map(id => [id, inputValues[id] || {}])) });
  selected = []; updateState(result); await refresh();
  announce(`${ids.length} ${state.mode === 'demo' ? 'simulated ' : ''}${ids.length === 1 ? 'workflow' : 'workflows'} added to the run queue.`);
}
async function run(ids) {
  if (blocked() || !ids.length) return;
  if (!$('branch').value.trim()) { error('Enter a branch before starting a workflow.'); $('branch').focus(); return; }
  busy = true; renderTable(); renderQueue();
  try { await showInputs(ids, true); } catch (failure) { error(failure.message); }
  finally { busy = false; renderTable(); renderQueue(); }
}
function settings() {
  if (blocked()) { error('Repository settings cannot change while a queue is being prepared or running.'); return; }
  $('settings-error').hidden = true; $('settings-dialog').showModal();
}
$('refresh').addEventListener('click', () => refresh(true));
$('dismiss-error').addEventListener('click', clearError);
for (const id of ['repo-switch', 'sidebar-settings', 'connect-repo']) $(id).addEventListener('click', settings);
for (const id of ['search', 'recency-filter', 'sort']) $(id).addEventListener(id === 'search' ? 'input' : 'change', () => renderTable());
$('branch').addEventListener('input', () => { schemas.clear(); inputValues = {}; renderQueue(); });
$('allow-multiple').addEventListener('change', () => {
  if (!$('allow-multiple').checked && selected.length > 1) { selected = selected.slice(0, 1); announce('Multiple selection is off. Only the first selected workflow was kept.'); }
  $('mode-help').textContent = $('allow-multiple').checked ? 'Select several. They still run one by one, never in parallel.' : 'Off by default. Select one workflow at a time.';
  renderTable(); renderQueue();
});
$('clear-selection').addEventListener('click', () => { selected = []; renderTable(); renderQueue(); announce('Selection cleared.'); });
$('run-selected').addEventListener('click', () => run([...selected]));
$('mobile-run').addEventListener('click', () => run([...selected]));
$('mobile-review').addEventListener('click', () => {
  $('queue-heading').scrollIntoView({ block: 'start' });
  $('run-selected').focus();
});
$('table-container').addEventListener('change', event => { if (event.target.dataset.select) selectWorkflow(Number(event.target.dataset.select)); });
$('table-container').addEventListener('click', event => {
  const runButton = event.target.closest('[data-run]');
  if (runButton) run([Number(runButton.dataset.run)]);
  if (event.target.closest('#clear-filters')) { $('search').value = ''; $('recency-filter').value = 'all'; renderTable(); $('search').focus(); }
});
$('queue-items').addEventListener('click', async event => {
  if (blocked()) return;
  const target = event.target.closest('button');
  if (!target) return;
  if (target.dataset.remove) selected = selected.filter(id => id !== Number(target.dataset.remove));
  if (target.dataset.move) {
    const index = selected.indexOf(Number(target.dataset.move));
    const other = index + Number(target.dataset.direction);
    if (other >= 0 && other < selected.length) [selected[index], selected[other]] = [selected[other], selected[index]];
  }
  if (target.dataset.options) {
    busy = true; renderQueue(); renderTable();
    try { await showInputs([Number(target.dataset.options)]); } catch (failure) { error(failure.message); }
    finally { busy = false; renderQueue(); renderTable(); }
  }
  renderTable(); renderQueue();
});
$('stop-queue').addEventListener('click', async () => {
  busy = true; renderQueue();
  try { updateState(await api('/api/queue/stop', {})); announce('Pending workflows removed. The current GitHub run is not canceled.'); }
  catch (failure) { error(failure.message); }
  finally { busy = false; renderQueue(); renderTable(); }
});
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('save-settings'); button.disabled = true; button.textContent = 'Connecting…'; $('settings-error').hidden = true;
  try { updateState(await api('/api/config', { repository: $('repository').value.trim() })); $('settings-dialog').close(); clearError(); await refresh(); announce('Repository connected.'); }
  catch (failure) { $('settings-error').textContent = failure.message; $('settings-error').hidden = false; }
  finally { button.disabled = false; button.textContent = 'Connect repository'; }
});
$('use-demo').addEventListener('click', async () => {
  $('use-demo').disabled = true;
  try { updateState(await api('/api/demo', {})); $('settings-dialog').close(); clearError(); await refresh(); }
  catch (failure) { $('settings-error').textContent = failure.message; $('settings-error').hidden = false; }
  finally { $('use-demo').disabled = false; }
});
$('inputs-form').addEventListener('submit', async event => {
  event.preventDefault();
  for (const id of dialogWorkflows) inputValues[id] = {};
  $('input-fields').querySelectorAll('[data-workflow]').forEach(field => { if (field.value !== '') inputValues[field.dataset.workflow][field.dataset.name] = field.value; });
  if (!runAfterInputs) { $('inputs-dialog').close(); renderQueue(true); return; }
  busy = true; $('save-inputs').disabled = true; $('save-inputs').textContent = 'Starting…';
  try { await dispatch(dialogWorkflows); $('inputs-dialog').close(); }
  catch (failure) { $('inputs-error').textContent = failure.message; $('inputs-error').hidden = false; }
  finally { busy = false; $('save-inputs').disabled = false; $('save-inputs').textContent = `Run ${dialogWorkflows.length === 1 ? 'workflow' : `${dialogWorkflows.length} workflows`}`; renderTable(); renderQueue(); }
});
document.querySelectorAll('.close-dialog').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
for (const view of ['workflows', 'activity']) $(`nav-${view}`).addEventListener('click', () => {
  page = view;
  for (const name of ['workflows', 'activity']) { $(`nav-${name}`).classList.toggle('active', name === view); if (name === view) $(`nav-${name}`).setAttribute('aria-current', 'page'); else $(`nav-${name}`).removeAttribute('aria-current'); }
  $('breadcrumb-page').textContent = view === 'activity' ? 'Latest activity' : 'Workflows';
  $('page-title').textContent = view === 'activity' ? 'The latest, at a glance.' : 'Your workflows. Ready to run.';
  $('page-description').textContent = view === 'activity' ? 'The most recent run of each workflow, newest first.' : 'Pick a workflow, or line up a few. We’ll take it from here.';
  $('list-heading').firstChild.textContent = view === 'activity' ? 'Latest workflow runs ' : 'Workflows ';
  $('sort').disabled = view === 'activity'; renderTable();
});
window.addEventListener('offline', () => error('You are offline. GitHub status cannot update. Keep the server running; reconnect before starting another queue.'));
await refresh();
setInterval(() => { if (!document.hidden || state?.queue.running) refresh(); }, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
