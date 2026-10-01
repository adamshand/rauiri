// Reconcile by identity, not list position. Only locally edited fields override
// a fresh snapshot; deleted workspaces disappear and new ones get fresh drafts.
export function reconcileWorkspaceDrafts(drafts, previous, latest) {
  const oldById = new Map(previous.map((workspace) => [workspace.id, workspace]));
  const draftById = new Map(drafts.map((workspace) => [workspace.id, workspace]));
  return latest.map((workspace) => {
    const old = oldById.get(workspace.id);
    const draft = draftById.get(workspace.id);
    if (!old || !draft) return { ...workspace };
    return {
      ...workspace,
      title: draft.title !== old.title ? draft.title : workspace.title,
      color: draft.color !== old.color ? draft.color : workspace.color,
    };
  });
}
