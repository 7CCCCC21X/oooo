import { envNumber, nowIso } from './env';
import { fetchJson } from './fetch-json';
import { complementBook, topOfBook } from './orderbooks';
import { normalizePair } from './pairs';
import type { PairConfig, SpreadDirection, SpreadResult, TopBook } from './types';
const PREDICT_BASE = 'https://api.predict.fun';
const POLY_CLOB_BASE = 'https://clob.polymarket.com';
export async function getPredictYesBook(marketId: string): Promise<TopBook> {
  const apiKey = process.env.PREDICT_API_KEY;
  if (!apiKey) {
    throw new Error('Missing PREDICT_API_KEY');
  }
  const raw = await fetchJson(`${PREDICT_BASE}/v1/markets/${encodeURIComponent(marketId)}/orderbook`, {
    headers: {
      'x-api-key': apiKey
    }
  });
  return topOfBook(raw);
}
export async function getPolymarketBook(tokenId: string): Promise<TopBook> {
  const raw = await fetchJson(`${POLY_CLOB_BASE}/book?token_id=${encodeURIComponent(tokenId)}`);
  return topOfBook(raw);
}
export function computeSpread(pair: PairConfig, predictBook: TopBook, polyBook: TopBook): SpreadResult {
  const checkedAt = nowIso();
  const threshold = Number(pair.threshold ?? envNumber('ALERT_THRESHOLD', 0.015));
  const minSize = Number(pair.minSize ?? envNumber('MIN_SIZE', 0));
  const feeBuffer = Number(pair.feeBuffer ?? envNumber('FEE_BUFFER', 0));
  if (!predictBook.bid || !predictBook.ask || !polyBook.bid || !polyBook.ask) {
    return {
      pair,
      checkedAt,
      ok: false,
      error: 'One side has no complete bid/ask',
      predictBook,
      polyBook,
      threshold,
      minSize,
      feeBuffer,
      alert: false
    };
  }
  const buyPredictSellPoly = polyBook.bid.price - predictBook.ask.price - feeBuffer;
  const buyPolySellPredict = predictBook.bid.price - polyBook.ask.price - feeBuffer;
  let direction: SpreadDirection;
  let directionLabel: string;
  let buyVenue: 'Predict.fun' | 'Polymarket';
  let sellVenue: 'Predict.fun' | 'Polymarket';
  let buyPrice: number;
  let sellPrice: number;
  let gap: number;
  let comparableSize: number;
  if (buyPredictSellPoly >= buyPolySellPredict) {
    direction = 'BUY_PREDICT_SELL_POLY';
    directionLabel = '买 Predict.fun / 卖 Polymarket';
    buyVenue = 'Predict.fun';
    sellVenue = 'Polymarket';
    buyPrice = predictBook.ask.price;
    sellPrice = polyBook.bid.price;
    gap = buyPredictSellPoly;
    comparableSize = Math.min(predictBook.ask.size || 0, polyBook.bid.size || 0);
  } else {
    direction = 'BUY_POLY_SELL_PREDICT';
    directionLabel = '买 Polymarket / 卖 Predict.fun';
    buyVenue = 'Polymarket';
    sellVenue = 'Predict.fun';
    buyPrice = polyBook.ask.price;
    sellPrice = predictBook.bid.price;
    gap = buyPolySellPredict;
    comparableSize = Math.min(polyBook.ask.size || 0, predictBook.bid.size || 0);
  }
  return {
    pair,
    checkedAt,
    ok: true,
    predictBook,
    polyBook,
    direction,
    directionLabel,
    buyVenue,
    sellVenue,
    buyPrice,
    sellPrice,
    gap,
    gapCents: gap * 100,
    comparableSize,
    threshold,
    minSize,
    feeBuffer,
    alert: gap >= threshold && comparableSize >= minSize
  };
}
export async function checkPair(input: PairConfig): Promise<SpreadResult> {
  const pair = normalizePair(input);
  const checkedAt = nowIso();
  if (!pair.predictMarketId) {
    return {
      pair,
      checkedAt,
      ok: false,
      error: 'Missing predictMarketId',
      threshold: Number(pair.threshold ?? 0.015),
      minSize: Number(pair.minSize ?? 0),
      feeBuffer: Number(pair.feeBuffer ?? 0),
      alert: false
    };
  }
  if (!pair.polymarketTokenId) {
    return {
      pair,
      checkedAt,
      ok: false,
      error: 'Missing polymarketTokenId',
      threshold: Number(pair.threshold ?? 0.015),
      minSize: Number(pair.minSize ?? 0),
      feeBuffer: Number(pair.feeBuffer ?? 0),
      alert: false
    };
  }
  try {
    const [predictYesBook, polyBook] = await Promise.all([
      getPredictYesBook(pair.predictMarketId),
      getPolymarketBook(pair.polymarketTokenId)
    ]);
    const predictBook = pair.predictSide === 'No' ? complementBook(predictYesBook) : predictYesBook;
    return computeSpread(pair, predictBook, polyBook);
  } catch (error) {
    return {
      pair,
      checkedAt,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      threshold: Number(pair.threshold ?? 0.015),
      minSize: Number(pair.minSize ?? 0),
      feeBuffer: Number(pair.feeBuffer ?? 0),
      alert: false
    };
  }
}
export async function checkPairs(pairs: PairConfig[]): Promise<SpreadResult[]> {
  return Promise.all(pairs.map((pair) => checkPair(pair)));
}
