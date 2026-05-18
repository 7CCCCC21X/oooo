import { NextResponse } from 'next/server';
import {
  fetchAllPredictMarkets,
  fetchAllPredictMarketsViaCategories,
  filterPredictOnly
} from '@/lib/predict-markets';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const source = (url.searchParams.get('source') || 'categories').toLowerCase(); // 'categories' | 'markets'
  const includeClosed = url.searchParams.get('includeClosed') === '1' || source === 'categories';
  const hasActiveRewards = url.searchParams.get('hasActiveRewards') === '1';
  const debug = url.searchParams.get('debug') === '1';
  const limit = Number(url.searchParams.get('limit') || '100');
  const maxPages = Number(url.searchParams.get('maxPages') || '100');
  const minHourlyRate = Number(url.searchParams.get('minHourlyRate') || '0');

  try {
    let markets;
    let pagesFetched;
    let stoppedReason;
    let totalCategories: number | undefined;
    let totalUniqueMarketIds: number | undefined;
    let categoriesWithoutMarkets: number | undefined;
    let sampleRaw: unknown;
    let rawWrapperKeys: string[] | undefined;
    let paginationMode: string | undefined;
    let totalUniqueIds: number | undefined;
    let usedSource: string;

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
      usedSource = 'markets';
    } else {
      const r = await fetchAllPredictMarketsViaCategories({
        includeClosed,
        limit: Number.isFinite(limit) ? limit : 100,
        maxPages: Number.isFinite(maxPages) ? maxPages : 100
      });
      markets = r.markets;
      pagesFetched = r.pagesFetched;
      stoppedReason = r.stoppedReason;
      totalCategories = r.totalCategories;
      totalUniqueMarketIds = r.totalUniqueMarketIds;
      categoriesWithoutMarkets = r.categoriesWithoutMarkets;
      usedSource = 'categories';
    }

    let predictOnly = filterPredictOnly(markets);
    if (hasActiveRewards && source === 'categories') {
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
      filters: { source, includeClosed, hasActiveRewards, minHourlyRate, limit, maxPages },
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
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
