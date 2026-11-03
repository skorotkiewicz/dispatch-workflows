# https://github.com/casey/just

set shell := ["bash", "-euo", "pipefail", "-c"]
set positional-arguments

[private]
default:
    @just --list

# Install the dependencies recorded in package-lock.json.
install:
    npm ci

# Build the Electrobun release for the current platform.
build:
    npm run desktop:build

# Run the browser interface.
run:
    npm start

# Restart the browser server when source files change.
dev:
    npm run dev

# Build and launch the native desktop app.
desktop:
    npm run desktop

# Rebuild and relaunch the desktop app when source files change.
desktop-dev:
    npm run desktop:dev

# Format this justfile.
fmt:
    just --fmt

# Check JavaScript syntax without starting the application.
syntax:
    #!/usr/bin/env bash
    set -euo pipefail
    for file in server.mjs lib/*.mjs desktop/*.mjs public/*.js public/*.mjs test/*.mjs test/network/*.mjs test/support/*.mjs test/browser/*.js; do
        node --check "$file"
    done

# Validate the GitHub release workflow. Requires Go.
actionlint:
    GOCACHE=/tmp/dispatch-actionlint-cache GOMODCACHE=/tmp/dispatch-actionlint-modules go run github.com/rhysd/actionlint/cmd/actionlint@latest .github/workflows/release.yml

# Check source syntax, workflow validity, and justfile formatting.
check: syntax actionlint
    just --fmt --check

# Run unit, backend, and desktop lifecycle tests.
test:
    npm test

# Run the Playwright browser suite.
test-ui:
    npm run test:ui

# Build and test the packaged Linux desktop app in a graphical session.
test-desktop: build
    npm run test:desktop

# Also verify real GitHub HTTPS without credentials or workflow dispatches.
test-desktop-github: build
    npm run test:desktop:github

# Run static checks and backend tests.
vet: check test

install-hook:
    @printf '#!/bin/sh\nset -e\njust check\n' > .git/hooks/pre-commit
    @chmod +x .git/hooks/pre-commit

remove-hook:
    @rm .git/hooks/pre-commit

# Create and push a release tag; defaults to the version in package.json.
add-tag VERSION="":
    #!/usr/bin/env bash
    set -euo pipefail
    version="${1:-$(node -p "require('./package.json').version")}"
    tag="v${version#v}"
    git tag -a "$tag" -m "Release $tag"
    git push origin "refs/tags/$tag"

# `just remove-tag v0.0.0` or `just remove-tag` (uses fzf)
remove-tag VERSION="":
    #!/usr/bin/env bash
    set -euo pipefail
    tag="$1"
    [ -z "$tag" ] && tag=$(git tag --sort=version:refname | fzf --prompt="Select tag to remove: ")
    [ -z "$tag" ] && echo "No tag selected" && exit 1
    git tag -d "$tag"
    git push --delete origin "refs/tags/$tag"

# Undo last commit locally and on remote, keeping changes staged.
undo-commit:
    #!/usr/bin/env bash
    set -euo pipefail

    upstream=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}')
    remote="${upstream%%/*}"
    branch="${upstream#*/}"

    git reset --soft HEAD~1
    git push --force-with-lease "$remote" "HEAD:$branch"
