/* Fetch wrapper. Carries the per-run token the server requires, and surfaces the
 * server's own error message rather than a bare status code -- those messages are
 * written to be actionable, so losing them hurts */

let token = '';
let requestHandler = null;

export function setToken(t) {
  token = t || '';
}

export function setRequestHandler(handler) {
  requestHandler = handler;
}

async function request(method, path, body) {
  if (requestHandler) return requestHandler(method, path, body);

  let res;
  try {
    res = await fetch(path, {
      method,
      headers: {
        'x-reorg-token': token,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`the reorg server is not responding (${e.message}). Is it still running?`);
  }

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body: fall back to the raw text below */
  }

  if (!res.ok) {
    const msg = (json && json.error) || text.slice(0, 300) || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.payload = json;
    throw err;
  }
  return json;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b ?? {}),
  put: (p, b) => request('PUT', p, b ?? {}),
};
