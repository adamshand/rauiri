export const WORKSPACE_SWATCHES = Object.freeze({
  grey: "#8d8d88", blue: "#4c7fa8", red: "#b6514b", yellow: "#c39836", green: "#668c69",
  pink: "#b96885", purple: "#8067a0", cyan: "#3d8e94", orange: "#c47536",
});

export async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error || "Rauiri did not respond.");
  return response.result;
}

export function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Restore business-rule disabled states, not just enable everything after a task.
export function disableControls(selector = "button, input, select") {
  const previous = [...document.querySelectorAll(selector)].map((node) => [node, node.disabled]);
  for (const [node] of previous) node.disabled = true;
  return () => {
    for (const [node, disabled] of previous) if (node.isConnected) node.disabled = disabled;
  };
}
