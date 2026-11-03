import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubAdapter } from '../../lib/github.mjs';
import { fetchGitHub } from '../../desktop/network.mjs';

// Explicit network check: public metadata only, without authentication or dispatches.
test('desktop HTTPS verifies GitHub using the runtime default trusted certificates', async () => {
  const adapter = new GitHubAdapter({ fetchImpl: fetchGitHub, timeoutMs: 10000 });
  const repo = await adapter.getRepo('octocat/Hello-World');
  assert.equal(repo.fullName, 'octocat/Hello-World');
  assert.ok(repo.defaultBranch);
});
