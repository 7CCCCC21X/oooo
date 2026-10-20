export type BookLevel = {
  price: number;
  size: number;
};
export type TopBook = {
  bid: BookLevel | null;
  ask: BookLevel | null;
  bidDepth: number;
  askDepth: number;
};
export type PredictMarketSummary = {
  id: string;
  title: string;
  question?: string;
  slug?: string;
  categorySlug?: string;
  categoryTitle?: string;
  status?: string;
  tradingStatus?: string;
  isResolved?: boolean;
  closed?: boolean;
  active?: boolean;
  category?: string;
  categoryStatus?: string;
  endDate?: string;
  endMs?: number | null;
  volume?: number;
  liquidity?: number;
  yesPrice?: number | null;
  noPrice?: number | null;
  hourlyRate: number;
  hourlyRateSource?: 'current' | 'schedule' | 'recursive' | 'none';
  spreadThreshold?: number;
  shareThreshold?: number;
  polymarketConditionIds: string[];
  hasPolymarket: boolean;
  tradeable: boolean;
  // NegRisk（多结果可转换）相关：来自 /v1/categories 的 market.isNegRisk / market.questionIndex / category.negRiskOnChainId
  isNegRisk?: boolean;
  questionIndex?: number;
  negRiskOnChainId?: string;
  raw?: unknown;
};
