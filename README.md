# GitHub CI Log Linker

A Firefox extension that surfaces failed test details directly on GitHub Actions pages, so you don't have to hunt through thousands of log lines to find out what broke.

## What it does

When you open a GitHub Actions run page, job page, or pull request, the extension fetches the raw job logs, finds every test failure, and displays them in a floating panel with the relevant log context expanded inline.

**Supported test frameworks:**

- **Behat / Cucumber** — parses the `--- Failed scenarios:` summary block and locates the matching scenario output in the log
- **PHPUnit** — parses `There were N errors/failures:` blocks and locates each numbered entry in the log

**Panel features:**

- One entry per failed test, each with an expandable log context block (ANSI colours preserved)
- Click an entry to open the job page for that run step
- Draggable header, resizable from all four corners and edges
- Minimize collapses the panel to a title bar and snaps it back to its spawn corner
- Restore returns the panel to its previous position and size
- Follows GitHub's dark / light theme automatically
- Configurable spawn corner (top-left, top-right, bottom-left, bottom-right)
- Panel is removed automatically when you navigate away

## Installation

The extension is not yet listed on addons.mozilla.org and must be loaded temporarily for development.

1. Clone or download this repository.
2. Open Firefox and navigate to `about:debugging`.
3. Click **This Firefox** in the left sidebar.
4. Click **Load Temporary Add-on…**.
5. Navigate to the repository folder and select `manifest.json`.

The extension will remain active until Firefox is restarted. Repeat from step 4 after each restart.

## Setup

A GitHub Personal Access Token is required because the GitHub API does not accept browser session cookies from the `github.com` domain when making requests to `api.github.com`.

1. Click the extension icon in the Firefox toolbar.
2. Paste your token into the **GitHub Personal Access Token** field and click **Save**.
   - Needs `public_repo` scope for public repositories.
   - Needs `repo` scope for private repositories.
   - [Create a token on GitHub ↗](https://github.com/settings/tokens/new?description=CI+Log+Linker&scopes=public_repo)
3. Optionally choose the corner where the panel should appear under **Panel spawn position**.

## Usage

Navigate to any of the following pages for a repository that uses Behat or PHPUnit in its CI:

- A pull request — `github.com/OWNER/REPO/pull/PR_NUMBER`
- An Actions run — `github.com/OWNER/REPO/actions/runs/RUN_ID`
- A specific job — `github.com/OWNER/REPO/actions/runs/RUN_ID/job/JOB_ID`

If failed tests are found the panel appears automatically. Each entry shows the test name; click **▶ Show log context** to expand the raw log output for that test.

## Permissions

| Permission | Reason |
|---|---|
| `https://github.com/*` | Read the page URL and inject the panel |
| `https://api.github.com/*` | Fetch job lists and log download URLs |
| `https://*.githubusercontent.com/*` | Download the actual raw log files (GitHub redirects log requests here) |
| `storage` | Save the Personal Access Token and spawn-position preference |
