import { NextResponse } from 'next/server';
import {
  fetchAllPredictMarkets,
  fetchAllPredictMarketsViaCategories,
  filterPredictOnly
} from '@/lib/predict-markets';
import { getCachedMarkets, getCacheStatus, refreshMarketsCache, getMarketsCachedOrFetch } from '@/lib/predict-cache';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const source = (url.searchParams.get('source') || 'cache').toLowerCase(); // 'cache' | 'categories' | 'markets'
  const refresh = url.searchParams.get('refresh') === '1';
  const includeClosed = url.searchParams.get('includeClosed') === '1' || source !== 'markets';
  const hasActiveRewards = url.searchParams.get('hasActiveRewards') === '1';
  const debug = url.searchParams.get('debug') === '1';
  const limit = Number(url.searchParams.get('limit') || '100');
  const maxPages = Number(url.searchParams.get('maxPages') || '300');
  const minHourlyRate = Number(url.searchParams.get('minHourlyRate') || '0');

  try {
    let markets;
    let pagesFetched: number | undefined;
    let stoppedReason: string | undefined;
    let totalCategories: number | undefined;
    let totalUniqueMarketIds: number | undefined;
    let categoriesWithoutMarkets: number | undefined;
    let sampleRaw: unknown;
    let rawWrapperKeys: string[] | undefined;
    let paginationMode: string | undefined;
    let totalUniqueIds: number | undefined;
    let usedSource: string;
    let cacheInfo: any = null;

    if (source === 'markets') {
      const r = await fetchAllPredictMarkets({
        includeClosed,
        hasActiveRewards,
        limit: Number.isFinite(limit) ? limit : 100,
        maxPages: Number.isFinite(maxPages) ? maxPages : 100
      });
      markets = r.markets;
      pagesFetched = r.pagesFetched;
      stoppedReason = r.stoppedReason;
      sampleRaw = r.sampleRaw;
      rawWrapperKeys = r.rawWrapperKeys;
      paginationMode = r.paginationMode;
      totalUniqueIds = r.totalUniqueIds;
      usedSource = 'markets-live';
    } else if (source === 'categories') {
      // 直接现场跑（慢，可能 Railway 边缘超时）
      const r = await fetchAllPredictMarketsViaCategories({
        includeClosed,
        limit: Number.isFinite(limit) ? limit : 100,
        maxPages: Number.isFinite(maxPages) ? maxPages : 300
      });
      markets = r.markets;
      pagesFetched = r.pagesFetched;
      stoppedReason = r.stoppedReason;
      totalCategories = r.totalCategories;
      totalUniqueMarketIds = r.totalUniqueMarketIds;
      categoriesWithoutMarkets = r.categoriesWithoutMarkets;
      paginationMode = 'categories-cursor-live';
      totalUniqueIds = r.totalUniqueMarketIds;
      usedSource = 'categories-live';
    } else {
      // source === 'cache'：从缓存取，秒回。没缓存就等首次拉取。
      const entry = refresh ? await refreshMarketsCache() : await getMarketsCachedOrFetch();
      markets = entry.markets;
      pagesFetched = entry.pagesFetched;
      stoppedReason = entry.stoppedReason;
      totalCategories = entry.totalCategories;
      totalUniqueMarketIds = entry.totalUniqueMarketIds;
      paginationMode = 'categories-cursor-cached';
      totalUniqueIds = entry.totalUniqueMarketIds;
      usedSource = 'cache';
      cacheInfo = getCacheStatus();
    }

    let predictOnly = filterPredictOnly(markets);
    if (hasActiveRewards) {
      predictOnly = predictOnly.filter((m) => m.hourlyRate > 0);
    }
    if (Number.isFinite(minHourlyRate) && minHourlyRate > 0) {
      predictOnly = predictOnly.filter((m) => m.hourlyRate >= minHourlyRate);
    }
    const withPoly = markets.filter((m) => m.hasPolymarket);

    return NextResponse.json({
      ok: true,
      checkedAt: new Date().toISOString(),
      source: usedSource,
      cache: cacheInfo,
      pagesFetched,
      stoppedReason,
      paginationMode,
      totalUniqueIds,
      totalCategories,
      totalUniqueMarketIds,
      categoriesWithoutMarkets,
      totalMarkets: markets.length,
      withPolymarketCount: withPoly.length,
      predictOnlyCount: predictOnly.length,
      filters: { source, refresh, includeClosed, hasActiveRewards, minHourlyRate, limit, maxPages },
      predictOnly,
      withPolymarket: withPoly.map((m) => ({
        id: m.id,
        title: m.title,
        hourlyRate: m.hourlyRate,
        polymarketConditionIds: m.polymarketConditionIds
      })),
      ...(debug ? { sampleRaw, rawWrapperKeys } : {})
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error), cache: getCacheStatus() },
      { status: 500 }
    );
  }
}
