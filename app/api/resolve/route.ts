import { NextResponse } from 'next/server';
import { resolveMarket } from '@/lib/resolve-market';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const predictMarketId = String(body?.predictMarketId || '').trim();
  if (!predictMarketId) {
    return NextResponse.json({ ok: false, error: 'Missing predictMarketId' }, { status: 400 });
  }
  try {
    const results = await resolveMarket(predictMarketId);
    return NextResponse.json({
      ok: true,
      checkedAt: new Date().toISOString(),
      results
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}
