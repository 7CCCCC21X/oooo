import { fetchJson, fetchJsonWithHeaders } from './fetch-json';
import type { PredictMarketSummary } from './types';

const PREDICT_REST_BASE = 'https://api.predict.fun/v1';
const PREDICT_WEB_BASE = 'https://predict.fun';

export function predictMarketUrl(m: { id: string; slug?: string; categorySlug?: string }): string {
  const slug = m.slug || m.categorySlug;
  if (slug) return `${PREDICT_WEB_BASE}/market/${slug}`;
  return `${PREDICT_WEB_BASE}/market/${m.id}`;
}

const CLOSED_STATUSES = new Set([
  'CLOSED',
  'RESOLVED',
  'PAUSED',
  'CANCELLED',
  'CANCELED',
  'ARCHIVED',
  'EXPIRED',
  'SETTLED',
  'INACTIVE'
]);

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
};

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function stringArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed.filter(Boolean).map(String);
      } catch {}
    }
    return trimmed.split(/[\s,]+/).filter(Boolean);
  }
  return [];
}

function pickArray(raw: unknown): unknown[] {
  const root = raw as any;
  if (Array.isArray(root)) return root;
  if (Array.isArray(root?.data)) return root.data;
  if (Array.isArray(root?.data?.markets)) return root.data.markets;
  if (Array.isArray(root?.data?.items)) return root.data.items;
  if (Array.isArray(root?.markets)) return root.markets;
  if (Array.isArray(root?.items)) return root.items;
  if (Array.isArray(root?.results)) return root.results;
  if (Array.isArray(root?.nodes)) return root.nodes;
  if (Array.isArray(root?.edges)) return root.edges.map((e: any) => e?.node ?? e).filter(Boolean);
  return [];
}

function tsOf(value: unknown): number | null {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  const p = Date.parse(String(value));
  return Number.isFinite(p) ? p : null;
}

function isTimingActive(t: any, now: number): boolean {
  if (!t || typeof t !== 'object') return false;
  for (const k of ['startsAt', 'startTime', 'startAt']) {
    const ts = tsOf(t[k]);
    if (ts != null && ts > now) return false;
  }
  for (const k of ['endsAt', 'endTime', 'endAt']) {
    const ts = tsOf(t[k]);
    if (ts != null && ts <= now) return false;
  }
  if (t.isActive === false) return false;
  return true;
}

function sumHourlyRateRecursive(value: any): number {
  if (value == null) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (Array.isArray(value)) {
    let total = 0;
    for (const item of value) total += sumHourlyRateRecursive(item);
    return total;
  }
  if (typeof value === 'object') {
    let total = 0;
    for (const [k, v] of Object.entries(value)) {
      if (k === 'hourlyRate' || k === 'hourly_rate' || k === 'hourly' || k === 'rate') {
        const n = Number(v);
        if (Number.isFinite(n)) total += n;
      } else if (typeof v === 'object' && v !== null) {
        total += sumHourlyRateRecursive(v);
      }
    }
    return total;
  }
  return 0;
}

export function parseEndFromTitle(title: string | undefined | null): number | null {
  if (!title) return null;
  const monthMatch = title.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2})(?:[,\s]+(20\d{2}))?/i);
  if (!monthMatch) return null;
  const month = MONTHS[monthMatch[1].slice(0, 3).toLowerCase()];
  const day = Number(monthMatch[2]);
  const year = monthMatch[3] ? Number(monthMatch[3]) : new Date().getUTCFullYear();
  const timeMatch = title.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s*ET/i);
  if (!timeMatch) return null;
  let hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2] ?? 0);
  const ampm = timeMatch[3].toUpperCase();
  if (ampm === 'PM' && hour !== 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;
  const isEdt = month >= 2 && month <= 10;
  const utcHour = hour + (isEdt ? 4 : 5);
  return Date.UTC(year, month, day, utcHour, minute);
}

export function marketEndMs(m: any): number | null {
  if (!m) return null;
  for (const f of ['endsAt', 'endTime', 'endsAtTimestamp', 'closeTime', 'end_date', 'endDate']) {
    const v = m[f];
    if (v == null || v === '') continue;
    const ts = tsOf(v);
    if (ts != null) return ts;
  }
  for (const s of [m.title, m.question, m.categorySlug, m.slug, m.marketSlug]) {
    const ts = parseEndFromTitle(s);
    if (ts != null) return ts;
  }
  return null;
}

