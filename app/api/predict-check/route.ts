import { NextResponse } from 'next/server';
import { fetchJson } from '@/lib/fetch-json';

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
  // 去掉 /zh-cn / /en 等 locale 前缀
  s = s.replace(/^\/(zh-cn|zh|en|ja|ko|es|fr|de|pt|ru)(?=\/)/i, '');
  // 抓 /market/<slug> 或 /markets/<slug>
  const m = s.match(/\/markets?\/([^/?#]+)/);
  if (m) return m[1];
  // 没匹配到就当原始 slug
  return s.replace(/^\/+/, '').split(/[/?#]/)[0];
}

type Attempt = {
  label: string;
  url: string;
  status: number | 'error';
  body?: unknown;
  error?: string;
  matched?: boolean;
  notes?: string;
};

async function tryFetch(label: string, url: string, headers: Record<string, string>): Promise<Attempt> {
  try {
    const json = await fetchJson(url, { headers });
    return { label, url, status: 200, body: json };
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

function extractMarketFromResponse(raw: any): any | null {
  if (!raw) return null;
  if (looksLikeMarket(raw)) return raw;
  if (looksLikeMarket(raw?.data)) return raw.data;
  if (Array.isArray(raw)) {
    const hit = raw.find(looksLikeMarket);
    if (hit) return hit;
  }
  if (Array.isArray(raw?.data)) {
    const hit = raw.data.find(looksLikeMarket);
    if (hit) return hit;
  }
  if (Array.isArray(raw?.markets)) {
    const hit = raw.markets.find(looksLikeMarket);
    if (hit) return hit;
  }
  return null;
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

  const apiKey = process.env.PREDICT_API_KEY;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;

  // 同时试多种取单市场的方式
  const attempts: Attempt[] = [];
  attempts.push(await tryFetch('GET /v1/markets/<slug>', `${PREDICT_REST_BASE}/markets/${encodeURIComponent(slug)}`, headers));
  attempts.push(await tryFetch('GET /v1/markets?slug=<slug>', `${PREDICT_REST_BASE}/markets?slug=${encodeURIComponent(slug)}`, headers));
  attempts.push(await tryFetch('GET /v1/markets?categorySlug=<slug>', `${PREDICT_REST_BASE}/markets?categorySlug=${encodeURIComponent(slug)}`, headers));
  attempts.push(await tryFetch('GET /v1/events?slug=<slug>', `${PREDICT_REST_BASE}/events?slug=${encodeURIComponent(slug)}`, headers));
  attempts.push(await tryFetch('GET /v1/events/<slug>', `${PREDICT_REST_BASE}/events/${encodeURIComponent(slug)}`, headers));

  // 标记每个 attempt 是否成功找到 market
  let found: any | null = null;
  for (const a of attempts) {
    if (a.status === 200) {
      const m = extractMarketFromResponse(a.body);
      if (m) {
        a.matched = true;
        a.notes = `提取到 market id=${m.id}`;
        if (!found) found = m;
      } else {
        a.notes = '响应里没找到 market 对象';
      }
    }
  }

  // 判定 polymarket 映射
  let polymarketConditionIds: string[] = [];
  let hasPolymarket = false;
  let allTopLevelKeys: string[] = [];
  if (found) {
    allTopLevelKeys = Object.keys(found);
    const raw = found.polymarketConditionIds ?? found.polymarket_condition_ids ?? found.polymarketConditionIDs;
    if (Array.isArray(raw)) {
      polymarketConditionIds = raw.filter(Boolean).map(String);
    } else if (typeof raw === 'string' && raw.trim()) {
      polymarketConditionIds = raw.split(/[\s,]+/).filter(Boolean);
    }
    hasPolymarket = polymarketConditionIds.length > 0;
  }

  return NextResponse.json({
    ok: true,
    input,
    extractedSlug: slug,
    found: !!found,
    summary: found
      ? {
          id: found.id,
          title: found.title ?? found.question ?? null,
          slug: found.slug ?? null,
          categorySlug: found.categorySlug ?? null,
          status: found.status ?? found.tradingStatus ?? null,
          isResolved: found.isResolved ?? null,
          endsAt: found.endsAt ?? null,
          polymarketConditionIds,
          hasPolymarket,
          conclusion: !found
            ? 'predict.fun API 找不到这个市场'
            : hasPolymarket
            ? '⚠️ 这个市场在 polymarket 也有对应（不是 predict 独有）'
            : '✅ 这个市场是 predict 独有（polymarketConditionIds 为空）'
        }
      : null,
    allTopLevelKeys,
    rawMarket: found,
    attempts: attempts.map((a) => ({
      label: a.label,
      url: a.url,
      status: a.status,
      matched: a.matched ?? false,
      notes: a.notes,
      error: a.error,
      bodyKeys: a.body && typeof a.body === 'object' ? Object.keys(a.body as object) : null
    }))
  });
}
