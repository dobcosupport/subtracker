export function adminFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, init);
}
