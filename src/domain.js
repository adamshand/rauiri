export const WORKSPACE_COLORS = Object.freeze([
  "grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange",
]);

export function cleanHostnameInput(input) {
  if (!input) return "";
  try {
    const value = String(input).trim();
    const candidate = value.includes("://") ? value : `https://${value}`;
    return new URL(candidate).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return String(input).trim().toLowerCase().replace(/\.$/, "");
  }
}

export function isValidRouteHostname(value) {
  const host = cleanHostnameInput(value);
  return Boolean(host) && host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/.test(label));
}

export function routeForUrl(routes, url) {
  if (!isRoutableUrl(url)) return null;
  const hostname = cleanHostnameInput(url);
  let match = null;
  let specificity = 0;
  for (const route of routes) {
    const host = cleanHostnameInput(route.hostname);
    if (host.length > specificity && (hostname === host || hostname.endsWith(`.${host}`))) {
      match = route;
      specificity = host.length;
    }
  }
  return match;
}

export function isRoutableUrl(url) {
  if (!url) return false;
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
