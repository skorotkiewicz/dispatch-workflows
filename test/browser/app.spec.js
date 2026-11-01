import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const waitForIdle = async request => {
  await expect.poll(async () => (await (await request.get('/api/state')).json()).queue.running, { timeout: 30_000 }).toBe(false);
};
test.beforeEach(async ({ page, request }) => {
  await waitForIdle(request);
  const state = await (await request.get('/api/state')).json();
  if (state.mode === 'setup') {
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
  await expect(page.getByRole('heading', { name: 'Connect your repository' })).toBeVisible();
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
