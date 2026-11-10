# Dispatch
**A native desktop app for running GitHub Actions workflows in sequence.**

Dispatch connects your GitHub repositories, inspects your workflow history, and lets you build ordered execution queues. It ensures that every workflow in your batch succeeds before the next one begins, making it perfect for complex deployment pipelines or dependent automated tasks. 

Built as a fast, native desktop application, Dispatch gives you a lightweight, responsive alternative to managing workflows directly in the browser.

---

## Key Features

*   **Sequential Workflow Queues:** Select multiple workflows to run in a specific order. If one fails, cancels, or times out, the rest of the queue is automatically halted.
*   **Dynamic Input Forms:** Automatically generates clean input forms (text, dropdowns, booleans, numbers) based on your workflow definitions. Drafts are saved per workspace.
*   **Cross-Repository Monitoring:** Dispatch checks your connected repositories for active runs before launching, helping prevent accidental overlaps or resource conflicts.
*   **Visual Recency Tracking:** Color-coded workflow names instantly show how long it's been since the last run (e.g., green for <12 hours, red for >7 days) alongside standard success/failure badges.
*   **True Native Experience:** Enjoy a smooth, fast interface without the overhead of a web browser. Dispatch supports native text editing, clipboard shortcuts, and system integrations.

---

## Getting Started

### 1. Install & Authenticate
Download the latest release for macOS, Windows, or Linux. Before opening the app, authenticate with GitHub:
*   **Option A:** Run `gh auth login --hostname github.com` in your terminal.
*   **Option B:** Provide a `GH_TOKEN` or `GITHUB_TOKEN` in your application environment.

*(Note: Dispatch requires **Actions: Write** and **Contents: Read** permissions to execute and inspect workflows on your private repositories).*

### 2. Connect Your Workspaces
Open Dispatch and click **Add workspace**. Enter your `owner/repository` name or paste the GitHub URL. You can save multiple repositories and easily switch between them using the sidebar. Each workspace remembers its preferred branch, selected workflows, and draft inputs.

### 3. Select and Run
1. Choose your target branch and click **Save branch**.
2. Search and select your workflows. Enable **Allow multiple workflows** to build a sequential queue.
3. Click **Options** to fill in any required inputs for your workflows.
4. Click **Run**. Dispatch will validate everything and launch your queue!

---

## How the Queue Works

*   **Strict Execution Order:** Workflows run exactly in the order you selected them. 
*   **Smart Halting:** A failure, cancellation, or unexpected error instantly stops the batch. Dispatch does not automatically retry failed workflows.
*   **Safety First:** You can use the **Stop after current workflow** button to let an active job finish while discarding the rest of the queue. *(Note: This does not cancel jobs that are already running on GitHub).*
*   **Keep the App Open:** Dispatch monitors your workflows in real-time by polling GitHub. Keep the application running while your queue executes. Closing the app will stop monitoring (though your already-dispatched GitHub jobs will continue running).

---

## Workspace & App Settings

*   **Branch Management:** Your preferred branches and workflow inputs are saved locally as drafts. 
*   **Workspace Management:** Add or remove repositories via **Workspace settings**. Changes to your saved workspaces will automatically wait until your current queue finishes running.
*   **Data & Privacy:** Credentials are read at startup and kept securely in memory—they are never written to your local workspace settings.

---

### System Requirements
*   **OS:** macOS (Intel & Apple Silicon), Windows (x64), and Linux (x64).
*   **GitHub:** Supports standard GitHub.com repositories (GitHub Enterprise Server is not currently supported).
*   **Network:** Requires an active internet connection to communicate with the GitHub API.
