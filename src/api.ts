const configuredApiOrigin = import.meta.env.VITE_API_BASE_URL?.trim().replace(/\/+$/, '');

/** Build an API URL for a split frontend/API deployment or same-origin local development. */
export function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return configuredApiOrigin ? `${configuredApiOrigin}${normalizedPath}` : normalizedPath;
}

/** Build the WebSocket endpoint using the API origin configured at frontend build time. */
export function apiWebSocketUrl(path: string): string {
  const url = new URL(apiUrl(path), window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}
