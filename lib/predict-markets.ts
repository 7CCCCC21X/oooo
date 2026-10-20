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
  if (market.closed === true) return false;
  if (market.active === false) return false;
  // 市场自身状态 + 交易状态都要看（两者可能不一致，任一关闭即不可交易）
  for (const v of [market.tradingStatus, market.status]) {
    const status = String(v ?? '').toUpperCase();
    if (status && CLOSED_STATUSES.has(status)) return false;
  }
  // 父 category 已 RESOLVED/CLOSED 时，里面的市场不可交易（predict 文档明确）
  const catStatus = String(market.categoryStatus ?? '').toUpperCase();
  if (catStatus && CLOSED_STATUSES.has(catStatus)) return false;
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
  const categoryTitle = raw?.categoryTitle || raw?.category_title ? String(raw.categoryTitle || raw.category_title) : undefined;
  const status = raw?.status ? String(raw.status) : undefined;
  const tradingStatus = raw?.tradingStatus ? String(raw.tradingStatus) : undefined;
  const isResolved = typeof raw?.isResolved === 'boolean' ? raw.isResolved : undefined;
  const closed = typeof raw?.closed === 'boolean' ? raw.closed : undefined;
  const active = typeof raw?.active === 'boolean' ? raw.active : undefined;
  const category = raw?.category ? String(raw.category) : raw?.categoryName ? String(raw.categoryName) : undefined;
  const categoryStatus = raw?.categoryStatus ? String(raw.categoryStatus) : undefined;
  const isNegRisk = typeof raw?.isNegRisk === 'boolean' ? raw.isNegRisk : typeof raw?.is_neg_risk === 'boolean' ? raw.is_neg_risk : undefined;
  const questionIndexRaw = numberOrNull(raw?.questionIndex ?? raw?.question_index);
  const questionIndex = questionIndexRaw == null ? undefined : questionIndexRaw;
  const negRiskOnChainId = raw?.negRiskOnChainId ? String(raw.negRiskOnChainId) : undefined;
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
    categoryTitle,
    status,
    tradingStatus,
    isResolved,
    closed,
    active,
    category,
    categoryStatus,
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
    tradeable: isTradeable(raw, endMs),
    isNegRisk,
    questionIndex,
    negRiskOnChainId
  };
}

