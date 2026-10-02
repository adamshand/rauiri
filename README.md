<img src="assets/icon-128.png" alt="Rauiri icon" width="96" align="right">

# Rauiri

A personal Chromium extension for focused browsing and resumable work. Designed for Helium, using standard Chromium APIs. Each workspace owns a persistent browser window; switching never closes or recreates its tabs.

## Load the extension

1. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**.
2. Select this repository and pin Rauiri’s icon to the toolbar.
3. Open the popup. On a fresh installation, the focused normal window becomes **Personal**, preserving its tabs and native pins. Work, Groundtruth and Read Later are also available.

Existing window-workspace configuration loads unchanged. The former tab-group workflow, automatic shelving, saved tab sets and group-backup support have been removed.

## Everyday use

- **Switch** focuses an existing workspace window. Put-away workspaces are resumed from their saved URLs and native pins.
- **+** in the popup creates a new workspace and window.
- Search includes active and put-away workspaces. **Enter** switches to the first available result; **Arrow Down** enters the results.
- **Move tab to** files the current tab without following it. A local fallback keeps your attention in the source window. Choosing a put-away destination resumes it first.
- Pin **one workspace** to keep it alongside the project you’re using. Pinning another replaces it and switches to its window. Closing or putting away the pinned workspace clears the pin.
- Settings edits names and colours. Numbered shortcut assignments save immediately; choosing an occupied number swaps its occupants.

An **active workspace** has an open window and enabled routing rules, even when minimised. A **put-away workspace** retains its pages and rules but has no window and inactive rules. There is no automatic age-based shelving or closure.

### Focus and geometry

With **Minimise other workspaces when switching** enabled, Rauiri keeps the selected workspace and pin visible, leaving unrelated windows alone. Visiting the pin also keeps your most recently used visible project; it does not reopen one you minimised or closed.

Project-to-project switches copy the outgoing normal window’s position and size. From the pin, they use the visible project’s geometry or the last remembered project bounds. The pin, maximised/full-screen windows and manually selected windows are not resized. Native window switching follows the same minimisation rules but never copies geometry.

### Routing

Hostname rules include subdomains, with the most specific active rule winning. `example.com → Work` includes `app.example.com`, unless a more specific rule overrides it. Lookalikes such as `notexample.com` do not match. Wildcards are unnecessary and not accepted.

- Address-bar navigation routes **and follows** when the tab is foreground in the focused window.
- Other navigation files quietly unless the rule enables following. Background tabs and unfocused windows never initiate focus switches.
- Pinned tabs are never automatically routed.
- Manual filing lasts until the URL changes or you deliberately navigate from the address bar, including across worker restarts.
- Rules for put-away workspaces are inactive. A URL never resumes one; a broader active rule may still match.
- **Move existing matches** stays in the background and preserves manual assignments.

## Put away, delete or merge

**Put away** in Settings requires confirmation and a successful fresh snapshot before closing its window. Only HTTP(S) URLs, titles, order and native pins are remembered—not forms, internal pages, navigation history or full application state. Save unfinished work first. Native window closure preserves the last complete captured inventory.

The × button opens a deletion/merge dialog:

- Active workspace: move its live tabs and rules to another workspace without reloading. A put-away destination is resumed.
- Put-away workspace: independently move or discard its remembered tabs and rules. Moving pages to an active destination opens them; a put-away destination stays put away.
- Failed live merges retain the source for review; already moved tabs remain at the destination.
- Read Later cannot be renamed, put away, deleted or merged away.

## Keyboard switching

`Alt` is Option on macOS:

- **Alt+Shift+Space**: popup with search focused.
- **Alt+Shift+P**: previous active workspace, including native window switches.
- **Alt+1 / +2**: workspace in shortcut slot 1/2.

Bind slots **3–9 and 0** through **Settings → Workspace window options → Change bindings**. Chromium permits only four default assignments. Empty slots do nothing. Putting away, closing or deleting a workspace clears only its slot; creating or explicitly resuming one leaves it unnumbered. Native browser-session restoration can restore its previous number when the window reconnects.

**Slot 0 always opens Read Later.** Closing it manually recreates its window in the background from remembered pages. Rauiri waits for batches of closing windows and does not create it when no normal non-private windows remain, to avoid fighting browser shutdown.

## Restart and recovery

Session storage retains window associations across worker restarts. Browser restart or extension reload clears those IDs, so Rauiri reconnects by URL overlap: at least half, with the workspace and window each being the other’s clear best match. Ties remain unassigned. An interrupted Rauiri restore keeps its full inventory and resumes only missing pages.

Windows arriving later can relink when they have at least two web pages, so a single torn-off tab cannot claim a workspace through the delayed reconnect path. Don’t resume an apparently put-away workspace while the browser is still restoring it. If matching is ambiguous, open the popup in the restored window and choose **Use this window**.

## Backups

- Full backups include remembered workspace URLs, pins and routing overrides. Keep them private: URLs can contain client details or access tokens.
- Configuration-only backups exclude all saved page lists, including retained attach inventories.
- Full exports capture current windows when the browser is idle. If startup, an operation, a read failure or a snapshot timeout prevents this, the export explicitly reports that it uses saved state. Settings and exports do not depend on browser startup completing.
- Import validates before replacement. Put away all workspaces except Read Later first. Its live tabs are preserved and missing imported reading URLs are opened. Other imported workspaces stay put away and unnumbered.
- Restore points cover the last import, deletion/merge, inexact reconnect and manual attachment. Download them from Settings before another operation replaces the relevant point.
- Existing window-workspace backups remain supported; unrelated historical fields are ignored. Old group-format backups are not supported.

A permanently unresponsive browser API can still require reloading the extension. Minimise and focus behavior should continue to be dogfooded in Helium/macOS.

## Development

Browser-native JavaScript modules; no build step or runtime dependencies. Playwright is a development-only dependency for browser tests.

```sh
npm ci
npm run hooks:install
npm test                  # Fast controller/message/event tests
npm run check
npx playwright install chromium  # Once, for browser tests
npm run test:browser      # Real Chromium popup/Settings and MV3 worker tests
npm run test:all          # Both suites
```

Browser tests use disposable extension copies and profiles, plus a local HTTP server; they never touch your installed extension or browser profile. Chrome API fault injection covers startup stalls and failed saves while the UI and controller remain real. Failure traces are saved under `test-results/`. These tests cover behavior, not a line-coverage target; the create/save/remove regressions were also checked against deliberately broken implementations.

The pre-commit hook patch-bumps `manifest.json` and `package.json` together for extension changes. After changes, reload Rauiri in `chrome://extensions` and reopen its popup/Settings.

- [`src/window-workspaces.js`](src/window-workspaces.js) — window ownership, routing, persistence and backups
- [`src/background.js`](src/background.js) — trusted message boundary
- [`src/domain.js`](src/domain.js) — hostname matching, URL validation and workspace colours
- [`src/workspace-drafts.js`](src/workspace-drafts.js) — reconciliation of unsaved Settings edits
- [`CONTEXT.md`](CONTEXT.md) — product vocabulary
- [`docs/PLAN.md`](docs/PLAN.md) — scope and safety contract
- [`docs/adr/`](docs/adr/) — architectural decisions
