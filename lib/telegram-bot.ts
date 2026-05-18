import { fetchAllPredictMarkets, filterPredictOnly } from './predict-markets';
import { runMonitorCycle } from './monitor';
import { loadPairs } from './pairs';

declare global {
  var __tgBotPolling: boolean | undefined;
  var __tgBotOffset: number | undefined;
  var __tgBotLastError: string | undefined;
  var __tgBotLastCycleAt: string | undefined;
}

const TG_API = 'https://api.telegram.org';

type TgUser = { id: number; first_name?: string; username?: string };
type TgChat = { id: number; type: string; title?: string; username?: string };
type TgMessage = { message_id: number; from?: TgUser; chat: TgChat; date: number; text?: string };
type TgCallbackQuery = { id: string; from: TgUser; message?: TgMessage; data?: string };
type TgUpdate = { update_id: number; message?: TgMessage; callback_query?: TgCallbackQuery };

async function tg(method: string, params: any, timeoutMs = 35_000): Promise<any> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('Missing TELEGRAM_BOT_TOKEN');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${TG_API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: controller.signal
    });
    const body = await response.text();
    let json: any = null;
    try { json = body ? JSON.parse(body) : null; } catch { json = null; }
    if (!response.ok || !json?.ok) {
      throw new Error(`tg.${method} HTTP ${response.status}: ${body.slice(0, 400)}`);
    }
    return json.result;
  } finally {
    clearTimeout(timeout);
  }
}

function allowedChatIds(): Set<string> {
  const ids = new Set<string>();
  const main = String(process.env.TELEGRAM_CHAT_ID || '').trim();
  if (main) ids.add(main);
  const extra = String(process.env.TELEGRAM_ALLOWED_CHAT_IDS || '').trim();
  if (extra) {
    for (const s of extra.split(/[\s,]+/)) {
      const t = s.trim();
      if (t) ids.add(t);
    }
  }
  return ids;
}

function isAllowed(chatId: number | string): boolean {
  const ids = allowedChatIds();
  if (!ids.size) return true; // no restriction configured
  return ids.has(String(chatId));
}

