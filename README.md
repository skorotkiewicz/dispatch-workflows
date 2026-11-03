# Dispatch

**A simple, beautiful desktop and web app for manually running your GitHub Actions workflows.**

Tired of clicking through GitHub's menus just to trigger a workflow? Dispatch is a local GUI that lets you save your repositories, check the latest status of your workflows, and trigger new runs with a single click. You can even build an ordered batch of workflows, and Dispatch will automatically run them one after the other!

For development, testing, packaging, and release instructions, see [CONTRIBUTING.md](CONTRIBUTING.md).

<p align="center">
  <img src="desktop.png" alt="Dispatch desktop interface for running GitHub Actions workflows" width="80%">
</p>

---

## Key Features

*   **One-Click Runs:** Trigger `workflow_dispatch` actions instantly without leaving your desktop.
*   **Smart Sequential Queues:** Select multiple workflows and queue them up. Dispatch ensures the next workflow only starts after the previous one succeeds.
*   **Multi-Workspace:** Save multiple repositories and switch between them effortlessly.
*   **Visual Status Indicators:** Instantly see how recently a workflow was run using intuitive color-coded names, alongside clear success/failure badges.
*   **Auto-Generated Forms:** Dispatch reads your workflow's YAML file and automatically creates input forms for variables, choices, and environments.
*   **Cross-Platform:** Use it right in your web browser or install the lightweight, native desktop app for macOS, Windows, and Linux.

---

## Installation & Getting Started

You can use Dispatch in two ways: as a **Native Desktop App** or directly in your **Web Browser**.

### Option 1: The Desktop App (Recommended)
The easiest way to use Dispatch is by downloading the native desktop app. It runs smoothly in the background without needing to keep a terminal window open.

1. Go to the [Releases page](https://github.com/skorotkiewicz/dispatch-workflows/releases).
2. Download the installer for your operating system (macOS, Windows, or Linux).
3. Install and launch the app!

#### Arch Linux (AUR)

On Arch Linux x86_64, install [dispatch-workflows-bin](https://aur.archlinux.org/packages/dispatch-workflows-bin) with your AUR helper:

```sh
yay -S dispatch-workflows-bin
```

### Option 2: Web Browser Mode
If you prefer running it locally via Node.js:

1. Ensure you have **Node.js 22** (or newer) installed.
2. Open your terminal in the project folder and run:
   ```sh
   npm install
   npm start
   ```
3. Open your browser and go to **http://127.0.0.1:3000**.

---

## Connecting to GitHub

Before you can run workflows, Dispatch needs permission to communicate with your GitHub account.

1. **Authenticate:** Open your terminal and log in using the official GitHub CLI:
   ```sh
   gh auth login --hostname github.com
   ```
   Alternatively, set `GH_TOKEN` or `GITHUB_TOKEN` in Dispatch's process environment. If you export a token in a terminal, launch Dispatch from that same terminal. Desktop shortcuts use the desktop session's environment.
2. **Restart Dispatch** (if it was already running) so it can detect your login.
3. In the Dispatch app, click **Connect a repository** and enter your repository URL (e.g., `owner/repository`).

> **Note:** Your GitHub account needs permission to run workflows. If you are using a fine-grained personal access token, ensure it has **Actions (Read & Write)**, **Contents (Read)**, and **Metadata (Read)** permissions.

---

## How to Use Dispatch

### Managing Workspaces
*   **Add Repositories:** Click **+ Add workspace** to save another repository. You can easily switch between them using the sidebar selector.
*   **Independent Drafts:** Filters, selections, and input drafts stay separate while you switch workspaces in the current tab. Reloading clears these drafts; saved branch preferences persist.
*   **Global Queue:** Only **one queue can run at a time** across all your saved repositories. You can safely browse other workspaces while a queue is running in the background.

### Running Workflows
1. Find the workflow you want to run in your list.
2. Click the **Play** button for a quick single run, or select it and click **Run workflow**.
3. **Queue Multiple Runs:** Check the **Allow multiple workflows** box to select a batch. Use the queue's up/down arrows to set the exact order you want them to execute.
4. **Fill in Inputs:** If the workflow requires inputs, Dispatch will automatically prompt you with a clean form based on your workflow's YAML configuration.

### Understanding the Dashboard
*   **Recency Colors:** Workflow names change color based on how recently they were run to help you spot stale workflows at a glance:
    *   **Green:** Run less than 12 hours ago
    *   **Dark Yellow:** Run 12–24 hours ago
    *   **Neutral:** Run 1–7 days ago
    *   **Red:** Run more than 7 days ago
    *   **Gray:** Never run
*   **Latest Activity:** Quickly see the result, branch, and duration of the most recent run. Click the timestamp to jump directly to the run on GitHub.

---

## Safe & Reliable Queues

*   **Runs Locally:** The queue is managed by the Dispatch app on your computer. You can safely close or refresh your browser tab, and the queue will keep running. Just keep the Dispatch app open!
*   **Strictly Sequential:** Workflows in a batch will only run one after the other. If a workflow fails, is canceled, or times out, the batch stops immediately to prevent cascading errors.
*   **No Overlapping:** Dispatch prevents you from accidentally starting multiple batches at the same time, even across different browser tabs.
*   **Manual Cancellations:** If you click **Stop after current workflow**, it prevents *pending* workflows from starting. To cancel a workflow that is *already actively running* on GitHub, you will need to cancel it directly on GitHub's website.

---
*Dispatch is designed to be a safe, local companion for your GitHub Actions. Happy automating!*
