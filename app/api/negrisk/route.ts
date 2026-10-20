import { NextResponse } from 'next/server';
import {
  analyzeCategoryBySlugOrUrl,
  getLastScan,
  getNegRiskDisplayMin,
  getNegRiskStatus,
  runManualScan,
  ScanBusyError
} from '@/lib/negrisk';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// GET /api/negrisk?slug=<链接或slug>          单个类目：每个结果 Yes 买1/卖1 + 总和
// GET /api/negrisk?min=95&limit=50            上次扫描结果，按显示下限筛选
// GET /api/negrisk?scan=1&min=95              立即扫一次再返回（与后台扫描互斥，进行中返回 409；结果写入「上次扫描」，不推送）
export async function GET(request: Request) {
  const url = new URL(request.url);
  const slug = url.searchParams.get('slug') || url.searchParams.get('url');
  try {
    if (slug) {
      const analysis = await analyzeCategoryBySlugOrUrl(slug);
      return NextResponse.json({ ok: true, status: getNegRiskStatus(), analysis });
    }
    const minRaw = url.searchParams.get('min');
    const minCents = minRaw == null || minRaw === '' ? getNegRiskDisplayMin() : Number(minRaw);
    const limit = Number(url.searchParams.get('limit') || '100');
    const scan = url.searchParams.get('scan') === '1' ? await runManualScan() : getLastScan();
    if (!scan) {
      return NextResponse.json({ ok: false, error: '还没有扫描结果（后台首次扫描在启动约 90 秒后；或加 ?scan=1 立即扫）', status: getNegRiskStatus() }, { status: 404 });
    }
    const results = scan.results.filter((r) => r.bidSum >= (Number.isFinite(minCents) ? minCents : 0)).slice(0, Number.isFinite(limit) ? limit : 100);
    return NextResponse.json({
      ok: true,
      status: getNegRiskStatus(),
      filters: { minCents, limit },
      scan: {
        checkedAt: scan.checkedAt,
        durationMs: scan.durationMs,
        detectMode: scan.detectMode,
        thresholdCents: scan.thresholdCents,
        candidates: scan.candidates,
        prefiltered: scan.prefiltered,
        scanned: scan.scanned,
        capped: scan.capped,
        requests: scan.requests,
        hits: scan.hits.length
      },
      count: results.length,
      results
    });
  } catch (error) {
    if (error instanceof ScanBusyError) {
      return NextResponse.json({ ok: false, error: error.message, status: getNegRiskStatus() }, { status: 409 });
    }
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