export function extractHourlyRate(market: any): { rate: number; source: 'current' | 'schedule' | 'recursive' | 'none' } {
  if (market == null) return { rate: 0, source: 'none' };

  const cur = market?.rewards?.current?.hourlyRate;
  if (cur != null) {
    const n = Number(cur);
    return { rate: Number.isFinite(n) ? n : 0, source: 'current' };
  }

  if (Array.isArray(market?.rewards?.schedule)) {
    const now = Date.now();
    const active = market.rewards.schedule.find((s: any) => isTimingActive(s, now));
    if (active != null) {
      const n = Number(active.hourlyRate);
      return { rate: Number.isFinite(n) ? n : 0, source: 'schedule' };
    }
    return { rate: 0, source: 'schedule' };
  }

  if (Array.isArray(market?.rewardTimings)) {
    const now = Date.now();
    const endMs = marketEndMs(market);
    if (endMs != null && endMs <= now) return { rate: 0, source: 'recursive' };
    const total = market.rewardTimings
      .filter((r: any) => isTimingActive(r, now))
      .map((r: any) => Number(r?.hourlyRate))
      .filter((n: number) => Number.isFinite(n))
      .reduce((a: number, b: number) => a + b, 0);
    return { rate: total, source: 'recursive' };
  }

  if (market && typeof market === 'object' && 'rewards' in market) {
    return { rate: sumHourlyRateRecursive(market.rewards), source: 'recursive' };
  }
  return { rate: 0, source: 'none' };
}

function isTradeable(market: any, endMs: number | null): boolean {
  if (!market) return false;
  if (market.isResolved === true) return false;
  if (market.resolvedAt != null) return false;
  const status = String(market.tradingStatus ?? market.status ?? '').toUpperCase();
  if (status && CLOSED_STATUSES.has(status)) return false;
  if (endMs != null && endMs <= Date.now()) return false;
  return true;
}

function priceFromOutcome(market: any, label: 'Yes' | 'No'): number | null {
  const outcomes = market?.outcomes || market?.tokens || [];
  if (!Array.isArray(outcomes)) return null;
  const match = outcomes.find(
    (o: any) => String(o?.name || o?.outcome || o?.label || '').trim().toLowerCase() === label.toLowerCase()
  );
  if (match) {
    const price = numberOrNull(match.price ?? match.lastPrice ?? match.midPrice ?? match.last_price);
    if (price !== null) return price;
  }
  if (label === 'Yes') {
    return numberOrNull(market?.yesPrice ?? market?.yes_price ?? market?.lastYesPrice ?? market?.last_yes_price);
  }
  return numberOrNull(market?.noPrice ?? market?.no_price ?? market?.lastNoPrice ?? market?.last_no_price);
}

export function normalizeMarket(raw: any): PredictMarketSummary {
  const id = String(raw?.id ?? raw?.marketId ?? raw?.market_id ?? '').trim();
  const title = String(raw?.title ?? raw?.question ?? raw?.name ?? '').trim();
  const question = raw?.question ? String(raw.question) : undefined;
  const slug = raw?.slug || raw?.marketSlug ? String(raw.slug || raw.marketSlug) : undefined;
  const categorySlug = raw?.categorySlug || raw?.category_slug ? String(raw.categorySlug || raw.category_slug) : undefined;
  const status = raw?.status ? String(raw.status) : undefined;
  const tradingStatus = raw?.tradingStatus ? String(raw.tradingStatus) : undefined;
  const isResolved = typeof raw?.isResolved === 'boolean' ? raw.isResolved : undefined;
  const closed = typeof raw?.closed === 'boolean' ? raw.closed : undefined;
  const active = typeof raw?.active === 'boolean' ? raw.active : undefined;
  const category = raw?.category ? String(raw.category) : raw?.categoryName ? String(raw.categoryName) : undefined;
  const endMs = marketEndMs(raw);
  const volume = numberOrNull(raw?.volume ?? raw?.totalVolume ?? raw?.total_volume) ?? undefined;
  const liquidity = numberOrNull(raw?.liquidity ?? raw?.totalLiquidity ?? raw?.total_liquidity) ?? undefined;
  const polymarketConditionIds = stringArray(raw?.polymarketConditionIds ?? raw?.polymarket_condition_ids);
  const spreadThreshold = numberOrNull(raw?.spreadThreshold) ?? undefined;
  const shareThreshold = numberOrNull(raw?.shareThreshold) ?? undefined;
  const { rate, source } = extractHourlyRate(raw);
  return {
    id,
    title,
    question,
    slug,
    categorySlug,
    status,
    tradingStatus,
    isResolved,
    closed,
    active,
    category,
    endDate: endMs ? new Date(endMs).toISOString() : undefined,
    endMs,
    volume,
    liquidity,
    yesPrice: priceFromOutcome(raw, 'Yes'),
    noPrice: priceFromOutcome(raw, 'No'),
    hourlyRate: rate,
    hourlyRateSource: source,
    spreadThreshold,
    shareThreshold,
    polymarketConditionIds,
    hasPolymarket: polymarketConditionIds.length > 0,
    tradeable: isTradeable(raw, endMs)
  };
}

