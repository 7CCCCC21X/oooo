import { envNumber } from './env';
import { acquirePredictSlot, isPredictApiUrl, notePredictRateLimited } from './predict-limiter';

const TIMEOUT_MS = 20_000;

async function rawFetch(url: string, init?: RequestInit): Promise<{ response: Response; text: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      cache: 'no-store',
      headers: { ...(init?.headers || {}) }
    });
    const text = await response.text();
    return { response, text };
  } finally {
    clearTimeout(timeout);
  }
}

// 所有 JSON 请求的入口。api.predict.fun 的请求会：
//   1. 先过进程级限速（predict-limiter）
//   2. 收到 429 时让全局暂停，并在暂停结束后自动重试 PREDICT_429_RETRIES 次（默认 2）
export async function fetchJsonWithHeaders(url: string, init?: RequestInit): Promise<{
  json: unknown;
  headers: Record<string, string>;
  status: number;
}> {
  const predict = isPredictApiUrl(url);
  const maxAttempts = predict ? 1 + Math.max(0, envNumber('PREDICT_429_RETRIES', 2)) : 1;
  for (let attempt = 1; ; attempt++) {
    if (predict) await acquirePredictSlot();
    const { response, text } = await rawFetch(url, init);
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
    if (response.status === 429 && predict) {
      const pauseMs = notePredictRateLimited(response.headers.get('retry-after'));
      let path = url;
      try {
        path = new URL(url).pathname;
      } catch {}
      console.warn(`[predict] 429 on ${path}: pausing all predict.fun calls ${pauseMs}ms (attempt ${attempt}/${maxAttempts})`);
      if (attempt < maxAttempts) continue; // acquirePredictSlot 会等暂停结束
    }
    if (!response.ok) {
      const body = json ? JSON.stringify(json).slice(0, 1000) : text.slice(0, 1000);
      throw new Error(`HTTP ${response.status} ${response.statusText}: ${body}`);
    }
    return { json, headers, status: response.status };
  }
}

export async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  return (await fetchJsonWithHeaders(url, init)).json;
}