function fmt(n: unknown, digits = 1): string {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString(undefined, { maximumFractionDigits: digits }) : '-';
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

const MENU_KEYBOARD = {
  inline_keyboard: [
    [{ text: '📊 Predict 独有市场 Top10 (按 PP/h)', callback_data: 'predict_only' }],
    [{ text: '🚨 立即跑一次价差检查', callback_data: 'check_spreads' }],
    [{ text: 'ℹ️ 监控状态', callback_data: 'status' }, { text: '❓ 帮助', callback_data: 'help' }]
  ]
};

async function sendMenu(chatId: number | string, prefix = '') {
  const text = `${prefix}请选择操作：`;
  await tg('sendMessage', { chat_id: chatId, text, reply_markup: MENU_KEYBOARD });
}

async function handlePredictOnly(chatId: number | string) {
  await tg('sendMessage', { chat_id: chatId, text: '⏳ 正在拉 predict.fun 独有市场...' });
  try {
    const { markets, pagesFetched } = await fetchAllPredictMarkets({
      hasActiveRewards: true,
      limit: 100,
      maxPages: 10,
      includeClosed: false
    });
    let predictOnly = filterPredictOnly(markets);
    predictOnly.sort((a, b) => (b.hourlyRate || 0) - (a.hourlyRate || 0));
    const top = predictOnly.slice(0, 10);
    if (!top.length) {
      await tg('sendMessage', {
        chat_id: chatId,
        text: `没找到 predict 独有市场。\n抓取了 ${pagesFetched} 页，总共 ${markets.length} 个市场，其中 ${markets.length - predictOnly.length} 个有 polymarket 映射。\n\n可能 hasActiveRewards 过滤太严，可以临时去掉。`
      });
      return;
    }
    const lines = top.map((m, i) => {
      const url = m.categorySlug || m.slug ? `https://predict.fun/markets/${m.categorySlug || m.slug}` : `https://predict.fun/markets/${m.id}`;
      const remain = fmtRemaining(m.endMs);
      return `${i + 1}. ${m.title}\n   PP/h: ${fmt(m.hourlyRate, 1)}${remain ? ` · ⏰ ${remain}` : ''}\n   ${url}`;
    });
    const totalPP = predictOnly.reduce((s, m) => s + (m.hourlyRate || 0), 0);
    const header = `📊 Predict 独有市场 Top ${top.length}（按 PP/h 降序）\n共 ${predictOnly.length} 个独有市场，总 PP/h = ${fmt(totalPP, 1)}\n\n`;
    await tg('sendMessage', {
      chat_id: chatId,
      text: (header + lines.join('\n\n')).slice(0, 3900),
      disable_web_page_preview: true
    });
  } catch (err) {
    await tg('sendMessage', {
      chat_id: chatId,
      text: `❌ 拉取失败: ${err instanceof Error ? err.message : String(err)}`
    });
  }
}

async function handleCheckSpreads(chatId: number | string) {
  await tg('sendMessage', { chat_id: chatId, text: '⏳ 正在跑一次价差检查...' });
  try {
    const result = await runMonitorCycle();
    const lines = [
      `检查时间: ${result.checkedAt}`,
      `配置对数: ${result.pairCount}`,
      `原始触发: ${result.rawAlertCount}`,
      `本轮发送: ${result.alertCount}（cooldown 内的会跳过）`,
      `Telegram 推送: ${result.telegramSent ? '✅' : '⏭️'}${result.telegramError ? ` 错误: ${result.telegramError}` : ''}`
    ];
    if (!result.alertCount && result.results.length) {
      const best = [...result.results]
        .filter((r) => r.ok && typeof r.gap === 'number')
        .sort((a, b) => (b.gap || 0) - (a.gap || 0))[0];
      if (best) {
        lines.push('');
        lines.push(`当前最大价差: ${best.pair.name}`);
        lines.push(`  方向: ${best.directionLabel}`);
        lines.push(`  gap: ${fmt(best.gap, 4)} = ${fmt(best.gapCents, 2)}¢ (阈值 ${fmt(best.threshold, 4)})`);
      }
    }
    await tg('sendMessage', { chat_id: chatId, text: lines.join('\n') });
  } catch (err) {
    await tg('sendMessage', {
      chat_id: chatId,
      text: `❌ 检查失败: ${err instanceof Error ? err.message : String(err)}`
    });
  }
}

async function handleStatus(chatId: number | string) {
  const pairs = loadPairs();
  const lines = [
    `🟢 监控状态`,
    `进程内监控: ${globalThis.__spreadMonitorTimer ? '运行中' : '未启动'}`,
    `Bot 长轮询: ${globalThis.__tgBotPolling ? '运行中' : '未启动'}`,
    `配置对数: ${pairs.length}`,
    `轮询间隔: ${process.env.MONITOR_INTERVAL_MS || '60000'} ms`,
    `阈值: ${process.env.ALERT_THRESHOLD || '0.015'}`,
    `Cooldown: ${process.env.ALERT_COOLDOWN_SEC || '300'} s`,
    `最近一次 cycle: ${globalThis.__tgBotLastCycleAt || '(尚未记录)'}`
  ];
  if (globalThis.__tgBotLastError) {
    lines.push(`最近错误: ${globalThis.__tgBotLastError}`);
  }
  await tg('sendMessage', { chat_id: chatId, text: lines.join('\n') });
}

async function handleHelp(chatId: number | string) {
  const text = [
    '🤖 命令列表',
    '',
    '/menu - 显示主菜单（按钮）',
    '/predict_only - Predict 独有市场 Top10（按 PP/h）',
    '/check - 立即跑一次价差检查',
    '/status - 监控运行状态',
    '/help - 显示这条帮助',
    '',
    '价差触发时会自动推送提醒（同一组合 cooldown 内不重复）。'
  ].join('\n');
  await tg('sendMessage', { chat_id: chatId, text });
}

async function handleCommand(chatId: number | string, command: string) {
  const cmd = command.split('@')[0].trim().toLowerCase();
  switch (cmd) {
    case '/start':
    case '/menu':
      await sendMenu(chatId, '👋 欢迎使用 Predict-Poly 监控机器人。\n\n');
      return;
    case '/predict_only':
    case '/predictonly':
      await handlePredictOnly(chatId);
      return;
    case '/check':
    case '/spreads':
      await handleCheckSpreads(chatId);
      return;
    case '/status':
      await handleStatus(chatId);
      return;
    case '/help':
      await handleHelp(chatId);
      return;
    default:
      await tg('sendMessage', { chat_id: chatId, text: `未知命令: ${cmd}\n发 /menu 看主菜单，或 /help 看命令列表。` });
  }
}

async function handleCallback(query: TgCallbackQuery) {
  const data = query.data || '';
  const chatId = query.message?.chat.id;
  await tg('answerCallbackQuery', { callback_query_id: query.id });
  if (!chatId) return;
  if (!isAllowed(chatId)) {
    await tg('sendMessage', { chat_id: chatId, text: '⛔ 未授权。请联系部署者。' });
    return;
  }
  switch (data) {
    case 'predict_only':
      await handlePredictOnly(chatId);
      break;
    case 'check_spreads':
      await handleCheckSpreads(chatId);
      break;
    case 'status':
      await handleStatus(chatId);
      break;
    case 'help':
      await handleHelp(chatId);
      break;
    default:
      await tg('sendMessage', { chat_id: chatId, text: `未知按钮: ${data}` });
  }
}

async function handleUpdate(update: TgUpdate) {
  if (update.callback_query) {
    await handleCallback(update.callback_query);
    return;
  }
  const msg = update.message;
  if (!msg?.text) return;
  const chatId = msg.chat.id;
  if (!isAllowed(chatId)) {
    await tg('sendMessage', {
      chat_id: chatId,
      text: `⛔ 未授权。你的 chat id 是 ${chatId}，把它加到 TELEGRAM_CHAT_ID 或 TELEGRAM_ALLOWED_CHAT_IDS 即可。`
    });
    return;
  }
  const text = msg.text.trim();
  if (text.startsWith('/')) {
    await handleCommand(chatId, text.split(/\s+/)[0]);
    return;
  }
  // non-command message → show menu
  await sendMenu(chatId);
}

async function registerCommandsMenu() {
  try {
    await tg('setMyCommands', {
      commands: [
        { command: 'menu', description: '主菜单' },
        { command: 'predict_only', description: 'Predict 独有市场 Top10' },
        { command: 'check', description: '立即跑一次价差检查' },
        { command: 'status', description: '监控状态' },
        { command: 'help', description: '帮助' }
      ]
    });
  } catch (err) {
    console.error('[bot] setMyCommands failed:', err instanceof Error ? err.message : err);
  }
}

export function startBotLongPolling(): void {
  if (globalThis.__tgBotPolling) return;
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.log('[bot] TELEGRAM_BOT_TOKEN missing, skip');
    return;
  }
  if (process.env.ENABLE_TG_BOT === '0') {
    console.log('[bot] disabled via ENABLE_TG_BOT=0');
    return;
  }
  globalThis.__tgBotPolling = true;
  console.log('[bot] starting long polling');

  void registerCommandsMenu();

  const loop = async () => {
    while (globalThis.__tgBotPolling) {
      try {
        const updates: TgUpdate[] = await tg(
          'getUpdates',
          { offset: globalThis.__tgBotOffset, timeout: 30, allowed_updates: ['message', 'callback_query'] },
          40_000
        );
        for (const update of updates) {
          globalThis.__tgBotOffset = update.update_id + 1;
          globalThis.__tgBotLastCycleAt = new Date().toISOString();
          try {
            await handleUpdate(update);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            globalThis.__tgBotLastError = msg;
            console.error('[bot] handleUpdate failed:', msg);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        globalThis.__tgBotLastError = msg;
        console.error('[bot] getUpdates failed:', msg);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  };
  void loop();
}
