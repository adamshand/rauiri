# Use window workspaces as the only runtime

All actively used profiles have migrated to workspace windows, so we remove the original tab-group controller, its UI, shelving and record model instead of maintaining two competing workflows. Existing window-workspace state and backups remain usable, but group-mode migration and group-format backups are no longer supported; fresh installations start directly with window workspaces. This reduces runtime ownership to one controller and removes the tabGroups, scripting, alarms and YouTube host permissions.

Durable Settings reads and backup exports are independent of browser reconnection. Full exports refresh idle browser windows when possible and explicitly identify cached inventories otherwise; destructive closes require a successful fresh source snapshot. Keeping a last-successful checkpoint prevents failed configuration writes from being published or carried into later saves.
