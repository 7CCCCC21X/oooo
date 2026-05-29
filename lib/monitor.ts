import { envNumber } from './env';
import { loadPairs } from './pairs';
import { checkPairs } from './spread';
import { getPairLinks, type PairLinks } from './market-links';
import { isSpreadAlertsEnabled } from './alert-state';
import type { SpreadResult } from './types';

type AlertCache = Map<string, number>;

declare global {
  var __spreadAlertCache: AlertCache | undefined;
  var __spreadMonitorTimer: NodeJS.Timeout | undefined;
  var __spreadMonitorRunning: boolean | undefined;
}

function getCache(): AlertCache {
  if (!globalThis.__spreadAlertCache) {
    globalThis.__spreadAlertCache = new Map<string, number>();
  }
  return globalThis.__spreadAlertCache;
}

function fmt(value: unknown, digits = 4): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : 'N/A';
}

function alertKey(item: SpreadResult): string {
  return [
    item.pair.predictMarketId,
    item.pair.polymarketTokenId,
    item.direction,
    item.pair.predictSide,
    item.pair.polymarketOutcome
  ].join(':');
}

function filterCooldown(alerts: SpreadResult[]): SpreadResult[] {
  const cooldownSec = envNumber('ALERT_COOLDOWN_SEC', 300);
  const cache = getCache();
  const now = Date.now();
  const kept: SpreadResult[] = [];
  for (const alert of alerts) {
    const key = alertKey(alert);
    const last = cache.get(key) || 0;
    if (now - last >= cooldownSec * 1000) {
      cache.set(key, now);
      kept.push(alert);
    }
  }
  return kept;
}

const MAX_ALERT_ITEMS = 20;

// 给每条 alert 解析两边市场的标题+链接（失败不致命，价格信息照常发）
async function enrichAlerts(alerts: SpreadResult[]): Promise<PairLinks[]> {
  const top = alerts.slice(0, MAX_ALERT_ITEMS);
  return Promise.all(
    top.map((item) =>
      getPairLinks(item.pair).catch(() => ({ predict: { title: '', url: '' }, poly: { title: '', url: '' } }))
    )
  );
}

function formatAlertMessage(alerts: SpreadResult[], links: PairLinks[] = []): string {
  const header = `🚨 Predict.fun × Polymarket 价差提醒\n触发数量：${alerts.length}`;
  const body = alerts.slice(0, MAX_ALERT_ITEMS).map((item, index) => {
    const link = links[index];
    const lines = [`${index + 1}. ${item.pair.name}`];
    if (link?.predict && (link.predict.title || link.predict.url)) {
      lines.push(`🔵 Predict.fun: ${link.predict.title || item.pair.predictMarketId}`);
      if (link.predict.url) lines.push(link.predict.url);
    }
    if (link?.poly && (link.poly.title || link.poly.url)) {
      lines.push(`🟣 Polymarket: ${link.poly.title || item.pair.polymarketOutcome || '-'}`);
      if (link.poly.url) lines.push(link.poly.url);
    }
    lines.push(
      `Predict side: ${item.pair.predictSide || 'Yes'}`,
      `Polymarket outcome: ${item.pair.polymarketOutcome || '-'}`,
      `方向: ${item.directionLabel || '-'}`,
      `价差: ${fmt(item.gap)} = ${fmt(item.gapCents, 2)}¢，阈值: ${fmt(item.threshold)}`,
      `买价: ${fmt(item.buyPrice)}，卖价: ${fmt(item.sellPrice)}，可比数量: ${fmt(item.comparableSize, 2)}`
    );
    return lines.join('\n');
  });
  return [header, ...body].join('\n\n').slice(0, 3900);
}

function telegramThreadId(): number | null {
  const raw = String(process.env.TELEGRAM_THREAD_ID || process.env.TELEGRAM_MESSAGE_THREAD_ID || '').trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

async function sendTelegram(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;
  const threadId = telegramThreadId();
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      ...(threadId !== null ? { message_thread_id: threadId } : {}),
      text,
      disable_web_page_preview: true
    })
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram HTTP ${response.status}: ${body.slice(0, 500)}`);
  }
  return true;
}

export type MonitorCycleResult = {
  checkedAt: string;
  pairCount: number;
  rawAlertCount: number;
  alertCount: number;
  alertsMuted: boolean;
  telegramSent: boolean;
  telegramError: string;
  alerts: SpreadResult[];
  results: SpreadResult[];
};

export async function runMonitorCycle(): Promise<MonitorCycleResult> {
  const pairs = loadPairs();
  const results = await checkPairs(pairs);
  const rawAlerts = results.filter((item) => item.alert);
  const alerts = filterCooldown(rawAlerts);
  let telegramSent = false;
  let telegramError = '';
  const alertsMuted = !isSpreadAlertsEnabled();
  if (alerts.length && !alertsMuted) {
    try {
      const links = await enrichAlerts(alerts);
      telegramSent = await sendTelegram(formatAlertMessage(alerts, links));
    } catch (error) {
      telegramError = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    checkedAt: new Date().toISOString(),
    pairCount: pairs.length,
    rawAlertCount: rawAlerts.length,
    alertCount: alerts.length,
    alertsMuted,
    telegramSent,
    telegramError,
    alerts,
    results
  };
}

export function startBackgroundMonitor(): void {
  if (globalThis.__spreadMonitorTimer) return;
  const enabled = process.env.ENABLE_INPROCESS_MONITOR !== '0';
  if (!enabled) {
    console.log('[monitor] disabled via ENABLE_INPROCESS_MONITOR=0');
    return;
  }
  const intervalMs = envNumber('MONITOR_INTERVAL_MS', 60_000);
  if (intervalMs < 5_000) {
    console.log(`[monitor] MONITOR_INTERVAL_MS=${intervalMs} too small, skipping`);
    return;
  }
  console.log(`[monitor] starting background monitor every ${intervalMs}ms`);

  const tick = async () => {
    if (globalThis.__spreadMonitorRunning) return;
    globalThis.__spreadMonitorRunning = true;
    try {
      const r = await runMonitorCycle();
      if (r.rawAlertCount || r.telegramError) {
        console.log(
          `[monitor] ${r.checkedAt} pairs=${r.pairCount} raw=${r.rawAlertCount} sent=${r.alertCount} tgOk=${r.telegramSent}${r.telegramError ? ` tgErr=${r.telegramError}` : ''}`
        );
      }
    } catch (err) {
      console.error('[monitor] cycle failed:', err instanceof Error ? err.message : err);
    } finally {
      globalThis.__spreadMonitorRunning = false;
    }
  };

  setTimeout(() => {
    void tick();
  }, 5_000);
  globalThis.__spreadMonitorTimer = setInterval(tick, intervalMs);
}
