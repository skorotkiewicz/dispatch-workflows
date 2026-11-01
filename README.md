# Dispatch

A local GUI for manually running GitHub Actions workflows. Save repository workspaces, see each workflow’s latest run, and start a workflow with one click. Enable **Allow multiple workflows** to build an ordered batch; the server starts the next workflow only after the previous one succeeds.

## Start

Requires Node.js 22 or newer.

```sh
npm install
npm start
```

Open **http://127.0.0.1:3000** and click **Connect a repository** to load your workflows.

## Connect GitHub

1. Authenticate on the machine running the server:
   ```sh
   gh auth login --hostname github.com
   ```
   Alternatively, provide `GH_TOKEN` or `GITHUB_TOKEN` in the server environment. Do not put a token in browser storage or commit it to a file.
2. If you authenticated after starting the app, restart it so it picks up the credentials.
3. Click **Connect a repository** (or **+ Add workspace**), enter `https://github.com/owner/repository` or `owner/repository`, and connect.

For a fine-grained personal access token, grant the target repository **Actions: read and write**, **Contents: read**, and **Metadata: read**. Your GitHub account must also have permission to run its workflows. Organization/SSO restrictions may require additional approval. Only GitHub.com is supported.

Credentials remain on the server. Workspace IDs, repository names, branch preferences, and the last selected workspace are saved in `.data/config.json`. You can bootstrap the first workspace using `GITHUB_REPO=owner/repository` when no saved configuration exists. Existing single-repository settings migrate automatically.

## Repository workspaces

- Use **+ Add workspace** to save another repository, then switch using the sidebar selector. Adding an already saved repository selects its existing workspace.
- Each workspace has its own workflows, saved branch, and server-side queue. Selections, filters, and input drafts stay separate while switching within a browser tab; reloading clears these drafts.
- You can browse other workspaces while a queue runs. A banner identifies the running repository and takes you back to its queue. Only **one queue runs at a time across all workspaces**.
- Each browser tab keeps its own viewed workspace. New tabs without a workspace URL open the last selected workspace.
- Open **Workspace settings** to remove saved workspaces. Removal only changes local settings, never the GitHub repository. A workspace with a running queue cannot be removed.

## Run workflows

- Use the play button on any active workflow for a single run, or select a workflow and click **Run workflow**.
- Single selection is the default. Check **Allow multiple workflows** to select a batch. This enables multiple *selections*, not parallel execution.
- Selection order is execution order. Use the queue’s up/down buttons to reorder, or remove individual items.
- Choose an existing **branch**; tags and commit SHAs are not supported. The repository’s default branch is selected initially; branch changes are validated and saved per workspace.
- Workflow inputs are read from the YAML at that branch. Required inputs, choices, booleans, numbers, environment names, and defaults are supported. Use **Run options** to prepare values, or enter them when prompted at run time.
- The workflow must have `workflow_dispatch` on the default branch. For example:
  ```yaml
  name: Refresh data
  on:
    workflow_dispatch:
      inputs:
        environment:
          description: Target environment
          type: choice
          required: true
          default: staging
          options: [staging, production]
  jobs:
    refresh:
      runs-on: ubuntu-latest
      steps:
        - run: printf '%s\n' 'Put your task here'
  ```

The latest run displays its result, branch, duration, and relative time. Hover the time for an exact timestamp; in a connected repository, click it to open the run on GitHub. **Latest activity** shows the latest run of each workflow, not the complete run history.

### Name colors indicate recency, not success

| Last started | Workflow name |
| --- | --- |
| Less than 12 hours ago | Green |
| 12–24 hours ago | Dark yellow |
| 1–7 days ago, including exactly 7 days | Neutral |
| More than 7 days ago | Red |
| Never run | Gray, labeled “Never run” |

The separate result badge indicates success, failure, cancellation, or progress. Search, last-run filters, and sorting are available.

## Queue behavior and safety

- Queues run on the **local server**, so closing or refreshing the browser does not interrupt a batch. Keep the server process and its machine running.
- Every workflow and input is validated before the first dispatch. Overlapping batch requests are rejected across all workspaces, even from multiple browser tabs. Existing active runs in other saved repositories block a new batch.
- Before each dispatch, the server waits for existing active repository runs. The app never intentionally runs its selected workflows in parallel.
- A failed, canceled, timed-out, skipped, or otherwise non-successful run stops the batch. Pending workflows are skipped.
- **Stop after current workflow** skips pending items. It does **not** cancel a run already dispatched to GitHub. Use GitHub to cancel that run if necessary.
- An uncertain dispatch response, ambiguous run identity, or monitoring error stops the batch. The server never automatically retries a dispatch. Inspect GitHub before starting another queue.
- **Queues are in memory, not persisted.** Restarting the server loses monitoring and pending items; it never resumes or re-dispatches them. Already dispatched GitHub runs continue.
- Repository-wide exclusivity is best effort. GitHub has no atomic repository-wide dispatch lock: another person, scheduler, or app can start a run between the checks. For strict guarantees across all callers, also configure GitHub Actions `concurrency` in the repository. This app is designed for one local server instance.
- Existing-run waiting times out after 30 minutes, run discovery after 2 minutes, and monitoring after 24 hours. These errors stop the batch without canceling GitHub runs.

The browser checks local status every 5 seconds. Live GitHub runs are monitored every 10 seconds. Workflow-list metadata is cached for at least 30 seconds (3 seconds per workflow for larger repositories) to preserve the GitHub API quota. **Refresh** explicitly bypasses that cache. GitHub rate limits and API availability still apply.

The server binds only to `127.0.0.1`, checks Host and Origin headers, and does not expose credential/configuration files through its static server. Do not put it behind a public proxy or use it as a multi-user service.

## Configuration

| Environment variable | Purpose |
| --- | --- |
| `PORT` | Local HTTP port; default `3000` |
| `GH_TOKEN` / `GITHUB_TOKEN` | Optional server-side GitHub token; falls back to `gh auth token` |
| `GITHUB_REPO` | Initial repository when no saved configuration exists |
| `DATA_DIR` | Configuration directory; defaults to `.data` in the app directory |

## Verify

```sh
npm test                  # Unit and backend integration tests; no GitHub dispatches
npx playwright install chromium  # Only needed if Chromium is not already installed
npm run test:ui           # Browser tests with a test-only fake GitHub adapter
```

Browser tests cover workspace switching, isolated drafts, saved branches, cross-workspace queue blocking, multiple tabs, safe removal, sequential execution across a reload, input forms, error recovery, keyboard controls, automated accessibility checks, mobile/320px layouts, long untrusted names, RTL, and 200% zoom. Screenshots are written to the ignored `artifacts/` directory. Tests do not dispatch real GitHub workflows.

## Files

- `server.mjs`: local HTTP/API entry point
- `lib/github.mjs`: authentication, GitHub API, YAML schemas, input validation
- `lib/runner.mjs`: sequential execution and run tracking
- `lib/workspaces.mjs`: saved workspaces, configuration migration, global queue lock
- `public/`: dependency-free browser interface
- `test/`: unit, integration, and Playwright tests
