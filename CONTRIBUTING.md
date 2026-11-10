# Contributing to Dispatch

Dispatch is a native Rust desktop app built with [`gpui-pre`](https://docs.rs/gpui-pre/0.3.11/gpui/). The Rust project is at the repository root. See the [README](README.md) for authentication, workspace settings, and queue behavior.

## Development setup

Install Rust 1.98 or newer and [just](https://github.com/casey/just), then run from the repository root:

```sh
just run
```

Without just:

```sh
cargo run
```

`just run` enables all features; `cargo run` uses the default desktop features.

GPUI uses the native graphics and windowing libraries for each platform. Linux builds enable Wayland and X11 and require a C/C++ toolchain, pkg-config, Fontconfig, FreeType, xkbcommon, and the corresponding development libraries. Running the desktop app requires a graphical session and a compatible graphics driver. The first build compiles GPUI and its graphics dependencies.

## Build and checks

Use the existing justfile recipes:

```sh
just build       # Build the release binary in target/release
just fmt         # Format, then run strict Clippy checks
just check       # Check formatting and run strict Clippy checks
just test        # Format, run Clippy, then run all tests
```

Clippy and tests run with all features and all targets. The Rust tests use fake GitHub data and temporary settings. They never dispatch real workflows. Linux tests also lay out and exercise the native views and queue controls using GPUI's headless platform.

Run the release packaging tests with Python:

```sh
python3 -m unittest discover -s .github/scripts -p 'test_*.py'
```

An optional visual test renders the native interface offscreen using a real GPU or software Vulkan adapter. It uses sample repositories and writes previews at desktop and compact window sizes:

```sh
DISPATCH_PREVIEW_DIR=artifacts/native cargo test --features visual-tests --bin dispatch render_desktop_previews -- --ignored
```

The UI bundles its fonts and SVG icons so typography and controls render consistently across systems.

## Source map

- `src/model.rs`: repository and branch validation, workflow inputs, run metadata and recency.
- `src/config.rs`: atomic settings writes and instance locking.
- `src/github.rs`: authentication and GitHub REST requests.
- `src/runner.rs`: preflight validation, sequential dispatch and run tracking.
- `src/service.rs`: background requests, caching and workspace commands.
- `src/ui.rs`: native workflow list, workspace drafts, input forms and queue controls.
- `src/input.rs`: native text editing, selection, clipboard and IME handling.
- `src/assets.rs`: embedded fonts and icons.
- `tests/backend.rs`: backend and queue integration tests.

## Release packaging

New version tags trigger `.github/workflows/release.yml`. The workflow sets the Cargo package version from the tag, runs checks, and builds Linux x64, Windows x64, and macOS Intel and Apple Silicon releases.

`.github/scripts/release.py` packages the binaries with licenses and supporting resources. Archives are named `dispatch-workflows-VERSION-PLATFORM`. Linux archives contain `dispatch`, Windows archives contain `dispatch.exe`, and macOS archives contain `Dispatch.app`.

After all platform builds succeed, the workflow publishes a GitHub release with the archives and `SHA256SUMS`. Stable version tags also update and publish the `dispatch-workflows-bin` AUR package using `arch/PKGBUILD`.

Before preparing a release, run `just test` and the Python packaging tests above.

## Documentation

Keep user-facing instructions in `README.md` and development instructions here. Check button labels and behavior against the app. Use defaults from the code and generic examples; do not include personal addresses, local paths, network settings, or device details.
