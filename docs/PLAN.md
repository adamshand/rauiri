# Rauiri — Scope and safety contract

Rauiri keeps browsing focused while making unfinished work easy to resume. Window workspaces are the sole supported workflow; the former group controller and its UI have been removed. See [current usage](../README.md) and [the window-only decision](adr/0002-window-workspaces-only.md).

## Product model

- Each active workspace owns a persistent normal browser window with native pinned tabs and active hostname routes.
- Put-away workspaces retain their page inventories and rules, but have no window and inactive routing.
- Switching focuses an existing window; it never closes or transfers all its tabs.
- One workspace pin stays alongside the current project. Optional minimisation affects only assigned windows.
- Numbered slots 1–9 are stable, with gaps; slot 0 is permanently Read Later. Explicit resume does not reclaim a number.
- Background filing keeps attention at the source. Following is an explicit choice or deliberate address-bar navigation.
- Names and colours save together; shortcut assignments save immediately. Fresh Settings snapshots preserve unsaved edits by workspace identity.

## Safety contract

- Putting away requires confirmation and a successful fresh, durable source inventory before closing anything.
- Native window closure retains the last complete snapshot, never a partially closed tab strip.
- Interrupted restoration retains the full inventory until missing pages have been opened successfully.
- Failed configuration writes do not become published state or get silently committed by later actions.
- Startup and browser mutations must not prevent durable Settings reads or backup exports. Cached exports disclose their freshness.
- Live merges move actual tabs rather than reopening URLs. Partial failures keep the source workspace available for review.
- Browser-internal pages, forms, navigation history and arbitrary application state are not resumable snapshots.
- Reconnection is conservative. Weak/ambiguous matches require manual attachment, and inexact matches retain a downloadable restore point.
- Configuration and metadata stay local. No account, automatic sync or browsing-history inference.

## Deliberate non-goals

- Automatic ageing, shelving or tab deletion
- Tab-group orchestration and explicitly saved tab sets
- Cookie/identity containers, cloud accounts or collaboration
- Perfect classification, generic page-state capture or a replacement browser tab strip

The key ongoing evaluation is whether switching, minimisation, routing and reconnecting feel predictable in everyday Helium/macOS use.
