import { NextResponse } from 'next/server';
import { fetchAllPredictMarkets } from '@/lib/predict-markets';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  const slug = (url.searchParams.get('slug') || '').trim().toLowerCase();
  const includeClosed = url.searchParams.get('includeClosed') !== '0';
  try {
    const { markets, pagesFetched, stoppedReason, paginationMode, rawWrapperKeys, sampleRaw } = await fetchAllPredictMarkets({
      includeClosed,
      hasActiveRewards: false,
      limit: 100,
      maxPages: 100
    });
    const matches = markets.filter((m) => {
      const blob = [m.id, m.title, m.question, m.slug, m.categorySlug, m.category].filter(Boolean).join(' ').toLowerCase();
      if (slug && (m.slug?.toLowerCase() === slug || m.categorySlug?.toLowerCase() === slug)) return true;
      if (q && blob.includes(q)) return true;
      return false;
    });
    return NextResponse.json({
      ok: true,
      query: { q, slug, includeClosed },
      paginationMode,
      pagesFetched,
      stoppedReason,
      totalMarkets: markets.length,
      matchCount: matches.length,
      rawWrapperKeys,
      sampleRawKeys: sampleRaw && typeof sampleRaw === 'object' ? Object.keys(sampleRaw as object) : null,
      matches
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
