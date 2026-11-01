import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recency, relativeTime, escapeHTML, filteredWorkflows } from '../public/model.mjs';

const now = Date.parse('2026-11-01T12:00:00Z');
const ago = milliseconds => new Date(now - milliseconds).toISOString();

test('recency has exact boundaries and a neutral 1–7 day range', () => {
  assert.equal(recency(ago(0), now), 'hour');
  assert.equal(recency(ago(3_599_999), now), 'hour');
  assert.equal(recency(ago(3_600_000), now), 'day');
  assert.equal(recency(ago(86_399_999), now), 'day');
  assert.equal(recency(ago(86_400_000), now), 'week');
  assert.equal(recency(ago(604_800_000), now), 'week');
  assert.equal(recency(ago(604_800_001), now), 'stale');
  assert.equal(recency(null, now), 'never');
  assert.equal(recency('invalid', now), 'never');
  assert.equal(recency(ago(-1000), now), 'hour');
});

test('relative dates have a useful no-history and immediate state', () => {
  assert.equal(relativeTime(null, now), 'Never run');
  assert.equal(relativeTime(ago(0), now), 'Just now');
  assert.match(relativeTime(ago(3_600_000), now), /1/);
});

test('untrusted workflow names and attributes are escaped', () => {
  assert.equal(escapeHTML('<img src=x onerror="run()"> & \'quoted\''), '&lt;img src=x onerror=&quot;run()&quot;&gt; &amp; &#39;quoted&#39;');
});

test('filtering supports paths, empty results, alphabetical and run-age sorting', () => {
  const workflows = [
    { id: 1, name: 'Zulu', path: 'z.yml', lastRun: { startedAt: '2026-10-31T12:00:00Z' } },
    { id: 2, name: 'Álpha', path: 'release.yml', lastRun: null },
    { id: 3, name: 'Build', path: 'build.yml', lastRun: { startedAt: '2026-11-01T10:00:00Z' } }
  ];
  assert.deepEqual(filteredWorkflows(workflows, { search: 'RELEASE' }).map(item => item.id), [2]);
  assert.deepEqual(filteredWorkflows(workflows, { sort: 'recent' }).map(item => item.id), [3, 1, 2]);
  assert.deepEqual(filteredWorkflows(workflows, { sort: 'oldest' }).map(item => item.id), [2, 1, 3]);
  assert.deepEqual(filteredWorkflows(workflows, { filter: 'never' }).map(item => item.id), [2]);
  assert.deepEqual(filteredWorkflows(workflows, { search: 'missing' }), []);
  assert.equal(workflows[0].id, 1);
});
