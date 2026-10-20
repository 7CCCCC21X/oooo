import { NextResponse } from 'next/server';
import {
  analyzeCategoryBySlugOrUrl,
  diagnoseCategory,
  getLastScan,
  getNegRiskDisplayMin,
  getNegRiskStatus,
  passesFloor,
  runManualScan,
  ScanBusyError
} from '@/lib/negrisk';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// GET /api/negrisk?slug=<链接或slug>          单个类目：每个结果 Yes 买1/卖1 + 总和（实时查订单簿）
//   &why=1                                    附带诊断：这个类目为什么不在扫描列表里；&live=0 只诊断不查订单簿
// GET /api/negrisk?min=95&limit=50            上次扫描结果，按显示下限筛选（没查全但上限估计 ≥ 下限的也返回）
// GET /api/negrisk?scan=1&min=95              立即扫一次再返回（与后台扫描互斥，进行中返回 409；结果写入「上次扫描」，不推送）
export async function GET(request: Request) {
  const url = new URL(request.url);
  const slug = url.searchParams.get('slug') || url.searchParams.get('url');
  try {
    if (slug) {
      const why = url.searchParams.get('why') === '1';
      const live = url.searchParams.get('live') !== '0';
      const diagnosis = why ? diagnoseCategory(slug) : undefined;
      const analysis = live ? await analyzeCategoryBySlugOrUrl(slug) : undefined;
      return NextResponse.json({
        ok: true,
        status: getNegRiskStatus(),
        ...(analysis ? { analysis } : {}),
        ...(diagnosis ? { diagnosis } : {})
      });
    }
    const minRaw = url.searchParams.get('min');
    const minCents = minRaw == null || minRaw === '' ? getNegRiskDisplayMin() : Number(minRaw);
    const limit = Number(url.searchParams.get('limit') || '100');
    const scan = url.searchParams.get('scan') === '1' ? await runManualScan() : getLastScan();
    if (!scan) {
      return NextResponse.json({ ok: false, error: '还没有扫描结果（后台首次扫描在启动约 90 秒后；或加 ?scan=1 立即扫）', status: getNegRiskStatus() }, { status: 404 });
    }
    const floor = Number.isFinite(minCents) ? minCents : 0;
    const results = scan.results.filter((r) => passesFloor(r, floor)).slice(0, Number.isFinite(limit) ? limit : 100);
    return NextResponse.json({
      ok: true,
      status: getNegRiskStatus(),
      filters: { minCents: floor, limit },
      scan: {
        checkedAt: scan.checkedAt,
        durationMs: scan.durationMs,
        detectMode: scan.detectMode,
        thresholdCents: scan.thresholdCents,
        candidates: scan.candidates,
        prefiltered: scan.prefiltered,
        unknownEstimate: scan.unknownEstimate,
        scanned: scan.scanned,
        capped: scan.capped,
        droppedByCap: scan.droppedByCap,
        requests: scan.requests,
        failedCategories: scan.failedCategories,
        retriedCategories: scan.retriedCategories,
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
