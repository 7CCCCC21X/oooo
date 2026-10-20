// ============================================================
// 可转换（NegRisk）市场检查
//
// 多结果类目（比如"哪个赛区夺冠"）在 predict.fun 上是 NegRisk 市场：
// 1 份某结果的「否」可以转换成其余每个结果各 1 份「是」。
// 所以「所有结果的 Yes 买一价之和」> 100¢ 时存在套利：
//   买 否_i（= 100 − Yes买一_i）→ 转换 → 把其余 Yes 按买一价卖掉
//   每份利润 ≈ Σ Yes买一 − 100（未扣手续费）
//
// 本模块提供：
//   - analyzeCategoryBySlugOrUrl：输入链接/slug，查每个结果 Yes 买一并求和
//   - scanConvertibleCategories：扫描缓存里所有可转换类目
//   - runNegRiskCycle / startNegRiskMonitor：定时扫描，总和 ≥ 阈值就推送
//   - 阈值 / 开关 运行时可改，可持久化到文件
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { envNumber } from './env';
import { fetchJson } from './fetch-json';
import { getCachedMarkets, type MarketsCacheEntry } from './predict-cache';
import { getPredictLimiterStatus } from './predict-limiter';
import { groupMarketsByCategory, normalizeCategoryMarkets, predictMarketUrl, type MarketGroup } from './predict-markets';
import { extractPredictSlug } from './predict-url';
import { getPredictYesBook } from './orderbooks';
import { getSubscriptions } from './subscribers';
import type { PredictMarketSummary, TopBook } from './types';

const PREDICT_REST_BASE = 'https://api.predict.fun/v1';
const DEFAULT_THRESHOLD_CENTS = 100;

export type OutcomeQuote = {
  id: string;
  title: string;
  questionIndex?: number;
  bid: number | null; // Yes 买一（¢）
  bidSize: number;
  ask: number | null; // Yes 卖一（¢）
  askSize: number;
  spread: number | null; // 卖一 − 买一（¢）
  // 盘口空：没买单 / 没卖单 / 价差 ≥ NEGRISK_EMPTY_BOOK_SPREAD（默认 30¢）。多半是已淘汰或无人做市，
  // 用它的卖一反推"直接卖否"没有意义，持有的否也不该拿去转换。
  emptyBook: boolean;
  noValue: number | null; // 否 的参考价值 = 100 − Yes 买一
  refPrice: number | null; // 缓存里的参考价（¢），订单簿获取失败时用它估计
  error?: string;
};

export type CategoryAnalysis = {
  slug: string;
  title: string;
  url: string;
  negRisk: boolean | null; // null = 接口没给 isNegRisk / negRiskOnChainId，无法判断
  outcomeCount: number;
  tradeableCount: number;
  activeCount: number; // 有买单且盘口不空的结果数
  outcomes: OutcomeQuote[]; // 只含可交易的结果，按 Yes 买一降序
  bidSum: number; // Σ Yes 买一（¢），没买单/获取失败按 0 计 —— 是下限
  askSum: number; // 活跃结果的 Σ Yes 卖一（¢）
  missingBids: number;
  emptyBooks: number;
  failed: number; // 订单簿获取失败的结果数
  estMissing: number; // 获取失败的结果按参考价估计的买一之和（没参考价按 100）
  bidSumUpper: number; // bidSum + estMissing：真实总和不会超过这个
  complete: boolean; // failed === 0
  minBid: { size: number; title: string } | null;
  checkedAt: string;
};

export type ScanResult = {
  checkedAt: string;
  durationMs: number;
  detectMode: 'flag' | 'heuristic';
  thresholdCents: number;
  candidates: number;
  prefiltered: number;
  unknownEstimate: number; // 缓存里没参考价、无法预过滤的类目数（优先扫）
  scanned: number;
  capped: boolean;
  droppedByCap: number; // 超过每轮上限没轮到的类目数
  requests: number;
  failedCategories: number; // 补查之后仍有结果没查到的类目数
  retriedCategories: number; // 第一遍有失败、做了补查的类目数
  results: CategoryAnalysis[]; // bidSum 降序
  hits: CategoryAnalysis[]; // bidSum ≥ 阈值
};

// thresholdCents：提醒阈值；displayMinCents：显示下限（扫描报告 / 提醒里"接近阈值"的范围）
type NegRiskState = { thresholdCents: number; displayMinCents: number; enabled: boolean; changedAt?: string };
type SendFn = (chatId: string, text: string, threadId: number | null) => Promise<void>;
type LastCycle = {
  at: string;
  scan: ScanResult | null;
  alertsSent: number;
  error?: string;
  manual?: boolean; // 手动扫描（/api/negrisk?scan=1），不推送
};

declare global {
  var __negRiskState: NegRiskState | undefined;
  var __negRiskTimer: NodeJS.Timeout | undefined;
  var __negRiskRunning: boolean | undefined;
  var __negRiskLastAlertAt: Map<string, number> | undefined;
  var __negRiskLastCycle: LastCycle | undefined;
  var __negRiskSendFn: SendFn | null | undefined;
}

// ---------------- 工具 ----------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toCents(p: number | null | undefined): number | null {
  if (p == null || !Number.isFinite(p)) return null;
  return p <= 1 ? p * 100 : p; // 接口给 0-1 小数，兼容已经是 ¢ 的情况
}

function fmtC(v: number | null | undefined, digits = 1): string {
  return v == null || !Number.isFinite(v) ? '-' : `${v.toFixed(digits)}¢`;
}

function fmtN(v: number | null | undefined, digits = 0): string {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: digits }) : '-';
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------------- 阈值 / 开关 状态 ----------------

function stateFile(): string {
  const explicit = String(process.env.NEGRISK_STATE_FILE || '').trim();
  if (explicit) return explicit;
  const subs = String(process.env.SUBSCRIBERS_FILE || '').trim();
  return subs ? path.join(path.dirname(subs), 'negrisk-state.json') : '';
}

const DEFAULT_DISPLAY_MIN_CENTS = 95;

