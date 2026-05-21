import { filterOutNoise, filterPredictOnly, groupMarketsByCategory, type MarketGroup } from './predict-markets';
import { getSubscriptions, type SubMode } from './subscribers';
import type { MarketsCacheEntry } from './predict-cache';

declare global {
  var __seenSlugsPredictOnly: Set<string> | undefined;
  var __seenSlugsAll: Set<string> | undefined;
  var __watcherInitPredictOnly: boolean | undefined;
  var __watcherInitAll: boolean | undefined;
  var __lastNewAtPredictOnly: string | undefined;
  var __lastNewAtAll: string | undefined;
  var __lastNewCountPredictOnly: number | undefined;
  var __lastNewCountAll: number | undefined;
}

function getSeen(mode: SubMode): Set<string> {
  if (mode === 'all') {
    if (!globalThis.__seenSlugsAll) globalThis.__seenSlugsAll = new Set<string>();
    return globalThis.__seenSlugsAll;
  }
  if (!globalThis.__seenSlugsPredictOnly) globalThis.__seenSlugsPredictOnly = new Set<string>();
  return globalThis.__seenSlugsPredictOnly;
}

function getInit(mode: SubMode): boolean {
  return mode === 'all' ? !!globalThis.__watcherInitAll : !!globalThis.__watcherInitPredictOnly;
}
function setInit(mode: SubMode) {
  if (mode === 'all') globalThis.__watcherInitAll = true;
  else globalThis.__watcherInitPredictOnly = true;
}
function setLastNew(mode: SubMode, count: number) {
  if (mode === 'all') {
    globalThis.__lastNewAtAll = new Date().toISOString();
    globalThis.__lastNewCountAll = count;
  } else {
    globalThis.__lastNewAtPredictOnly = new Date().toISOString();
    globalThis.__lastNewCountPredictOnly = count;
  }
}

function fmt(value: unknown, digits = 1): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: digits }) : '-';
}

function fmtRemaining(endMs?: number | null): string {
  if (!endMs) return '';
  const ms = endMs - Date.now();
  if (ms <= 0) return '已结束';
  const h = ms / 3600000;
  if (h >= 24) return `${(h / 24).toFixed(1)}d`;
  if (h >= 1) return `${h.toFixed(1)}h`;
  return `${Math.round(ms / 60000)}m`;
}

function groupHasPolymarket(g: MarketGroup): boolean {
  return g.markets.some((m) => m.hasPolymarket);
}

// 电竞赛事名（标题一般是 "Counter-Strike: A vs B (BO3) - ..." 这种）
const ESPORTS_GAMES = [
  'counter-strike', 'counter strike', 'cs2', 'cs:go', 'csgo',
  'league of legends', 'lol', 'dota 2', 'dota2', 'dota',
  'valorant', 'overwatch', 'rainbow six', 'rainbow 6',
  'starcraft', 'rocket league', 'mobile legends', 'mlbb', 'pubg',
  'honor of kings', 'king of glory', 'wild rift', 'apex legends',
  'call of duty'
];
// slug 前缀，如 cs2-mglz-tl1 / lol-dnf-drx / dota2-tundra-xtreme
const ESPORTS_SLUG_PREFIXES = ['cs2-', 'csgo-', 'lol-', 'dota2-', 'dota-', 'val-', 'valorant-', 'ow-', 'r6-', 'rl-'];

function titleStartsWithGame(title: string): boolean {
  return ESPORTS_GAMES.some((g) => {
    if (!title.startsWith(g)) return false;
    const next = title.charAt(g.length);
    return next === '' || next === ':' || next === ' ' || next === '-';
  });
}

// 判断是不是电竞对战类市场（这类基本用不上，打个标签方便快速跳过）
function isEsportsGroup(g: MarketGroup): boolean {
  const title = (g.title || '').toLowerCase().trim();
  if (titleStartsWithGame(title)) return true;
  // 结构特征：含 "vs" 且带 "(BOn)" 几乎都是电竞对战
  if (/\bvs\.?\b/.test(title) && /\(\s*bo\s*\d+\s*\)/.test(title)) return true;
  const blob = [g.slug, g.markets[0]?.categorySlug, g.markets[0]?.category, g.markets[0]?.slug]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (ESPORTS_SLUG_PREFIXES.some((p) => blob.includes(p))) return true;
  if (/\besports?\b/.test(blob)) return true;
  return false;
}

export function buildMessage(g: MarketGroup, idx: number, total: number, mode: SubMode): string {
  const lines: string[] = [];
  const tag = mode === 'all' && groupHasPolymarket(g) ? '（含 Polymarket 对应）' : '';
  const kind = isEsportsGroup(g) ? '🎮 [电竞] ' : '';
  const scope = mode === 'all' ? '新市场' : 'Predict 独有市场';
  lines.push(`🆕 发现${scope} (${idx}/${total})`);
  lines.push('');
  lines.push(`📊 ${kind}${g.title}${tag}`);
  const remain = fmtRemaining(g.endMs);
  lines.push(`总 PP/h: ${fmt(g.totalHourlyRate, 1)}${remain ? ` · ⏰ ${remain}` : ''}`);
  if (g.markets.length > 1) {
    lines.push(`选项 (${g.markets.length}):`);
    const shown = g.markets.slice(0, 10);
    for (const m of shown) {
      const pp = m.hourlyRate > 0 ? ` · PP/h ${fmt(m.hourlyRate, 1)}` : '';
      lines.push(`  • ${m.title || '?'}${pp}`);
    }
    if (g.markets.length > 10) lines.push(`  ...还有 ${g.markets.length - 10} 个`);
  }
  lines.push('');
  lines.push(g.url);
  return lines.join('\n');
}

