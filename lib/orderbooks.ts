import type { BookLevel, TopBook } from './types';
function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function normalizeLevel(level: unknown): BookLevel | null {
  if (Array.isArray(level)) {
    const price = numberOrNull(level[0]);
    const size = numberOrNull(level[1] ?? level[2] ?? 0);
    return price === null ? null : { price, size: size ?? 0 };
  }
  if (!level || typeof level !== 'object') return null;
  const obj = level as Record<string, unknown>;
  const price = numberOrNull(obj.price ?? obj.p);
  const size = numberOrNull(obj.size ?? obj.s ?? obj.quantity ?? obj.q ?? 0);
  return price === null ? null : { price, size: size ?? 0 };
}
function bookRoot(raw: unknown): { bids?: unknown[]; asks?: unknown[] } {
  const root = raw as any;
  if (root?.data?.orderbook?.bids || root?.data?.orderbook?.asks) return root.data.orderbook;
  if (root?.data?.bids || root?.data?.asks) return root.data;
  if (root?.orderbook?.bids || root?.orderbook?.asks) return root.orderbook;
  return root || {};
}
export function topOfBook(raw: unknown): TopBook {
  const root = bookRoot(raw);
  const bids = (root.bids || [])
    .map(normalizeLevel)
    .filter((level): level is BookLevel => !!level)
    .sort((a, b) => b.price - a.price);
  const asks = (root.asks || [])
    .map(normalizeLevel)
    .filter((level): level is BookLevel => !!level)
    .sort((a, b) => a.price - b.price);
  return {
    bid: bids[0] || null,
    ask: asks[0] || null,
    bidDepth: bids.length,
    askDepth: asks.length
  };
}
export function complementBook(book: TopBook): TopBook {
  return {
    bid: book.ask ? { price: 1 - book.ask.price, size: book.ask.size } : null,
    ask: book.bid ? { price: 1 - book.bid.price, size: book.bid.size } : null,
    bidDepth: book.askDepth,
    askDepth: book.bidDepth
  };
}
export function midPrice(book: TopBook): number | null {
  if (!book.bid || !book.ask) return null;
  return (book.bid.price + book.ask.price) / 2;
}
