# Rauiri

Rauiri is a personal Chromium extension that keeps one browser window focused by context. Inactive contexts collapse into native tab groups; stale browsing settles into a cold Read Later shelf without being closed.

The prototype is designed for [Helium](https://helium.computer/) and should also load in Chromium browsers supporting the Chrome 121 extension APIs.

## Load the prototype in Helium

1. Open `chrome://extensions` in Helium.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select this repository directory.
5. Pin Rauiri’s extension icon to the toolbar.
6. Open the icon in the browser window you want Rauiri to own.
7. Choose **Manage this window**.

Adoption intentionally puts every ordinary tab in **Personal** and treats existing pinned tabs as global pins. Temporary and incognito windows are ignored.

## First-use workflow

- Change context from the dropdown in the extension popup, or expand a context group in the tab strip. Context groups behave like an accordion.
- Assign the current tab to a different context from **Belongs to**.
- Choose whether a tab is unpinned, kept at the front of its context group, or pinned everywhere.
- Send unfinished browsing to **Read Later** from the popup.
- Open **Settings** to rename/recolour contexts, create exact-host or `*.example.com` routing rules, or tune lifecycle delays.

Strict routes are intended only for sites that always belong to one context. Wildcards match subdomains at any depth but not the apex hostname; exact routes take priority. A routed hostname is also protected from automatic shelving. Ambiguous sites should inherit from their opener or the current context instead.

## Automatic lifecycle

Once per hour Rauiri:

- moves eligible ordinary tabs to Read Later after 12 hours idle;
- leaves active, audible, pinned, and strictly routed tabs alone; and
- unloads Read Later tabs after another 2 hours idle.

YouTube playback position is written into the URL before shelving or unloading when the page permits it. Rauiri never closes tabs automatically.

## Prototype caveats

- Native tab groups in the managed window are reserved for contexts.
- Active navigation into a strictly routed hostname switches to that hostname’s context. This is intentionally experimental.
- Managed-window recovery uses the distinctive Rauiri groups and known tabs because Chromium does not provide stable window IDs across restarts.
- The prototype has no activity history or undo yet; incorrectly shelved tabs can be returned from Read Later manually.
- All state is stored locally through Chromium extension storage.

## Development

The extension uses browser-native JavaScript modules and has no build step.

```sh
npm test
npm run check
```

After changing extension files, return to `chrome://extensions` and reload Rauiri.

## Project files

- [`docs/PLAN.md`](docs/PLAN.md) — product intent and prototype contract
- [`src/background.js`](src/background.js) — browser orchestration and persistence
- [`src/domain.js`](src/domain.js) — testable classification and lifecycle rules
- [`popup/`](popup/) — context and current-tab controls
- [`options/`](options/) — contexts, routes, and lifecycle settings
- [`test/`](test/) — domain tests