// 把一个 category 里嵌的 markets 补上 category 信息后 normalize（去重按 id）
export function normalizeCategoryMarkets(cat: any): PredictMarketSummary[] {
  const markets = Array.isArray(cat?.markets) ? cat.markets : [];
  const out: PredictMarketSummary[] = [];
  const seen = new Set<string>();
  for (const m of markets) {
    const id = String(m?.id ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const negRiskOnChainId = m?.negRiskOnChainId ?? cat?.negRiskOnChainId;
    out.push(
      normalizeMarket({
        ...m,
        categorySlug: m?.categorySlug ?? cat?.slug,
        categoryTitle: cat?.title,
        categoryStatus: cat?.status,
        negRiskOnChainId,
        // 市场没带 isNegRisk 但类目有链上 NegRisk id → 也算 NegRisk
        isNegRisk: typeof m?.isNegRisk === 'boolean' ? m.isNegRisk : negRiskOnChainId ? true : undefined
      })
    );
  }
  return out;
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

// 响应里是否"明确带了 cursor 字段"（哪怕值是 null/空串）。
// 带了但为空 = 服务端说没有下一页，应视为翻到底，而不是退回 lastId 再试一次换来 400。
const CURSOR_KEYS = ['cursor', 'nextCursor', 'next_cursor', 'endCursor', 'end_cursor'];
function responseDeclaresCursor(raw: unknown): boolean {
  const root = raw as any;
  if (!root || typeof root !== 'object') return false;
  for (const holder of [root, root.data, root.pageInfo, root.page_info, root.pagination, root.meta]) {
    if (holder && typeof holder === 'object' && CURSOR_KEYS.some((k) => k in holder)) return true;
  }
  return false;
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

// 噪音市场关键词排除。
// baseline 始终生效（除非 DISABLE_NOISE_FILTER=1），覆盖高频重复的 "up or down" 类。
// EXCLUDE_TITLE_KEYWORDS 在 baseline 之上追加更多关键词。
const BASELINE_NOISE_KEYWORDS = ['up or down', 'updown', 'up-or-down'];

function getExcludeKeywords(): string[] {
  if (process.env.DISABLE_NOISE_FILTER === '1') return [];
  const set = new Set<string>(BASELINE_NOISE_KEYWORDS);
  const env = process.env.EXCLUDE_TITLE_KEYWORDS;
  if (env && env.trim()) {
    for (const k of env.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
      set.add(k);
    }
  }
  return [...set];
}

export function getActiveExcludeKeywords(): string[] {
  return getExcludeKeywords();
}

export function isNoiseMarket(m: PredictMarketSummary): boolean {
  const keywords = getExcludeKeywords();
  if (!keywords.length) return false;
  const blob = [m.title, m.categoryTitle, m.category, m.categorySlug, m.slug]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return keywords.some((k) => blob.includes(k));
}

export function filterOutNoise(markets: PredictMarketSummary[]): PredictMarketSummary[] {
  const keywords = getExcludeKeywords();
  if (!keywords.length) return markets;
  return markets.filter((m) => !isNoiseMarket(m));
}

// ============================================================
// 统一的筛选入口：bot / 订阅推送 / API 都走这里，保证口径一致。
// 顺序：polymarket 过滤 → 噪音过滤 → 可交易 → PP 门槛，每步计数便于排查"为什么少了"。
// ============================================================
export type SelectOptions = {
  predictOnly?: boolean;      // 只要没有 polymarket 映射的（默认 true）
  includeNoise?: boolean;     // 保留噪音市场（默认 false）
  tradeableOnly?: boolean;    // 只要可交易的（默认 true）
  requireRewards?: boolean;   // 只要 PP/h > 0 的（默认 true）
  minHourlyRate?: number;     // PP/h 下限（默认 0）
};

export type SelectStats = {
  input: number;
  afterPolymarket: number;
  afterNoise: number;
  afterTradeable: number;
  afterRewards: number;
  output: number;
};

export function selectEligibleMarkets(
  markets: PredictMarketSummary[],
  options: SelectOptions = {}
): { markets: PredictMarketSummary[]; stats: SelectStats } {
  const predictOnly = options.predictOnly ?? true;
  const includeNoise = options.includeNoise ?? false;
  const tradeableOnly = options.tradeableOnly ?? true;
  const requireRewards = options.requireRewards ?? true;
  const minHourlyRate = Number.isFinite(options.minHourlyRate) ? Number(options.minHourlyRate) : 0;

  let list = markets;
  const stats: SelectStats = { input: list.length, afterPolymarket: 0, afterNoise: 0, afterTradeable: 0, afterRewards: 0, output: 0 };

  if (predictOnly) list = filterPredictOnly(list);
  stats.afterPolymarket = list.length;

  if (!includeNoise) list = filterOutNoise(list);
  stats.afterNoise = list.length;

  if (tradeableOnly) list = list.filter((m) => m.tradeable);
  stats.afterTradeable = list.length;

  if (requireRewards) list = list.filter((m) => (m.hourlyRate || 0) > 0);
  if (minHourlyRate > 0) list = list.filter((m) => (m.hourlyRate || 0) >= minHourlyRate);
  stats.afterRewards = list.length;

  list = [...list].sort((a, b) => (b.hourlyRate || 0) - (a.hourlyRate || 0));
  stats.output = list.length;
  return { markets: list, stats };
}

// 选出来的市场按 event 分组 + 只留有 PP 的 event，按总 PP/h 降序
export function selectEligibleGroups(markets: PredictMarketSummary[], options: SelectOptions = {}): {
  groups: MarketGroup[];
  stats: SelectStats;
} {
  const { markets: eligible, stats } = selectEligibleMarkets(markets, options);
  const requireRewards = options.requireRewards ?? true;
  let groups = groupMarketsByCategory(eligible);
  if (requireRewards) groups = groups.filter((g) => g.totalHourlyRate > 0);
  groups.sort((a, b) => (b.totalHourlyRate || 0) - (a.totalHourlyRate || 0));
  return { groups, stats };
}

export type MarketGroup = {
  slug: string;
  title: string;
  markets: PredictMarketSummary[];
  totalHourlyRate: number;
  url: string;
  endMs: number | null;
};

// 按 categorySlug 分组（同一个 event 的子市场合并）
export function groupMarketsByCategory(markets: PredictMarketSummary[]): MarketGroup[] {
  const map = new Map<string, PredictMarketSummary[]>();
  for (const m of markets) {
    const key = (m.categorySlug || m.slug || m.id || '').toLowerCase();
    if (!key) continue;
    const list = map.get(key) || [];
    list.push(m);
    map.set(key, list);
  }
  return Array.from(map.entries()).map(([slug, list]) => {
    // 排序子市场让显示稳定：PP/h 降序
    list.sort((a, b) => (b.hourlyRate || 0) - (a.hourlyRate || 0));
    const first = list[0];
    const title = first.categoryTitle || first.category || first.title || slug;
    const ends = list.map((m) => m.endMs).filter((v): v is number => typeof v === 'number');
    return {
      slug,
      title,
      markets: list,
      totalHourlyRate: list.reduce((s, m) => s + (m.hourlyRate || 0), 0),
      url: predictMarketUrl(first),
      endMs: ends.length ? Math.max(...ends) : null
    };
  });
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

// 只抓这些状态的 category（服务端过滤，省掉已结算的几千页）。
// 默认 OPEN；设 PREDICT_CATEGORY_STATUS=none 关闭服务端过滤。
export function getCategoryStatusFilter(): string | null {
  const env = process.env.PREDICT_CATEGORY_STATUS;
  if (env == null) return 'OPEN';
  const v = env.trim();
  if (!v || v.toLowerCase() === 'none' || v === '0') return null;
  return v;
}

// 这些结束原因代表"翻到底了"，其余（页数上限 / 报错）都算不完整
const COMPLETE_STOP_REASONS = new Set(['exhausted', 'empty-page', 'no-new-ids', 'cursor-not-advancing']);
export function isCompleteStop(stoppedReason: string): boolean {
  return COMPLETE_STOP_REASONS.has(stoppedReason);
}

function isRetryableFetchError(msg: string): boolean {
  if (/HTTP 4\d\d/.test(msg) && !/HTTP 429/.test(msg)) return false; // 4xx（除 429）不重试
  return true; // 429 / 5xx / 超时 / 网络断 都重试
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 带重试的单页抓取：429/5xx/超时 最多重试 PREDICT_FETCH_RETRIES 次（默认 4），指数退避
async function fetchPageWithRetry(url: string, headers: Record<string, string>) {
  const maxAttempts = 1 + (Number(process.env.PREDICT_FETCH_RETRIES) || 4);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fetchJsonWithHeaders(url, { headers });
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!isRetryableFetchError(msg) || attempt === maxAttempts) throw err;
      const wait = Math.min(15_000, 1000 * 2 ** (attempt - 1));
      console.warn(`[predict] page fetch failed (attempt ${attempt}/${maxAttempts}), retry in ${wait}ms: ${msg.slice(0, 160)}`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

export async function fetchAllPredictCategories(
  options: { limit?: number; maxPages?: number; status?: string | null } = {}
): Promise<{
  categories: PredictCategoryRaw[];
  pagesFetched: number;
  stoppedReason: string;
  totalUniqueIds: number;
  complete: boolean;
  statusFilter: string | null;
  pageSize: number;
  firstPageDebug?: { responseKeys: string[] | null; headerKeys: string[]; sampleHeaderValues: Record<string, string> };
}> {
  const apiKey = process.env.PREDICT_API_KEY;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;

  const limit = options.limit ?? 100;
  const maxPages = options.maxPages ?? 100;
  let statusFilter: string | null = options.status === undefined ? getCategoryStatusFilter() : options.status;

  const all: PredictCategoryRaw[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  let lastCursor: string | null = null;
  let pagesFetched = 0;
  let stoppedReason = 'exhausted';
  let emptyPagesInARow = 0;
  let pageSize = 0;
  let firstPageDebug: { responseKeys: string[] | null; headerKeys: string[]; sampleHeaderValues: Record<string, string> } | undefined;

  const buildUrl = () => {
    const params = new URLSearchParams();
    params.set('first', String(limit));
    if (cursor) params.set('after', cursor);
    if (statusFilter) params.set('status', statusFilter);
    return `${PREDICT_REST_BASE}/categories?${params.toString()}`;
  };

  while (pagesFetched < maxPages) {
    let raw: unknown;
    let respHeaders: Record<string, string> = {};
    try {
      const r = await fetchPageWithRetry(buildUrl(), headers);
      raw = r.json;
      respHeaders = r.headers;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 第一页就被 400 拒绝且带了 status 过滤：多半是 status 取值不被接受 → 去掉过滤重来
      if (pagesFetched === 0 && statusFilter && /HTTP 400/.test(msg)) {
        console.warn(`[predict] status=${statusFilter} rejected by API, falling back to unfiltered crawl: ${msg.slice(0, 160)}`);
        statusFilter = null;
        continue;
      }
      if (msg.includes('invalid_cursor') || /HTTP 400/.test(msg)) {
        stoppedReason = `cursor-rejected-page-${pagesFetched + 1}: ${msg.slice(0, 150)}`;
        console.warn(`[predict] cursor rejected after page ${pagesFetched}, keeping partial data:`, msg.slice(0, 200));
        break;
      }
      // 重试用尽仍失败：保留已抓到的，停
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
    // 带 status 过滤的第一页就是空的：过滤值可能不匹配（比如大小写），退回全量抓取
    if (!rows.length && pagesFetched === 1 && statusFilter) {
      console.warn(`[predict] status=${statusFilter} returned 0 categories on page 1, falling back to unfiltered crawl`);
      statusFilter = null;
      pagesFetched = 0;
      continue;
    }
    if (!rows.length) {
      emptyPagesInARow += 1;
      if (emptyPagesInARow >= 2) {
        stoppedReason = 'empty-page';
        break;
      }
      continue;
    }
    emptyPagesInARow = 0;
    pageSize = Math.max(pageSize, rows.length);

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
    if (!headerCursor && !bodyCursor && responseDeclaresCursor(raw)) {
      // 服务端明确返回了空 cursor：没有下一页了
      stoppedReason = 'exhausted';
      break;
    }
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
  const complete = isCompleteStop(stoppedReason);
  console.log(
    `[predict] categories crawl: ${all.length} categories, ${pagesFetched} pages (pageSize≈${pageSize}), status=${statusFilter ?? 'none'}, stop=${stoppedReason}, complete=${complete}`
  );

  return {
    categories: all,
    pagesFetched,
    stoppedReason,
    totalUniqueIds: seen.size,
    complete,
    statusFilter,
    pageSize,
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
    const normalized = normalizeCategoryMarkets(cat);
    if (!normalized.length) {
      categoriesWithoutMarkets += 1;
      continue;
    }
    for (const summary of normalized) {
      if (seenMarketIds.has(summary.id)) continue;
      seenMarketIds.add(summary.id);
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
  status?: string | null;
} = {}): Promise<{
  markets: PredictMarketSummary[];
  pagesFetched: number;
  stoppedReason: string;
  totalCategories: number;
  totalUniqueMarketIds: number;
  categoriesWithoutMarkets: number;
  complete: boolean;
  statusFilter: string | null;
  pageSize: number;
  source: 'categories';
}> {
  const { categories, pagesFetched, stoppedReason, totalUniqueIds, complete, statusFilter, pageSize } =
    await fetchAllPredictCategories({
      limit: options.limit,
      maxPages: options.maxPages,
      status: options.status
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
    complete,
    statusFilter,
    pageSize,
    source: 'categories'
  };
}
