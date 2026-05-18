import { fetchAllPredictMarketsViaCategories } from './predict-markets';
import type { PredictMarketSummary } from './types';

export type MarketsCacheEntry = {
  markets: PredictMarketSummary[];
  totalCategories: number;
  totalUniqueMarketIds: number;
  pagesFetched: number;
  stoppedReason: string;
  fetchedAt: string;
  durationMs: number;
};

declare global {
  var __predictMarketsCache: MarketsCacheEntry | null | undefined;
  var __predictMarketsInflight: Promise<MarketsCacheEntry> | null | undefined;
  var __predictCacheTimer: NodeJS.Timeout | undefined;
  var __predictCacheLastError: string | undefined;
}

const CACHE_TTL_MS = Number(process.env.PREDICT_CACHE_TTL_MS) || 10 * 60 * 1000;
const MAX_PAGES = Number(process.env.PREDICT_CACHE_MAX_PAGES) || 500;

export function getCachedMarkets(): MarketsCacheEntry | null {
  return globalThis.__predictMarketsCache ?? null;
}

export function getCacheStatus() {
  const entry = globalThis.__predictMarketsCache;
  return {
    hasCache: !!entry,
    fetchedAt: entry?.fetchedAt ?? null,
    ageMs: entry ? Date.now() - new Date(entry.fetchedAt).getTime() : null,
    ttlMs: CACHE_TTL_MS,
    totalMarkets: entry?.markets.length ?? 0,
    totalCategories: entry?.totalCategories ?? 0,
    pagesFetched: entry?.pagesFetched ?? 0,
    stoppedReason: entry?.stoppedReason ?? null,
    durationMs: entry?.durationMs ?? null,
    refreshInflight: !!globalThis.__predictMarketsInflight,
    timerActive: !!globalThis.__predictCacheTimer,
    lastError: globalThis.__predictCacheLastError ?? null
  };
}

export async function refreshMarketsCache(maxPages = MAX_PAGES): Promise<MarketsCacheEntry> {
  if (globalThis.__predictMarketsInflight) return globalThis.__predictMarketsInflight;

  const start = Date.now();
  const promise = (async () => {
    console.log(`[predict-cache] refresh start (maxPages=${maxPages})`);
    const r = await fetchAllPredictMarketsViaCategories({
      includeClosed: true,
      limit: 100,
      maxPages
    });
    const entry: MarketsCacheEntry = {
      markets: r.markets,
      totalCategories: r.totalCategories,
      totalUniqueMarketIds: r.totalUniqueMarketIds,
      pagesFetched: r.pagesFetched,
      stoppedReason: r.stoppedReason,
      fetchedAt: new Date().toISOString(),
      durationMs: Date.now() - start
    };
    globalThis.__predictMarketsCache = entry;
    globalThis.__predictCacheLastError = undefined;
    console.log(`[predict-cache] refresh done: ${entry.markets.length} markets, ${entry.pagesFetched} pages, ${entry.durationMs}ms, stop=${entry.stoppedReason}`);
    return entry;
  })()
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      globalThis.__predictCacheLastError = msg;
      console.error('[predict-cache] refresh failed:', msg);
      throw err;
    })
    .finally(() => {
      globalThis.__predictMarketsInflight = null;
    });

  globalThis.__predictMarketsInflight = promise;
  return promise;
}

// 主入口：
// - 有 fresh cache → 直接返回
// - 有 stale cache → 返回 stale，同时后台刷新
// - 没 cache 但有 inflight → 等 inflight
// - 完全没有 → 等首次拉取（首次必慢，后续都秒回）
export async function getMarketsCachedOrFetch(maxAge = CACHE_TTL_MS): Promise<MarketsCacheEntry> {
  const cached = getCachedMarkets();
  if (cached) {
    const age = Date.now() - new Date(cached.fetchedAt).getTime();
    if (age < maxAge) return cached;
    // stale: 后台刷新但不等
    refreshMarketsCache().catch(() => {});
    return cached;
  }
  return refreshMarketsCache();
}

export function startBackgroundCacheRefresh(): void {
  if (globalThis.__predictCacheTimer) return;
  if (process.env.ENABLE_PREDICT_CACHE === '0') {
    console.log('[predict-cache] disabled via ENABLE_PREDICT_CACHE=0');
    return;
  }
  console.log(`[predict-cache] background refresh every ${CACHE_TTL_MS}ms, maxPages=${MAX_PAGES}`);
  // 启动延迟 10s 跑首次（让 web server 先 ready）
  setTimeout(() => {
    refreshMarketsCache().catch(() => {});
  }, 10_000);
  globalThis.__predictCacheTimer = setInterval(() => {
    refreshMarketsCache().catch(() => {});
  }, CACHE_TTL_MS);
}
