import { NextResponse } from 'next/server';
import { fetchJson } from '@/lib/fetch-json';
import { fetchAllPredictMarkets } from '@/lib/predict-markets';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const PREDICT_REST_BASE = 'https://api.predict.fun/v1';

function lower(value: unknown): string {
  return value == null ? '' : String(value).toLowerCase();
}

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
  const m = s.match(/\/(markets?|categories|categor[iy]|events?)\/([^/?#]+)/);
  if (m) return m[2];
  return s.replace(/^\/+/, '').split(/[/?#]/)[0];
}

function predictHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (process.env.PREDICT_API_KEY) headers['x-api-key'] = process.env.PREDICT_API_KEY;
  return headers;
}

function polymarketIds(market: any): string[] {
  const raw = market?.polymarketConditionIds ?? market?.polymarket_condition_ids ?? market?.polymarketConditionIDs;
  if (Array.isArray(raw)) return raw.filter(Boolean).map(String);
  if (typeof raw === 'string' && raw.trim()) return raw.split(/[\s,]+/).filter(Boolean);
  return [];
}

function buildConclusion(market: any): string {
  const ids = polymarketIds(market);
  if (Array.isArray(market?.polymarketConditionIds) || Array.isArray(market?.polymarket_condition_ids)) {
    return ids.length === 0
      ? '✅ 这个市场是 predict 独有（polymarketConditionIds 为空）'
      : '⚠️ 这个市场关联了 Polymarket conditionId，不是 predict 独有';
  }
  return '⚠️ 找到市场，但没有 polymarketConditionIds 字段，无法判断';
}

type Attempt = {
  label: string;
  url: string;
  status: number | 'error';
  matched?: boolean;
  rejectedReason?: string;
  error?: string;
};

async function tryFetch(label: string, url: string, headers: Record<string, string>): Promise<{ attempt: Attempt; body: any | null }> {
  try {
    const json = await fetchJson(url, { headers });
    return { attempt: { label, url, status: 200 }, body: json };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const m = msg.match(/HTTP (\d+)/);
    const code = m ? Number(m[1]) : 'error';
    return { attempt: { label, url, status: code as any, error: msg.slice(0, 300) }, body: null };
  }
}

function looksLikeMarket(obj: any): boolean {
  if (!obj || typeof obj !== 'object') return false;
  return 'id' in obj && ('title' in obj || 'question' in obj || 'slug' in obj || 'categorySlug' in obj);
}

function pickMarkets(obj: any): any[] {
  if (!obj || typeof obj !== 'object') return [];
  if (Array.isArray(obj.markets)) return obj.markets.filter(looksLikeMarket);
  if (Array.isArray(obj.data?.markets)) return obj.data.markets.filter(looksLikeMarket);
  return [];
}

function exactSlugMatch(market: any, slug: string): boolean {
  if (!market || !slug) return false;
  const target = slug.toLowerCase();
  return [market.slug, market.marketSlug, market.categorySlug, market.category_slug]
    .map(lower)
    .filter(Boolean)
    .includes(target);
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

  if (!process.env.PREDICT_API_KEY) {
    return NextResponse.json({
      ok: false,
      extractedSlug: slug,
      error: '❌ Railway 没有配置 PREDICT_API_KEY。Predict API 需要 x-api-key 才能访问 /v1/categories /v1/search 等接口。',
      action: '在 Railway → Variables 加 PREDICT_API_KEY，redeploy 后再试。'
    }, { status: 500 });
  }

  const headers = predictHeaders();
  const attempts: Attempt[] = [];
  let found: any | null = null;
  let foundVia: string | null = null;
  let foundCategory: any | null = null;

  // ========== 优先级 1: /v1/categories/<slug> ==========
  {
    const { attempt, body } = await tryFetch(
      'GET /v1/categories/<slug>',
      `${PREDICT_REST_BASE}/categories/${encodeURIComponent(slug)}`,
      headers
    );
    if (attempt.status === 200) {
      const category = body?.data || body;
      if (category && lower(category.slug) === lower(slug)) {
        const markets = pickMarkets(category);
        const market = markets.find((m) => exactSlugMatch(m, slug)) || markets[0] || null;
        if (market) {
          attempt.matched = true;
          found = market;
          foundCategory = category;
          foundVia = 'category-by-slug';
        } else {
          attempt.rejectedReason = `category 找到但 markets 为空 (marketsCount=${category.marketsCount ?? 0})`;
        }
      } else {
        attempt.rejectedReason = `category.slug=${category?.slug || '(无)'} 不匹配输入 slug`;
      }
    }
    attempts.push(attempt);
  }

  // ========== 优先级 2: /v1/search?q=<slug> ==========
  if (!found) {
    const { attempt, body } = await tryFetch(
      'GET /v1/search?q=<slug>',
      `${PREDICT_REST_BASE}/search?q=${encodeURIComponent(slug)}`,
      headers
    );
    if (attempt.status === 200) {
      const candidates: any[] = [];
      // search 可能返回 { markets: [...], categories: [...] } 或 { data: ... }
      const root = body?.data || body;
      if (Array.isArray(root?.markets)) candidates.push(...root.markets);
      if (Array.isArray(root?.categories)) {
        for (const c of root.categories) {
          if (Array.isArray(c.markets)) candidates.push(...c.markets);
        }
      }
      if (Array.isArray(root)) candidates.push(...root.filter(looksLikeMarket));
      const market = candidates.find((m) => exactSlugMatch(m, slug));
      if (market) {
        attempt.matched = true;
        found = market;
        foundVia = 'search';
      } else if (candidates.length) {
        attempt.rejectedReason = `search 返回 ${candidates.length} 条，但都不匹配 slug`;
      } else {
        attempt.rejectedReason = 'search 没返回 market candidates';
      }
    }
    attempts.push(attempt);
  }

  // ========== 优先级 3: /v1/markets/<slug> 单查 ==========
  if (!found) {
    const { attempt, body } = await tryFetch(
      'GET /v1/markets/<slug>',
      `${PREDICT_REST_BASE}/markets/${encodeURIComponent(slug)}`,
      headers
    );
    if (attempt.status === 200) {
      const market = body?.data || body;
      if (looksLikeMarket(market) && exactSlugMatch(market, slug)) {
        attempt.matched = true;
        found = market;
        foundVia = 'markets-by-slug';
      } else {
        attempt.rejectedReason = '响应 market.slug 不匹配输入';
      }
    }
    attempts.push(attempt);
  }

  // ========== 优先级 4: deepScan 兜底 ==========
  let deepScanInfo:
    | {
        pagesFetched: number;
        totalScanned: number;
        totalUniqueIds?: number;
        stoppedReason?: string;
        paginationMode?: string;
        matchedId?: string;
      }
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
          lower(m.slug) === lower(slug) ||
          lower(m.categorySlug) === lower(slug) ||
          lower(m.id) === lower(slug)
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

  // ========== 组装 summary ==========
  let summary: Record<string, unknown> | null = null;
  if (found) {
    const ids = polymarketIds(found);
    summary = {
      ...(foundCategory
        ? {
            categoryId: foundCategory.id,
            categorySlug: foundCategory.slug,
            categoryTitle: foundCategory.title,
            categoryStatus: foundCategory.status,
            marketsInCategory: pickMarkets(foundCategory).length
          }
        : {}),
      id: found.id,
      title: found.title ?? found.question ?? null,
      slug: found.slug ?? null,
      categorySlug: found.categorySlug ?? null,
      status: found.status ?? null,
      tradingStatus: found.tradingStatus ?? null,
      isResolved: found.isResolved ?? null,
      endsAt: found.endsAt ?? null,
      polymarketConditionIds: ids,
      hasPolymarket: ids.length > 0
    };
  }

  const conclusion = !found
    ? deepScan
      ? '❌ category / search / markets / deepScan 都没找到。slug 可能拼错，或不在 REST 暴露的范围。'
      : '❌ category / search / markets 都没找到。可加 &deepScan=1 让我扫全量再确认。'
    : buildConclusion(found);

  return NextResponse.json({
    ok: true,
    input,
    extractedSlug: slug,
    found: !!found,
    foundVia,
    conclusion,
    summary,
    rawCategory: foundCategory,
    rawMarket: found,
    deepScan: deepScanInfo,
    attempts: attempts.map((a) => ({
      label: a.label,
      url: a.url,
      status: a.status,
      matched: a.matched ?? false,
      rejectedReason: a.rejectedReason,
      error: a.error
    }))
  });
}