export type AlertSendFn = (chatId: string, text: string, threadId: number | null) => Promise<void>;

let registeredSendFn: AlertSendFn | null = null;
export function registerAlertSendFn(fn: AlertSendFn) {
  registeredSendFn = fn;
}

export type NewMarketsResult = {
  mode: SubMode;
  totalEvents: number;
  newCount: number;
  notified: number;
  initial: boolean;
};

// 计算某 mode 下符合条件的 event 分组
export function computeEligibleGroups(entry: MarketsCacheEntry, mode: SubMode): {
  groups: MarketGroup[];
  predictOnlyCount: number;
  noiseRemoved: number;
} {
  // mode='all' 时不做 polymarket 过滤；'predict_only' 时只留无 poly 映射的
  const base = mode === 'all' ? entry.markets : filterPredictOnly(entry.markets);
  const afterNoise = filterOutNoise(base);
  const noiseRemoved = base.length - afterNoise.length;
  const eligible = afterNoise.filter((m) => m.tradeable && m.hourlyRate > 0);
  const groups = groupMarketsByCategory(eligible)
    .filter((g) => g.totalHourlyRate > 0)
    .sort((a, b) => (b.totalHourlyRate || 0) - (a.totalHourlyRate || 0));
  return { groups, predictOnlyCount: base.length, noiseRemoved };
}

async function notifyForMode(entry: MarketsCacheEntry, mode: SubMode): Promise<NewMarketsResult> {
  const { groups, predictOnlyCount, noiseRemoved } = computeEligibleGroups(entry, mode);
  console.log(`[new-markets][${mode}] base=${predictOnlyCount}, noise过滤=${noiseRemoved}, events=${groups.length}`);

  const seen = getSeen(mode);

  // 首次扫描：标记全部为已知，不报警
  if (!getInit(mode)) {
    for (const g of groups) seen.add(g.slug);
    setInit(mode);
    console.log(`[new-markets][${mode}] initial scan: ${seen.size} events seeded, no alerts`);
    return { mode, totalEvents: groups.length, newCount: 0, notified: 0, initial: true };
  }

  const newGroups: MarketGroup[] = [];
  for (const g of groups) {
    if (!seen.has(g.slug)) {
      newGroups.push(g);
      seen.add(g.slug);
    }
  }
  if (!newGroups.length) {
    return { mode, totalEvents: groups.length, newCount: 0, notified: 0, initial: false };
  }

  setLastNew(mode, newGroups.length);

  const subs = getSubscriptions(mode);
  if (!registeredSendFn || !subs.length) {
    console.log(`[new-markets][${mode}] ${newGroups.length} new events, subscribers=${subs.length}, sendFn=${!!registeredSendFn}`);
    return { mode, totalEvents: groups.length, newCount: newGroups.length, notified: 0, initial: false };
  }

  console.log(`[new-markets][${mode}] ${newGroups.length} new events → ${subs.length} subscriptions`);
  let notified = 0;
  for (let i = 0; i < newGroups.length; i++) {
    const text = buildMessage(newGroups[i], i + 1, newGroups.length, mode);
    for (const sub of subs) {
      try {
        await registeredSendFn(sub.chatId, text, sub.threadId);
        notified += 1;
        await new Promise((r) => setTimeout(r, 1200));
      } catch (err) {
        console.error(`[new-markets][${mode}] send to ${sub.chatId}:${sub.threadId} failed:`, err instanceof Error ? err.message : err);
      }
    }
  }
  return { mode, totalEvents: groups.length, newCount: newGroups.length, notified, initial: false };
}

// refresh hook 入口：两种 mode 都跑
export async function notifyNewMarkets(entry: MarketsCacheEntry): Promise<NewMarketsResult[]> {
  const predictOnly = await notifyForMode(entry, 'predict_only');
  const all = await notifyForMode(entry, 'all');
  return [predictOnly, all];
}

export function getWatcherStatus() {
  return {
    predictOnly: {
      initialized: !!globalThis.__watcherInitPredictOnly,
      knownEvents: globalThis.__seenSlugsPredictOnly?.size ?? 0,
      lastNewAt: globalThis.__lastNewAtPredictOnly ?? null,
      lastNewCount: globalThis.__lastNewCountPredictOnly ?? 0
    },
    all: {
      initialized: !!globalThis.__watcherInitAll,
      knownEvents: globalThis.__seenSlugsAll?.size ?? 0,
      lastNewAt: globalThis.__lastNewAtAll ?? null,
      lastNewCount: globalThis.__lastNewCountAll ?? 0
    }
  };
}