function defaultState(): NegRiskState {
  return {
    thresholdCents: envNumber('NEGRISK_ALERT_THRESHOLD', DEFAULT_THRESHOLD_CENTS),
    displayMinCents: envNumber('NEGRISK_DISPLAY_MIN', DEFAULT_DISPLAY_MIN_CENTS),
    enabled: process.env.DISABLE_NEGRISK_ALERTS !== '1'
  };
}

function loadState(): NegRiskState {
  if (globalThis.__negRiskState) return globalThis.__negRiskState;
  const state = defaultState();
  const f = stateFile();
  if (f) {
    try {
      if (fs.existsSync(f)) {
        const data = JSON.parse(fs.readFileSync(f, 'utf-8'));
        const t = Number(data?.thresholdCents);
        if (Number.isFinite(t) && t > 0) state.thresholdCents = t;
        const d = Number(data?.displayMinCents);
        if (Number.isFinite(d) && d >= 0) state.displayMinCents = d;
        if (typeof data?.enabled === 'boolean') state.enabled = data.enabled;
        if (typeof data?.changedAt === 'string') state.changedAt = data.changedAt;
      }
    } catch (err) {
      console.error('[negrisk] load state failed:', err instanceof Error ? err.message : err);
    }
  }
  globalThis.__negRiskState = state;
  return state;
}

function persistState(state: NegRiskState): void {
  const f = stateFile();
  if (!f) return;
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('[negrisk] persist state failed:', err instanceof Error ? err.message : err);
  }
}

export function getNegRiskThreshold(): number {
  return loadState().thresholdCents;
}

// 返回 null 表示输入不合法
export function setNegRiskThreshold(value: number): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 1000) return null;
  const state = loadState();
  state.thresholdCents = n;
  state.changedAt = new Date().toISOString();
  persistState(state);
  return n;
}

// 显示下限：扫描报告列出 Σ Yes 买1 ≥ 这个值的类目（可以低于提醒阈值）
export function getNegRiskDisplayMin(): number {
  return loadState().displayMinCents;
}

export function setNegRiskDisplayMin(value: number): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1000) return null;
  const state = loadState();
  state.displayMinCents = n;
  state.changedAt = new Date().toISOString();
  persistState(state);
  return n;
}

export function isNegRiskAlertsEnabled(): boolean {
  return loadState().enabled;
}

export function getLastScan(): ScanResult | null {
  return globalThis.__negRiskLastCycle?.scan ?? null;
}

export function setNegRiskAlertsEnabled(enabled: boolean): { changed: boolean; enabled: boolean } {
  const state = loadState();
  if (state.enabled === enabled) return { changed: false, enabled };
  state.enabled = enabled;
  state.changedAt = new Date().toISOString();
  persistState(state);
  return { changed: true, enabled };
}

export function registerNegRiskSendFn(fn: SendFn): void {
  globalThis.__negRiskSendFn = fn;
}

export function getNegRiskStatus() {
  const state = loadState();
  const last = globalThis.__negRiskLastCycle;
  return {
    enabled: state.enabled,
    thresholdCents: state.thresholdCents,
    displayMinCents: state.displayMinCents,
    changedAt: state.changedAt ?? null,
    intervalMs: envNumber('NEGRISK_CHECK_INTERVAL_MS', 300_000),
    cooldownSec: envNumber('NEGRISK_ALERT_COOLDOWN_SEC', 1800),
    timerActive: !!globalThis.__negRiskTimer,
    running: !!globalThis.__negRiskRunning,
    subscribers: getSubscriptions('negrisk').length,
    limiter: getPredictLimiterStatus(),
    lastCycle: last
      ? {
          at: last.at,
          alertsSent: last.alertsSent,
          error: last.error ?? null,
          manual: !!last.manual,
          detectMode: last.scan?.detectMode ?? null,
          candidates: last.scan?.candidates ?? 0,
          prefiltered: last.scan?.prefiltered ?? 0,
          scanned: last.scan?.scanned ?? 0,
          requests: last.scan?.requests ?? 0,
          durationMs: last.scan?.durationMs ?? 0,
          capped: last.scan?.capped ?? false,
          droppedByCap: last.scan?.droppedByCap ?? 0,
          failedCategories: last.scan?.failedCategories ?? 0,
          retriedCategories: last.scan?.retriedCategories ?? 0,
          hits: last.scan?.hits.length ?? 0,
          topSum: last.scan?.results[0]?.bidSum ?? null,
          topTitle: last.scan?.results[0]?.title ?? null
        }
      : null
  };
}

// ---------------- 可转换判断 ----------------

// 缓存里只要有任何市场带了 isNegRisk / negRiskOnChainId 字段，就按字段判断；
// 否则（接口没返回这些字段）退化为"3 个以上结果的类目"启发式。
export function detectModeOf(markets: PredictMarketSummary[]): 'flag' | 'heuristic' {
  return markets.some((m) => typeof m.isNegRisk === 'boolean' || !!m.negRiskOnChainId) ? 'flag' : 'heuristic';
}

export function negRiskOfGroup(markets: PredictMarketSummary[], mode: 'flag' | 'heuristic'): boolean | null {
  if (mode === 'flag') return markets.some((m) => m.isNegRisk === true || !!m.negRiskOnChainId);
  return null;
}

function isConvertibleGroup(g: MarketGroup, mode: 'flag' | 'heuristic'): boolean {
  const tradeable = g.markets.filter((m) => m.tradeable);
  if (tradeable.length < 2) return false;
  if (mode === 'flag') return negRiskOfGroup(g.markets, mode) === true;
  return tradeable.length >= 3;
}

// ---------------- 单个类目分析 ----------------

type OutcomeRef = { id: string; title: string; questionIndex?: number; refPrice: number | null };

function outcomeRef(m: PredictMarketSummary): OutcomeRef {
  return { id: m.id, title: m.title || m.question || m.id, questionIndex: m.questionIndex, refPrice: toCents(m.yesPrice ?? null) };
}

function emptyBookSpread(): number {
  return envNumber('NEGRISK_EMPTY_BOOK_SPREAD', 30);
}

