# Rauiri — Project Plan

> Based on the [original design conversation](https://chatgpt.com/share/6a83b742-599c-83ec-ac25-d83a6a7bd9a2) and subsequent design review.

## Intention

Build a personal Chromium extension that keeps the visible browser focused on the user's current context without losing tabs from other parts of life.

Rauiri is an **attention layer over the browser**, not another general-purpose tab manager:

> As much as possible, only tabs relevant to the current context should be visible. Stale tabs should quietly leave the active context without being lost.

Reducing noise, friction, and distraction is the primary goal. Resource savings and tab organization support that goal.

The extension is personal-first. Publishing it later is possible but is not an initial priority. The primary browser and testing target is [Helium](https://helium.computer/), while using standard Chromium extension behaviour where possible.

## Safety contract

- Rauiri must not close tabs automatically in the initial product.
- Automatic actions should preserve the tab, its originating context, its URL, and supported page state.
- Automatic shelving should be silent; requiring confirmation would create more administrative work.
- Incorrect moves must be easy to reverse manually.
- All configuration and metadata remain local, with no account or automatic sync.

## Product model

### Managed window

Rauiri manages one designated normal browser window. Temporary, testing, and incognito windows remain outside the context system.

Chromium does not expose a stable identifier for an open window across browser restarts. Rauiri will therefore remember the runtime window while the browser is open, then rediscover its restored successor from the known Rauiri groups and tabs. If there is no unambiguous match, it should wait for the user to designate a window again.

Closing the managed window pauses Rauiri rather than causing another window to be adopted automatically. Restoring the window should allow management to resume.

### Contexts

The initial contexts are:

- **Personal** — green
- **Work** — red
- **Groundtruth** — orange

Contexts will ultimately have configurable names, colours, and stable ordering. Only one is active at a time. Its native tab group is expanded while inactive context groups are collapsed.

Native groups in the managed window are reserved for Rauiri contexts because Chromium does not support nested groups. Manual expanding and collapsing is allowed, but arbitrary grouping may be normalized on the next context switch or maintenance pass.

Rauiri should not continuously fight manual tab-strip changes. It restores the intended layout during explicit context switches, startup recovery, and maintenance.

### Context inheritance

A new tab receives its context in this order:

1. A strict explicit hostname rule, if one exists.
2. Otherwise, the opener tab's context.
3. Otherwise, the currently active context.
4. Manual reassignment overrides the result for that tab.

This keeps research trails together without trying to infer intent from page content. Ambiguous sites such as Reddit, X, Facebook, YouTube, and ChatGPT should not receive automatic context rules merely from observed use.

### Routing rules

Routing is strict but entirely opt-in. It is intended for unambiguous sites such as Hnry or a company control panel.

For the prototype:

- Rules match exact hostnames.
- A rule applies when a tab is created or its top-level hostname changes.
- A rule assigns the site to one context.
- A routed domain is also persistent and does not age into Read Later automatically.
- Creating a rule offers to move existing matching tabs, showing how many will be affected.
- If an active tab enters a site routed to an inactive context, Rauiri initially switches to that context with the tab. Whether this is helpful or annoying is an explicit prototype experiment.
- Background tabs move without changing the active context.

Wildcard subdomains may be added later. Path-level rules are deferred until real usage demonstrates a need.

A site used in several contexts should normally have no routing rule. ChatGPT, for example, is better represented by a global pin; tabs opened from it inherit the active context.

### Pins

Rauiri supports:

- **Global pins**, such as ChatGPT, visible in every context.
- **Context pins**, such as Hnry in Work, pinned only while their context is active.

Pinned status and context membership remain separate. Native pinning creates a context-specific pin; “Pin globally” is a separate Rauiri action. Native unpinning returns the tab to normal status in its existing context.

Pinned tabs never move to Read Later automatically.

### Read Later shelf

**Read Later is a shelf, not a context.** It is cold storage for unfinished browsing and has a fixed neutral grey identity.

- Tabs may be sent there manually.
- An hourly sweep sends eligible tabs there after approximately 12 hours without being accessed.
- Missed sweeps run when a sleeping laptop wakes, so no special overnight event is required.
- Active, audible, pinned, and strictly routed tabs are excluded from automatic shelving.
- All other ordinary tabs are archivable by default.
- There is no per-tab “keep” feature in the prototype.
- A strictly routed tab can still be sent to Read Later explicitly; that manual decision overrides routing until the tab is restored.
- Opening a Read Later tab does not restore it to an active context.
- Returning a tab to its originating context is an explicit action.
- Tabs opened from a Read Later item inherit both its originating context and its Read Later state.
- Read Later tabs that become idle again are unloaded by the hourly sweep after roughly two hours.
- Read Later has unlimited retention and never deletes tabs automatically.

When an active tab is sent to Read Later, Rauiri activates the most recently used tab in the same context, then a context pin, then a new tab if necessary.

### Page state

Initially preserve only durable, useful state:

- the normal page URL; and
- supported media state, beginning with a YouTube timestamp encoded into the URL.

Do not capture form data or generic page contents. Generic scroll restoration can be reconsidered if browser restoration proves inadequate.

### Independent concepts

These concerns should remain conceptually distinct even when the prototype combines some of them for simplicity:

- **Context:** global, Personal, Work, or Groundtruth
- **Prominence:** pinned or normal
- **Lifecycle:** persistent or archivable
- **Attention state:** current or Read Later

For the prototype, strict routing implies persistence. These can be separated later if that rule proves too coarse.

## Initial adoption

The first designated window uses a deliberately simple migration:

1. Personal becomes the initial active context.
2. All existing ordinary tabs move into Personal.
3. Existing pinned tabs become global pins by default.
4. Tabs can then be moved manually into Work, Groundtruth, or Read Later.

Do not infer initial classifications from browsing history.

## Interaction model

The initial extension popup provides:

- a dropdown for changing the current context;
- assignment of the current tab to a context;
- movement of the current tab to Read Later; and
- access to settings.

Full context, colour, ordering, and rule configuration belongs on a normal extension settings page rather than crowding the popup.

Keyboard shortcuts and a custom sidebar are deferred. Helium's native vertical-tab interface remains the main tab UI.

## Prototype scope

Build one vertical slice containing:

1. One designated managed window.
2. Personal, Work, and Groundtruth groups.
3. A popup context dropdown.
4. Parent/current-context inheritance for new tabs.
5. Global and context-specific pins.
6. Exact-host routing rules.
7. Manual movement between contexts and Read Later.
8. Hourly shelving after 12 hours idle.
9. Read Later unloading after two hours idle.
10. YouTube timestamp preservation.
11. Local persistence across ordinary browser restarts.

The prototype exists to test behaviour, not polish every recovery and configuration path.

### Deferred from the prototype

- Polished onboarding and ambiguous-window recovery
- Wildcard and path-level routing rules
- Activity history and undo
- Keyboard shortcuts
- Import/export and configuration sync
- Generic page-state or scroll restoration
- Automatic deletion from Read Later
- A custom sidebar or replacement tab strip
- Cookie or identity containers

## Prototype evaluation

Dogfood the prototype for roughly one week and evaluate:

- Does Helium's collapsed-group UI provide enough visual separation?
- Does automatic context switching for an actively routed tab help or annoy?
- Does the 12-hour sweep remove noise without hiding tabs too early?
- Is the two-hour Read Later unloading delay appropriate?
- Are global and context pins stable and predictable during switches?
- Does Read Later feel like relief rather than another backlog?
- Does the workflow naturally remain in one browser window?
- How often is a tab manually corrected after automatic classification or shelving?

These results should drive the next design round rather than adding speculative controls now.

## Future possibilities

- Separate routing from persistence if their combined prototype behaviour is too coarse.
- Add wildcard hostname rules or path-level rules where justified.
- Add recent automatic activity and “undo last move.”
- Add keyboard switching after actual usage reveals the right interaction.
- Export and import local configuration as JSON.
- If Helium implements container tabs, optionally associate contexts with isolated identities and cookies.
- Optionally archive very old Read Later items into Readeck or Linkding, then remove the browser tab only after remote archival is verified. This is retained separately as project idea `IDEA-6f2e5e5d`.

## Deliberate non-goals

- Hidden parking windows
- Managing temporary or incognito windows
- Perfect or AI-based intent classification
- Cloud accounts, collaboration, tasks, or notes
- A Workona-style productivity platform
- Separate cookies or profiles in the initial product
- Automatic tab deletion

## Related products and useful resources

### Product references

- [Arc Spaces](https://resources.arc.net/hc/en-us/articles/19228064149143-Spaces-Distinct-Browsing-Areas) — the closest conceptual model for contexts, global favourites, context pins, and tab ageing.
- [Workona](https://workona.com/) — an established benchmark previously found insufficient and too productized/expensive.
- [Tab Harbor](https://chromewebstore.google.com/detail/tab-harbor/bcnkhodiggfeabfedmpfpdmgjdgmkcma) / [source](https://github.com/itwuthe3/tab-harbor) — close prior art for spaces and pins. The original research found no repository license; do not copy code unless licensing is clarified.
- [TabRest](https://github.com/lamngockhuong/tabrest) — prior art for tab discarding and YouTube restoration, reported as MIT-licensed in the original research.
- [Tab Flow](https://github.com/monotykamary/tab-flow-chrome) — prior art for scheduled cleanup and auto-archive behaviour, reported as MIT-licensed in the original research.

Verify current features and licenses before borrowing code.

### Platform references

- [Helium](https://helium.computer/) and its [GitHub repository](https://github.com/imputnet/helium)
- [Helium vertical-tabs discussion](https://github.com/imputnet/helium/issues/239)
- [Helium extension/group restart issue](https://github.com/imputnet/helium/issues/2008)
- [Helium container-tabs request](https://github.com/imputnet/helium/issues/199)
- [Chromium Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs)
- [Chromium Tab Groups API](https://developer.chrome.com/docs/extensions/reference/api/tabGroups)
- [Chromium Alarms API](https://developer.chrome.com/docs/extensions/reference/api/alarms)
- [Chromium Windows API](https://developer.chrome.com/docs/extensions/reference/api/windows)
