import { fetchJson } from './fetch-json';
import type { PredictMarketSummary } from './types';

const PREDICT_BASE = 'https://api.predict.fun';

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function stringArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.filter(Boolean).map(String);
  }
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
  return [];
}

function pickNextCursor(raw: unknown): string {
  const root = raw as any;
  return String(
    root?.data?.pagination?.nextCursor ||
      root?.data?.pagination?.next_cursor ||
      root?.data?.nextCursor ||
      root?.data?.next_cursor ||
      root?.pagination?.nextCursor ||
      root?.pagination?.next_cursor ||
      root?.nextCursor ||
      root?.next_cursor ||
      ''
  );
}

function pickPageMeta(raw: unknown): { page?: number; totalPages?: number; total?: number; hasMore?: boolean } {
  const root = raw as any;
  const meta = root?.data?.pagination || root?.pagination || root?.meta || {};
  return {
    page: numberOrNull(meta.page) ?? undefined,
    totalPages: numberOrNull(meta.totalPages ?? meta.total_pages ?? meta.pageCount) ?? undefined,
    total: numberOrNull(meta.total ?? meta.totalCount) ?? undefined,
    hasMore: typeof meta.hasMore === 'boolean' ? meta.hasMore : typeof meta.has_more === 'boolean' ? meta.has_more : undefined
  };
}

function priceFromOutcome(market: any, label: 'Yes' | 'No'): number | null {
  const outcomes = market?.outcomes || market?.tokens || [];
  if (!Array.isArray(outcomes)) return null;
  const match = outcomes.find((o: any) => String(o?.name || o?.outcome || o?.label || '').trim().toLowerCase() === label.toLowerCase());
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
  const slug = raw?.slug ? String(raw.slug) : undefined;
  const status = raw?.status ? String(raw.status) : undefined;
  const closed = typeof raw?.closed === 'boolean' ? raw.closed : undefined;
  const active = typeof raw?.active === 'boolean' ? raw.active : undefined;
  const category = raw?.category ? String(raw.category) : raw?.categoryName ? String(raw.categoryName) : undefined;
  const endDate =
    raw?.endDate ||
    raw?.end_date ||
    raw?.endsAt ||
    raw?.ends_at ||
    raw?.closeTime ||
    raw?.close_time ||
    raw?.expiry ||
    raw?.resolveTime ||
    raw?.resolve_time ||
    undefined;
  const volume = numberOrNull(raw?.volume ?? raw?.totalVolume ?? raw?.total_volume) ?? undefined;
  const liquidity = numberOrNull(raw?.liquidity ?? raw?.totalLiquidity ?? raw?.total_liquidity) ?? undefined;
  const polymarketConditionIds = stringArray(raw?.polymarketConditionIds ?? raw?.polymarket_condition_ids);
  return {
    id,
    title,
    slug,
    status,
    closed,
    active,
    category,
    endDate: endDate ? String(endDate) : undefined,
    volume,
    liquidity,
    yesPrice: priceFromOutcome(raw, 'Yes'),
    noPrice: priceFromOutcome(raw, 'No'),
    polymarketConditionIds,
    hasPolymarket: polymarketConditionIds.length > 0
  };
}

type FetchOptions = {
  status?: string;
  limit?: number;
  maxPages?: number;
  includeClosed?: boolean;
};

export async function fetchAllPredictMarkets(options: FetchOptions = {}): Promise<{
  markets: PredictMarketSummary[];
  pagesFetched: number;
  stoppedReason: string;
}> {
  const apiKey = process.env.PREDICT_API_KEY;
  if (!apiKey) throw new Error('Missing PREDICT_API_KEY');
  const limit = options.limit ?? 100;
  const maxPages = options.maxPages ?? 50;
  const status = options.status ?? 'open';
  const includeClosed = options.includeClosed ?? false;

  const all: PredictMarketSummary[] = [];
  const seen = new Set<string>();
  let cursor = '';
  let page = 1;
  let pagesFetched = 0;
  let stoppedReason = 'exhausted';

  while (pagesFetched < maxPages) {
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    if (cursor) {
      params.set('cursor', cursor);
    } else {
      params.set('page', String(page));
    }
    if (status && !includeClosed) params.set('status', status);

    const url = `${PREDICT_BASE}/v1/markets?${params.toString()}`;
    const raw = await fetchJson(url, { headers: { 'x-api-key': apiKey } });
    pagesFetched += 1;

    const rows = pickArray(raw);
    if (!rows.length) {
      stoppedReason = 'empty-page';
      break;
    }

    let added = 0;
    for (const row of rows) {
      const summary = normalizeMarket(row);
      if (!summary.id || seen.has(summary.id)) continue;
      if (!includeClosed && (summary.closed === true || (summary.status && summary.status.toLowerCase() === 'closed'))) {
        continue;
      }
      seen.add(summary.id);
      all.push(summary);
      added += 1;
    }

    const nextCursor = pickNextCursor(raw);
    const meta = pickPageMeta(raw);

    if (nextCursor) {
      cursor = nextCursor;
      continue;
    }
    if (meta.hasMore === false) {
      stoppedReason = 'no-more';
      break;
    }
    if (meta.totalPages && page >= meta.totalPages) {
      stoppedReason = 'last-page';
      break;
    }
    if (added === 0 && !cursor) {
      stoppedReason = 'no-new-items';
      break;
    }
    if (rows.length < limit && !cursor) {
      stoppedReason = 'short-page';
      break;
    }
    page += 1;
  }

  if (pagesFetched >= maxPages && stoppedReason === 'exhausted') {
    stoppedReason = `hit-max-pages-${maxPages}`;
  }

  return { markets: all, pagesFetched, stoppedReason };
}

export function filterPredictOnly(markets: PredictMarketSummary[]): PredictMarketSummary[] {
  return markets.filter((m) => !m.hasPolymarket);
}