function finishQuote(ref: OutcomeRef, book: TopBook): OutcomeQuote {
  const bid = toCents(book.bid?.price ?? null);
  const ask = toCents(book.ask?.price ?? null);
  const spread = bid != null && ask != null ? Math.round((ask - bid) * 100) / 100 : null;
  const emptyBook = bid == null || ask == null || (spread != null && spread >= emptyBookSpread());
  return {
    ...ref,
    bid,
    bidSize: book.bid?.size ?? 0,
    ask,
    askSize: book.ask?.size ?? 0,
    spread,
    emptyBook,
    noValue: bid == null ? null : Math.round((100 - bid) * 100) / 100
  };
}

async function quoteOutcome(ref: OutcomeRef): Promise<OutcomeQuote> {
  try {
    const book: TopBook = await getPredictYesBook(ref.id);
    return finishQuote(ref, book);
  } catch (err) {
    return { ...ref, bid: null, bidSize: 0, ask: null, askSize: 0, spread: null, emptyBook: false, noValue: null, error: err instanceof Error ? err.message : String(err) };
  }
}

type CategoryInfo = { slug: string; title: string; url: string; negRisk: boolean | null };

function summarize(info: CategoryInfo, outcomes: OutcomeQuote[], outcomeCount: number, tradeableCount: number): CategoryAnalysis {
  outcomes.sort((a, b) => (b.bid ?? -1) - (a.bid ?? -1));
  let bidSum = 0;
  let askSum = 0;
  let missingBids = 0;
  let emptyBooks = 0;
  let failed = 0;
  let activeCount = 0;
  let estMissing = 0;
  let minBid: { size: number; title: string } | null = null;
  for (const o of outcomes) {
    if (o.error) {
      failed += 1;
      estMissing += o.refPrice == null ? 100 : Math.min(100, Math.max(0, o.refPrice));
      continue;
    }
    if (o.bid == null) missingBids += 1;
    bidSum += o.bid ?? 0;
    if (o.emptyBook) {
      emptyBooks += 1;
      continue;
    }
    activeCount += 1;
    askSum += o.ask ?? 0;
    if (o.bid != null && (!minBid || o.bidSize < minBid.size)) minBid = { size: o.bidSize, title: o.title };
  }
  const r2 = (x: number) => Math.round(x * 100) / 100; // 去掉浮点累加尾数
  return {
    slug: info.slug,
    title: info.title,
    url: info.url,
    negRisk: info.negRisk,
    outcomeCount,
    tradeableCount,
    activeCount,
    outcomes,
    bidSum: r2(bidSum),
    askSum: r2(askSum),
    missingBids,
    emptyBooks,
    failed,
    estMissing: r2(estMissing),
    bidSumUpper: r2(bidSum + estMissing),
    complete: failed === 0,
    minBid,
    checkedAt: new Date().toISOString()
  };
}

export async function analyzeMarkets(
  info: CategoryInfo,
  markets: PredictMarketSummary[],
  options: { concurrency?: number } = {}
): Promise<CategoryAnalysis> {
  const tradeable = markets.filter((m) => m.tradeable);
  const concurrency = options.concurrency ?? envNumber('NEGRISK_SCAN_CONCURRENCY', 2);
  const outcomes = await mapLimit(tradeable.map(outcomeRef), concurrency, quoteOutcome);
  return summarize(info, outcomes, markets.length, tradeable.length);
}

// 只补查上次获取失败的结果，其余沿用，然后重新汇总
export async function requoteFailed(a: CategoryAnalysis): Promise<CategoryAnalysis> {
  const failed = a.outcomes.filter((o) => o.error);
  if (!failed.length) return a;
  const concurrency = envNumber('NEGRISK_SCAN_CONCURRENCY', 2);
  const fresh = await mapLimit(
    failed.map((o) => ({ id: o.id, title: o.title, questionIndex: o.questionIndex, refPrice: o.refPrice })),
    concurrency,
    quoteOutcome
  );
  const byId = new Map(fresh.map((q) => [q.id, q]));
  const merged = a.outcomes.map((o) => byId.get(o.id) ?? o);
  return summarize({ slug: a.slug, title: a.title, url: a.url, negRisk: a.negRisk }, merged, a.outcomeCount, a.tradeableCount);
}

function predictHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (process.env.PREDICT_API_KEY) headers['x-api-key'] = process.env.PREDICT_API_KEY;
  return headers;
}

// GET /v1/categories/<slug>：拿到类目和嵌在里面的市场
export async function fetchCategoryBySlug(slug: string): Promise<{ category: any; markets: PredictMarketSummary[] } | null> {
  const raw = await fetchJson(`${PREDICT_REST_BASE}/categories/${encodeURIComponent(slug)}`, { headers: predictHeaders() });
  const category = (raw as any)?.data ?? raw;
  if (!category || typeof category !== 'object') return null;
  const markets = normalizeCategoryMarkets(category);
  if (!markets.length) return null;
  return { category, markets };
}

function groupFromCache(slug: string): MarketGroup | null {
  const entry = getCachedMarkets();
  if (!entry) return null;
  const key = slug.toLowerCase();
  // 先按 categorySlug 找；找不到再看是不是某个市场自己的 slug
  let list = entry.markets.filter((m) => (m.categorySlug || '').toLowerCase() === key);
  if (!list.length) {
    const hit = entry.markets.find((m) => (m.slug || '').toLowerCase() === key);
    if (hit?.categorySlug) {
      const ck = hit.categorySlug.toLowerCase();
      list = entry.markets.filter((m) => (m.categorySlug || '').toLowerCase() === ck);
    } else if (hit) {
      list = [hit];
    }
  }
  if (!list.length) return null;
  return groupMarketsByCategory(list)[0] ?? null;
}

