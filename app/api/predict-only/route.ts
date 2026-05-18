import { NextResponse } from 'next/server';
import { fetchAllPredictMarkets, filterPredictOnly } from '@/lib/predict-markets';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const includeClosed = url.searchParams.get('includeClosed') === '1';
  const limit = Number(url.searchParams.get('limit') || '100');
  const maxPages = Number(url.searchParams.get('maxPages') || '50');
  const status = url.searchParams.get('status') || undefined;
  try {
    const { markets, pagesFetched, stoppedReason } = await fetchAllPredictMarkets({
      includeClosed,
      limit: Number.isFinite(limit) ? limit : 100,
      maxPages: Number.isFinite(maxPages) ? maxPages : 50,
      status: status || undefined
    });
    const predictOnly = filterPredictOnly(markets);
    const withPoly = markets.filter((m) => m.hasPolymarket);
    return NextResponse.json({
      ok: true,
      checkedAt: new Date().toISOString(),
      pagesFetched,
      stoppedReason,
      totalMarkets: markets.length,
      withPolymarketCount: withPoly.length,
      predictOnlyCount: predictOnly.length,
      predictOnly,
      withPolymarket: withPoly.map((m) => ({ id: m.id, title: m.title, polymarketConditionIds: m.polymarketConditionIds }))
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
