# Contributing to Dispatch

For installation and everyday usage, see [README.md](README.md). This guide covers development, testing, packaging, and releases.

## Development setup

Requires Node.js 22 or newer. Install the locked dependencies and start the browser server with automatic restarts:

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:3000**. Authenticate with GitHub before connecting a repository, as described in the [README](README.md).

## Tests and checks

If you use `just`, run `just` to list the project recipes. `just build` packages the desktop app, `just run` starts browser mode, and `just desktop` launches desktop mode. `just check` checks JavaScript syntax, justfile formatting, and the release workflow with actionlint; it requires Go and network access to resolve actionlint. `just test` runs the backend tests, while `just vet` runs both checks and tests. The recipes require Bash.

```sh
npm test                  # Unit and backend integration tests; no GitHub dispatches
npx playwright install chromium  # Only needed if Chromium is not already installed
npm run test:ui           # Browser tests with a test-only fake GitHub adapter
npm run test:desktop      # Linux native webview smoke test; build the release first
npm run test:desktop:github  # Opt-in public GitHub HTTPS check in the packaged app
```

Browser tests cover workspace switching, isolated drafts, saved branches, cross-workspace queue blocking, multiple tabs, safe removal, sequential execution across a reload, input forms, error recovery, keyboard controls, automated accessibility checks, mobile/320px layouts, long untrusted names, RTL, and 200% zoom. Screenshots are written to the ignored `artifacts/` directory. Tests do not dispatch real GitHub workflows.

The Linux desktop smoke test requires `WebKitWebDriver`, `tar`, `zstd`, and a graphical session. It extracts and launches the release payload with isolated settings and no GitHub credentials, checks the native UI and repository validation, and writes `artifacts/electrobun-desktop.png`.

The `test:desktop:github` check also connects to `octocat/Hello-World` to verify real HTTPS requests from the packaged runtime. It reads public repository metadata without credentials and never dispatches workflows. Network regression tests are kept separate from the offline test suite in `test/network/`.

## Desktop development and builds