// 输入链接 / slug → 查该类目所有结果的 Yes 买一并求和。
// 先走 /v1/categories/<slug>（最新），失败再退回缓存。
export async function analyzeCategoryBySlugOrUrl(input: string): Promise<CategoryAnalysis> {
  const slug = extractPredictSlug(input);
  if (!slug) throw new Error('没解析出 slug，请发 predict.fun 的市场链接');

  let markets: PredictMarketSummary[] | null = null;
  let title = '';
  let url = '';
  let negRisk: boolean | null = null;
  let source = '';
  try {
    const r = await fetchCategoryBySlug(slug);
    if (r) {
      markets = r.markets;
      title = String(r.category.title || r.category.name || '').trim();
      url = predictMarketUrl({ id: String(r.category.id ?? ''), slug: r.category.slug || slug });
      negRisk = negRiskOfGroup(markets, detectModeOf(markets));
      source = 'live';
    }
  } catch (err) {
    source = `live-failed: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`;
  }
  if (!markets) {
    const g = groupFromCache(slug);
    if (!g) {
      throw new Error(`没找到类目 ${slug}（接口 ${source || '无结果'}，缓存里也没有）`);
    }
    markets = g.markets;
    title = g.title;
    url = g.url;
    const cached = getCachedMarkets();
    negRisk = negRiskOfGroup(g.markets, detectModeOf(cached?.markets ?? g.markets));
  }
  const analysis = await analyzeMarkets({ slug, title: title || slug, url, negRisk }, markets);
  console.log(`[negrisk] analyze ${slug} via ${source || 'cache'}: ${analysis.tradeableCount} outcomes, Σbid=${analysis.bidSum.toFixed(1)}¢`);
  return analysis;
}

// ---------------- 全量扫描 ----------------

// 用缓存里的参考价粗估 Σ Yes 价格；每个结果都有价才返回数值
function estimateFromCache(g: MarketGroup): number | null {
  let sum = 0;
  for (const m of g.markets) {
    if (!m.tradeable) continue;
    const c = toCents(m.yesPrice ?? null);
    if (c == null) return null;
    sum += c;
  }
  return Math.round(sum * 100) / 100;
}

export type ScanCandidate = { g: MarketGroup; est: number | null };
export type ScanPlan = {
  detectMode: 'flag' | 'heuristic';
  groups: MarketGroup[]; // 可转换的候选类目
  prefiltered: ScanCandidate[]; // 参考价之和 < cutoff，跳过
  ranked: ScanCandidate[]; // 要扫的，按优先级：没参考价的在前（未知就得查），其余估值高的在前
  toScan: ScanCandidate[]; // ranked 截到每轮上限
  maxCategories: number;
  margin: number;
  cutoff: number; // thresholdCents − margin；margin < 0 表示关闭预过滤
};

// 扫描计划：扫描和 /yes_why 诊断共用同一套规则，诊断结果才能解释扫描行为
export function planScan(entry: MarketsCacheEntry, thresholdCents: number): ScanPlan {
  const detectMode = detectModeOf(entry.markets);
  const groups = groupMarketsByCategory(entry.markets).filter((g) => isConvertibleGroup(g, detectMode));
  // 预过滤：缓存参考价之和远低于阈值的类目跳过，省订单簿请求。
  // NEGRISK_PREFILTER_MARGIN=¢ 余量（默认 5），设 -1 关闭预过滤。
  const margin = envNumber('NEGRISK_PREFILTER_MARGIN', 5);
  const cutoff = thresholdCents - margin;
  const prefiltered: ScanCandidate[] = [];
  const ranked: ScanCandidate[] = [];
  for (const g of groups) {
    const est = estimateFromCache(g);
    if (margin >= 0 && est != null && est < cutoff) prefiltered.push({ g, est });
    else ranked.push({ g, est });
  }
  ranked.sort((a, b) => {
    if (a.est == null && b.est != null) return -1;
    if (a.est != null && b.est == null) return 1;
    return (b.est ?? 0) - (a.est ?? 0);
  });
  const maxCategories = Math.max(1, envNumber('NEGRISK_SCAN_MAX_CATEGORIES', 200));
  return { detectMode, groups, prefiltered, ranked, toScan: ranked.slice(0, maxCategories), maxCategories, margin, cutoff };
}

export async function scanConvertibleCategories(options: { thresholdCents?: number } = {}): Promise<ScanResult> {
  const start = Date.now();
  const thresholdCents = options.thresholdCents ?? getNegRiskThreshold();
  const entry = getCachedMarkets();
  if (!entry) throw new Error('市场缓存还没就绪，稍后再试（或先 /refresh）');

  const plan = planScan(entry, thresholdCents);
  const categoryConcurrency = envNumber('NEGRISK_SCAN_CATEGORY_CONCURRENCY', 1);

  let requests = 0;
  const results = await mapLimit(plan.toScan, categoryConcurrency, async ({ g }) => {
    requests += g.markets.filter((m) => m.tradeable).length;
    return analyzeMarkets({ slug: g.slug, title: g.title, url: g.url, negRisk: negRiskOfGroup(g.markets, plan.detectMode) }, g.markets);
  });

  // 第一遍有订单簿没查到（多半是 429）的类目，等限速器放行后只补查失败的那几个结果
  let retriedCategories = 0;
  if (process.env.NEGRISK_RETRY_FAILED !== '0') {
    for (let i = 0; i < results.length; i++) {
      if (results[i].failed === 0) continue;
      requests += results[i].failed;
      retriedCategories += 1;
      results[i] = await requoteFailed(results[i]);
    }
  }

  results.sort((a, b) => b.bidSum - a.bidSum);
  const hits = results.filter((r) => r.bidSum >= thresholdCents);
  const scan: ScanResult = {
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - start,
    detectMode: plan.detectMode,
    thresholdCents,
    candidates: plan.groups.length,
    prefiltered: plan.prefiltered.length,
    unknownEstimate: plan.ranked.filter((c) => c.est == null).length,
    scanned: results.length,
    capped: plan.ranked.length > plan.toScan.length,
    droppedByCap: plan.ranked.length - plan.toScan.length,
    requests,
    failedCategories: results.filter((r) => r.failed > 0).length,
    retriedCategories,
    results,
    hits
  };
  console.log(
    `[negrisk] scan: mode=${plan.detectMode} candidates=${scan.candidates} prefiltered=${scan.prefiltered} unknownEst=${scan.unknownEstimate} scanned=${scan.scanned}${scan.capped ? ` (capped, dropped ${scan.droppedByCap})` : ''} requests=${requests} retried=${retriedCategories} stillFailed=${scan.failedCategories} hits=${hits.length} top=${results[0] ? `${results[0].bidSum.toFixed(1)}¢ ${results[0].title}` : '-'} ${scan.durationMs}ms`
  );
  return scan;
}