type FetchOptions = {
  limit?: number;
  maxPages?: number;
  includeClosed?: boolean;
  hasActiveRewards?: boolean;
};

function pickCursorFromResponse(raw: unknown): string {
  const root = raw as any;
  return String(
    root?.cursor ||
      root?.nextCursor ||
      root?.next_cursor ||
      root?.endCursor ||
      root?.end_cursor ||
      root?.data?.cursor ||
      root?.data?.nextCursor ||
      root?.data?.next_cursor ||
      root?.data?.endCursor ||
      root?.pageInfo?.endCursor ||
      root?.page_info?.end_cursor ||
      root?.pagination?.nextCursor ||
      root?.pagination?.next_cursor ||
      root?.pagination?.endCursor ||
      root?.meta?.cursor ||
      root?.meta?.nextCursor ||
      ''
  );
}

export async function fetchAllPredictMarkets(options: FetchOptions = {}): Promise<{
  markets: PredictMarketSummary[];
  pagesFetched: number;
  stoppedReason: string;
  sampleRaw?: unknown;
  rawWrapperKeys?: string[];
  paginationMode?: string;
  totalUniqueIds?: number;
}> {
  const apiKey = process.env.PREDICT_API_KEY;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;

  const limit = options.limit ?? 100;
  const maxPages = options.maxPages ?? 50;
  const includeClosed = options.includeClosed ?? false;
  const hasActiveRewards = options.hasActiveRewards ?? false;

  // Predict 文档明确说 /v1/markets 用 ?first=&after=<cursor>，cursor 来自响应
  const paginationMode = 'cursor';

  const all: PredictMarketSummary[] = [];
  const seenIds = new Set<string>();
  let cursor: string | null = null;
  let lastCursor: string | null = null;
  let pagesFetched = 0;
  let stoppedReason = 'exhausted';
  let sampleRaw: unknown = undefined;
  let rawWrapperKeys: string[] | undefined = undefined;
  let emptyPagesInARow = 0;

  while (pagesFetched < maxPages) {
    const params = new URLSearchParams();
    params.set('first', String(limit));
    if (cursor) params.set('after', cursor);
    if (hasActiveRewards) params.set('hasActiveRewards', 'true');

    const url = `${PREDICT_REST_BASE}/markets?${params.toString()}`;
    const raw = await fetchJson(url, { headers });
    pagesFetched += 1;

    if (!rawWrapperKeys && raw && typeof raw === 'object' && !Array.isArray(raw)) {
      rawWrapperKeys = Object.keys(raw as object);
    }
    const rows = pickArray(raw);
    if (!sampleRaw && rows.length) sampleRaw = rows[0];

    if (!rows.length) {
      emptyPagesInARow += 1;
      if (emptyPagesInARow >= 2) {
        stoppedReason = 'empty-page';
        break;
      }
      continue;
    }
    emptyPagesInARow = 0;

    const sizeBefore = seenIds.size;
    let lastRowId: string | null = null;
    for (const row of rows) {
      const r = row as any;
      const id = String(r?.id ?? r?.marketId ?? r?.market_id ?? '').trim();
      if (!id) continue;
      lastRowId = id;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      const summary = normalizeMarket(r);
      if (!includeClosed && !summary.tradeable) continue;
      all.push(summary);
    }
    const newUniqueThisPage = seenIds.size - sizeBefore;

    // 优先从响应取 cursor；没有就退而用最后一行 id
    const nextCursor = pickCursorFromResponse(raw) || lastRowId || '';
    if (!nextCursor) {
      stoppedReason = 'no-cursor-found';
      break;
    }
    if (nextCursor === lastCursor) {
      stoppedReason = 'cursor-not-advancing';
      break;
    }
    if (pagesFetched > 1 && newUniqueThisPage === 0) {
      stoppedReason = 'no-new-ids';
      break;
    }
    lastCursor = nextCursor;
    cursor = nextCursor;
  }

  if (pagesFetched >= maxPages && stoppedReason === 'exhausted') {
    stoppedReason = `hit-max-pages-${maxPages}`;
  }

  return {
    markets: all,
    pagesFetched,
    stoppedReason,
    sampleRaw,
    rawWrapperKeys,
    paginationMode,
    totalUniqueIds: seenIds.size
  };
}

