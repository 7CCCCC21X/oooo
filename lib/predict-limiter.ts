// ============================================================
// predict.fun 请求的进程级限速 + 429 全局暂停
//
// 同一个 API key 被缓存抓取、可转换扫描、网页查询、bot 命令共用，
// 之前各自发请求互不知情，突发一多就 429。这里用一个令牌桶让所有
// 走 fetchJson 的 api.predict.fun 请求排队，并在收到 429 时让全部
// 请求暂停一段时间（Retry-After 或 PREDICT_429_PAUSE_MS）。
// ============================================================
import { envNumber } from './env';

type LimiterState = {
  tokens: number;
  lastRefill: number;
  pausedUntil: number;
  count429: number;
  last429At: string | null;
  totalRequests: number;
  waiting: number;
};

declare global {
  var __predictLimiter: LimiterState | undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function predictRps(): number {
  // PREDICT_RATE_LIMIT_RPS=0 关闭限速（只保留 429 暂停）
  const n = envNumber('PREDICT_RATE_LIMIT_RPS', 5);
  if (n === 0) return Infinity;
  return n > 0 ? n : 5;
}

function state(): LimiterState {
  if (!globalThis.__predictLimiter) {
    const cap = Number.isFinite(predictRps()) ? Math.max(1, Math.ceil(predictRps())) : 1;
    globalThis.__predictLimiter = { tokens: cap, lastRefill: Date.now(), pausedUntil: 0, count429: 0, last429At: null, totalRequests: 0, waiting: 0 };
  }
  return globalThis.__predictLimiter;
}

export function isPredictApiUrl(url: string): boolean {
  try {
    return new URL(url).hostname === 'api.predict.fun';
  } catch {
    return false;
  }
}

// 等到可以发下一个 predict.fun 请求为止（先等 429 暂停结束，再等令牌）
export async function acquirePredictSlot(): Promise<void> {
  const rps = predictRps();
  const s = state();
  const cap = Number.isFinite(rps) ? Math.max(1, Math.ceil(rps)) : 1;
  s.waiting += 1;
  try {
    for (;;) {
      const now = Date.now();
      if (s.pausedUntil > now) {
        await sleep(Math.min(s.pausedUntil - now, 2000));
        continue;
      }
      if (!Number.isFinite(rps)) {
        s.totalRequests += 1;
        return;
      }
      const elapsed = (now - s.lastRefill) / 1000;
      s.tokens = Math.min(cap, s.tokens + elapsed * rps);
      s.lastRefill = now;
      if (s.tokens >= 1) {
        s.tokens -= 1;
        s.totalRequests += 1;
        return;
      }
      await sleep(Math.max(10, Math.ceil(((1 - s.tokens) / rps) * 1000)));
    }
  } finally {
    s.waiting -= 1;
  }
}

// 收到 429：全部 predict.fun 请求暂停。返回暂停毫秒数。
export function notePredictRateLimited(retryAfter?: string | null): number {
  const s = state();
  const now = Date.now();
  let ms = Math.max(1000, envNumber('PREDICT_429_PAUSE_MS', 20_000));
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs > 0) ms = Math.max(ms, secs * 1000);
    else {
      const at = Date.parse(retryAfter);
      if (Number.isFinite(at) && at > now) ms = Math.max(ms, at - now);
    }
  }
  ms = Math.min(ms, 300_000);
  s.pausedUntil = Math.max(s.pausedUntil, now + ms);
  s.tokens = 0;
  s.count429 += 1;
  s.last429At = new Date(now).toISOString();
  return ms;
}

export function getPredictLimiterStatus() {
  const s = state();
  const now = Date.now();
  const rps = predictRps();
  return {
    rps: Number.isFinite(rps) ? rps : null,
    pausedForMs: Math.max(0, s.pausedUntil - now),
    pausedUntil: s.pausedUntil > now ? new Date(s.pausedUntil).toISOString() : null,
    count429: s.count429,
    last429At: s.last429At,
    totalRequests: s.totalRequests,
    waiting: s.waiting
  };
}

// 仅测试用
export function resetPredictLimiter(): void {
  globalThis.__predictLimiter = undefined;
}
