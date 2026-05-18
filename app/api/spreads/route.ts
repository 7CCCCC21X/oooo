import { NextResponse } from 'next/server';
import { checkPairs } from '@/lib/spread';
import { loadPairs, sanitizePairs } from '@/lib/pairs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export async function GET() {
  const pairs = loadPairs();
  const results = await checkPairs(pairs);
  return NextResponse.json({
    ok: true,
    checkedAt: new Date().toISOString(),
    source: process.env.PAIRS_JSON ? 'PAIRS_JSON' : 'config/pairs.json',
    pairs,
    results
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
