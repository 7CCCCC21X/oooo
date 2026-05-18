import { fetchJson } from './fetch-json';
import { midPrice, complementBook } from './orderbooks';
import { getPolymarketBook, getPredictYesBook } from './spread';
import type { PairConfig, ResolveResult, TopBook } from './types';
const PREDICT_BASE = 'https://api.predict.fun';
const POLY_CLOB_BASE = 'https://clob.polymarket.com';
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
function titleOf(market: any): string {
  return String(market?.title || market?.question || market?.name || '').trim();
}
function absDiff(a: number | null, b: number | null): number {
  if (a === null || b === null) return 999;
  return Math.abs(a - b);
}
function marketTokensFromClob(raw: unknown): Array<{ outcome: string; tokenId: string }> {
  const root = raw as any;
  const tokens = Array.isArray(root?.t) ? root.t : Array.isArray(root?.tokens) ? root.tokens : [];
  return tokens
    .map((token: any) => ({
      outcome: String(token.o || token.outcome || token.name || ''),
      tokenId: String(token.t || token.token_id || token.tokenId || token.asset_id || token.id || '')
    }))
    .filter((token: { outcome: string; tokenId: string }) => token.tokenId);
}
async function getPredictMarket(marketId: string): Promise<any> {
  const apiKey = process.env.PREDICT_API_KEY;
  if (!apiKey) throw new Error('Missing PREDICT_API_KEY');
  const raw = await fetchJson(`${PREDICT_BASE}/v1/markets/${encodeURIComponent(marketId)}`, {
    headers: { 'x-api-key': apiKey }
  });
  return (raw as any)?.data || raw;
}
async function getClobTokens(conditionId: string): Promise<Array<{ outcome: string; tokenId: string }>> {
  const raw = await fetchJson(`${POLY_CLOB_BASE}/clob-markets/${encodeURIComponent(conditionId)}`);
  return marketTokensFromClob(raw);
}
function chooseBinaryMapping(args: {
  marketId: string;
  title: string;
  conditionId: string;
  tokens: Array<{ outcome: string; tokenId: string }>;
  predictYesBook: TopBook;
  polyBooks: TopBook[];
}): { pairs: PairConfig[]; mappingNote: string } {
  const { marketId, conditionId, tokens, predictYesBook, polyBooks } = args;
  const predictNoBook = complementBook(predictYesBook);
  if (tokens.length !== 2 || polyBooks.length !== 2) {
    return {
      mappingNote: '非 2-outcome 市场，无法自动用 Predict Yes/No 映射；请人工确认 token。',
      pairs: tokens.map((token, index) => ({
        name: `${marketId} ${token.outcome || `token_${index + 1}`}`,
        predictMarketId: marketId,
        predictSide: index === 0 ? 'Yes' : 'No',
        polymarketConditionId: conditionId,
        polymarketOutcome: token.outcome,
        polymarketTokenId: token.tokenId,
        threshold: 0.015,
        minSize: 0
      }))
    };
  }
  const scoreA =
    absDiff(midPrice(predictYesBook), midPrice(polyBooks[0])) +
    absDiff(midPrice(predictNoBook), midPrice(polyBooks[1]));
  const scoreB =
    absDiff(midPrice(predictYesBook), midPrice(polyBooks[1])) +
    absDiff(midPrice(predictNoBook), midPrice(polyBooks[0]));
  const ordered =
    scoreA <= scoreB
      ? [
          { predictSide: 'Yes' as const, token: tokens[0] },
          { predictSide: 'No' as const, token: tokens[1] }
        ]
      : [
          { predictSide: 'Yes' as const, token: tokens[1] },
          { predictSide: 'No' as const, token: tokens[0] }
        ];
  return {
    mappingNote: `按 bid/ask mid price 自动映射。scoreA=${scoreA.toFixed(4)}, scoreB=${scoreB.toFixed(4)}。请人工复核一次标题和结果方向。`,
    pairs: ordered.map((item) => ({
      name: `${marketId} ${item.token.outcome}`,
      predictMarketId: marketId,
      predictSide: item.predictSide,
      polymarketConditionId: conditionId,
      polymarketOutcome: item.token.outcome,
      polymarketTokenId: item.token.tokenId,
      threshold: 0.015,
      minSize: 0
    }))
  };
}
export async function resolveMarket(predictMarketId: string): Promise<ResolveResult[]> {
  const market = await getPredictMarket(predictMarketId);
  const title = titleOf(market);
  const conditionIds = stringArray(market?.polymarketConditionIds);
  if (!conditionIds.length) {
    throw new Error(`Predict market ${predictMarketId} 没有 polymarketConditionIds，无法自动匹配 Polymarket。`);
  }
  const predictYesBook = await getPredictYesBook(predictMarketId);
  const results: ResolveResult[] = [];
  for (const conditionId of conditionIds) {
    const tokens = await getClobTokens(conditionId);
    const polyBooks = await Promise.all(tokens.map((token) => getPolymarketBook(token.tokenId)));
    const mapping = chooseBinaryMapping({
      marketId: predictMarketId,
      title,
      conditionId,
      tokens,
      predictYesBook,
      polyBooks
    });
    results.push({
      predictMarketId,
      predictTitle: title,
      polymarketConditionId: conditionId,
      tokenCount: tokens.length,
      tokens,
      pairs: mapping.pairs,
      mappingNote: mapping.mappingNote
    });
  }
  return results;
}
