<img src="assets/icon-128.png" alt="Rauiri icon" width="96" align="right">

# Rauiri

A personal Chromium extension for focused browsing and resumable client work. Designed for [Helium](https://helium.computer/), using standard Chromium APIs.

## Load the extension

1. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**.
2. Select this repository and pin Rauiri’s extension icon to the toolbar.
3. Open the popup in the browser window you want to manage.

## Live workspace windows — experimental

In the popup, expand **Try workspace windows** and choose **Use workspace windows**. Migration is explicit: existing grouped tabs move into separate windows without being reloaded or closed. Native pinned tabs remain in the original window. Your old configuration and recovery records are retained; download the original group backup from Settings.

Each workspace has its own live browser window and its own native pins. The searchable popup lists current, live, and closed workspaces:

- **Switch** focuses the existing window without recreating tabs. Project-to-project switches copy the outgoing normal window’s position and size. From the pinned base, they use the last live project’s geometry instead. The pinned base, maximised/full-screen windows, and manually selected windows are not resized; when switching from the pinned base with no visible project, Rauiri uses the last remembered project geometry (retained within the browser session). If no geometry is available, the destination keeps its own.
- **New workspace** creates a separate window for a client, project, or personal area.
- Tab URLs, order, titles, and pinning are remembered automatically. No repeated Save action.
- **File this tab without following** moves it in the background, keeping the source window alive and activating a local fallback when necessary.
- Pin **one workspace** from the popup to keep it alongside the one you’re using. Pin Personal for evening browsing, then pin Haume for work: the new pin replaces the old one and switches to its window. Click the selected pin again to clear it. Pinning a closed workspace explicitly resumes it; ordinary switching never reopens a manually closed pinned window.
- When **Minimise other workspace windows** is enabled in Settings, only the pinned and selected workspace windows are kept visible by Rauiri. Swapping the pin minimises the old base along with other inactive workspaces. Unrelated windows are never minimised; pins are not always-on-top. Numbered shortcuts keep their existing order.
- Selecting or restoring a managed window through macOS follows the same switching rules as Rauiri’s hotkeys. Visiting the pinned base keeps your most recently used visible project alongside it; it does not reopen a project you manually minimised or closed. Unrelated windows and stale focus events are ignored.
- The old **Keep available** preference migrates to this single pin. If several workspaces were exempt, the first in shortcut order becomes the pin; no tabs are moved or closed by this preference migration.
- Address-bar navigation routes **and follows** when the tab is still foreground. Other navigation files quietly unless the rule enables following. Explicit filing and **Move existing matches** always stay in the background, even for follow rules. Background tabs and unfocused windows never initiate a focus switch.
- Routing waits for top-level navigation metadata from Chromium’s `webNavigation` API (a new extension permission), rather than guessing from tab creation/history. Address-bar qualifiers and typed transitions identify deliberate visits; Helium’s reporting still needs real-world verification.
- Hostname rules include the hostname itself and all its subdomains; the most specific hostname wins. For example, `haume.nz → Work` includes `musi.haume.nz`, unless `musi.haume.nz → Personal` overrides it (including its own subdomains). Wildcards are unnecessary and not accepted. Matching respects dot boundaries, so `nothaume.nz` does not match `haume.nz`. Native pins are never automatically routed. Manual assignment lasts until the URL changes or you deliberately navigate from the address bar.

This is a live-window prototype, not automatic cold storage. **Switching never closes tabs.** If you close a whole workspace window through the browser, Rauiri retains its last captured web URLs and pinning for explicit resumption. This is not a guarantee of unsaved forms, application state, history, or a complete browser session. Browser memory management can still unload tabs.

### Keyboard switching

Default shortcuts (`Alt` is Option on macOS):

- **Option/Alt+Shift+Space**: open the popup with search focused. Type, then Enter to switch to the first available result; Arrow Down enters the results.
- **Option/Alt+Shift+P**: toggle back to the previous workspace, including switches made using native window controls.
- **Option/Alt+1 / +2**: switch to the first/second workspace.

Commands for slots **3–10** are also available: assign Option/Alt+3 through +9 and +0 in **Settings → Configure keyboard shortcuts** (`chrome://extensions/shortcuts`). Chromium permits only four default assignments and does not support backtick as an extension command key. OS/browser conflicts may require rebinding defaults there too.

Slot numbers follow **Workspace names & order** in Settings, independent of the popup’s recent-first sorting. Previous/recent history survives service-worker restarts within the browser session. Shortcuts other than opening the popup are inactive in legacy group mode.

### Restart and recovery

Runtime window associations are stored in session storage. After a browser restart, Rauiri reconnects only unique exact sets of saved web URLs. It does not loosely guess ownership from one overlapping page. If automatic matching is ambiguous or restoration is incomplete, open the popup in the restored window and choose **Use this window** for its workspace. The previous tab list is retained in the full backup as `savedBeforeAttach`.

Do not resume a closed-looking workspace if the browser is still restoring it—wait or attach the restored window instead. The prototype has no automatic tab-closing, workspace deletion, or "put away" action yet.

### Backups

- Full window-workspace backups include saved URLs, pins, routes, and legacy recovery data. URLs can contain private client information or access tokens; keep these files private.
- Configuration-only backups retain workspace names and rules but omit all saved page lists and legacy records.
- Import validates first. Existing assigned workspace windows must be closed before replacement; importing does not open or close tabs. Fresh installations can import window-workspace backups directly.
- Settings offers a pre-import backup and the original group-mode backup. The legacy Recovery panel is hidden in window mode; its records remain in the original/full backups.
- Only HTTP(S) pages are saved for resumption. Browser-internal pages, extension pages, forms, and navigation history are not session backups.

### Current limitations

- Workspace names appear in Rauiri, not as custom OS window titles.
- There is no nested workspace hierarchy yet; naming and search keep the list manageable.
- Automatic Read Later/Inactive sweeping is paused in window mode. Existing shelves become named workspaces so their live tabs are preserved.
- A timed-out browser edit is not replayed. Mutations wait for its result; Settings and exports remain accessible. A permanently unresponsive browser API can still require reloading the extension.
- Minimise and focus behavior has been smoke-tested in Chromium; Helium/macOS dogfooding remains important.

## Original group mode

Until you enable window workspaces, Rauiri keeps the original single-window workflow:

- **Manage this window** puts ordinary tabs in Personal and preserves existing recovery records.
- Broad buckets use accordion tab groups. **Move this tab…** files the current tab elsewhere.
- Native pins are global within that one window.
- **Client & project tab sets** are explicit saved URL snapshots, not live workspaces.
- Automatic shelving sends eligible tabs to Inactive after 72 idle hours. Read Later is intentional reading; both shelves unload idle tabs after two hours. Active, audible, pinned, and strictly routed tabs are excluded from automatic shelving.
- Settings includes backup import/export and missing-page Recovery. Rauiri never closes tabs automatically.

Window mode disables the old group controller rather than running both systems concurrently. The original state is retained separately; migration does not automatically rewrite or delete it.

## Development

Browser-native JavaScript modules; no build step.

```sh
npm run hooks:install
npm test
npm run check
```

The tracked pre-commit hook patch-bumps `manifest.json` and `package.json` together for extension changes. After changing files, reload Rauiri in `chrome://extensions`.

## Project files

- [`src/window-workspaces.js`](src/window-workspaces.js) — live-window ownership, tracking, routing, and backup boundary
- [`src/background.js`](src/background.js) — message dispatch and legacy group orchestration
- [`src/domain.js`](src/domain.js) — legacy classification, lifecycle, and backup rules
- [`popup/`](popup/) — workspace switcher and tab actions
- [`options/`](options/) — workspace names, routes, preferences, and backups
- [`test/`](test/) — domain and mocked-browser regression tests
- [`CONTEXT.md`](CONTEXT.md) — product vocabulary
- [`docs/adr/0001-live-workspace-windows.md`](docs/adr/0001-live-workspace-windows.md) — why live workspaces use separate windows
- [`docs/PLAN.md`](docs/PLAN.md) — original group prototype and subsequent direction
