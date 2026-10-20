'use client';
import Link from 'next/link';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
// 只导入类型：SWC 会把 import type 擦掉，不会把 node:fs 打进客户端包
import type { CategoryAnalysis, CategoryDiagnosis, OutcomeQuote } from '@/lib/negrisk';

// ---------------- API 返回类型（只在客户端用，和各 route 的 JSON 对齐；旧版字段都按可选处理） ----------------

// 进程级 predict.fun 限速器（/api/health.predictLimiter 与 /api/negrisk status.limiter 是同一个对象；旧版服务端没有）
type PredictLimiter = {
  rps: number | null; // null = 不限速
  pausedForMs: number; // 收到 429 后全局暂停，剩余毫秒
  pausedUntil: string | null;
  count429: number;
  last429At: string | null;
  totalRequests: number;
  waiting: number;
};

type HealthResponse = {
  ok: boolean;
  version: string;
  processStarted: string;
  now: string;
  cacheTimerActive?: boolean;
  negriskTimerActive?: boolean;
  botPolling: boolean;
  botLastEventAt: string | null;
  botLastError: string | null;
  hasTelegram: boolean;
  hasPredictApiKey?: boolean;
  predictLimiter?: PredictLimiter | null;
  env?: string;
};

type CacheStatus = {
  hasCache: boolean;
  fetchedAt: string | null;
  ageMs: number | null;
  ttlMs: number;
  totalMarkets: number;
  totalCategories: number;
  pagesFetched: number;
  stoppedReason: string | null;
  complete: boolean | null;
  statusFilter: string | null;
  pageSize: number;
  durationMs: number | null;
  refreshInflight: boolean;
  timerActive: boolean;
  lastError: string | null;
};

type NegRiskLastCycle = {
  at: string;
  alertsSent: number;
  error: string | null;
  manual?: boolean;
  detectMode: 'flag' | 'heuristic' | null;
  candidates: number;
  prefiltered: number;
  scanned: number;
  requests: number;
  durationMs: number;
  capped?: boolean;
  droppedByCap?: number;
  failedCategories?: number;
  retriedCategories?: number;
  hits: number;
  topSum: number | null;
  topTitle: string | null;
};

type NegRiskStatus = {
  enabled: boolean;
  thresholdCents: number;
  displayMinCents: number;
  changedAt: string | null;
  intervalMs: number;
  cooldownSec: number;
  timerActive: boolean;
  running: boolean;
  subscribers: number;
  limiter?: PredictLimiter | null;
  lastCycle: NegRiskLastCycle | null;
};

type ScanSummary = {
  checkedAt: string;
  durationMs: number;
  detectMode: 'flag' | 'heuristic';
  thresholdCents: number;
  candidates: number;
  prefiltered: number;
  scanned: number;
  unknownEstimate?: number;
  capped: boolean;
  droppedByCap?: number; // 超过每轮上限没轮到的类目数
  requests: number;
  failedCategories?: number; // 补查之后仍有结果没查到的类目数
  retriedCategories?: number; // 第一遍有失败、做了补查的类目数
  hits: number;
};

// 服务端返回的类目 / 结果：新字段（活跃数、盘口空、未查到的估计上限…）旧版服务端没有，按可选处理；
// 进页面前经 normalizeAnalysis 补齐成 CategoryAnalysis，下面的组件只认完整类型
type ApiOutcome = Omit<OutcomeQuote, 'spread' | 'emptyBook' | 'noValue' | 'refPrice'> & Partial<Pick<OutcomeQuote, 'spread' | 'emptyBook' | 'noValue' | 'refPrice'>>;
type ApiCategory = Omit<CategoryAnalysis, 'activeCount' | 'emptyBooks' | 'estMissing' | 'bidSumUpper' | 'complete' | 'outcomes'> &
  Partial<Pick<CategoryAnalysis, 'activeCount' | 'emptyBooks' | 'estMissing' | 'bidSumUpper' | 'complete'>> & { outcomes?: ApiOutcome[] };

type NegRiskListResponse = {
  ok: boolean;
  error?: string;
  status: NegRiskStatus;
  filters?: { minCents: number; limit: number };
  scan: ScanSummary;
  count: number;
  results: ApiCategory[];
};
type NegRiskListData = Omit<NegRiskListResponse, 'results'> & { results: CategoryAnalysis[] };

// ?slug= 的响应：analysis（实时订单簿）和 / 或 diagnosis（&why=1：这个类目为什么不在扫描列表里）
type AnalysisResponse = { ok: boolean; error?: string; status?: NegRiskStatus; analysis?: ApiCategory; diagnosis?: CategoryDiagnosis };

type PredictMarketSummary = {
  id: string;
  title: string;
  slug?: string;
  categorySlug?: string;
  categoryTitle?: string;
  category?: string;
  endMs?: number | null;
  yesPrice?: number | null;
  noPrice?: number | null;
  hourlyRate: number;
  hourlyRateSource?: 'current' | 'schedule' | 'recursive' | 'none';
  polymarketConditionIds: string[];
  hasPolymarket: boolean;
  tradeable: boolean;
};

type FilterStats = { input: number; afterPolymarket: number; afterNoise: number; afterTradeable: number; afterRewards: number; output: number };

type PredictOnlyResponse = {
  ok: boolean;
  error?: string;
  checkedAt?: string;
  complete?: boolean | null;
  pagesFetched?: number;
  stoppedReason?: string | null;
  filterStats?: FilterStats;
  predictOnly?: PredictMarketSummary[];
};

type EventGroup = { slug: string; title: string; url: string; totalHourlyRate: number; endMs: number | null; markets: PredictMarketSummary[] };
type Row = CategoryAnalysis & { live?: boolean };
type Tone = 'ok' | 'warn' | 'bad' | undefined;
type JsonResult<T> = { ok: boolean; status: number; json: T | null; error: string; timedOut: boolean };
type CacheEnvelope = { ok: boolean; cache: CacheStatus };

const PP_URL = '/api/predict-only?hasActiveRewards=1';
const NEGRISK_LIMIT = 50;
const PP_MAX_GROUPS = 30;
const SCAN_BUSY_MSG = '后台扫描正在进行，稍后自动刷新';

// ---------------- 工具 ----------------

// 永不 throw：超时 / 网络错误 / 非 2xx 都变成 { ok:false, error }，404/409/500 的 JSON 也会解析出来
async function getJson<T>(url: string, timeoutMs: number): Promise<JsonResult<T>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    const ok = res.ok && json != null && json.ok !== false;
    return { ok, status: res.status, json, error: ok ? '' : String(json?.error || `HTTP ${res.status}`), timedOut: false };
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      json: null,
      error: timedOut ? `请求超时（${Math.round(timeoutMs / 1000)}s）` : err instanceof Error ? err.message : String(err),
      timedOut
    };
  } finally {
    clearTimeout(timer);
  }
}

function fmtC(v: number | null | undefined, digits = 1) {
  return v == null || !Number.isFinite(v) ? '-' : `${v.toFixed(digits)}¢`;
}

function fmtN(v: unknown, digits = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: digits }) : '-';
}

function fmtPrice(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  return `${(n * 100).toFixed(1)}¢`;
}

function fmtTime(iso?: string | null) {
  if (!iso) return '-';
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? iso : t.toLocaleString('zh-CN', { hour12: false });
}

function fmtClock(iso?: string | null) {
  if (!iso) return '-';
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? iso : t.toLocaleTimeString('zh-CN', { hour12: false });
}

// 相对时间；skewMs = 服务器时间 − 浏览器时间，避免本机时钟不准时出现「-3 分钟前」
function agoWith(iso: string | null | undefined, skewMs: number) {
  if (!iso) return '-';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '-';
  const s = Math.max(0, Math.round((Date.now() + skewMs - t) / 1000));
  if (s < 5) return '刚刚';
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${(s / 86400).toFixed(1)} 天前`;
}

function fmtDur(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const s = ms / 1000;
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟`;
  if (s < 86400) return `${(s / 3600).toFixed(1)} 小时`;
  return `${(s / 86400).toFixed(1)} 天`;
}

function fmtRemaining(endMs?: number | null) {
  if (!endMs) return '';
  const ms = endMs - Date.now();
  if (ms <= 0) return '已结束';
  const h = ms / 3600000;
  if (h >= 24) return `${(h / 24).toFixed(1)}d`;
  if (h >= 1) return `${h.toFixed(1)}h`;
  return `${Math.round(ms / 60000)}m`;
}

