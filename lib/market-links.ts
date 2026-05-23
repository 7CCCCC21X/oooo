import { fetchJson } from './fetch-json';
import { predictMarketUrl } from './predict-markets';
import type { PairConfig } from './types';

export type MarketInfo = { title: string; url: string };
export type PairLinks = { predict: MarketInfo; poly: MarketInfo };

declare global {
  var __predictInfoCache: Map<string, MarketInfo> | undefined;
  var __polyInfoCache: Map<string, MarketInfo> | undefined;
}

// 标题/slug 基本不变，解析一次就长期缓存（解析失败不缓存，下次重试）
function predictCache(): Map<string, MarketInfo> {
  if (!globalThis.__predictInfoCache) globalThis.__predictInfoCache = new Map();
  return globalThis.__predictInfoCache;
}
function polyCache(): Map<string, MarketInfo> {
  if (!globalThis.__polyInfoCache) globalThis.__polyInfoCache = new Map();
  return globalThis.__polyInfoCache;
}

const PREDICT_API_BASE = 'https://api.predict.fun';
const POLY_CLOB_BASE = 'https://clob.polymarket.com';
const POLY_GAMMA_BASE = 'https://gamma-api.polymarket.com';
const PREDICT_WEB = 'https://predict.fun';
const POLY_WEB = 'https://polymarket.com';

export async function getPredictInfo(marketId: string): Promise<MarketInfo> {
  const id = String(marketId || '').trim();
  if (!id) return { title: '', url: '' };
  const cache = predictCache();
  const hit = cache.get(id);
  if (hit) return hit;
  try {
    const apiKey = process.env.PREDICT_API_KEY;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (apiKey) headers['x-api-key'] = apiKey;
    const raw = await fetchJson(`${PREDICT_API_BASE}/v1/markets/${encodeURIComponent(id)}`, { headers });
    const m = (raw as any)?.data || raw;
    const title = String(m?.title || m?.question || m?.name || '').trim();
    const url = predictMarketUrl({
      id,
      slug: m?.slug || m?.marketSlug,
      categorySlug: m?.categorySlug || m?.category_slug
    });
    const info: MarketInfo = { title, url };
    if (title || url) cache.set(id, info);
    return info;
  } catch {
    return { title: '', url: `${PREDICT_WEB}/market/${encodeURIComponent(id)}` };
  }
}

function pickFromGamma(raw: unknown): { title: string; slug: string } {
  const root = raw as any;
  const list = Array.isArray(root) ? root : Array.isArray(root?.data) ? root.data : [];
  const m = list[0];
  if (!m) return { title: '', slug: '' };
  const title = String(m.question || m.title || '').trim();
  const eventSlug = Array.isArray(m.events) && m.events[0]?.slug ? String(m.events[0].slug) : '';
  const slug = eventSlug || String(m.slug || m.marketSlug || m.market_slug || '');
  return { title, slug };
}

export async function getPolymarketInfo(conditionId: string): Promise<MarketInfo> {
  const cid = String(conditionId || '').trim();
  if (!cid) return { title: '', url: '' };
  const cache = polyCache();
  const hit = cache.get(cid);
  if (hit) return hit;

  let title = '';
  let slug = '';

  // 1) Gamma：question + event slug 信息最全
  try {
    const raw = await fetchJson(`${POLY_GAMMA_BASE}/markets?condition_ids=${encodeURIComponent(cid)}`);
    const g = pickFromGamma(raw);
    title = g.title;
    slug = g.slug;
  } catch {}

  // 2) CLOB 兜底（这个 host 监控里已经在用，一定可达）
  if (!title || !slug) {
    try {
      const raw = await fetchJson(`${POLY_CLOB_BASE}/markets/${encodeURIComponent(cid)}`);
      const m = (raw as any)?.data || raw;
      if (!title) title = String(m?.question || m?.title || '').trim();
      if (!slug) slug = String(m?.market_slug || m?.marketSlug || m?.slug || '');
    } catch {}
  }

  const url = slug ? `${POLY_WEB}/event/${slug}` : '';
  const info: MarketInfo = { title, url };
  if (title || url) cache.set(cid, info);
  return info;
}

// 给一个 pair 解析两边的标题+链接，任何一边失败都不影响另一边
export async function getPairLinks(pair: PairConfig): Promise<PairLinks> {
  const [predict, poly] = await Promise.all([
    getPredictInfo(pair.predictMarketId).catch(() => ({ title: '', url: '' })),
    pair.polymarketConditionId
      ? getPolymarketInfo(pair.polymarketConditionId).catch(() => ({ title: '', url: '' }))
      : Promise.resolve({ title: '', url: '' })
  ]);
  return { predict, poly };
}