// 列表/报告里该不该显示：总和 ≥ 下限，或者没查全但上限估计 ≥ 下限（宁可多显示也不静默漏掉）
export function passesFloor(a: CategoryAnalysis, minCents: number): boolean {
  return a.bidSum >= minCents || (a.failed > 0 && a.bidSumUpper >= minCents);
}

// ---------------- 消息格式 ----------------

function fmtSum(a: CategoryAnalysis): string {
  // 没查全时总和是下限
  return `${a.failed ? '≥ ' : ''}${fmtC(a.bidSum)}`;
}

export function formatCategoryReport(a: CategoryAnalysis, thresholdCents = getNegRiskThreshold()): string {
  const edge = a.bidSum - 100;
  const lines: string[] = [];
  lines.push(`🔁 ${a.title}`);
  lines.push(
    `可转换(NegRisk): ${a.negRisk === true ? '是' : a.negRisk === false ? '否' : '未知'} · ${a.outcomeCount} 个结果（可交易 ${a.tradeableCount} · 活跃 ${a.activeCount}${a.emptyBooks ? ` · 盘口空 ${a.emptyBooks}` : ''}${a.failed ? ` · 未查到 ${a.failed}` : ''}）`
  );
  lines.push(
    `Σ Yes 买1 = ${fmtSum(a)}${a.failed ? `（${a.failed} 个结果未查到，最多再 +${a.estMissing.toFixed(1)}¢）` : ''}（阈值 ${fmtC(thresholdCents, 1)} → ${a.bidSum >= thresholdCents ? '✅ 达到' : a.failed && a.bidSumUpper >= thresholdCents ? '❓ 可能达到，需重查' : '❌ 未达到'}）`
  );
  lines.push(`活跃结果 Σ Yes 卖1 = ${fmtC(a.askSum)} · 转换套利每份 ≈ ${edge >= 0 ? '+' : ''}${edge.toFixed(1)}¢（未扣手续费）`);
  if (a.negRisk === false) lines.push('⚠️ 接口标记这个类目不是 NegRisk，否 不能转换成 Yes');
  lines.push('');
  const active = a.outcomes.filter((o) => !o.error && !o.emptyBook);
  const empty = a.outcomes.filter((o) => !o.error && o.emptyBook);
  const failed = a.outcomes.filter((o) => o.error);
  if (active.length) {
    lines.push('结果 · Yes买1 ×深度 · Yes卖1 · 持「否」转换后可卖 / 直接卖否 · 否参考价值');
    active.forEach((o, i) => {
      const convert = a.bidSum - (o.bid ?? 0); // 转换成其余结果的 Yes 后按买一卖出
      const noBid = o.ask == null ? null : 100 - o.ask; // 否 的买一 = 100 − Yes 卖一
      lines.push(`${i + 1}. ${o.title} · ${fmtC(o.bid)} ×${fmtN(o.bidSize)} · ${fmtC(o.ask)} · ${fmtC(convert)} / ${fmtC(noBid)} · 否≈${fmtC(o.noValue)}`);
    });
  } else {
    lines.push('没有盘口正常的活跃结果。');
  }
  if (empty.length) {
    const parts = empty.slice(0, 8).map((o) => `${shortTitle(o.title)}（${o.bid == null ? '无买单' : `买1 ${fmtC(o.bid)}`} · ${o.ask == null ? '无卖单' : `卖1 ${fmtC(o.ask)}`}）`);
    if (empty.length > 8) parts.push(`…还有 ${empty.length - 8} 个`);
    lines.push('');
    lines.push(`盘口空 / 无买单（${empty.length}）：${parts.join('、')}`);
    lines.push('这些结果多半已淘汰或无人做市，否的参考价值接近 100¢，不要拿它们的否去转换。');
  }
  if (failed.length) {
    lines.push('');
    lines.push(`❌ 未查到订单簿（${failed.length}）：${failed.slice(0, 8).map((o) => shortTitle(o.title)).join('、')}${failed.length > 8 ? ` …还有 ${failed.length - 8} 个` : ''}（按 0 计，总和偏低）`);
  }
  lines.push('');
  if (a.minBid) lines.push(`最小买1深度: ${fmtN(a.minBid.size)} 份（${a.minBid.title}）`);
  lines.push(a.url);
  return lines.join('\n');
}

function outcomeSummary(a: CategoryAnalysis, max = 12): string {
  const active = a.outcomes.filter((o) => !o.error && !o.emptyBook);
  const parts = active.slice(0, max).map((o) => `${shortTitle(o.title)} ${o.bid == null ? '-' : o.bid.toFixed(1)}`);
  if (active.length > max) parts.push(`…还有 ${active.length - max} 个`);
  if (a.emptyBooks) parts.push(`盘口空 ${a.emptyBooks} 个`);
  if (a.failed) parts.push(`❌ 未查到 ${a.failed} 个`);
  return parts.join(' · ');
}

function shortTitle(t: string): string {
  const s = t.replace(/\s+/g, ' ').trim();
  return s.length > 24 ? s.slice(0, 22) + '…' : s;
}

export function formatAlertMessage(
  hits: CategoryAnalysis[],
  thresholdCents: number,
  near: CategoryAnalysis[] = [],
  displayMinCents = getNegRiskDisplayMin()
): string {
  const lines: string[] = [`🔁 可转换市场提醒：Yes 买1 总和 ≥ ${fmtC(thresholdCents)}（${hits.length} 个类目）`];
  hits.forEach((a, i) => {
    const edge = a.bidSum - 100;
    lines.push('');
    lines.push(`${i + 1}. ${a.title}`);
    lines.push(
      `   Σ Yes买1 = ${fmtSum(a)}（每份 ≈ ${edge >= 0 ? '+' : ''}${edge.toFixed(1)}¢）· 活跃 ${a.activeCount}/${a.tradeableCount} 个结果 · 最小买1深度 ${a.minBid ? fmtN(a.minBid.size) : '-'}${a.failed ? ` · ❌${a.failed} 个未查到` : ''}`
    );
    lines.push(`   ${outcomeSummary(a)}`);
    lines.push(`   ${a.url}`);
  });
  if (near.length) {
    lines.push('');
    lines.push(`📉 接近阈值（≥ ${fmtC(displayMinCents)}，未达 ${fmtC(thresholdCents)}）：`);
    for (const a of near) {
      lines.push(`• ${fmtC(a.bidSum)} · ${a.title}（${a.tradeableCount} 个结果）`);
      lines.push(`  ${a.url}`);
    }
  }
  return lines.join('\n');
}

