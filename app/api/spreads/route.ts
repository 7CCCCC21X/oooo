import { NextResponse } from 'next/server';
import { checkPairs } from '@/lib/spread';
import { loadPairs, sanitizePairs } from '@/lib/pairs';
import { getPairLinks } from '@/lib/market-links';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export async function GET(request: Request) {
  const pairs = loadPairs();
  const results = await checkPairs(pairs);
  // ?links=1 用于验证两边市场标题/链接解析是否正确（价差提醒里就用它）
  const withLinks = new URL(request.url).searchParams.get('links') === '1';
  const links = withLinks ? await Promise.all(pairs.map((p) => getPairLinks(p))) : undefined;
  return NextResponse.json({
    ok: true,
    checkedAt: new Date().toISOString(),
    source: process.env.PAIRS_JSON ? 'PAIRS_JSON' : 'config/pairs.json',
    pairs,
    results,
    ...(withLinks ? { links } : {})
  });
}
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const pairs = sanitizePairs(body?.pairs);
  const results = await checkPairs(pairs);
  return NextResponse.json({
    ok: true,
    checkedAt: new Date().toISOString(),
    source: 'request.body.pairs',
    pairs,
    results
  });
}
