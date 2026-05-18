import { NextResponse } from 'next/server';
import { fetchJson } from '@/lib/fetch-json';
import { fetchAllPredictMarkets } from '@/lib/predict-markets';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const PREDICT_REST_BASE = 'https://api.predict.fun/v1';

function extractSlug(input: string): string {
  let s = input.trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    s = u.pathname;
  } catch {
    // not a URL; treat as raw slug
  }
  s = s.replace(/^\/(zh-cn|zh|en|ja|ko|es|fr|de|pt|ru)(?=\/)/i, '');
  const m = s.match(/\/markets?\/([^/?#]+)/);
  if (m) return m[1];
  return s.replace(/^\/+/, '').split(/[/?#]/)[0];
}

function lower(value: unknown): string {
  return value == null ? '' : String(value).toLowerCase();
}

function exactSlugMatch(market: any, slug: string): boolean {
  if (!market || !slug) return false;
  const target = slug.toLowerCase();
  const candidates = [
    market.slug,
    market.marketSlug,
    market.categorySlug,
    market.category_slug,
    market.eventSlug,
    market.event_slug
  ].map(lower).filter(Boolean);
  return candidates.includes(target);
}

type Attempt = {
  label: string;
  url: string;
  status: number | 'error';
  body?: unknown;
  bodyKeys?: string[] | null;
  arrayLength?: number;
  matched?: boolean;
  rejectedReason?: string;
  error?: string;
};

async function tryFetch(label: string, url: string, headers: Record<string, string>): Promise<Attempt> {
  try {
    const json = await fetchJson(url, { headers });
    const bodyKeys = json && typeof json === 'object' && !Array.isArray(json) ? Object.keys(json as object) : null;
    const arr = Array.isArray(json) ? json : Array.isArray((json as any)?.data) ? (json as any).data : null;
    return { label, url, status: 200, body: json, bodyKeys, arrayLength: arr ? arr.length : undefined };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const m = msg.match(/HTTP (\d+)/);
    const code = m ? Number(m[1]) : 'error';
    return { label, url, status: code as any, error: msg.slice(0, 300) };
  }
}

function looksLikeMarket(obj: any): boolean {
  if (!obj || typeof obj !== 'object') return false;
  return 'id' in obj && ('title' in obj || 'question' in obj || 'slug' in obj || 'categorySlug' in obj);
}

function candidatesFromAttempt(a: Attempt): any[] {
  const raw = a.body as any;
  if (!raw) return [];
  if (looksLikeMarket(raw)) return [raw];
  if (looksLikeMarket(raw?.data)) return [raw.data];
  if (Array.isArray(raw)) return raw.filter(looksLikeMarket);
  if (Array.isArray(raw?.data)) return raw.data.filter(looksLikeMarket);
  if (Array.isArray(raw?.markets)) return raw.markets.filter(looksLikeMarket);
  return [];
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const input = url.searchParams.get('url') || url.searchParams.get('slug') || '';
  if (!input.trim()) {
    return NextResponse.json({ ok: false, error: 'Missing ?url= or ?slug=' }, { status: 400 });
  }
  const slug = extractSlug(input);
  if (!slug) {
    return NextResponse.json({ ok: false, error: `Cannot extract slug from: ${input}` }, { status: 400 });
  }
  const deepScan = url.searchParams.get('deepScan') === '1';
  const limit = Math.max(10, Math.min(200, Number(url.searchParams.get('limit') || '100')));
  const maxPages = Math.max(1, Math.min(500, Number(url.searchParams.get('maxPages') || '100')));

  const apiKey = process.env.PREDICT_API_KEY;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;

  const attempts: Attempt[] = [];
  attempts.push(await tryFetch('GET /v1/markets/<slug>', `${PREDICT_REST_BASE}/markets/${encodeURIComponent(slug)}`, headers));
  attempts.push(await tryFetch('GET /v1/markets?slug=<slug>', `${PREDICT_REST_BASE}/markets?slug=${encodeURIComponent(slug)}`, headers));
  attempts.push(await tryFetch('GET /v1/markets?categorySlug=<slug>', `${PREDICT_REST_BASE}/markets?categorySlug=${encodeURIComponent(slug)}`, headers));
  attempts.push(await tryFetch('GET /v1/events?slug=<slug>', `${PREDICT_REST_BASE}/events?slug=${encodeURIComponent(slug)}`, headers));
  attempts.push(await tryFetch('GET /v1/events/<slug>', `${PREDICT_REST_BASE}/events/${encodeURIComponent(slug)}`, headers));

  let found: any | null = null;
  let foundVia: string | null = null;

  for (const a of attempts) {
    if (a.status !== 200) continue;
    const candidates = candidatesFromAttempt(a);
    if (!candidates.length) {
      a.rejectedReason = '响应里没找到 market 对象';
      continue;
    }
    // 必须精确匹配 slug，否则视为 API 没真过滤、误返回默认列表
    const exact = candidates.find((m) => exactSlugMatch(m, slug));
    if (exact) {
      a.matched = true;
      if (!found) {
        found = exact;
        foundVia = a.label;
      }
    } else {
      a.matched = false;
      const first = candidates[0];
      const firstSlug = first?.slug || first?.categorySlug || first?.eventSlug || '(无)';
      a.rejectedReason = `返回 ${candidates.length} 条但都不匹配 slug，看起来 API 没真过滤（首条 slug=${firstSlug}, title=${first?.title?.slice(0, 60) || '?'}）`;
    }
  }

  // 全部 REST endpoint 都没拿到 → 兜底：扫全量市场列表，本地按 slug 找
  let deepScanInfo:
    | { pagesFetched: number; totalScanned: number; totalUniqueIds?: number; stoppedReason?: string; paginationMode?: string; matchedId?: string }
    | undefined;
  if (!found && deepScan) {
    try {
      const { markets, pagesFetched, stoppedReason, totalUniqueIds, paginationMode } = await fetchAllPredictMarkets({
        includeClosed: true,
        hasActiveRewards: false,
        limit,
        maxPages
      });
      deepScanInfo = {
        pagesFetched,
        totalScanned: markets.length,
        totalUniqueIds,
        stoppedReason,
        paginationMode
      };
      const hit = markets.find(
        (m) =>
          lower(m.slug) === slug.toLowerCase() ||
          lower(m.categorySlug) === slug.toLowerCase() ||
          lower(m.id) === slug.toLowerCase()
      );
      if (hit) {
        found = hit;
        foundVia = 'deep-scan';
        deepScanInfo.matchedId = hit.id;
      }
    } catch (err) {
      // ignore
    }
  }

  // 提取 polymarket 字段
  let polymarketConditionIds: string[] = [];
  let hasPolymarket = false;
  let allTopLevelKeys: string[] = [];
  if (found) {
    allTopLevelKeys = Object.keys(found);
    const raw =
      found.polymarketConditionIds ?? found.polymarket_condition_ids ?? found.polymarketConditionIDs;
    if (Array.isArray(raw)) {
      polymarketConditionIds = raw.filter(Boolean).map(String);
    } else if (typeof raw === 'string' && raw.trim()) {
      polymarketConditionIds = raw.split(/[\s,]+/).filter(Boolean);
    }
    hasPolymarket = polymarketConditionIds.length > 0;
  }

  const conclusion = !found
    ? deepScan
      ? '❌ predict.fun REST 5 个端点都拿不到这个 slug，全量扫也没找到。可能 (a) 它是 event 不是 market，(b) 它在 GraphQL 里，(c) slug 拼错。'
      : '❌ predict.fun REST 5 个端点都没精确返回这个 slug。可加 &deepScan=1 让我扫全量市场列表再确认一次。'
    : hasPolymarket
    ? '⚠️ 这个市场在 polymarket 也有对应（polymarketConditionIds 非空，不算 predict 独有）'
    : '✅ 这个市场是 predict 独有（polymarketConditionIds 为空）';

  return NextResponse.json({
    ok: true,
    input,
    extractedSlug: slug,
    found: !!found,
    foundVia,
    summary: found
      ? {
          id: found.id,
          title: found.title ?? found.question ?? null,
          slug: found.slug ?? null,
          categorySlug: found.categorySlug ?? null,
          eventSlug: found.eventSlug ?? null,
          status: found.status ?? found.tradingStatus ?? null,
          isResolved: found.isResolved ?? null,
          endsAt: found.endsAt ?? null,
          polymarketConditionIds,
          hasPolymarket
        }
      : null,
    conclusion,
    allTopLevelKeys,
    deepScan: deepScanInfo,
    rawMarket: found,
    attempts: attempts.map((a) => ({
      label: a.label,
      url: a.url,
      status: a.status,
      arrayLength: a.arrayLength,
      bodyKeys: a.bodyKeys,
      matched: a.matched ?? false,
      rejectedReason: a.rejectedReason,
      error: a.error
    }))
  });
}