export function filterPredictOnly(markets: PredictMarketSummary[]): PredictMarketSummary[] {
  return markets.filter((m) => !m.hasPolymarket);
}

// ============================================================
// /v1/categories 遍历方案
// predict.fun 真正的数据结构入口：所有市场都挂在 category 下
// （esports / competition / event 等都只在 category 里出现）
// ============================================================

export type PredictCategoryRaw = {
  id: string | number;
  slug?: string;
  title?: string;
  status?: string;
  marketsCount?: number;
  markets?: any[];
  [key: string]: any;
};

function pickCursorFromHeaders(headers: Record<string, string>): string {
  // 常见的 cursor header
  return String(
    headers['x-next-cursor'] ||
      headers['x-cursor'] ||
      headers['next-cursor'] ||
      headers['x-pagination-cursor'] ||
      ''
  );
}

function parseLinkHeader(link: string | undefined): string {
  if (!link) return '';
  // Link: <url>; rel="next", <url>; rel="prev"
  const m = link.match(/<([^>]+)>\s*;\s*rel="next"/i);
  if (!m) return '';
  try {
    const u = new URL(m[1]);
    return u.searchParams.get('after') || u.searchParams.get('cursor') || '';
  } catch {
    return '';
  }
}

export async function fetchAllPredictCategories(options: { limit?: number; maxPages?: number } = {}): Promise<{
  categories: PredictCategoryRaw[];
  pagesFetched: number;
  stoppedReason: string;
  totalUniqueIds: number;
  firstPageDebug?: { responseKeys: string[] | null; headerKeys: string[]; sampleHeaderValues: Record<string, string> };
}> {
  const apiKey = process.env.PREDICT_API_KEY;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;

  const limit = options.limit ?? 100;
  const maxPages = options.maxPages ?? 100;

  const all: PredictCategoryRaw[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  let lastCursor: string | null = null;
  let pagesFetched = 0;
  let stoppedReason = 'exhausted';
  let emptyPagesInARow = 0;
  let firstPageDebug: { responseKeys: string[] | null; headerKeys: string[]; sampleHeaderValues: Record<string, string> } | undefined;

  while (pagesFetched < maxPages) {
    const params = new URLSearchParams();
    params.set('first', String(limit));
    if (cursor) params.set('after', cursor);

    const url = `${PREDICT_REST_BASE}/categories?${params.toString()}`;
    let raw: unknown;
    let respHeaders: Record<string, string> = {};
    try {
      const r = await fetchJsonWithHeaders(url, { headers });
      raw = r.json;
      respHeaders = r.headers;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('invalid_cursor') || msg.includes('400')) {
        stoppedReason = `cursor-rejected-page-${pagesFetched + 1}: ${msg.slice(0, 150)}`;
        console.warn(`[predict] cursor rejected after page ${pagesFetched}, keeping partial data:`, msg.slice(0, 200));
        break;
      }
      // 其它错（429/5xx 等）：保留已抓到的，停
      stoppedReason = `fetch-error-page-${pagesFetched + 1}: ${msg.slice(0, 150)}`;
      console.warn(`[predict] fetch error after page ${pagesFetched}, keeping partial:`, msg.slice(0, 200));
      break;
    }
    pagesFetched += 1;

    if (pagesFetched === 1) {
      const isArr = Array.isArray(raw);
      const cursorRelatedHeaders: Record<string, string> = {};
      for (const k of Object.keys(respHeaders)) {
        if (k.toLowerCase().includes('cursor') || k.toLowerCase() === 'link' || k.toLowerCase().includes('next') || k.toLowerCase().includes('page')) {
          cursorRelatedHeaders[k] = respHeaders[k];
        }
      }
      firstPageDebug = {
        responseKeys: isArr ? null : raw && typeof raw === 'object' ? Object.keys(raw as object) : null,
        headerKeys: Object.keys(respHeaders),
        sampleHeaderValues: cursorRelatedHeaders
      };
      console.log(`[predict] /v1/categories page 1: isArray=${isArr}, headers=${Object.keys(cursorRelatedHeaders).join(',') || '(none related)'}`);
    }

    const rows = pickArray(raw);
    if (!rows.length) {
      emptyPagesInARow += 1;
      if (emptyPagesInARow >= 2) {
        stoppedReason = 'empty-page';
        break;
      }
      continue;
    }
    emptyPagesInARow = 0;

    const sizeBefore = seen.size;
    let lastRowId: string | null = null;
    let lastRowSlug: string | null = null;
    for (const row of rows) {
      const r = row as PredictCategoryRaw;
      const id = String(r?.id ?? '').trim();
      if (!id) continue;
      lastRowId = id;
      if (r?.slug) lastRowSlug = String(r.slug);
      if (seen.has(id)) continue;
      seen.add(id);
      all.push(r);
    }
    const newUniqueThisPage = seen.size - sizeBefore;

    // 多个 cursor 候选，优先级 headers > response body > lastSlug > lastId
    const headerCursor = pickCursorFromHeaders(respHeaders) || parseLinkHeader(respHeaders['link']);
    const bodyCursor = pickCursorFromResponse(raw);
    const nextCursor = headerCursor || bodyCursor || lastRowSlug || lastRowId || '';

    if (!nextCursor) {
      stoppedReason = 'no-cursor-found';
      break;
    }
    if (nextCursor === lastCursor) {
      stoppedReason = 'cursor-not-advancing';
      break;
    }
    if (pagesFetched > 1 && newUniqueThisPage === 0) {
      stoppedReason = 'no-new-ids';
      break;
    }
    lastCursor = nextCursor;
    cursor = nextCursor;
  }

  if (pagesFetched >= maxPages && stoppedReason === 'exhausted') {
    stoppedReason = `hit-max-pages-${maxPages}`;
  }

  return {
    categories: all,
    pagesFetched,
    stoppedReason,
    totalUniqueIds: seen.size,
    firstPageDebug
  };
}

