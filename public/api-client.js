/** Small same-origin API client shared by the browser application. */
export function createApiClient({ fetchImpl = fetch, onConnectionChange = () => {} } = {}) {
  return async function request(path, { method = 'GET', body, keepalive } = {}) {
    let response;
    try {
      response = await fetchImpl(`/api${path}`, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        keepalive,
      });
    } catch {
      onConnectionChange(false);
      throw new Error('مفيش اتصال بالسيرفر');
    }

    onConnectionChange(true);
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      // Some successful endpoints do not return a JSON body.
    }
    if (!response.ok) throw new Error(payload?.error || `حصل خطأ (${response.status})`);
    return payload;
  };
}
