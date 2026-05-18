import { NextResponse } from 'next/server';
import { getCacheStatus, refreshMarketsCache } from '@/lib/predict-cache';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get('refresh') === '1') {
    // 不等结果直接返回，让客户端轮询 GET 看状态
    refreshMarketsCache().catch(() => {});
    return NextResponse.json({ ok: true, action: 'refresh-triggered', cache: getCacheStatus() });
  }
  return NextResponse.json({ ok: true, cache: getCacheStatus() });
}