function shortTitle(t: string, max = 24) {
  const s = t.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 2) + '…' : s;
}

// 与 /predict-only 页面、lib groupMarketsByCategory 同一套分组规则
function groupByEvent(markets: PredictMarketSummary[]): EventGroup[] {
  const map = new Map<string, PredictMarketSummary[]>();
  for (const m of markets) {
    const key = (m.categorySlug || m.slug || m.id || '').toLowerCase();
    if (!key) continue;
    const list = map.get(key) || [];
    list.push(m);
    map.set(key, list);
  }
  return Array.from(map.entries()).map(([slug, list]) => {
    list.sort((a, b) => (b.hourlyRate || 0) - (a.hourlyRate || 0));
    const first = list[0];
    const title = first.categoryTitle || first.category || first.title || slug;
    const ends = list.map((m) => m.endMs).filter((v): v is number => typeof v === 'number');
    const url = first.slug || first.categorySlug ? `https://predict.fun/market/${first.slug || first.categorySlug}` : `https://predict.fun/market/${first.id}`;
    return {
      slug,
      title,
      url,
      totalHourlyRate: list.reduce((s, m) => s + (m.hourlyRate || 0), 0),
      endMs: ends.length ? Math.max(...ends) : null,
      markets: list
    };
  });
}

function negriskUrl(floor: number | null) {
  return floor == null ? `/api/negrisk?limit=${NEGRISK_LIMIT}` : `/api/negrisk?min=${floor}&limit=${NEGRISK_LIMIT}`;
}

// ---------------- 兼容旧版服务端：补齐新字段 ----------------

const EMPTY_BOOK_SPREAD = 30; // 与 lib/negrisk NEGRISK_EMPTY_BOOK_SPREAD 默认值一致，只在服务端没给 emptyBook 时用
const r2 = (x: number) => Math.round(x * 100) / 100;
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function normalizeOutcome(o: ApiOutcome): OutcomeQuote {
  const bid = numOrNull(o.bid);
  const ask = numOrNull(o.ask);
  const spread = o.spread !== undefined ? o.spread : bid != null && ask != null ? r2(ask - bid) : null;
  // 盘口空（lib/negrisk finishQuote 同一规则）：没买单 / 没卖单 / 价差 ≥ 30¢；获取失败的结果不算
  const emptyBook = typeof o.emptyBook === 'boolean' ? o.emptyBook : !o.error && (bid == null || ask == null || (spread != null && spread >= EMPTY_BOOK_SPREAD));
  return {
    ...o,
    bid,
    ask,
    bidSize: Number(o.bidSize) || 0,
    askSize: Number(o.askSize) || 0,
    spread,
    emptyBook,
    noValue: o.noValue !== undefined ? o.noValue : bid == null ? null : r2(100 - bid),
    refPrice: o.refPrice ?? null
  };
}

// activeCount / emptyBooks / estMissing / bidSumUpper / complete 缺失时按 lib/negrisk summarize 同一规则从结果补算
function normalizeAnalysis(a: ApiCategory): CategoryAnalysis {
  const outcomes = (Array.isArray(a.outcomes) ? a.outcomes : []).map(normalizeOutcome);
  const failedOutcomes = outcomes.filter((o) => !!o.error);
  const failed = Number(a.failed) || failedOutcomes.length;
  const estMissing = a.estMissing ?? r2(failedOutcomes.reduce((s, o) => s + (o.refPrice == null ? 100 : Math.min(100, Math.max(0, o.refPrice))), 0));
  const bidSum = Number(a.bidSum) || 0;
  return {
    ...a,
    outcomes,
    bidSum,
    askSum: Number(a.askSum) || 0,
    missingBids: Number(a.missingBids) || 0,
    failed,
    activeCount: a.activeCount ?? outcomes.filter((o) => !o.error && !o.emptyBook).length,
    emptyBooks: a.emptyBooks ?? outcomes.filter((o) => !o.error && o.emptyBook).length,
    estMissing,
    bidSumUpper: a.bidSumUpper ?? r2(bidSum + estMissing),
    complete: a.complete ?? failed === 0,
    minBid: a.minBid ?? null
  };
}

// ---------------- 纯展示组件 ----------------

function StatCard({ label, value, tone, lines }: { label: string; value: ReactNode; tone?: Tone; lines: ReactNode[] }) {
  const shown = lines.filter((l) => l !== null && l !== undefined && l !== false && l !== '');
  return (
    <div className="card stat">
      <span>{label}</span>
      <strong className={tone}>{value}</strong>
      {shown.length > 0 && (
        <small>
          {shown.map((l, i) => (
            <Fragment key={i}>
              {i > 0 && <br />}
              {l}
            </Fragment>
          ))}
        </small>
      )}
    </div>
  );
}

