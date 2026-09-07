# Keep each live workspace in its own browser window

Rauiri's goal is to resume ongoing work without showing unrelated tabs. Chromium cannot hide arbitrary tabs, and using collapsed groups as both filing and focus controls led to repeated browser-event conflicts. We use one persistent window per live workspace: switching focuses that window and can minimise the other managed windows, without moving or recreating its tabs. Native pins consequently belong to each workspace.

A shared storage window was considered, but it requires tab transfers on every switch. Save-and-close switching was rejected because URL snapshots cannot reliably preserve unfinished forms or application state. Explicit cold storage is a later feature, not part of ordinary switching. Window workspaces are opt-in while the new workflow is being tested; enabling them retains a legacy backup and moves live tabs rather than reloading them.

Window IDs are session-local. After browser restart, only unique exact URL signatures are automatically reattached; ambiguous cases require user assignment. This is intentionally conservative to avoid claiming unrelated browser windows.
