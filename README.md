# Dispatch

A native Rust desktop app for running GitHub Actions workflows, built with [`gpui-pre`](https://docs.rs/gpui-pre/0.3.9/gpui/). Connect repository workspaces, inspect the latest run of each workflow, and dispatch an ordered queue. Each workflow must succeed before the next one starts.

The desktop implementation lives in `dispatch-rs`. It talks directly to GitHub.

## Run

Install Rust 1.98 or newer and [just](https://github.com/casey/just), then run the existing recipes from the Rust project:

```sh
cd dispatch-rs
just run
```

Without just:

```sh
cargo run --manifest-path dispatch-rs/Cargo.toml
```

GPUI uses the native graphics and windowing libraries for each platform. Linux builds enable Wayland and X11 and require a C/C++ toolchain, pkg-config, Fontconfig, FreeType, xkbcommon, and the corresponding development libraries. Running the desktop app requires a graphical session and a compatible graphics driver. The first build compiles GPUI and its graphics dependencies.

```sh
cd dispatch-rs
just build       # Release binary in target/release/dispatch
just fmt         # Format, then run strict Clippy checks
just check       # Check formatting and run strict Clippy checks
just test        # Check formatting, run Clippy, then run all tests
```

## Releases

Version tags build the native Rust app for Linux x64, Windows x64, and macOS Intel and Apple Silicon. Releases contain `dispatch-workflows-VERSION-PLATFORM` archives and `SHA256SUMS`. Linux archives contain the `dispatch` executable, Windows archives contain `dispatch.exe`, and macOS archives contain `Dispatch.app`.

The stable `dispatch-workflows-bin` AUR package installs the Linux release as `dispatch-workflows`, together with its desktop entry, icon, and licenses. Release packaging checks can be run with `python3 -m unittest discover -s .github/scripts -p 'test_*.py'`.

## Connect GitHub

Authenticate before opening Dispatch:

```sh
gh auth login --hostname github.com
```

Alternatively, provide `GH_TOKEN` or `GITHUB_TOKEN` in the application environment. Dispatch reads credentials at startup and keeps them in memory. Credentials are never written to workspace settings. Restart the app after changing authentication.

Click **Add workspace**, enter `owner/repository` or its `https://github.com` URL, and connect. Private repositories require authentication. Running workflows requires Actions write access and Contents read access. Only GitHub.com is supported.

## Workspaces and run options

- Switch saved repositories using the sidebar. Each workspace keeps its branch, selection, search, filters, and input drafts separate.
- The branch must exist in the repository. Click **Save branch** to validate and persist a branch preference.
- Select one workflow, or enable **Allow multiple workflows** to build a batch. Selection order is execution order. Use the queue controls to reorder or remove items.
- Click **Options** to prepare branch-specific inputs. Clicking **Run** walks through the selected workflows' input forms before launching. String, boolean, number, choice, and environment inputs are supported, including required values and defaults.
- Dispatch validates every selected workflow and input before sending the first dispatch. Workflows must be active and support `workflow_dispatch`. Dispatch also checks the repository's default branch when running a different branch.
- Workflow name colors show recency, separately from the result badge. Green means less than 12 hours, yellow means 12–24 hours, gray means 1–7 days, and red means more than 7 days. Workflows without a run are labeled **Never run**.
- Search matches workflow names and paths. The filter and sort buttons cycle through their available modes. **Latest activity** lists the latest run of each workflow, newest first.
- Run timestamps and execution links open the corresponding run on GitHub.
- **Workspace settings** removes saved workspaces locally. Workspace additions and removals wait until the running queue finishes.

## Queue behavior

One queue runs at a time across saved workspaces. Dispatch checks other saved repositories for active runs before launch and again before each dispatch. It waits for active runs in the target repository before starting the next selected workflow.

A failure, cancellation, non-successful conclusion, monitoring error, or uncertain dispatch response stops the batch and skips pending workflows. Dispatch never automatically retries a workflow dispatch. A dispatch must return a valid workflow run ID. Missing IDs or mismatched run details also stop the batch; Dispatch monitors only the ID returned by its dispatch request.

**Stop after current workflow** keeps monitoring a workflow already dispatched and skips pending items. It does not cancel runs on GitHub. Keep Dispatch open while a queue runs. Closing the window during execution asks before quitting. Quitting discards the queue and stops monitoring; already dispatched GitHub runs continue. Queues are held in memory and never resume automatically.

The idle wait limit is 30 minutes and monitoring is 24 hours. Monitoring polls GitHub every 10 seconds. Workflow metadata is cached for at least 30 seconds, or 3 seconds per workflow for larger repositories. **Refresh** bypasses that cache.

Exclusivity is best effort because GitHub provides no atomic repository-wide dispatch lock. Other callers can start runs between checks. Use GitHub Actions `concurrency` when exclusivity must cover every caller. A file lock prevents two native Dispatch instances from sharing one configuration directory.

## Settings

Native workspace settings use version 2 JSON. The desktop app saves `config.json` in the operating system's application configuration directory for `dispatch`. Set `DATA_DIR` to choose a different configuration directory. `GITHUB_REPO=owner/repository` bootstraps a workspace only when there is no saved configuration.

Dispatch reads only its configured settings file. Invalid or unsupported settings produce an error and are not overwritten.

## Verification and source map

The Rust tests use fake GitHub data and temporary settings. They never dispatch real workflows. Linux tests also lay out and exercise the native views and queue controls using GPUI's headless platform.

An optional visual test renders the native interface offscreen using a real GPU or software Vulkan adapter. It uses sample repositories and writes previews at desktop and compact window sizes:

```sh
cd dispatch-rs
DISPATCH_PREVIEW_DIR=../artifacts/native cargo test --features visual-tests --bin dispatch render_desktop_previews -- --ignored
```

The UI bundles its fonts and SVG icons so typography and controls render consistently across systems.

- `dispatch-rs/src/model.rs`: repository and branch validation, workflow inputs, run metadata and recency.
- `dispatch-rs/src/config.rs`: atomic settings writes and instance locking.
- `dispatch-rs/src/github.rs`: authentication and GitHub REST requests.
- `dispatch-rs/src/runner.rs`: preflight validation, sequential dispatch and run tracking.
- `dispatch-rs/src/service.rs`: background requests, caching and workspace commands.
- `dispatch-rs/src/ui.rs`: native workflow list, workspace drafts, input forms and queue controls.
- `dispatch-rs/src/input.rs`: native text editing, selection, clipboard and IME handling.