function IssueBanners({ issues }: { issues: { errors: string[]; warnings: string[] } }) {
  if (!issues.errors.length && !issues.warnings.length) return null;
  return (
    <>
      {issues.errors.length > 0 && (
        <div className="error">
          <ul>
            {issues.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      {issues.warnings.length > 0 && (
        <div className="notice">
          <ul>
            {issues.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function NegRiskBadge({ negRisk }: { negRisk: boolean | null }) {
  if (negRisk === false) return <span className="badge bad">非 NegRisk</span>;
  if (negRisk === null) return <span className="badge warn">可转换未知</span>;
  return null;
}

// 空状态单元格：表格有 1060px 最小宽度，手机上整表横向滚动；把文案限制在可视宽度内，不用滚动就能读到
function EmptyCell({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <td colSpan={colSpan} className="empty">
      <div style={{ maxWidth: 'calc(100vw - 100px)' }}>{children}</div>
    </td>
  );
}

// 重扫计时：独立组件，每秒只重渲染这一个标签，不带动整页（50 行 + 展开的子表）
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <>{Math.max(0, Math.round((now - since) / 1000))}s</>;
}

// 8 列结果表 + 脚注；口径与 lib/negrisk formatCategoryReport 一致：
//   持「否」转换后可卖 = Σ Yes 买1 − 本结果 Yes 买1；直接卖否 = 100 − Yes 卖1；否参考价值 = 100 − Yes 买1
// 活跃结果按 Yes 买1 降序排前面；盘口空 / 无买单 与 未查到 的结果各折叠成一行摘要，点开才列出
const OUTCOME_COLS = 8;

function OutcomeTable({ analysis }: { analysis: CategoryAnalysis }) {
  const { outcomes, minBid, bidSum } = analysis;
  const [showEmpty, setShowEmpty] = useState(false);
  const [showFailed, setShowFailed] = useState(false);
  const allKeyMissing = outcomes.length > 0 && outcomes.every((o) => !!o.error && o.error.includes('Missing PREDICT_API_KEY'));
  if (allKeyMissing) return <div className="error">PREDICT_API_KEY 未配置，订单簿全部失败</div>;
  const active = outcomes.filter((o) => !o.error && !o.emptyBook).sort((a, b) => (b.bid ?? -1) - (a.bid ?? -1));
  const empty = outcomes.filter((o) => !o.error && o.emptyBook);
  const failed = outcomes.filter((o) => !!o.error);
  let bottleneckMarked = false;

  const quoteRow = (o: OutcomeQuote, index: number) => {
    const convert = o.bid == null ? null : bidSum - o.bid;
    const noBid = o.ask == null ? null : 100 - o.ask;
    const d = convert == null || noBid == null ? null : convert - noBid;
    const isBottleneck = !o.emptyBook && !!minBid && !bottleneckMarked && o.title === minBid.title && o.bidSize === minBid.size;
    if (isBottleneck) bottleneckMarked = true;
    return (
      <tr key={`${o.id}-${index}`}>
        <td>{index + 1}</td>
        <td>
          <b>{o.title}</b>
          {isBottleneck && <span className="badge warn">瓶颈</span>}
          <small>#{o.id}</small>
        </td>
        <td>
          {o.bid == null ? (
            <span className={o.emptyBook ? 'muted' : 'negative'}>无买单</span>
          ) : (
            <>
              {fmtC(o.bid)}
              <small>×{fmtN(o.bidSize)} 份</small>
            </>
          )}
        </td>
        <td>
          {o.ask == null ? (
            '-'
          ) : (
            <>
              {fmtC(o.ask)}
              <small>×{fmtN(o.askSize)} 份</small>
            </>
          )}
        </td>
        <td>{fmtC(convert)}</td>
        {o.emptyBook ? (
          <>
            <td style={{ whiteSpace: 'nowrap' }}>
              —
              <span className="badge warn" title="没买单 / 没卖单 / 价差 ≥ 30¢：多半已淘汰或无人做市，用卖一反推「直接卖否」没有意义">
                盘口空
              </span>
            </td>
            <td>—</td>
          </>
        ) : (
          <>
            <td>{noBid == null ? '-' : fmtC(noBid)}</td>
            <td>
              {d == null ? (
                '-'
              ) : (
                <span className={d > 0 ? 'positive' : d < 0 ? 'negative' : undefined}>
                  {d >= 0 ? '+' : ''}
                  {d.toFixed(1)}¢
                </span>
              )}
            </td>
          </>
        )}
        <td>{fmtC(o.noValue)}</td>
      </tr>
    );
  };

  const failedRow = (o: OutcomeQuote, index: number) => (
    <tr key={`${o.id}-${index}`}>
      <td>{index + 1}</td>
      <td>
        <b>{o.title}</b>
        <small>#{o.id}</small>
      </td>
      <td colSpan={OUTCOME_COLS - 2} className="negative">
        ❌ 订单簿未查到：{o.error}
        {o.refPrice != null && <small className="muted">缓存参考价 {fmtC(o.refPrice)}，上限估计按它算</small>}
      </td>
    </tr>
  );

  // 折叠行：盘口空 / 未查到 各一行，点开才列出具体结果
  const groupRow = (key: string, label: string, open: boolean, toggle: () => void, hint: string) => (
    <tr key={key} className="groupRow">
      <td colSpan={OUTCOME_COLS}>
        <button type="button" className="groupToggle" aria-expanded={open} onClick={toggle}>
          {label} {open ? '▾ 收起' : '▸ 展开'}
        </button>
        <span className="groupHint">{hint}</span>
      </td>
    </tr>
  );

  return (
    <>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>结果</th>
            <th>Yes 买1</th>
            <th>Yes 卖1</th>
            <th>持「否」转换后可卖</th>
            <th>直接卖否</th>
            <th>转换优势</th>
            <th>否参考价值</th>
          </tr>
        </thead>
        <tbody>
          {active.map(quoteRow)}
          {!outcomes.length && (
            <tr>
              <EmptyCell colSpan={OUTCOME_COLS}>没有可交易的结果</EmptyCell>
            </tr>
          )}
          {outcomes.length > 0 && !active.length && (
            <tr>
              <EmptyCell colSpan={OUTCOME_COLS}>没有盘口正常的活跃结果</EmptyCell>
            </tr>
          )}
          {empty.length > 0 &&
            groupRow('empty', `盘口空 / 无买单 ${empty.length} 个`, showEmpty, () => setShowEmpty((v) => !v), '多半已淘汰或无人做市，否的参考价值接近 100¢，别拿它们的否去转换')}
          {showEmpty && empty.map((o, i) => quoteRow(o, active.length + i))}
          {failed.length > 0 &&
            groupRow(
              'failed',
              `未查到 ${failed.length} 个`,
              showFailed,
              () => setShowFailed((v) => !v),
              `订单簿没查到（多半是 429 限流），按 0 计，Σ 是下限，最多再 +${analysis.estMissing.toFixed(1)}¢`
            )}
          {showFailed && failed.map((o, i) => failedRow(o, active.length + empty.length + i))}
        </tbody>
      </table>
      <small className="muted" style={{ display: 'block', marginTop: 8, lineHeight: 1.6 }}>
        {minBid && (
          <>
            最小买1深度: {fmtN(minBid.size)} 份（{minBid.title}）<br />
          </>
        )}
        {analysis.missingBids > 0 && (
          <>
            无买单的结果: {analysis.missingBids} 个（按 0 计）<br />
          </>
        )}
        {analysis.failed > 0 && (
          <>
            未查到订单簿: {analysis.failed} 个（按 0 计，Σ 是下限，最多再 +{analysis.estMissing.toFixed(1)}¢）<br />
          </>
        )}
        Yes买1 ×深度 · Yes卖1 · 持「否」转换后可卖 / 直接卖否 · 否参考价值 — 与 Telegram 报告同口径
      </small>
    </>
  );
}

// formatCategoryReport 的 4 行表头：没查全时 Σ 是下限，判定多一档「❓ 可能达到，需重查」（上限估计 ≥ 阈值）
function CategoryHeader({ analysis: a, thresholdCents }: { analysis: CategoryAnalysis; thresholdCents: number }) {
  const edge = a.bidSum - 100;
  const hit = a.bidSum >= thresholdCents;
  const maybe = !hit && a.failed > 0 && a.bidSumUpper >= thresholdCents;
  const verdict = hit ? '✅ 达到' : maybe ? '❓ 可能达到，需重查' : '❌ 未达到';
  return (
    <div style={{ lineHeight: 1.7, marginBottom: 6 }}>
      <div>
        <b>
          <a className="linkOut" href={a.url} target="_blank" rel="noreferrer">
            {a.title} ↗
          </a>
        </b>
        <NegRiskBadge negRisk={a.negRisk} />
      </div>
      <div className="muted">
        {`可转换(NegRisk): ${a.negRisk === true ? '是' : a.negRisk === false ? '否' : '未知'} · ${a.outcomeCount} 个结果（可交易 ${a.tradeableCount} · 活跃 ${a.activeCount}${
          a.emptyBooks ? ` · 盘口空 ${a.emptyBooks}` : ''
        }${a.failed ? ` · 未查到 ${a.failed}` : ''}）`}
      </div>
      <div>
        <span className={hit ? 'positive' : maybe ? 'caution' : 'negative'}>
          {`Σ Yes 买1 ${a.failed ? '≥' : '='} ${fmtC(a.bidSum)}${a.failed ? `（${a.failed} 个结果未查到，最多再 +${a.estMissing.toFixed(1)}¢）` : ''}（阈值 ${fmtC(thresholdCents)} → ${verdict}）`}
        </span>
      </div>
      <div className="muted">{`活跃结果 Σ Yes 卖1 = ${fmtC(a.askSum)} · 转换套利每份 ≈ ${edge >= 0 ? '+' : ''}${edge.toFixed(1)}¢（未扣手续费）`}</div>
      {a.negRisk === false && <div className="error">⚠️ 接口标记这个类目不是 NegRisk，否 不能转换成 Yes</div>}
      <div className="muted">检查于 {fmtTime(a.checkedAt)}</div>
    </div>
  );
}

type CategoryRowProps = {
  row: Row;
  thresholdCents: number;
  expanded: boolean;
  requoting: boolean;
  rowError?: string;
  skewMs: number;
  onToggle: (slug: string) => void;
  onRequote: (slug: string) => void;
};

function CategoryRow({ row, thresholdCents, expanded, requoting, rowError, skewMs, onToggle, onRequote }: CategoryRowProps) {
  const hit = row.bidSum >= thresholdCents;
  const incomplete = row.failed > 0; // 没查全：bidSum 只是下限，真实总和 ≤ bidSumUpper
  const maybeHit = !hit && incomplete && row.bidSumUpper >= thresholdCents;
  const edge = row.bidSum - 100;
  const allFailed = incomplete && row.failed === row.outcomes.length;
  const qualityOk = row.missingBids === 0 && !incomplete;
  const upperHint = `最多再 +${row.estMissing.toFixed(1)}¢`;
  return (
    <>
      <tr className={hit ? 'hit' : 'near'}>
        <td>
          {hit ? (
            <span className="positive" style={{ whiteSpace: 'nowrap' }}>✅ 达标</span>
          ) : maybeHit ? (
            <span className="caution" style={{ whiteSpace: 'nowrap' }} title={`没查全：上限估计 ${fmtC(row.bidSumUpper)} ≥ 阈值，点「重新查」确认`}>
              ❓ 可能达标
            </span>
          ) : (
            <span className="muted" style={{ whiteSpace: 'nowrap' }}>▫️ 接近</span>
          )}
          {row.live && <small>实时 {fmtClock(row.checkedAt)}</small>}
        </td>
        <td>
          <b>{row.title}</b>
          <NegRiskBadge negRisk={row.negRisk} />
          <small>{row.slug}</small>
        </td>
        <td>
          {allFailed ? (
            <>
              —<small className="negative">全部未查到</small>
            </>
          ) : (
            <>
              <b className={hit ? 'positive' : undefined} style={{ whiteSpace: 'nowrap' }} title={incomplete ? `下限：${row.failed} 个结果未查到，${upperHint}` : undefined}>
                {incomplete ? '≥ ' : ''}
                {row.bidSum.toFixed(1)}¢
              </b>
              <small>
                每份 {incomplete ? '≥' : '≈'} {edge >= 0 ? '+' : ''}
                {edge.toFixed(1)}¢
              </small>
              {incomplete && <small className="caution">下限 · {upperHint}</small>}
            </>
          )}
        </td>
        <td>
          {row.askSum.toFixed(1)}¢<small>活跃结果</small>
        </td>
        <td>
          {row.activeCount} / {row.tradeableCount} / {row.outcomeCount}
          <small>活跃 / 可交易 / 共</small>
        </td>
        <td>
          {row.minBid ? (
            <>
              {fmtN(row.minBid.size)} 份<small>{shortTitle(row.minBid.title)}</small>
              {edge > 0 && <small>顶档利润 ≈ ${((edge * row.minBid.size) / 100).toFixed(2)}（未扣手续费）</small>}
            </>
          ) : (
            '-'
          )}
        </td>
        <td>
          {qualityOk ? (
            <span className="muted">OK</span>
          ) : (
            <>
              {row.missingBids > 0 && (
                <span className="badge warn" title="按 0 计">
                  无买单 {row.missingBids}
                </span>
              )}
              {incomplete && (
                <span className="badge warn" title={`订单簿没查到（多半是 429 限流），按 0 计，Σ 是下限；${upperHint}`}>
                  未查到 {row.failed}
                </span>
              )}
            </>
          )}
        </td>
        <td>
          {fmtClock(row.checkedAt)}
          <small>{agoWith(row.checkedAt, skewMs)}</small>
        </td>
        <td>
          <button className="secondary sm" onClick={() => onToggle(row.slug)} aria-expanded={expanded}>
            {expanded ? '收起' : `展开 ${row.outcomes.length} 个`}
          </button>
          <button className="secondary sm" onClick={() => onRequote(row.slug)} disabled={requoting}>
            {requoting ? '查询中…' : '重新查'}
          </button>
          <a className="linkOut" href={row.url} target="_blank" rel="noreferrer" style={{ whiteSpace: 'nowrap' }}>
            打开 ↗
          </a>
          {rowError && <small className="negative">{rowError}</small>}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={9}>
            <div className="subTable">
              <OutcomeTable analysis={row} />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// /api/negrisk?slug=…&why=1&live=0 的结果：结论放大，其余事实一行一条（措辞与 lib/negrisk formatDiagnosis 一致）
function DiagnosisPanel({ d }: { d: CategoryDiagnosis }) {
  const facts: string[] = [];
  facts.push(d.cacheReady ? `缓存: ${d.inCache ? '有' : '无'}这个类目 · 抓取于 ${fmtTime(d.cacheFetchedAt)}（${d.cacheComplete ? '完整' : '不完整'}）` : '缓存: 未就绪');
  if (d.inCache) {
    facts.push(
      `市场: ${d.marketsInCache} 个（可交易 ${d.tradeableInCache}）· 判定方式 ${d.detectMode === 'flag' ? '接口 isNegRisk' : '启发式'} · 带标记 ${d.flaggedMarkets} 个 → 可转换: ${d.convertible ? '是' : '否'}`
    );
    if (d.cutoff != null) {
      facts.push(`预过滤: 参考价之和 ${d.estimate == null ? '无（缺参考价，优先扫）' : fmtC(d.estimate)} vs 下限 ${fmtC(d.cutoff)} → ${d.prefiltered ? '跳过' : '不跳过'}`);
    }
    if (d.rank != null) facts.push(`队列: 第 ${d.rank}/${d.queueLength ?? '-'} 位 · 每轮上限 ${d.maxCategories ?? '-'} → ${d.capped ? '这轮没轮到' : '在本轮内'}`);
  }
  const ls = d.lastScan ?? null;
  facts.push(
    ls
      ? ls.scanned
        ? `上次扫描 ${fmtTime(ls.at)}: Σ ${ls.failed ? '≥ ' : ''}${fmtC(ls.bidSum)}（未查到 ${ls.failed ?? 0}，上限 ${fmtC(ls.bidSumUpper)}，活跃 ${ls.activeCount ?? '-'}）→ ${
            ls.passesFloor ? '在列表里' : '低于显示下限'
          }`
        : `上次扫描 ${fmtTime(ls.at)}: 没有这个类目`
      : '上次扫描: 还没有'
  );
  facts.push(`阈值 ${d.thresholdCents}¢ · 显示下限 ${d.displayMinCents}¢`);
  return (
    <div className="diagnosis">
      <div className="muted" style={{ fontSize: 13 }}>🔎 {d.slug || '-'} · 为什么不在列表？</div>
      <p className="conclusion">{d.conclusion || '（服务端没给结论）'}</p>
      <ul>
        {facts.map((f, i) => (
          <li key={i}>{f}</li>
        ))}
      </ul>
    </div>
  );
}

// ---------------- 页面 ----------------

export default function DashboardPage() {
  const [health, setHealth] = useState<{ data: HealthResponse | null; error: string }>({ data: null, error: '' });
  const [cache, setCache] = useState<{ data: CacheStatus | null; error: string }>({ data: null, error: '' });
  const [negrisk, setNegrisk] = useState<{ data: NegRiskListData | null; status: NegRiskStatus | null; error: string; notScanned: boolean }>({
    data: null,
    status: null,
    error: '',
    notScanned: false
  });
  const [pp, setPp] = useState<{ data: PredictOnlyResponse | null; error: string }>({ data: null, error: '' });
  const [floor, setFloor] = useState<number | null>(null);
  const [onlyHits, setOnlyHits] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [loading, setLoading] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);
  const [lastRefreshError, setLastRefreshError] = useState('');
  const [skewMs, setSkewMs] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [scanStartedAt, setScanStartedAt] = useState<number | null>(null);
  const [scanError, setScanError] = useState('');
  const [cacheRefreshing, setCacheRefreshing] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [liveRows, setLiveRows] = useState<Record<string, CategoryAnalysis>>({});
  const [requoting, setRequoting] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [analyzeInput, setAnalyzeInput] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  // 单类目结果连同响应里的「当前阈值」一起存：bot 的 /yes 按当前阈值判定，不是上次扫描时的阈值
  const [analysis, setAnalysis] = useState<{ analysis: CategoryAnalysis; thresholdCents: number } | null>(null);
  const [analyzeError, setAnalyzeError] = useState('');
  // 「为什么不在列表？」：只诊断不查订单簿（/api/negrisk?slug=…&why=1&live=0，与 bot 的 /yes_why 同口径）
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnosis, setDiagnosis] = useState<CategoryDiagnosis | null>(null);
  const [diagnoseError, setDiagnoseError] = useState('');

  const floorRef = useRef<number | null>(null);
  const scanningRef = useRef(false);
  const loadingRef = useRef(false);
  const ppLoadedFetchedAtRef = useRef<string | null>(null);
  const cachePollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cacheRef = useRef<CacheStatus | null>(null); // 上一次成功的缓存状态（/api/predict-cache 失败时 PP 门控仍可用）
  const negSeqRef = useRef(0); // 丢弃乱序到达的旧 /api/negrisk 响应
  const mountedRef = useRef(true); // 离开页面后，在途的 await 回来不再 setState / 不再发请求
  const scanFollowUpRef = useRef<ReturnType<typeof setTimeout> | null>(null); // 409 后的跟进拉取
  const floorDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null); // 显示下限输入防抖

  // 200 → data+status；404 带 status → notScanned；其他 → 保留旧数据只记错误
  const applyNegRisk = useCallback((r: JsonResult<NegRiskListResponse>): boolean => {
    const json = r.json;
    let applied = true;
    if (r.ok && json && Array.isArray(json.results)) {
      setNegrisk({ data: { ...json, results: json.results.map(normalizeAnalysis) }, status: json.status, error: '', notScanned: false });
    } else if (r.status === 404 && json?.status) {
      setNegrisk({ data: null, status: json.status, error: '', notScanned: true });
    } else {
      setNegrisk((prev) => ({ ...prev, error: r.error }));
      applied = false;
    }
    const st = json?.status;
    if (floorRef.current == null && st && Number.isFinite(st.displayMinCents)) {
      floorRef.current = st.displayMinCents;
      setFloor(st.displayMinCents);
    }
    return applied;
  }, []);

  const refreshAll = useCallback(
    async () => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      setLoading(true);
      const errors: string[] = [];
      try {
        const skipNegrisk = scanningRef.current; // 重扫进行中，别用旧扫描结果盖掉
        const negSeq = skipNegrisk ? 0 : ++negSeqRef.current;
        const [h, c, n] = await Promise.all([
          getJson<HealthResponse>('/api/health', 10000),
          getJson<CacheEnvelope>('/api/predict-cache', 10000),
          skipNegrisk ? Promise.resolve<JsonResult<NegRiskListResponse> | null>(null) : getJson<NegRiskListResponse>(negriskUrl(floorRef.current), 20000)
        ]);
        if (h.ok && h.json) {
          setHealth({ data: h.json, error: '' });
          const serverNow = Date.parse(h.json.now);
          if (!Number.isNaN(serverNow)) setSkewMs(serverNow - Date.now());
        } else {
          setHealth((prev) => ({ ...prev, error: h.error }));
          errors.push(`health: ${h.error}`);
        }
        if (c.ok && c.json?.cache) {
          cacheRef.current = c.json.cache;
          setCache({ data: c.json.cache, error: '' });
        } else {
          setCache((prev) => ({ ...prev, error: c.error }));
          errors.push(`predict-cache: ${c.error}`);
        }
        if (n && negSeq === negSeqRef.current) {
          if (!applyNegRisk(n)) errors.push(`negrisk: ${n.error}`);
        }
        // PP 门控：缓存就绪才拉 /api/predict-only（否则该接口会阻塞到首次抓取完成），且只在缓存更新后重拉
        // （同一份缓存下该接口的结果是确定的，「刷新」也不重拉这份最大的响应；失败时 ppLoadedFetchedAtRef 不前进，下个周期自动重试）
        const cacheNow = c.ok && c.json?.cache ? c.json.cache : cacheRef.current;
        if (cacheNow?.hasCache && cacheNow.fetchedAt !== ppLoadedFetchedAtRef.current) {
          const p = await getJson<PredictOnlyResponse>(PP_URL, 30000);
          if (p.ok && p.json) {
            setPp({ data: p.json, error: '' });
            ppLoadedFetchedAtRef.current = cacheNow.fetchedAt;
          } else {
            setPp((prev) => ({ ...prev, error: p.error }));
            errors.push(`predict-only: ${p.error}`);
          }
        }
      } finally {
        loadingRef.current = false;
        setLoading(false);
        setLastRefreshedAt(new Date().toISOString());
        setLastRefreshError(errors.join('；'));
      }
    },
    [applyNegRisk]
  );

  // 只重拉 /api/negrisk（显示下限输入框、409 后的跟进用），保留 liveRows；返回响应里的 status（被更新的请求作废时返回 null）
  const fetchNegRisk = useCallback(
    async (floorValue: number | null): Promise<NegRiskStatus | null> => {
      const seq = ++negSeqRef.current;
      const r = await getJson<NegRiskListResponse>(negriskUrl(floorValue), 20000);
      if (seq !== negSeqRef.current) return null;
      applyNegRisk(r);
      return r.json?.status ?? null;
    },
    [applyNegRisk]
  );

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => {
      if (document.hidden) return;
      void refreshAll();
    }, 60000);
    return () => clearInterval(id);
  }, [autoRefresh, refreshAll]);

  useEffect(() => {
    const onVisibility = () => {
      if (!document.hidden) void refreshAll();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [refreshAll]);

  // 卸载：标记未挂载（在途的轮询 / 跟进 await 回来后不再 setState、不再发请求），清掉所有定时器
  useEffect(() => {
    mountedRef.current = true; // dev StrictMode 会先卸载再挂载一次
    return () => {
      mountedRef.current = false;
      for (const ref of [cachePollTimerRef, scanFollowUpRef, floorDebounceRef]) {
        if (ref.current) clearTimeout(ref.current);
        ref.current = null;
      }
    };
  }, []);

  // 409 之后不依赖「自动刷新」开关：每 15 秒拉一次 /api/negrisk，直到后台扫描结束（最多 6 次），再清掉提示
  function scheduleScanFollowUp(attempt: number) {
    if (scanFollowUpRef.current) clearTimeout(scanFollowUpRef.current);
    scanFollowUpRef.current = setTimeout(async () => {
      scanFollowUpRef.current = null;
      if (!mountedRef.current || scanningRef.current) return;
      const st = await fetchNegRisk(floorRef.current);
      if (!mountedRef.current) return;
      if (st?.running && attempt < 6) {
        scheduleScanFollowUp(attempt + 1);
        return;
      }
      setScanError((prev) => (prev === SCAN_BUSY_MSG ? '' : prev));
    }, 15000);
  }

  async function runScan() {
    if (scanningRef.current || !cache.data?.hasCache) return;
    scanningRef.current = true;
    if (scanFollowUpRef.current) clearTimeout(scanFollowUpRef.current);
    scanFollowUpRef.current = null;
    setScanning(true);
    setScanStartedAt(Date.now());
    setScanError('');
    try {
      const r = await getJson<NegRiskListResponse>(`${negriskUrl(floorRef.current)}&scan=1`, 180000);
      if (r.ok && r.json && Array.isArray(r.json.results)) {
        negSeqRef.current += 1; // 扫描结果最新，作废在途的旧请求
        applyNegRisk(r);
        setLiveRows({});
        setRowErrors({});
      } else if (r.status === 409) {
        setScanError(SCAN_BUSY_MSG);
        const st = r.json?.status;
        if (st) setNegrisk((prev) => ({ ...prev, status: st }));
        scheduleScanFollowUp(1);
      } else if (r.timedOut) {
        setScanError('扫描超过 180 秒，后台可能仍在运行，稍后自动刷新');
      } else {
        setScanError(`扫描失败：${r.error}`);
      }
    } finally {
      scanningRef.current = false;
      setScanning(false);
      setScanStartedAt(null);
    }
  }

  // 触发后台重抓（服务端 fire-and-forget），然后每 5 秒轮询直到 refreshInflight=false（最多 5 分钟），再整体刷新
  async function refreshCache() {
    if (cacheRefreshing) return;
    setCacheRefreshing(true);
    const r = await getJson<CacheEnvelope>('/api/predict-cache?refresh=1', 10000);
    if (!mountedRef.current) return;
    if (!(r.ok && r.json?.cache)) {
      setCache((prev) => ({ ...prev, error: r.error }));
      setCacheRefreshing(false);
      return;
    }
    cacheRef.current = r.json.cache;
    setCache({ data: r.json.cache, error: '' });
    const startedAt = Date.now();
    const finish = () => {
      cachePollTimerRef.current = null;
      if (!mountedRef.current) return;
      setCacheRefreshing(false);
      void refreshAll();
    };
    const poll = async () => {
      const p = await getJson<CacheEnvelope>('/api/predict-cache', 10000);
      if (!mountedRef.current) return; // 页面已离开：不再 setState，也不再重新定时
      if (p.ok && p.json?.cache) {
        cacheRef.current = p.json.cache;
        setCache({ data: p.json.cache, error: '' });
        if (!p.json.cache.refreshInflight) return finish();
      }
      if (Date.now() - startedAt > 300000) return finish();
      cachePollTimerRef.current = setTimeout(() => void poll(), 5000);
    };
    cachePollTimerRef.current = setTimeout(() => void poll(), 5000);
  }

  const fetchAnalysis = (input: string) => getJson<AnalysisResponse>(`/api/negrisk?slug=${encodeURIComponent(input)}`, 60000);

  async function analyze() {
    const input = analyzeInput.trim();
    if (!input || analyzing) return;
    setAnalyzing(true);
    setAnalysis(null);
    setAnalyzeError('');
    const r = await fetchAnalysis(input);
    if (r.ok && r.json?.analysis) {
      // 阈值用响应里的当前设置：与 bot /yes 的 formatCategoryReport(a, getNegRiskThreshold()) 同口径
      setAnalysis({ analysis: normalizeAnalysis(r.json.analysis), thresholdCents: r.json.status?.thresholdCents ?? negrisk.status?.thresholdCents ?? 100 });
    } else setAnalyzeError(r.error || '查询失败');
    setAnalyzing(false);
  }

  // 只问「为什么不在列表」：live=0 不碰订单簿，响应里只有 diagnosis
  async function diagnose() {
    const input = analyzeInput.trim();
    if (!input || diagnosing) return;
    setDiagnosing(true);
    setDiagnosis(null);
    setDiagnoseError('');
    const r = await getJson<AnalysisResponse>(`/api/negrisk?slug=${encodeURIComponent(input)}&why=1&live=0`, 20000);
    if (!mountedRef.current) return;
    if (r.ok && r.json?.diagnosis) setDiagnosis(r.json.diagnosis);
    else setDiagnoseError(r.ok ? '服务端没有返回诊断（旧版本不支持 ?why=1，请升级后台）' : `诊断失败：${r.error || '未知错误'}`);
    setDiagnosing(false);
  }

  // 每行「重新查」：同一个接口，结果放进 liveRows（checkedAt 更新的才覆盖扫描行）
  async function requote(slug: string) {
    if (requoting) return;
    setRequoting(slug);
    setRowErrors((prev) => {
      const next = { ...prev };
      delete next[slug];
      return next;
    });
    const r = await fetchAnalysis(slug);
    if (r.ok && r.json?.analysis) {
      const a = normalizeAnalysis(r.json.analysis);
      setLiveRows((prev) => ({ ...prev, [slug]: a }));
    } else {
      setRowErrors((prev) => ({ ...prev, [slug]: r.error || '查询失败' }));
    }
    setRequoting(null);
  }

  function toggle(slug: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }

  function onFloorChange(raw: string) {
    if (raw === '') {
      setFloor(null); // 清空时先不查，失焦后恢复上一个值
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    const v = Math.max(0, Math.min(1000, n));
    setFloor(v);
    floorRef.current = v;
    // 防抖：连续敲键只发最后一次请求（每个响应都是一整份 ≤50 行的扫描结果）
    if (floorDebounceRef.current) clearTimeout(floorDebounceRef.current);
    floorDebounceRef.current = setTimeout(() => {
      floorDebounceRef.current = null;
      void fetchNegRisk(v);
    }, 300);
  }

  function onFloorBlur() {
    if (floor == null && floorRef.current != null) setFloor(floorRef.current);
  }

  // ---------------- 派生数据 ----------------
  const scan = negrisk.data?.scan ?? null;
  const lastCycle = negrisk.status?.lastCycle ?? null;
  // 行 / 达标判定用扫描时的阈值（与 bot 的扫描报告一致）；卡片 2 显示当前设置，/yes_threshold 后一轮内可能不同；单类目查询用响应里的当前阈值（与 bot /yes 一致）
  const thresholdCents = scan?.thresholdCents ?? negrisk.status?.thresholdCents ?? 100;
  const displayFloor = floor ?? negrisk.status?.displayMinCents ?? null;

  const rows = useMemo<Row[]>(() => {
    const list = negrisk.data?.results ?? [];
    return list
      .map((r) => {
        const live = liveRows[r.slug];
        return live && live.checkedAt > r.checkedAt ? { ...live, live: true } : r;
      })
      .filter((r) => !onlyHits || r.bidSum >= thresholdCents);
  }, [negrisk.data, liveRows, onlyHits, thresholdCents]);

  const hitsCount = scan?.hits ?? lastCycle?.hits ?? null;
  const ppRows = useMemo(() => (pp.data?.predictOnly ?? []).filter((m) => m.tradeable && m.hourlyRate > 0), [pp.data]);
  const ppGroups = useMemo(
    () =>
      groupByEvent(ppRows)
        .filter((g) => g.totalHourlyRate > 0)
        .sort((a, b) => b.totalHourlyRate - a.totalHourlyRate),
    [ppRows]
  );
  const ppShown = ppGroups.slice(0, PP_MAX_GROUPS);
  const ppTotal = useMemo(() => ppRows.reduce((s, m) => s + (Number.isFinite(m.hourlyRate) ? m.hourlyRate : 0), 0), [ppRows]);

  const issues = useMemo(() => {
    const errors: string[] = [];
    const warnings: string[] = [];
    const h = health.data;
    const c = cache.data;
    if (h && h.hasPredictApiKey === false) errors.push('PREDICT_API_KEY 未配置：订单簿与市场抓取都会失败（Railway → Variables）');
    if (negrisk.status?.lastCycle?.error) errors.push(`NegRisk 扫描错误：${negrisk.status.lastCycle.error}`);
    if (health.error) errors.push(`无法读取 /api/health：${health.error}`);
    if (h?.env && h.env !== 'production') warnings.push('开发模式：instrumentation 不启动后台任务；用「重新抓取市场缓存」和「立即重扫」手动填充');
    if (c?.lastError) warnings.push(`缓存错误：${c.lastError}`);
    if (c && c.complete === false) warnings.push(`市场缓存不完整（${c.pagesFetched} 页，stop=${c.stoppedReason ?? '-'}），NegRisk 候选与 PP 列表可能漏`);
    const sc = negrisk.data?.scan;
    if (sc?.capped) warnings.push(`本轮扫描超过 NEGRISK_SCAN_MAX_CATEGORIES 每轮上限${sc.droppedByCap != null ? `，截掉 ${sc.droppedByCap} 个类目没查` : '，部分类目未查'}`);
    if (sc?.failedCategories) warnings.push(`${sc.failedCategories} 个类目有结果的订单簿没查到（多半是 429 限流），这些行的 Σ Yes 买1 只是下限（标 ≥），点「重新查」补齐`);
    if (negrisk.status && negrisk.status.enabled === false) warnings.push('NegRisk 提醒已关闭（/yes_on 开启），扫描仍在跑');
    if (h?.botLastError) warnings.push(`Bot 错误：${h.botLastError}`);
    return { errors, warnings };
  }, [health, cache, negrisk]);

  const ago = (iso: string | null | undefined) => agoWith(iso, skewMs);

  // ---------------- 三张状态卡 ----------------
  const cacheCard = (() => {
    const c = cache.data;
    let value = '-';
    let tone: Tone;
    if (cache.error) {
      value = '无法读取';
      tone = 'bad';
    } else if (c) {
      if (!c.hasCache) {
        value = '未就绪';
        tone = 'bad';
      } else if (c.complete === false) {
        value = '⚠️ 不完整';
        tone = 'warn';
      } else {
        value = '✅ 完整';
        tone = 'ok';
      }
    }
    const lines: ReactNode[] = [];
    if (cache.error) lines.push(<span className="negative">{cache.error}</span>);
    if (c) {
      if (c.hasCache) {
        lines.push(`${fmtN(c.totalMarkets)} 市场 · ${c.totalCategories} 类目 · ${c.pagesFetched} 页`);
        lines.push(
          `抓取于 ${fmtClock(c.fetchedAt)}（${ago(c.fetchedAt)}，耗时 ${Math.round((c.durationMs ?? 0) / 1000)}s）· 每 ${c.ttlMs / 60000} 分钟刷新`
        );
        lines.push(`stop=${c.stoppedReason ?? '-'} · status=${c.statusFilter ?? 'none'}`);
      } else {
        lines.push(`每 ${c.ttlMs / 60000} 分钟刷新`);
      }
      if (c.refreshInflight) lines.push('刷新中…');
      if (!c.timerActive) lines.push('定时刷新未启动（dev 模式不跑后台任务）');
      if (c.lastError) lines.push(<span className="negative">{c.lastError}</span>);
      if (!c.hasCache) lines.push('启动约 10 秒后开始首次抓取，需 1–3 分钟；长时间未就绪请检查 PREDICT_API_KEY');
    }
    return { value, tone, lines };
  })();

  const negriskCard = (() => {
    const s = negrisk.status;
    let value = '-';
    let tone: Tone;
    const lines: ReactNode[] = [];
    if (!s) {
      if (negrisk.error) {
        value = '无法读取';
        tone = 'bad';
        lines.push(<span className="negative">{negrisk.error}</span>);
      }
      return { value, tone, lines };
    }
    const lc = s.lastCycle;
    if (lc?.error) {
      value = '扫描出错';
      tone = 'bad';
    } else if (s.running) {
      value = '扫描中…';
      tone = 'warn';
    } else if (lc) {
      value = `${lc.hits} 达标 / 查 ${lc.scanned}`;
      tone = lc.hits > 0 ? 'ok' : undefined;
    } else {
      value = '还没扫描';
      tone = 'warn';
    }
    lines.push(`阈值 ${s.thresholdCents}¢ · 显示下限 ${s.displayMinCents}¢ · 提醒 ${s.enabled ? '开' : '关'}`);
    lines.push(<span className="muted">（/yes_threshold · /yes_show · /yes_off 可改）</span>);
    if (lc) {
      lines.push(
        `上次 ${fmtClock(lc.at)}（${ago(lc.at)}）· ${lc.manual ? '手动' : '后台'} · 候选 ${lc.candidates} · 预过滤 ${lc.prefiltered} · 请求 ${lc.requests} · ${Math.round(lc.durationMs / 1000)}s · 已推送 ${lc.alertsSent}`
      );
    }
    lines.push(`每 ${s.intervalMs / 60000} 分钟 · 订阅 ${s.subscribers} · 定时器 ${s.timerActive ? '已注册' : '未启动'}`);
    if (!s.timerActive && !lc) lines.push('首扫在启动约 90 秒后');
    if (lc?.error) lines.push(<span className="negative">{lc.error}</span>);
    return { value, tone, lines };
  })();

  const healthCard = (() => {
    const h = health.data;
    let value = '-';
    let tone: Tone;
    const lines: ReactNode[] = [];
    if (health.error) {
      value = '无法读取';
      tone = 'bad';
      lines.push(<span className="negative">{health.error}</span>);
    } else if (h) {
      const cacheOk = h.cacheTimerActive === true;
      const scanOk = h.negriskTimerActive === true;
      value = `缓存 ${cacheOk ? '✅' : '❌'} · 扫描 ${scanOk ? '✅' : '❌'} · Bot ${h.botPolling ? '✅' : '❌'}`;
      tone = cacheOk && scanOk && h.botPolling ? 'ok' : 'warn';
    }
    if (h) {
      lines.push(`${h.version} · 启动于 ${fmtClock(h.processStarted)}（已运行 ${fmtDur(Date.now() + skewMs - Date.parse(h.processStarted))}）`);
      lines.push(`✅ 仅表示定时器已注册 · Bot 最近收到消息 ${h.botLastEventAt ? `${fmtClock(h.botLastEventAt)}（${ago(h.botLastEventAt)}）` : '(尚未)'}`);
      lines.push(
        `${h.hasTelegram ? 'Telegram 已配置' : '未配置 Telegram（不会推送）'}${
          h.hasPredictApiKey !== undefined ? ` · PREDICT_API_KEY ${h.hasPredictApiKey ? '已配置' : '未配置'}` : ''
        }`
      );
      // 进程级 predict.fun 限速器（旧版服务端没有这个字段）
      const lim = h.predictLimiter;
      if (lim) {
        lines.push(
          `predict.fun 限速 ${lim.rps == null ? '不限' : `${lim.rps}/s`} · 429 共 ${lim.count429 ?? 0} 次${
            lim.last429At ? `（最近 ${fmtClock(lim.last429At)}，${ago(lim.last429At)}）` : ''
          } · 请求 ${fmtN(lim.totalRequests)}${lim.waiting ? ` · 排队 ${lim.waiting}` : ''}`
        );
        if (lim.pausedForMs > 0) {
          lines.push(<span className="caution">⏸ 限流暂停中，剩 {Math.ceil(lim.pausedForMs / 1000)}s</span>);
          if (tone !== 'bad') tone = 'warn';
        }
      }
      if (h.botLastError) lines.push(<span className="negative">{h.botLastError}</span>);
    }
    return { value, tone, lines };
  })();

  // ---------------- 空状态文案 ----------------
  const negriskEmptyText = (() => {
    if (negrisk.data) {
      if (negrisk.data.count === 0) {
        const lc = negrisk.status?.lastCycle;
        const top = lc && lc.topSum != null ? ` · 本轮最高 ${lc.topSum.toFixed(1)}¢（${lc.topTitle ?? '-'}）` : '';
        return `没有 Σ Yes 买1 ≥ ${displayFloor ?? '-'}¢ 的类目${top} · 把显示下限调低可查看更多`;
      }
      if (onlyHits) return `本轮没有达到 ${thresholdCents}¢ 的类目，关闭「只看达标」查看接近阈值的`;
      return '暂无数据';
    }
    if (negrisk.notScanned) return '还没有扫描结果（后台首次扫描在启动约 90 秒后）— 可点「立即重扫」';
    if (negrisk.error) return `加载失败：${negrisk.error}`;
    return '加载中...';
  })();

  const ppEmptyText = (() => {
    if (!cache.data?.hasCache) return '市场缓存未就绪，就绪后自动显示（首次抓取 1–3 分钟）';
    if (pp.data) return '暂无在派 PP 的 Predict 独有市场';
    if (pp.error) return `加载失败：${pp.error}（下次自动刷新重试）`;
    return '加载中...';
  })();

  const fs = pp.data?.filterStats;
  const hasCache = !!cache.data?.hasCache;
  const refreshInflight = !!cache.data?.refreshInflight;

  return (
    <main className="shell">
      <nav className="nav">
        <Link href="/" className="active">看板</Link>
        <Link href="/predict-only">Predict 独有市场</Link>
      </nav>

      <section className="hero">
        <div>
          <p className="eyebrow">Predict.fun · NegRisk 否转换</p>
          <h1>Yes 总和看板</h1>
          <p className="subtitle">
            可转换(NegRisk)类目的 Σ Yes 买1、Predict 独有市场的 PP/h、市场缓存完整性与后台任务状态。数据来自后台缓存，每 60 秒自动刷新；下单前请点「重新查」刷新订单簿。
          </p>
        </div>
        <div className="heroCard">
          <span>达到阈值的类目（Σ Yes 买1 ≥ {thresholdCents}¢）</span>
          <strong className={hitsCount != null && hitsCount > 0 ? 'positive' : undefined}>{hitsCount ?? '-'}</strong>
          <small>
            {lastCycle && lastCycle.topSum != null ? `最高 Σ Yes 买1：${lastCycle.topSum.toFixed(1)}¢ · ${lastCycle.topTitle ?? '-'}` : '还没扫描'}
            <br />
            阈值 {thresholdCents}¢ · 显示下限 {displayFloor ?? '-'}¢
            {scan ? ` · 判定 ${scan.detectMode === 'flag' ? '接口 isNegRisk' : '启发式(≥3 结果)'}` : ''}
            <br />
            {pp.data ? `在派 PP 的 event：${ppGroups.length} · 总 PP/h ${fmtN(ppTotal, 1)}` : '在派 PP 的 event：-'}
          </small>
        </div>
      </section>

      <section className="controls card">
        <button onClick={() => void refreshAll()} disabled={loading}>
          {loading ? '刷新中...' : '刷新'}
        </button>
        <label className="switch">
          <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
          自动刷新（60 秒）
        </label>
        <button className="secondary" onClick={() => void refreshCache()} disabled={cacheRefreshing || refreshInflight}>
          {cacheRefreshing || refreshInflight ? '抓取中…' : '重新抓取市场缓存'}
        </button>
        <span className="muted">最近刷新 {fmtClock(lastRefreshedAt)}</span>
        {lastRefreshError && (
          <span className="negative">
            上次刷新失败 {fmtClock(lastRefreshedAt)}: {lastRefreshError}
          </span>
        )}
      </section>

      <IssueBanners issues={issues} />

      <section className="summaryGrid">
        <StatCard label="市场缓存" value={cacheCard.value} tone={cacheCard.tone} lines={cacheCard.lines} />
        <StatCard label="NegRisk 扫描" value={negriskCard.value} tone={negriskCard.tone} lines={negriskCard.lines} />
        <StatCard label="后台任务 / Bot" value={healthCard.value} tone={healthCard.tone} lines={healthCard.lines} />
      </section>

      <section className="card tableCard" id="negrisk">
        <div className="sectionHeader">
          <h2>可转换类目 · Σ Yes 买1</h2>
          <p>
            Σ Yes 买1 ≥ 显示下限的类目；≥ 提醒阈值的高亮为达标（买 否 → 转换 → 卖 Yes，每份 ≈ Σ − 100¢，未扣手续费）。
            {scan && (
              <>
                判定 {scan.detectMode === 'flag' ? '接口 isNegRisk 字段' : '启发式（≥3 个结果，接口没给 isNegRisk）'} · 扫描于 {fmtClock(scan.checkedAt)}（{ago(scan.checkedAt)}）
                {lastCycle?.manual ? ' · 手动扫描' : ''}
                {scan.capped && <span className="caution"> · ⚠️ 超每轮上限{scan.droppedByCap != null ? `，截掉 ${scan.droppedByCap} 个` : ''}</span>}
                {(scan.failedCategories ?? 0) > 0 && ` · ${scan.failedCategories} 个类目有结果未查到`}
                {(scan.retriedCategories ?? 0) > 0 && ` · 补查 ${scan.retriedCategories} 个`}
              </>
            )}
          </p>
        </div>
        <div className="filterRow">
          <label>
            显示下限 ¢
            <input type="number" min={0} max={1000} step={1} value={floor ?? ''} onChange={(e) => onFloorChange(e.target.value)} onBlur={onFloorBlur} />
          </label>
          <span className="muted">（后台默认 {negrisk.status?.displayMinCents ?? '-'}¢，/yes_show 可改；不改服务端）</span>
          <label className="switch">
            <input type="checkbox" checked={onlyHits} onChange={(e) => setOnlyHits(e.target.checked)} />
            只看达标（≥ {thresholdCents}¢）
          </label>
          <button className="secondary" onClick={() => void runScan()} disabled={scanning || !hasCache}>
            {scanning && scanStartedAt ? (
              <>
                重扫中… <Elapsed since={scanStartedAt} />
              </>
            ) : (
              '立即重扫'
            )}
          </button>
          {cache.data && !hasCache && <span className="muted">（市场缓存未就绪，暂不能重扫）</span>}
          <span className="muted">
            显示 {rows.length}/{negrisk.data?.count ?? 0} · 达标 {scan?.hits ?? '-'}
          </span>
          {scanError && <span className="negative">{scanError}</span>}
          {negrisk.error && negrisk.data && <span className="negative">刷新失败：{negrisk.error}（表格仍是上一次的结果）</span>}
        </div>
        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>状态</th>
                <th>类目</th>
                <th>Σ Yes 买1 ¢</th>
                <th>Σ Yes 卖1 ¢</th>
                <th>结果</th>
                <th>最小买1深度</th>
                <th>数据质量</th>
                <th>检查时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <CategoryRow
                  key={row.slug}
                  row={row}
                  thresholdCents={thresholdCents}
                  expanded={expanded.has(row.slug)}
                  requoting={requoting === row.slug}
                  rowError={rowErrors[row.slug]}
                  skewMs={skewMs}
                  onToggle={toggle}
                  onRequote={(slug) => void requote(slug)}
                />
              ))}
              {!rows.length && (
                <tr>
                  <EmptyCell colSpan={9}>{negriskEmptyText}</EmptyCell>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card resolverCard" id="analyze">
        <div className="sectionHeader">
          <h2>查单个类目</h2>
          <p>
            粘贴 predict.fun 链接或 slug，实时查该类目每个结果的 Yes 买1/卖1（与 bot 的 /yes 报告同口径，会发 N 个订单簿请求）；「为什么不在列表？」只看扫描诊断，不查订单簿（同
            /yes_why）
          </p>
        </div>
        <div className="resolverRow">
          <input
            type="text"
            value={analyzeInput}
            aria-label="predict.fun 链接或 slug"
            placeholder="predict.fun 链接或 slug，例如 https://predict.fun/market/xxx"
            onChange={(e) => setAnalyzeInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void analyze();
            }}
          />
          <button onClick={() => void analyze()} disabled={analyzing || !analyzeInput.trim()}>
            {analyzing ? '查询中...' : '查询'}
          </button>
          <button
            className="secondary"
            onClick={() => void diagnose()}
            disabled={diagnosing || !analyzeInput.trim()}
            title="只解释后台扫描为什么没列出它（与 bot 的 /yes_why 同口径），不查订单簿"
          >
            {diagnosing ? '诊断中...' : '为什么不在列表？'}
          </button>
        </div>
        {analyzeError && <div className="error">{analyzeError}</div>}
        {diagnoseError && <div className="error">{diagnoseError}</div>}
        {diagnosis && <DiagnosisPanel d={diagnosis} />}
        {analysis && (
          <>
            <CategoryHeader analysis={analysis.analysis} thresholdCents={analysis.thresholdCents} />
            <div className="subTable">
              {/* key：换一个类目 / 重新查询时折叠状态归零 */}
              <OutcomeTable key={`${analysis.analysis.slug}-${analysis.analysis.checkedAt}`} analysis={analysis.analysis} />
            </div>
          </>
        )}
      </section>

      <section className="card tableCard" id="pp">
        <div className="sectionHeader">
          <h2>Predict 独有 · 在派 PP 的 event</h2>
          <p>
            {pp.data
              ? `${ppGroups.length} 个 event · ${ppRows.length} 个市场 · 总 PP/h ${fmtN(ppTotal, 1)} · 抓取 ${pp.data.complete === false ? '⚠️ 不完整' : '✅ 完整'}${
                  fs ? ` · 筛选 ${fs.input} → 无 poly 映射 ${fs.afterPolymarket} → 去噪 ${fs.afterNoise} → 在派 PP ${fs.afterRewards}` : ''
                } · 数据 ${fmtClock(pp.data.checkedAt)}`
              : `按 event 汇总 Predict 独有市场的 PP/h（只含可交易且在派 PP 的市场），显示前 ${PP_MAX_GROUPS} 个。`}
          </p>
        </div>
        {pp.data?.complete === false && (
          <div className="notice">
            ⚠️ 抓取未翻到底（{pp.data.pagesFetched ?? '-'} 页，stop={pp.data.stoppedReason ?? '-'}），列表可能不完整 — 用上方「重新抓取市场缓存」重试
          </div>
        )}
        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>Event</th>
                <th>总 PP/h</th>
                <th>选项</th>
                <th>结束</th>
                <th>链接</th>
              </tr>
            </thead>
            <tbody>
              {ppShown.map((g) => (
                <tr key={g.slug} className="hit">
                  <td>
                    <b>{g.title}</b>
                    <small>{g.slug}</small>
                  </td>
                  <td>
                    <b className="positive">{fmtN(g.totalHourlyRate, 1)}</b>
                    <small>{g.markets.length} 个选项</small>
                  </td>
                  <td>
                    <details>
                      <summary style={{ cursor: 'pointer', color: 'var(--muted)' }}>展开 {g.markets.length} 个</summary>
                      <ul style={{ margin: '8px 0 0', paddingLeft: 16 }}>
                        {g.markets.map((m) => (
                          <li key={m.id} style={{ marginBottom: 4 }}>
                            <code>{m.id}</code> {m.title} · <span className="positive">PP/h {fmtN(m.hourlyRate, 1)}</span> · Yes {fmtPrice(m.yesPrice)} / No{' '}
                            {fmtPrice(m.noPrice)}
                            {m.hourlyRateSource && m.hourlyRateSource !== 'none' && <span className="muted"> {m.hourlyRateSource}</span>}
                          </li>
                        ))}
                      </ul>
                    </details>
                  </td>
                  <td>
                    {g.endMs ? new Date(g.endMs).toLocaleDateString('zh-CN') : '-'}
                    {g.endMs ? <small>{fmtRemaining(g.endMs)}</small> : null}
                  </td>
                  <td>
                    <a className="linkOut" href={g.url} target="_blank" rel="noreferrer">
                      打开 ↗
                    </a>
                  </td>
                </tr>
              ))}
              {!ppShown.length && (
                <tr>
                  <EmptyCell colSpan={5}>{ppEmptyText}</EmptyCell>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {ppGroups.length > PP_MAX_GROUPS && (
          <p className="muted" style={{ marginTop: 12, marginBottom: 0 }}>
            仅显示前 {PP_MAX_GROUPS} 个（共 {ppGroups.length}）
          </p>
        )}
        <p style={{ marginTop: 12, marginBottom: 0 }}>
          <Link href="/predict-only" className="linkOut">
            查看全部 / 更多筛选 →
          </Link>
        </p>
      </section>
    </main>
  );
}
