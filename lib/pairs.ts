import filePairs from '@/config/pairs.json';
import { envNumber } from './env';
import type { PairConfig, PredictSide } from './types';
function normalizeSide(value: unknown): PredictSide {
  const s = String(value || '').trim().toLowerCase();
  return s === 'no' ? 'No' : 'Yes';
}
function numberOrDefault(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
export function normalizePair(input: PairConfig): PairConfig {
  const predictSide = normalizeSide(input.predictSide ?? input.outcome ?? 'Yes');
  const polymarketTokenId =
    input.polymarketTokenId ||
    (predictSide === 'Yes' ? input.polymarketYesTokenId : input.polymarketNoTokenId) ||
    input.polymarketYesTokenId ||
    input.polymarketNoTokenId ||
    '';
  return {
    ...input,
    name: String(input.name || `${input.predictMarketId || 'predict'} ${input.polymarketOutcome || predictSide}`),
    predictMarketId: String(input.predictMarketId || ''),
    predictSide,
    polymarketTokenId: String(polymarketTokenId),
    threshold: numberOrDefault(input.threshold, envNumber('ALERT_THRESHOLD', 0.015)),
    minSize: numberOrDefault(input.minSize, envNumber('MIN_SIZE', 0)),
    feeBuffer: numberOrDefault(input.feeBuffer, envNumber('FEE_BUFFER', 0))
  };
}
export function sanitizePairs(value: unknown): PairConfig[] {
  if (!Array.isArray(value)) {
    throw new Error('pairs must be a JSON array');
  }
  return value.map((item) => normalizePair(item as PairConfig));
}
export function loadPairs(): PairConfig[] {
  if (process.env.PAIRS_JSON && process.env.PAIRS_JSON.trim()) {
    return sanitizePairs(JSON.parse(process.env.PAIRS_JSON));
  }
  return sanitizePairs(filePairs);
}