// 从扫描结果里取"接近阈值"的类目：显示下限 ≤ Σ < 提醒阈值
export function nearThreshold(scan: ScanResult, displayMinCents = getNegRiskDisplayMin(), max = 5): CategoryAnalysis[] {
  return scan.results.filter((r) => r.bidSum < scan.thresholdCents && r.bidSum >= displayMinCents).slice(0, max);
}

// minCents：显示下限（列出 Σ Yes 买1 ≥ minCents 的全部类目，低于提醒阈值的也显示）
// max：最多列多少个，防止刷屏
export function formatScanReport(
  scan: ScanResult,
  options: { minCents?: number; max?: number } = {}
): string {
  const minCents = options.minCents ?? getNegRiskDisplayMin();
  const max = options.max ?? envNumber('NEGRISK_REPORT_MAX', 40);
  const lines: string[] = [
    `🔁 可转换市场扫描（提醒阈值 ${fmtC(scan.thresholdCents)} · 显示下限 ${fmtC(minCents)}）`,
    `候选 ${scan.candidates} 个类目 · 预过滤跳过 ${scan.prefiltered} · 实际查询 ${scan.scanned}${scan.capped ? `（超每轮上限，截掉 ${scan.droppedByCap} 个，调大 NEGRISK_SCAN_MAX_CATEGORIES）` : ''} · 订单簿请求 ${scan.requests} · ${Math.round(scan.durationMs / 1000)}s`,
    `判定方式: ${scan.detectMode === 'flag' ? '接口 isNegRisk 字段' : '启发式（≥3 个结果的类目，接口没给 isNegRisk）'}${scan.retriedCategories ? ` · 补查 ${scan.retriedCategories} 个类目` : ''}${scan.failedCategories ? ` · ⚠️ ${scan.failedCategories} 个类目仍有结果未查到` : ''}`,
    `达到提醒阈值: ${scan.hits.length} 个`
  ];
  if (!scan.results.length) {
    lines.push('', '没有可扫描的类目。');
    return lines.join('\n');
  }
  let list = scan.results.filter((a) => passesFloor(a, minCents));
  if (list.length) {
    lines.push('', `Σ Yes 买1 ≥ ${fmtC(minCents)} 的 ${list.length} 个（✅ = 达到提醒阈值，≥ = 没查全只是下限）：`);
  } else {
    // 下限以上一个都没有：仍然给最高的几个，免得空手而归
    list = scan.results.slice(0, 5);
    lines.push('', `没有 ≥ ${fmtC(minCents)} 的类目，最高的 ${list.length} 个：`);
  }
  const shown = list.slice(0, max);
  shown.forEach((a, i) => {
    lines.push(
      `${i + 1}. ${a.bidSum >= scan.thresholdCents ? '✅' : '▫️'} ${fmtSum(a)} · ${a.title}（活跃 ${a.activeCount}/${a.tradeableCount}${a.failed ? `，${a.failed} 个未查到` : ''}）`
    );
    lines.push(`   ${a.url}`);
  });
  if (list.length > shown.length) {
    lines.push(`…还有 ${list.length - shown.length} 个（提高下限：/yes_check 98，或改 NEGRISK_REPORT_MAX）`);
  }
  lines.push('', `换个下限看: /yes_check 90 · 固定下限: /yes_show 90 · 全部: /yes_check all · 某类目为何不在列表: /yes_why <链接>`);
  return lines.join('\n');
}

// ---------------- 定时任务 ----------------

function envTarget(): { chatId: string; threadId: number | null } | null {
  const chatId = String(process.env.TELEGRAM_CHAT_ID || '').trim();
  if (!chatId) return null;
  const raw = String(process.env.TELEGRAM_THREAD_ID || process.env.TELEGRAM_MESSAGE_THREAD_ID || '').trim();
  const n = Number(raw);
  return { chatId, threadId: raw && Number.isFinite(n) ? n : null };
}

function cooldownMap(): Map<string, number> {
  if (!globalThis.__negRiskLastAlertAt) globalThis.__negRiskLastAlertAt = new Map();
  return globalThis.__negRiskLastAlertAt;
}

export async function runNegRiskCycle(): Promise<LastCycle> {
  const at = new Date().toISOString();
  let scan: ScanResult | null = null;
  let alertsSent = 0;
  try {
    scan = await scanConvertibleCategories();
    const enabled = isNegRiskAlertsEnabled();
    const cooldownMs = envNumber('NEGRISK_ALERT_COOLDOWN_SEC', 1800) * 1000;
    const now = Date.now();
    const map = cooldownMap();
    const fresh = scan.hits.filter((h) => now - (map.get(h.slug) || 0) >= cooldownMs);
    const sendFn = globalThis.__negRiskSendFn;
    if (fresh.length && enabled && sendFn) {
      const subs = getSubscriptions('negrisk');
      const targets = subs.length ? subs.map((s) => ({ chatId: s.chatId, threadId: s.threadId })) : [envTarget()].filter(Boolean) as Array<{ chatId: string; threadId: number | null }>;
      if (targets.length) {
        const text = formatAlertMessage(fresh, scan.thresholdCents, nearThreshold(scan));
        for (const t of targets) {
          try {
            await sendFn(t.chatId, text, t.threadId);
            alertsSent += 1;
            await sleep(1200);
          } catch (err) {
            console.error(`[negrisk] send to ${t.chatId}:${t.threadId} failed:`, err instanceof Error ? err.message : err);
          }
        }
        if (alertsSent) for (const h of fresh) map.set(h.slug, now);
      } else {
        console.log('[negrisk] hits found but no subscribers and no TELEGRAM_CHAT_ID; nothing sent');
      }
    }
    const cycle: LastCycle = { at, scan, alertsSent };
    globalThis.__negRiskLastCycle = cycle;
    return cycle;
  } catch (err) {
    const cycle: LastCycle = { at, scan, alertsSent, error: err instanceof Error ? err.message : String(err) };
    globalThis.__negRiskLastCycle = cycle;
    console.error('[negrisk] cycle failed:', cycle.error);
    return cycle;
  }
}