Dispatch also runs in a native [Electrobun](https://electrobun.dev/electrobun/) window using the same interface and workflow backend. It uses the system webview and Electrobun's experimental Cottontail runtime to keep the package smaller, without bundling Chromium or Bun. The backend test suite also runs successfully under Cottontail.

```sh
npm install
npm run desktop           # Build and launch the desktop app
npm run desktop:dev       # Rebuild and relaunch when source files change
npm run desktop:build     # Create a release for the current OS and architecture
```

The first desktop command downloads the pinned Electrobun toolchain. You do not need a global Electrobun installation. Linux requires GTK 3 and WebKitGTK 4.1; macOS and Windows use their system webviews.

Release installers and update bundles are written to `dist/electrobun/`. On Linux, extract `linux-x64-Dispatch-Setup.tar.gz` for x64 builds and run the setup executable inside it. End users do not need Node.js, Bun, or the source files. Packages include a compressed payload, so the download, launcher, and installed app sizes differ.

Desktop settings live in the operating system's per-user app data directory, scoped to `app.dispatch.workflows` and the release channel. Set `DATA_DIR` to an absolute directory to choose another location. To share existing browser-mode workspaces, set it to the source installation's `.data` directory before launching. Development and stable desktop builds keep separate settings by default. The desktop server chooses an available loopback port automatically; `PORT` applies to browser mode.

GitHub authentication works the same way in both modes. Closing the desktop app stops monitoring and skips pending workflows. If a queue is active, Dispatch asks before closing. Runs already started on GitHub continue.

Desktop HTTPS requests use the runtime's default trusted certificates, including additional roots configured through `NODE_EXTRA_CA_CERTS`.

## GitHub releases

The release workflow runs only when a new tag is pushed. It tests and builds Linux x64, Windows x64, macOS Intel, and macOS Apple Silicon packages, then publishes a GitHub release after every build succeeds. Installers and update bundles are attached as release assets.

Commit and push release changes before creating a new semantic version tag. Choose a version that has not already been released, with an optional `v` prefix:

```sh
git tag v1.0.1
git push origin v1.0.1
```

The tag sets the packaged application version through `DISPATCH_VERSION`; no version-edit commit is required. Tags such as `v1.1.0-beta.1` produce prereleases. Branch pushes and updates to existing tags do not build releases. Builds use the unsigned packaging configuration in `electrobun.config.ts` and the repository's automatic `GITHUB_TOKEN` to publish.

After committing release changes, `just add-tag 1.0.1` creates and pushes `v1.0.1` to trigger the release workflow. Without a version argument it uses `package.json`.

## Arch Linux packaging and AUR

`arch/PKGBUILD` is the release template for `dispatch-workflows-bin`, with `pkgver=0.0.0` and `SKIP` checksums. The workflow fills in the actual version and calculates the checksums; `.SRCINFO` is generated only in CI. The package installs the bundled app under `/opt/dispatch-workflows`, adds the `dispatch-workflows` command and a desktop entry, and includes the MIT license.

To build locally, download and extract the `aur-package-metadata` artifact from a successful release workflow, then run this inside the extracted directory:

```sh
makepkg -si
```

After GitHub publishes a stable release, the workflow updates `pkgver`, the exact source tag, and SHA-256 checksums, generates `.SRCINFO`, and builds the Arch package before publishing its build files to AUR. The `aur-package-metadata` workflow artifact contains the prepared files. Prereleases and tags with build metadata do not update the stable AUR package.

Configure these repository Actions secrets before the first AUR publication:

| Secret | Purpose |
| --- | --- |
| `AUR_USERNAME` | Commit author name for AUR updates |
| `AUR_EMAIL` | Commit author email for AUR updates |
| `AUR_SSH_PRIVATE_KEY` | Private SSH key whose public key is registered with the AUR account maintaining `dispatch-workflows-bin` |

The deploy action can create the AUR package on the first push if the name is available. For an existing package, the SSH key's account must be a maintainer or co-maintainer. Package upgrades are managed through pacman or your AUR helper; the packaging process does not run the standalone installer.

## Behavior and configuration reference

These details describe behavior that contributions should preserve. The [README](README.md) has the main usage walkthrough.

### Connect GitHub

1. Authenticate on the machine running the server:
   ```sh
   gh auth login --hostname github.com
   ```
   Alternatively, provide `GH_TOKEN` or `GITHUB_TOKEN` in the server environment. Do not put a token in browser storage or commit it to a file.
2. If you authenticated after starting the app, restart it so it picks up the credentials.
3. Click **Connect a repository** (or **+ Add workspace**), enter `https://github.com/owner/repository` or `owner/repository`, and connect.

For a fine-grained personal access token, grant the target repository **Actions: read and write**, **Contents: read**, and **Metadata: read**. Your GitHub account must also have permission to run its workflows. Organization/SSO restrictions may require additional approval. Only GitHub.com is supported.

Credentials remain in the backend process. Workspace IDs, repository names, branch preferences, and the last selected workspace are saved in `config.json` in the settings directory, which defaults to `.data` in browser mode. You can bootstrap the first workspace using `GITHUB_REPO=owner/repository` when no saved configuration exists. Existing single-repository settings migrate automatically.

### Repository workspaces

- Use **+ Add workspace** to save another repository, then switch using the sidebar selector. Adding an already saved repository selects its existing workspace.
- Each workspace has its own workflows, saved branch, and server-side queue. Selections, filters, and input drafts stay separate while switching within a browser tab; reloading clears these drafts.
- You can browse other workspaces while a queue runs. A banner identifies the running repository and takes you back to its queue. Only **one queue runs at a time across all workspaces**.
- Each browser tab keeps its own viewed workspace. New tabs without a workspace URL open the last selected workspace.
- Open **Workspace settings** to remove saved workspaces. Removal only changes local settings, never the GitHub repository. A workspace with a running queue cannot be removed.

### Run workflows

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

#### Name colors indicate recency, not success

| Last started | Workflow name |
| --- | --- |
| Less than 12 hours ago | Green |
| 12–24 hours ago | Dark yellow |
| 1–7 days ago, including exactly 7 days | Neutral |
| More than 7 days ago | Red |
| Never run | Gray, labeled “Never run” |

The separate result badge indicates success, failure, cancellation, or progress. Search, last-run filters, and sorting are available.

### Queue behavior and safety

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

### Configuration

| Environment variable | Purpose |
| --- | --- |
| `PORT` | Browser-mode HTTP port; default `3000`. Desktop mode uses an available port |
| `GH_TOKEN` / `GITHUB_TOKEN` | Optional server-side GitHub token; falls back to `gh auth token` |
| `GITHUB_REPO` | Initial repository when no saved configuration exists |
| `DATA_DIR` | Configuration directory; defaults to `.data` in the app directory in browser mode, or the per-user app data directory in desktop mode |

## Files

- `server.mjs`: local HTTP/API entry point
- `lib/application.mjs`: shared HTTP/API server for browser and desktop modes
- `desktop/`: native window, desktop server startup, and shutdown handling
- `electrobun.config.ts`, `hutch.config.ts`: pinned desktop build configuration
- `lib/github.mjs`: authentication, GitHub API, YAML schemas, input validation
- `lib/runner.mjs`: sequential execution and run tracking
- `lib/workspaces.mjs`: saved workspaces, configuration migration, global queue lock
- `public/`: dependency-free browser interface
- `test/`: unit, integration, and Playwright tests
