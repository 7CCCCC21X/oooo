import { NextResponse } from 'next/server';
import { fetchAllPredictMarketsViaCategories } from '@/lib/predict-markets';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  const slug = (url.searchParams.get('slug') || '').trim().toLowerCase();
  const includeClosed = url.searchParams.get('includeClosed') !== '0';
  try {
    const { markets, pagesFetched, stoppedReason, totalCategories, totalUniqueMarketIds, categoriesWithoutMarkets, source } =
      await fetchAllPredictMarketsViaCategories({
        includeClosed,
        limit: 100,
        maxPages: 200
      });
    const matches = markets.filter((m) => {
      if (slug) {
        if (m.slug?.toLowerCase() === slug) return true;
        if (m.categorySlug?.toLowerCase() === slug) return true;
        return false;
      }
      if (q) {
        const blob = [m.id, m.title, m.question, m.slug, m.categorySlug, m.category].filter(Boolean).join(' ').toLowerCase();
        return blob.includes(q);
      }
      return false;
    });
    return NextResponse.json({
      ok: true,
      query: { q, slug, includeClosed },
      source,
      pagesFetched,
      stoppedReason,
      totalCategories,
      totalUniqueMarketIds,
      totalMarkets: markets.length,
      categoriesWithoutMarkets,
      matchCount: matches.length,
      matches
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
