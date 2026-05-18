import { NextRequest, NextResponse } from 'next/server';
import { loadPairs } from '@/lib/pairs';
import { checkPairs } from '@/lib/spread';
import { envNumber } from '@/lib/env';
import type { SpreadResult } from '@/lib/types';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
type AlertCache = Map<string, number>;
declare global {
  var __spreadAlertCache: AlertCache | undefined;
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
function formatAlertMessage(alerts: SpreadResult[]): string {
  const header = `🚨 Predict.fun × Polymarket 价差提醒\n触发数量：${alerts.length}`;
  const body = alerts.slice(0, 20).map((item, index) => {
    return [
      `${index + 1}. ${item.pair.name}`,
      `Predict side: ${item.pair.predictSide || 'Yes'}`,
      `Polymarket outcome: ${item.pair.polymarketOutcome || '-'}`,
      `方向: ${item.directionLabel || '-'}`,
      `价差: ${fmt(item.gap)} = ${fmt(item.gapCents, 2)}¢，阈值: ${fmt(item.threshold)}`,
      `买价: ${fmt(item.buyPrice)}，卖价: ${fmt(item.sellPrice)}，可比数量: ${fmt(item.comparableSize, 2)}`
    ].join('\n');
  });
  return [header, ...body].join('\n\n').slice(0, 3900);
}
async function sendTelegram(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
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
function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const auth = request.headers.get('authorization') || '';
  const querySecret = request.nextUrl.searchParams.get('secret') || '';
  return auth === `Bearer ${secret}` || querySecret === secret;
}
export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  const pairs = loadPairs();
  const results = await checkPairs(pairs);
  const rawAlerts = results.filter((item) => item.alert);
  const alerts = filterCooldown(rawAlerts);
  let telegramSent = false;
  let telegramError = '';
  if (alerts.length) {
    try {
      telegramSent = await sendTelegram(formatAlertMessage(alerts));
    } catch (error) {
      telegramError = error instanceof Error ? error.message : String(error);
    }
  }
  return NextResponse.json({
    ok: true,
    checkedAt: new Date().toISOString(),
    pairCount: pairs.length,
    rawAlertCount: rawAlerts.length,
    alertCount: alerts.length,
    telegramSent,
    telegramError,
    alerts,
    results
  });
}
