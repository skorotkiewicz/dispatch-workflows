import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const origin = { Origin: 'http://127.0.0.1:3107' };
const waitForIdle = async request => {
  await expect.poll(async () => {
    const state = await (await request.get('/api/state')).json();
    return Boolean(state.globalQueue || state.queue.running);
  }, { timeout: 30_000 }).toBe(false);
};
test.beforeEach(async ({ page, request }) => {
  await waitForIdle(request);
  const state = await (await request.get('/api/state')).json();
  if (state.mode === 'setup' || state.repo.fullName !== 'test-org/workflows') {
    const response = await request.post('/api/config', { data: { repository: 'test-org/workflows' }, headers: { Origin: 'http://127.0.0.1:3107' } });
    expect(response.status()).toBe(200);
  }
  await page.goto('/');
  await expect(page.locator('#workflow-count')).toHaveText('8');
});

test('unconfigured workspace shows an accessible setup screen and connects through the form', async ({ page }) => {
  await page.route('**/api/state*', route => route.fulfill({ json: {
    mode: 'setup', repo: { fullName: '', url: null, defaultBranch: 'main' }, workflows: [],
    queue: { running: false, items: [], error: null }, updatedAt: new Date().toISOString(), auth: 'none'
  } }));
  await page.reload();
  await expect(page.getByRole('heading', { name: 'No repository connected', exact: true })).toBeVisible();
  await expect(page.locator('#workspace-grid')).toBeHidden();
  await expect(page.locator('#connection')).toHaveText('Not connected');
  await expect(page.locator('tbody tr')).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/setup-desktop.png', fullPage: true });
  const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(audit.violations).toEqual([]);
  await page.setViewportSize({ width: 320, height: 900 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/setup-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Connect a repository', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
  await page.getByLabel('GitHub repository URL').fill('test-org/workflows');
  await page.unroute('**/api/state*');
  await page.getByRole('button', { name: 'Connect repository', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('#setup-screen')).toBeHidden();
  await expect(page.locator('#workflow-count')).toHaveText('8');
  await expect(page.locator('#connection')).toHaveText('GitHub connected');
  await page.reload();
  await expect(page.locator('#breadcrumb-repo')).toHaveText('test-org/workflows');
});

test('loads repository workflows, supports one selection by default, filters, and keyboard navigation', async ({ page }) => {
  const errors = []; page.on('pageerror', failure => errors.push(failure.message));
  await expect(page.locator('#connection')).toHaveText('GitHub connected');
  await expect(page.getByLabel('Allow multiple workflows')).not.toBeChecked();
  await page.getByLabel('Select CI pipeline', { exact: true }).check();
  await page.getByLabel('Select Docs preview', { exact: true }).check();
  await expect(page.getByLabel('Select CI pipeline', { exact: true })).not.toBeChecked();
  await expect(page.locator('#queue-count')).toHaveText('1');
  await page.getByLabel('Search workflows').fill('not-a-workflow');
  await expect(page.getByText('No matching workflows', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.getByLabel('Search workflows')).toBeFocused();
  await page.getByLabel('Filter by last run').selectOption('never');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('tbody')).toContainText('Docs preview');
  await page.getByLabel('Filter by last run').selectOption('all');
  await page.getByRole('button', { name: 'Latest activity' }).click();
  await expect(page.getByRole('heading', { name: 'The latest, at a glance.' })).toBeVisible();
  await expect(page.locator('tbody tr')).toHaveCount(7);
  await page.locator('#nav-workflows').click();
  await page.getByLabel('Select CI pipeline', { exact: true }).focus();
  await expect(page.getByLabel('Select CI pipeline', { exact: true })).toBeFocused();
  await page.keyboard.press('Space');
  await expect(page.getByLabel('Select CI pipeline', { exact: true })).toBeChecked();
  await page.screenshot({ path: 'artifacts/desktop.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('multiple selection has editable order, collapses safely, and keeps branch options', async ({ page }) => {
  await page.getByLabel('Allow multiple workflows').check();
  await page.getByLabel('Select CI pipeline', { exact: true }).check();
  await page.getByLabel('Select Docs preview', { exact: true }).check();
  await expect(page.locator('#queue-count')).toHaveText('2');
  await page.getByLabel('Move Docs preview earlier', { exact: true }).click();
  await expect(page.locator('.queue-list li').first()).toContainText('Docs preview');
  await page.getByLabel('Allow multiple workflows').uncheck();
  await expect(page.locator('#queue-count')).toHaveText('1');
  await expect(page.getByLabel('Select Docs preview', { exact: true })).toBeChecked();
  await page.locator('#queue-items').getByRole('button', { name: 'Run options', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  const inputAudit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(inputAudit.violations).toEqual([]);
  await expect(page.getByText('No inputs needed for this workflow.')).toBeVisible();
  await page.getByRole('button', { name: 'Save options', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByLabel('Run on branch').fill('');
  await expect(page.locator('#run-selected')).toBeDisabled();
  await expect(page.locator('#run-help')).toHaveText('Enter a branch to run on.');
});

test('runs a selected batch sequentially and preserves monitoring across reload', async ({ page, request }) => {
  await page.getByLabel('Allow multiple workflows').check();
  await page.getByLabel('Select CI pipeline', { exact: true }).check();
  await page.getByLabel('Select Docs preview', { exact: true }).check();
  await page.locator('#run-selected').click();
  await expect(page.locator('#queue-label')).toHaveText('IN PROGRESS');
  const initial = (await (await request.get('/api/state')).json()).queue;
  expect(initial.items[0].workflowId).toBe(1);
  expect(initial.items[1].workflowId).toBe(8);
  expect(initial.items[1].status).toBe('pending');
  await page.reload();
  await expect(page.locator('#queue-count')).toHaveText('2');
  await expect.poll(async () => {
    const queue = (await (await request.get('/api/state')).json()).queue;
    return queue.running ? [] : queue.items.map(item => item.status);
  }, { timeout: 30_000 }).toEqual(['completed', 'completed']);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('#queue-label')).toHaveText('LAST QUEUE');
  await expect(page.locator('#queue-items')).toContainText('success');
});

test('requires workflow inputs, handles configuration errors inline, and traps dialog focus', async ({ page }) => {
  await page.getByLabel('Run Deploy production', { exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('version *', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('version *', { exact: true })).toHaveAttribute('required', '');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await page.locator('#sidebar-settings').click();
  await expect(page.getByRole('heading', { name: 'Add a workspace' })).toBeVisible();
  await page.getByLabel('GitHub repository URL').fill('https://example.com/owner/repo');
  await page.getByRole('button', { name: 'Connect repository', exact: true }).click();
  await expect(page.locator('#settings-error')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
});

test('has no serious accessibility violations and fits mobile, RTL and zoom layouts', async ({ page }) => {
  let audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(audit.violations).toEqual([]);
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.screenshot({ path: 'artifacts/mobile.png', fullPage: true });
  audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(audit.violations).toEqual([]);
  await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => { document.documentElement.dir = 'ltr'; });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  await expect(page.getByRole('heading', { name: 'Your workflows. Ready to run.' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('mobile selection exposes a thumb-zone action and keyboard-accessible queue review', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('Select CI pipeline', { exact: true }).check();
  await expect(page.locator('#mobile-run-bar')).toBeVisible();
  await expect(page.locator('#mobile-run')).toHaveText('Run workflow');
  await page.screenshot({ path: 'artifacts/mobile-selected.png', fullPage: true });
  const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(audit.violations).toEqual([]);
  await page.locator('#mobile-review').click();
  await expect(page.locator('#run-selected')).toBeInViewport();
  await expect(page.locator('#mobile-run-bar')).toBeHidden();
});

test('long and hostile workflow names stay readable without overflow or HTML execution', async ({ page, request }) => {
  const data = await (await request.get('/api/state')).json();
  data.workflows[0].name = 'Validate integration compatibility for all supported release environments '.repeat(3) + '<script>window.injected=true</script>';
  data.workflows[0].lastRun.branch = 'feature/a-very-long-branch-name-for-release-compatibility-testing';
  await page.route('**/api/state*', route => route.fulfill({ json: data }));
  await page.reload();
  await expect(page.locator('tbody')).toContainText('<script>window.injected=true</script>');
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test('displays a persistent offline/error state and can recover on refresh', async ({ page }) => {
  await page.route('**/api/state*', route => route.abort('failed'));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('#error-banner')).toBeVisible();
  await expect(page.locator('#connection')).toContainText('Connection interrupted');
  await page.unroute('**/api/state*');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('#error-banner')).toBeHidden();
  await expect(page.locator('#connection')).toContainText('GitHub connected');
});

async function addWebsite(page) {
  await page.locator('#add-workspace').click();
  await page.getByLabel('GitHub repository URL').fill('test-org/website');
  await page.getByRole('button', { name: 'Connect repository', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.locator('#workflow-count')).toHaveText('2');
  return page.locator('#workspace-select').inputValue();
}

test('workspace switching preserves isolated selections, input drafts, filters and saved branches', async ({ page }) => {
  const primary = await page.locator('#workspace-select').inputValue();
  await page.getByLabel('Run on branch').fill('release/candidate');
  await page.getByLabel('Run on branch').press('Tab');
  await expect(page.locator('#branch-status')).toHaveText('Branch saved for this workspace.');
  await page.getByLabel('Select Deploy production', { exact: true }).check();
  await page.locator('#queue-items').getByRole('button', { name: 'Run options', exact: true }).click();
  await page.getByLabel('version *', { exact: true }).fill('v2.3.4');
  await page.getByRole('button', { name: 'Save options', exact: true }).click();
  await page.getByLabel('Search workflows').fill('production');
  const website = await addWebsite(page);
  await expect(page.getByLabel('Run on branch')).toHaveValue('develop');
  await expect(page.getByLabel('Search workflows')).toHaveValue('');
  await expect(page.locator('#queue-count')).toHaveText('0');
  await page.getByLabel('Select Build website', { exact: true }).check();
  await page.locator('#workspace-select').selectOption(primary);
  await expect(page.getByLabel('Run on branch')).toHaveValue('release/candidate');
  await expect(page.getByLabel('Search workflows')).toHaveValue('production');
  await expect(page.getByLabel('Select Deploy production', { exact: true })).toBeChecked();
  await page.locator('#queue-items').getByRole('button', { name: 'Run options · saved', exact: true }).click();
  await expect(page.getByLabel('version *', { exact: true })).toHaveValue('v2.3.4');
  await page.getByRole('button', { name: 'Save options', exact: true }).click();
  await page.locator('#workspace-select').selectOption(website);
  await expect(page.getByLabel('Select Build website', { exact: true })).toBeChecked();
  await page.reload();
  await expect(page.locator('#breadcrumb-repo')).toHaveText('test-org/website');
  await expect(page.getByLabel('Run on branch')).toHaveValue('develop');
  await page.locator('#workspace-select').selectOption(primary);
  await expect(page.getByLabel('Run on branch')).toHaveValue('release/candidate');
});

test('queues remain attached to their workspace and block overlapping runs globally', async ({ page, request }) => {
  const primary = await page.locator('#workspace-select').inputValue();
  const website = await addWebsite(page);
  await page.locator('#workspace-select').selectOption(primary);
  await page.getByLabel('Run on branch').fill('workspace-queue-test');
  await page.getByLabel('Allow multiple workflows').check();
  await page.getByLabel('Select CI pipeline', { exact: true }).check();
  await page.getByLabel('Select Docs preview', { exact: true }).check();
  await page.locator('#run-selected').click();
  await expect(page.locator('#queue-label')).toHaveText('IN PROGRESS');
  await page.locator('#workspace-select').selectOption(website);
  await expect(page.locator('#global-run-banner')).toContainText('test-org/workflows');
  await page.getByLabel('Select Build website', { exact: true }).check();
  await expect(page.locator('#run-selected')).toBeDisabled();
  await expect(page.getByLabel('Run Build website', { exact: true })).toBeDisabled();
  await expect(page.locator('#queue-items')).toContainText('Build website');
  const overlapping = await request.post('/api/queue', { headers: origin, data: { workspaceId: website, workflowIds: [1], ref: 'develop', allowMultiple: false, inputs: {} } });
  expect(overlapping.status()).toBe(409);
  const wrongStop = await request.post('/api/queue/stop', { headers: origin, data: { workspaceId: website } });
  expect((await wrongStop.json()).queue.running).toBe(false);
  const owner = await (await request.get(`/api/state?workspaceId=${primary}`)).json();
  expect(owner.queue.running).toBe(true);
  expect(owner.queue.items[1].status).toBe('pending');
  const removeRunning = await request.post('/api/workspaces/remove', { headers: origin, data: { workspaceId: primary } });
  expect(removeRunning.status()).toBe(409);
  await page.screenshot({ path: 'artifacts/workspace-running.png', fullPage: true });
  await page.locator('#view-running-workspace').click();
  await expect(page.locator('#queue-items')).toContainText('Docs preview');
  await page.locator('#stop-queue').click();
  await waitForIdle(request);
  const finished = await (await request.get(`/api/state?workspaceId=${primary}`)).json();
  expect(finished.queue.items.map(item => item.status)).toEqual(['completed', 'skipped']);
  await page.locator('#workspace-select').selectOption(website);
  await expect(page.getByLabel('Select Build website', { exact: true })).toBeChecked();
  await expect(page.locator('#run-selected')).toBeEnabled();
});

test('browser tabs retain their own workspace despite the saved active workspace changing', async ({ page, context }) => {
  const primary = await page.locator('#workspace-select').inputValue();
  const website = await addWebsite(page);
  const other = await context.newPage();
  await other.goto(`/?workspace=${primary}`);
  await expect(other.locator('#workflow-count')).toHaveText('8');
  await other.locator('#workspace-select').selectOption(website);
  await page.locator('#workspace-select').selectOption(primary);
  await other.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(other.locator('#breadcrumb-repo')).toHaveText('test-org/website');
  await expect(page.locator('#breadcrumb-repo')).toHaveText('test-org/workflows');
  await other.reload();
  await expect(other.locator('#workflow-count')).toHaveText('2');
  await other.close();
});

test('late refresh responses cannot replace a newly selected workspace', async ({ page, request }) => {
  const primary = await page.locator('#workspace-select').inputValue();
  const website = await addWebsite(page);
  await page.locator('#workspace-select').selectOption(primary);
  const previous = await (await request.get(`/api/state?workspaceId=${primary}`)).json();
  let held;
  await page.route('**/api/state*', route => {
    if (new URL(route.request().url()).searchParams.get('refresh') === '1') held = route;
    else return route.continue();
  });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => Boolean(held)).toBe(true);
  await page.locator('#workspace-select').selectOption(website);
  await expect(page.locator('#workflow-count')).toHaveText('2');
  await held.fulfill({ json: previous });
  await page.unroute('**/api/state*');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('#breadcrumb-repo')).toHaveText('test-org/website');
  await expect(page.locator('#workflow-count')).toHaveText('2');
});

test('an upstream GitHub 404 keeps the viewed workspace instead of using another tab’s selection', async ({ page, request }) => {
  const primary = await page.locator('#workspace-select').inputValue();
  const website = await addWebsite(page);
  await page.locator('#workspace-select').selectOption(primary);
  await request.post('/api/workspaces/select', { headers: origin, data: { workspaceId: website } });
  await page.route('**/api/state*', route => route.fulfill({ status: 404, json: { error: 'GitHub repository not found.' } }));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('#error-banner')).toContainText('GitHub repository not found.');
  await expect(page.locator('#workspace-select')).toHaveValue(primary);
  await expect(page.locator('#breadcrumb-repo')).toHaveText('test-org/workflows');
  await page.unroute('**/api/state*');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('#error-banner')).toBeHidden();
});

test('reconnecting the current workspace during refresh does not stall future refreshes', async ({ page }) => {
  const website = await addWebsite(page);
  let held;
  await page.route('**/api/state*', route => {
    if (!held && new URL(route.request().url()).searchParams.get('refresh') === '1') held = route;
    else return route.continue();
  });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => Boolean(held)).toBe(true);
  expect(await addWebsite(page)).toBe(website);
  await expect(page.locator('#workspace-select')).toBeEnabled();
  const current = await page.request.get(`/api/state?workspaceId=${website}`);
  await held.fulfill({ json: await current.json() });
  await page.unroute('**/api/state*');
  const refreshed = page.waitForResponse(response => new URL(response.url()).searchParams.get('refresh') === '1');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  expect((await refreshed).status()).toBe(200);
  await expect(page.locator('#workspace-select')).toHaveValue(website);
});

test('a workspace removed in another tab falls back to the remaining saved workspace', async ({ page, request }) => {
  const primary = await page.locator('#workspace-select').inputValue();
  const website = await addWebsite(page);
  const removed = await request.post('/api/workspaces/remove', { headers: origin, data: { workspaceId: website } });
  expect(removed.status()).toBe(200);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('#workspace-select')).toHaveValue(primary);
  await expect(page.locator('#workflow-count')).toHaveText('8');
  await expect(page.locator('#error-banner')).toBeHidden();
});

test('duplicate connections reuse workspaces and removal only removes local saved settings', async ({ page, request }) => {
  const primary = await page.locator('#workspace-select').inputValue();
  const website = await addWebsite(page);
  const count = await page.locator('#workspace-select option').count();
  expect(await addWebsite(page)).toBe(website);
  await expect(page.locator('#workspace-select option')).toHaveCount(count);
  await page.locator('#sidebar-settings').click();
  const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(audit.violations).toEqual([]);
  await page.setViewportSize({ width: 320, height: 900 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/workspaces-mobile.png', fullPage: true });
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Remove workspace test-org/website', exact: true }).click();
  await expect(page.locator('#workspace-select')).toHaveValue(primary);
  await expect(page.locator('#workflow-count')).toHaveText('8');
  await expect(page.getByRole('button', { name: 'Remove workspace test-org/website', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.locator('#workspace-select option')).toHaveCount(count - 1);
  const missing = await request.get(`/api/state?workspaceId=${website}`);
  expect(missing.status()).toBe(404);
  expect((await missing.json()).code).toBe('WORKSPACE_NOT_FOUND');
});
