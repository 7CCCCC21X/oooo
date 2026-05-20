import { filterOutNoise, filterPredictOnly, groupMarketsByCategory, type MarketGroup } from './predict-markets';
import { getSubscribers } from './subscribers';
import type { MarketsCacheEntry } from './predict-cache';

declare global {
  var __seenEventSlugs: Set<string> | undefined;
  var __watcherInitialized: boolean | undefined;
  var __lastNewMarketsAt: string | undefined;
  var __lastNewMarketsCount: number | undefined;
}

function getSeen(): Set<string> {
  if (!globalThis.__seenEventSlugs) globalThis.__seenEventSlugs = new Set<string>();
  return globalThis.__seenEventSlugs;
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

function buildMessage(g: MarketGroup, idx: number, total: number): string {
  const lines: string[] = [];
  lines.push(`🆕 发现新的 Predict 独有市场 (${idx}/${total})`);
  lines.push('');
  lines.push(`📊 ${g.title}`);
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

export type AlertSendFn = (chatId: string, text: string) => Promise<void>;

let registeredSendFn: AlertSendFn | null = null;
export function registerAlertSendFn(fn: AlertSendFn) {
  registeredSendFn = fn;
}

export type NewMarketsResult = {
  totalEvents: number;
  newCount: number;
  notified: number;
  initial: boolean;
};

export async function notifyNewMarkets(entry: MarketsCacheEntry): Promise<NewMarketsResult> {
  const predictOnly = filterOutNoise(filterPredictOnly(entry.markets)).filter((m) => m.tradeable && m.hourlyRate > 0);
  let groups = groupMarketsByCategory(predictOnly).filter((g) => g.totalHourlyRate > 0);

  const seen = getSeen();

  // 首次扫描：标记全部为已知，不发提醒
  if (!globalThis.__watcherInitialized) {
    for (const g of groups) seen.add(g.slug);
    globalThis.__watcherInitialized = true;
    console.log(`[new-markets] initial scan: ${seen.size} events seeded, no alerts`);
    return { totalEvents: groups.length, newCount: 0, notified: 0, initial: true };
  }

  const newGroups: MarketGroup[] = [];
  for (const g of groups) {
    if (!seen.has(g.slug)) {
      newGroups.push(g);
      seen.add(g.slug);
    }
  }

  if (!newGroups.length) {
    return { totalEvents: groups.length, newCount: 0, notified: 0, initial: false };
  }

  newGroups.sort((a, b) => (b.totalHourlyRate || 0) - (a.totalHourlyRate || 0));
  globalThis.__lastNewMarketsAt = new Date().toISOString();
  globalThis.__lastNewMarketsCount = newGroups.length;

  if (!registeredSendFn) {
    console.warn(`[new-markets] ${newGroups.length} new events but no send fn registered`);
    return { totalEvents: groups.length, newCount: newGroups.length, notified: 0, initial: false };
  }

  const subs = getSubscribers();
  if (!subs.length) {
    console.log(`[new-markets] ${newGroups.length} new events, but no subscribers`);
    return { totalEvents: groups.length, newCount: newGroups.length, notified: 0, initial: false };
  }

  console.log(`[new-markets] ${newGroups.length} new events → ${subs.length} subscribers`);
  let notified = 0;
  for (let i = 0; i < newGroups.length; i++) {
    const text = buildMessage(newGroups[i], i + 1, newGroups.length);
    for (const chat of subs) {
      try {
        await registeredSendFn(chat, text);
        notified += 1;
        await new Promise((r) => setTimeout(r, 1200));
      } catch (err) {
        console.error(`[new-markets] send to ${chat} failed:`, err instanceof Error ? err.message : err);
      }
    }
  }
  return { totalEvents: groups.length, newCount: newGroups.length, notified, initial: false };
}

export function getWatcherStatus() {
  return {
    initialized: !!globalThis.__watcherInitialized,
    knownEvents: globalThis.__seenEventSlugs?.size ?? 0,
    lastNewAt: globalThis.__lastNewMarketsAt ?? null,
    lastNewCount: globalThis.__lastNewMarketsCount ?? 0
  };
}