// 把 categories 里嵌入的 markets 拉平，去重，normalize
export function flattenCategoryMarkets(
  categories: PredictCategoryRaw[],
  options: { includeClosed?: boolean } = {}
): { markets: PredictMarketSummary[]; categoriesWithoutMarkets: number; totalMarketIds: number } {
  const includeClosed = options.includeClosed ?? true;
  const out: PredictMarketSummary[] = [];
  const seenMarketIds = new Set<string>();
  let categoriesWithoutMarkets = 0;

  for (const cat of categories) {
    const markets = Array.isArray(cat.markets) ? cat.markets : [];
    if (!markets.length) {
      categoriesWithoutMarkets += 1;
      continue;
    }
    for (const m of markets) {
      const id = String(m?.id ?? '').trim();
      if (!id || seenMarketIds.has(id)) continue;
      seenMarketIds.add(id);
      // 补 category 信息到 market 对象再 normalize
      const enriched = {
        ...m,
        categorySlug: m.categorySlug ?? cat.slug,
        categoryTitle: cat.title,
        categoryStatus: cat.status
      };
      const summary = normalizeMarket(enriched);
      if (!includeClosed && !summary.tradeable) continue;
      out.push(summary);
    }
  }
  return { markets: out, categoriesWithoutMarkets, totalMarketIds: seenMarketIds.size };
}

// 综合版：先扫所有 categories，提取嵌入的 markets。
// 这是 bot / 列表页应该用的入口，覆盖最全（包括 esports / event 类）。
export async function fetchAllPredictMarketsViaCategories(options: {
  limit?: number;
  maxPages?: number;
  includeClosed?: boolean;
} = {}): Promise<{
  markets: PredictMarketSummary[];
  pagesFetched: number;
  stoppedReason: string;
  totalCategories: number;
  totalUniqueMarketIds: number;
  categoriesWithoutMarkets: number;
  source: 'categories';
}> {
  const { categories, pagesFetched, stoppedReason, totalUniqueIds } = await fetchAllPredictCategories({
    limit: options.limit,
    maxPages: options.maxPages
  });
  const { markets, categoriesWithoutMarkets, totalMarketIds } = flattenCategoryMarkets(categories, {
    includeClosed: options.includeClosed ?? true
  });
  return {
    markets,
    pagesFetched,
    stoppedReason,
    totalCategories: totalUniqueIds,
    totalUniqueMarketIds: totalMarketIds,
    categoriesWithoutMarkets,
    source: 'categories'
  };
}
