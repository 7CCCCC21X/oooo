export async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      cache: 'no-store',
      headers: {
        ...(init?.headers || {})
      }
    });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!response.ok) {
      const body = json ? JSON.stringify(json).slice(0, 1000) : text.slice(0, 1000);
      throw new Error(`HTTP ${response.status} ${response.statusText}: ${body}`);
    }
    return json;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchJsonWithHeaders(url: string, init?: RequestInit): Promise<{
  json: unknown;
  headers: Record<string, string>;
  status: number;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      cache: 'no-store',
      headers: { ...(init?.headers || {}) }
    });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const headers: Record<string, string> = {};
    response.headers.forEach((v, k) => {
      headers[k] = v;
    });
    if (!response.ok) {
      const body = json ? JSON.stringify(json).slice(0, 1000) : text.slice(0, 1000);
      throw new Error(`HTTP ${response.status} ${response.statusText}: ${body}`);
    }
    return { json, headers, status: response.status };
  } finally {
    clearTimeout(timeout);
  }
}
