import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowRunner } from '../lib/runner.mjs';

function fixture(workflowCount = 8) {
  let now = Date.parse('2026-11-01T12:00:00Z');
  let calls = 0;
  const adapter = {
    async getRepo() { calls++; return { fullName: 'acme/platform', url: 'https://github.com/acme/platform', defaultBranch: 'main' }; },
    async listWorkflows() { calls++; return Array.from({ length: workflowCount }, (_, index) => ({ id: index + 1, name: `Workflow ${index}`, path: `.github/workflows/${index}.yml`, state: 'active' })); },
    async latestRun() { calls++; return null; }
  };
  return { runner: new WorkflowRunner({ adapter, repository: 'acme/platform', now: () => now }), calls: () => calls, advance: amount => { now += amount; } };
}

test('local status polling reuses GitHub metadata and preserves true sync timestamp', async () => {
  const { runner, calls, advance } = fixture();
  const first = await runner.refresh();
  assert.equal(calls(), 10);
  advance(5000);
  runner.queue = { running: true, items: [{ workflowId: 1, status: 'waiting' }], error: null };
  const cached = await runner.refresh();
  assert.equal(calls(), 10);
  assert.equal(cached.updatedAt, first.updatedAt);
  assert.equal(cached.queue.items[0].status, 'waiting');
  advance(25000);
  const fresh = await runner.refresh();
  assert.equal(calls(), 20);
  assert.notEqual(fresh.updatedAt, first.updatedAt);
});

test('manual refresh bypasses cache and large repositories have a longer cache lifetime', async () => {
  const { runner, calls, advance } = fixture(100);
  await runner.refresh();
  assert.equal(calls(), 102);
  advance(30000);
  await runner.refresh();
  assert.equal(calls(), 102);
  await runner.refresh({ force: true });
  assert.equal(calls(), 204);
  advance(300000);
  await runner.refresh();
  assert.equal(calls(), 306);
});
