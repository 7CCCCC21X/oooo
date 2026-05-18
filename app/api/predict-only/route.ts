import { NextResponse } from 'next/server';
import { fetchAllPredictMarkets, filterPredictOnly } from '@/lib/predict-markets';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const includeClosed = url.searchParams.get('includeClosed') === '1';
  const hasActiveRewards = url.searchParams.get('hasActiveRewards') === '1';
  const debug = url.searchParams.get('debug') === '1';
  const limit = Number(url.searchParams.get('limit') || '100');
  const maxPages = Number(url.searchParams.get('maxPages') || '50');
  const minHourlyRate = Number(url.searchParams.get('minHourlyRate') || '0');

  try {
    const { markets, pagesFetched, stoppedReason, sampleRaw, rawWrapperKeys, paginationMode, totalUniqueIds } = await fetchAllPredictMarkets({
      includeClosed,
      hasActiveRewards,
      limit: Number.isFinite(limit) ? limit : 100,
      maxPages: Number.isFinite(maxPages) ? maxPages : 50
    });
    let predictOnly = filterPredictOnly(markets);
    if (Number.isFinite(minHourlyRate) && minHourlyRate > 0) {
      predictOnly = predictOnly.filter((m) => m.hourlyRate >= minHourlyRate);
    }
    const withPoly = markets.filter((m) => m.hasPolymarket);
    return NextResponse.json({
      ok: true,
      checkedAt: new Date().toISOString(),
      pagesFetched,
      stoppedReason,
      paginationMode,
      totalUniqueIds,
      totalMarkets: markets.length,
      withPolymarketCount: withPoly.length,
      predictOnlyCount: predictOnly.length,
      filters: { includeClosed, hasActiveRewards, minHourlyRate, limit, maxPages },
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