export class ScanBusyError extends Error {
  constructor() {
    super('扫描进行中，请稍后再试');
    this.name = 'ScanBusyError';
  }
}

// 手动扫一次（/api/negrisk?scan=1）：与后台 tick 互斥（同一个 __negRiskRunning 标志），
// 成功的结果写入「上次扫描」（alertsSent 0、manual true），不推送提醒。
export async function runManualScan(): Promise<ScanResult> {
  if (globalThis.__negRiskRunning) throw new ScanBusyError();
  globalThis.__negRiskRunning = true;
  try {
    const scan = await scanConvertibleCategories();
    globalThis.__negRiskLastCycle = { at: scan.checkedAt, scan, alertsSent: 0, manual: true };
    return scan;
  } finally {
    globalThis.__negRiskRunning = false;
  }
}

export function startNegRiskMonitor(): void {
  if (globalThis.__negRiskTimer) return;
  if (process.env.ENABLE_NEGRISK_MONITOR === '0') {
    console.log('[negrisk] disabled via ENABLE_NEGRISK_MONITOR=0');
    return;
  }
  const intervalMs = envNumber('NEGRISK_CHECK_INTERVAL_MS', 300_000);
  if (intervalMs < 30_000) {
    console.log(`[negrisk] NEGRISK_CHECK_INTERVAL_MS=${intervalMs} too small, skipping`);
    return;
  }
  console.log(`[negrisk] starting monitor every ${intervalMs}ms, threshold=${getNegRiskThreshold()}¢`);
  const tick = async () => {
    if (globalThis.__negRiskRunning) return;
    if (!getCachedMarkets()) return; // 缓存还没拉好，下个周期再说
    globalThis.__negRiskRunning = true;
    try {
      await runNegRiskCycle();
    } finally {
      globalThis.__negRiskRunning = false;
    }
  };
  // 等市场缓存先拉完（缓存启动 10s 后开始，首次要 1-3 分钟）
  setTimeout(() => void tick(), 90_000);
  globalThis.__negRiskTimer = setInterval(() => void tick(), intervalMs);
}

// ---------------- 诊断：某个类目为什么不在列表里 ----------------

export type CategoryDiagnosis = {
  slug: string;
  thresholdCents: number;
  displayMinCents: number;
  cacheReady: boolean;
  cacheFetchedAt: string | null;
  cacheComplete: boolean | null;
  inCache: boolean;
  marketsInCache: number;
  tradeableInCache: number;
  detectMode: 'flag' | 'heuristic' | null;
  flaggedMarkets: number; // 缓存里这个类目带 isNegRisk/negRiskOnChainId 的市场数
  convertible: boolean | null;
  estimate: number | null; // 缓存参考价之和
  cutoff: number | null; // 低于这个值被预过滤
  prefiltered: boolean | null;
  rank: number | null; // 在本轮扫描队列里的位置（1 = 最先）
  queueLength: number | null;
  maxCategories: number | null;
  capped: boolean | null; // 排名超过每轮上限
  lastScan: {
    at: string;
    scanned: boolean;
    bidSum: number | null;
    bidSumUpper: number | null;
    failed: number | null;
    activeCount: number | null;
    passesFloor: boolean | null;
  } | null;
  conclusion: string; // 一句话结论
};

