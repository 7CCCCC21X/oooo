import { NextResponse } from 'next/server';
import { getMarketsCachedOrFetch, getCacheStatus } from '@/lib/predict-cache';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  const slug = (url.searchParams.get('slug') || '').trim().toLowerCase();
  try {
    const entry = await getMarketsCachedOrFetch();
    const matches = entry.markets.filter((m) => {
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
      query: { q, slug },
      cache: getCacheStatus(),
      totalMarkets: entry.markets.length,
      totalCategories: entry.totalCategories,
      matchCount: matches.length,
      matches
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error), cache: getCacheStatus() },
      { status: 500 }
    );
  }
}