export function diagnoseCategory(input: string): CategoryDiagnosis {
  const slug = extractPredictSlug(input);
  const thresholdCents = getNegRiskThreshold();
  const displayMinCents = getNegRiskDisplayMin();
  const entry = getCachedMarkets();
  const d: CategoryDiagnosis = {
    slug,
    thresholdCents,
    displayMinCents,
    cacheReady: !!entry,
    cacheFetchedAt: entry?.fetchedAt ?? null,
    cacheComplete: entry?.complete ?? null,
    inCache: false,
    marketsInCache: 0,
    tradeableInCache: 0,
    detectMode: null,
    flaggedMarkets: 0,
    convertible: null,
    estimate: null,
    cutoff: null,
    prefiltered: null,
    rank: null,
    queueLength: null,
    maxCategories: null,
    capped: null,
    lastScan: null,
    conclusion: ''
  };
  if (!slug) {
    d.conclusion = '没解析出 slug，请发 predict.fun 的市场链接';
    return d;
  }
  if (!entry) {
    d.conclusion = '市场缓存还没就绪，后台扫描还没开始；等缓存抓完或先 /refresh';
    return d;
  }
  const g = groupFromCache(slug);
  if (!g) {
    d.conclusion = `缓存里没有这个类目（缓存抓取于 ${entry.fetchedAt}，${entry.complete ? '翻到底了' : '没翻到底'}）。可能类目状态不是 ${process.env.PREDICT_CATEGORY_STATUS || 'OPEN'} 被服务端过滤，或者抓取没覆盖到它；链接查询走的是单类目接口，不受影响`;
    return d;
  }
  d.inCache = true;
  d.marketsInCache = g.markets.length;
  d.tradeableInCache = g.markets.filter((m) => m.tradeable).length;
  const plan = planScan(entry, thresholdCents);
  d.detectMode = plan.detectMode;
  d.flaggedMarkets = g.markets.filter((m) => m.isNegRisk === true || !!m.negRiskOnChainId).length;
  const key = g.slug.toLowerCase();
  d.convertible = plan.groups.some((x) => x.slug.toLowerCase() === key);
  d.cutoff = plan.margin >= 0 ? plan.cutoff : null;
  d.maxCategories = plan.maxCategories;
  d.queueLength = plan.ranked.length;

  const last = getLastScan();
  const scanned = last?.results.find((r) => r.slug.toLowerCase() === key) ?? null;
  if (last) {
    d.lastScan = {
      at: last.checkedAt,
      scanned: !!scanned,
      bidSum: scanned?.bidSum ?? null,
      bidSumUpper: scanned?.bidSumUpper ?? null,
      failed: scanned?.failed ?? null,
      activeCount: scanned?.activeCount ?? null,
      passesFloor: scanned ? passesFloor(scanned, displayMinCents) : null
    };
  }

  if (!d.convertible) {
    d.conclusion =
      plan.detectMode === 'flag'
        ? d.tradeableInCache < 2
          ? `缓存里这个类目可交易的结果只有 ${d.tradeableInCache} 个，不算可转换类目`
          : `缓存里这个类目的 ${d.marketsInCache} 个市场都没有 isNegRisk / negRiskOnChainId 标记（列表接口给的字段可能比单类目接口少），被判定为不可转换，扫描不查它`
        : `启发式判定下需要 ≥3 个可交易结果，这个类目只有 ${d.tradeableInCache} 个`;
    return d;
  }
  const pre = plan.prefiltered.find((c) => c.g.slug.toLowerCase() === key);
  if (pre) {
    d.estimate = pre.est;
    d.prefiltered = true;
    d.conclusion = `被预过滤跳过：缓存参考价之和 ${pre.est?.toFixed(1)}¢ 低于 ${plan.cutoff.toFixed(1)}¢（阈值 ${thresholdCents} − 余量 ${plan.margin}）。参考价是缓存抓取时的旧价，盘口变动大时会误判；调大 NEGRISK_PREFILTER_MARGIN 或设 -1 关闭预过滤`;
    return d;
  }
  d.prefiltered = false;
  const idx = plan.ranked.findIndex((c) => c.g.slug.toLowerCase() === key);
  if (idx >= 0) {
    d.estimate = plan.ranked[idx].est;
    d.rank = idx + 1;
    d.capped = idx >= plan.maxCategories;
  }
  if (d.capped) {
    d.conclusion = `在扫描队列里排第 ${d.rank}/${d.queueLength}，超过每轮上限 ${plan.maxCategories}，这轮没轮到。调大 NEGRISK_SCAN_MAX_CATEGORIES，或收紧预过滤让队列变短`;
    return d;
  }
  if (!last) {
    d.conclusion = '还没有任何一轮扫描结果（后台首次扫描在启动约 90 秒后）';
    return d;
  }
  if (!scanned) {
    d.conclusion = `本应在上次扫描（${last.checkedAt}）的队列里（第 ${d.rank} 位），但结果里没有它：多半是它在那之后才进入候选，或那轮扫描中途出错；等下一轮或点「立即重扫」`;
    return d;
  }
  if (scanned.failed > 0 && !passesFloor(scanned, displayMinCents)) {
    d.conclusion = `上次扫描查到了，但 ${scanned.failed} 个结果的订单簿没查到（多半是 429 限流），总和按 0 计只有 ${scanned.bidSum.toFixed(1)}¢，连上限估计 ${scanned.bidSumUpper.toFixed(1)}¢ 也低于显示下限 ${displayMinCents}¢`;
    return d;
  }
  if (!passesFloor(scanned, displayMinCents)) {
    d.conclusion = `上次扫描（${last.checkedAt}）算出 Σ Yes 买1 = ${scanned.bidSum.toFixed(1)}¢，低于显示下限 ${displayMinCents}¢，所以列表没显示；链接查询是实时的，盘口这几分钟可能变了。降低下限 /yes_show 或等下一轮`;
    return d;
  }
  d.conclusion = `上次扫描（${last.checkedAt}）算出 ${scanned.failed ? '≥ ' : ''}${scanned.bidSum.toFixed(1)}¢${scanned.failed ? `（${scanned.failed} 个未查到）` : ''}，≥ 显示下限 ${displayMinCents}¢，应该在列表里；网页没显示就刷新一下，或检查"只看达标"勾选`;
  return d;
}

export function formatDiagnosis(d: CategoryDiagnosis): string {
  const lines = [`🔎 ${d.slug}`, d.conclusion, ''];
  lines.push(`缓存: ${d.cacheReady ? `${d.inCache ? '有' : '无'}这个类目 · 抓取于 ${d.cacheFetchedAt}（${d.cacheComplete ? '完整' : '不完整'}）` : '未就绪'}`);
  if (d.inCache) {
    lines.push(`市场: ${d.marketsInCache} 个（可交易 ${d.tradeableInCache}）· 判定方式 ${d.detectMode === 'flag' ? '接口 isNegRisk' : '启发式'} · 带标记 ${d.flaggedMarkets} 个 → 可转换: ${d.convertible ? '是' : '否'}`);
    if (d.cutoff != null) lines.push(`预过滤: 参考价之和 ${d.estimate == null ? '无（缺参考价，优先扫）' : `${d.estimate.toFixed(1)}¢`} vs 下限 ${d.cutoff.toFixed(1)}¢ → ${d.prefiltered ? '跳过' : '不跳过'}`);
    if (d.rank != null) lines.push(`队列: 第 ${d.rank}/${d.queueLength} 位 · 每轮上限 ${d.maxCategories} → ${d.capped ? '这轮没轮到' : '在本轮内'}`);
  }
  if (d.lastScan) {
    lines.push(
      d.lastScan.scanned
        ? `上次扫描 ${d.lastScan.at}: Σ ${d.lastScan.failed ? '≥ ' : ''}${d.lastScan.bidSum?.toFixed(1)}¢（未查到 ${d.lastScan.failed}，上限 ${d.lastScan.bidSumUpper?.toFixed(1)}¢，活跃 ${d.lastScan.activeCount}）→ ${d.lastScan.passesFloor ? '在列表里' : '低于显示下限'}`
        : `上次扫描 ${d.lastScan.at}: 没有这个类目`
    );
  } else {
    lines.push('上次扫描: 还没有');
  }
  lines.push(`阈值 ${d.thresholdCents}¢ · 显示下限 ${d.displayMinCents}¢`);
  return lines.join('\n');
}
