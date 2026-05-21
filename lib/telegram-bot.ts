import {
  filterOutNoise,
  filterPredictOnly,
  getActiveExcludeKeywords,
  groupMarketsByCategory,
  predictMarketUrl
} from './predict-markets';
import { getCacheStatus, getMarketsCachedOrFetch, refreshMarketsCache } from './predict-cache';
import {
  addSubscriber,
  getSubscriptions,
  isSubscribed,
  removeAllModes,
  getSubscribersFilePath,
  type SubMode
} from './subscribers';
import { getWatcherStatus, registerAlertSendFn } from './new-markets-alerts';
import { runMonitorCycle } from './monitor';
import { loadPairs } from './pairs';
import { CODE_VERSION } from './version';

declare global {
  var __tgBotPolling: boolean | undefined;
  var __tgBotOffset: number | undefined;
  var __tgBotLastError: string | undefined;
  var __tgBotLastCycleAt: string | undefined;
}

const TG_API = 'https://api.telegram.org';

// 实例指纹：每个进程启动随机生成。用于诊断是否有多实例 / 旧版本在跑。
const INSTANCE_ID = Math.random().toString(36).slice(2, 8);
const INSTANCE_STARTED = new Date().toISOString();

type TgUser = { id: number; first_name?: string; username?: string };
type TgChat = { id: number; type: string; title?: string; username?: string };
type TgMessage = {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  message_thread_id?: number;
  is_topic_message?: boolean;
};
type TgCallbackQuery = { id: string; from: TgUser; message?: TgMessage; data?: string };
type TgUpdate = { update_id: number; message?: TgMessage; callback_query?: TgCallbackQuery };

// 话题群：发消息必须带 message_thread_id 才能发到指定话题，否则进 General。
// 只要 Telegram 给了 message_thread_id 就用（话题里的消息都会带），
// 不强求 is_topic_message（部分客户端/General 不一定设）。
function threadOf(msg?: TgMessage): number | null {
  if (!msg) return null;
  return typeof msg.message_thread_id === 'number' ? msg.message_thread_id : null;
}

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

// 统一的发送助手：带 threadId 时发到指定话题
async function reply(chatId: number | string, threadId: number | null, text: string, extra: any = {}): Promise<void> {
  await tg('sendMessage', {
    chat_id: chatId,
    ...(threadId ? { message_thread_id: threadId } : {}),
    text: text.slice(0, 3900),
    disable_web_page_preview: true,
    ...extra
  });
}

export async function sendTextToChat(chatId: string, text: string, threadId: number | null = null): Promise<void> {
  await reply(chatId, threadId, text);
}

async function tgSendDocument(
  chatId: number | string,
  threadId: number | null,
  filename: string,
  content: string,
  caption?: string
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('Missing TELEGRAM_BOT_TOKEN');
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (threadId) form.append('message_thread_id', String(threadId));
  if (caption) form.append('caption', caption.slice(0, 1024));
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  form.append('document', blob, filename);
  const response = await fetch(`${TG_API}/bot${token}/sendDocument`, {
    method: 'POST',
    body: form
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`tg.sendDocument HTTP ${response.status}: ${text.slice(0, 400)}`);
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
    [{ text: '📊 Predict 独有市场（在派 PP）', callback_data: 'predict_only_all' }],
    [
      { text: '🔔 订阅·Predict独有', callback_data: 'subscribe_predict_only' },
      { text: '🔔 订阅·全部(含Poly)', callback_data: 'subscribe_all' }
    ],
    [{ text: '🔕 取消本话题订阅', callback_data: 'unsubscribe' }],
    [{ text: '🔄 强制刷新缓存', callback_data: 'refresh_cache' }],
    [{ text: '🚨 立即跑一次价差检查', callback_data: 'check_spreads' }],
    [{ text: 'ℹ️ 监控状态', callback_data: 'status' }, { text: '❓ 帮助', callback_data: 'help' }]
  ]
};

async function handleRefreshCache(chatId: number | string, threadId: number | null) {
  await reply(chatId, threadId, '🔄 已触发后台刷新缓存，60~180 秒后再点查询即可。');
  refreshMarketsCache().catch(() => {});
}

function modeLabel(mode: SubMode): string {
  return mode === 'all' ? '全部(含Poly)' : 'Predict独有';
}

async function handleSubscribe(chatId: number | string, threadId: number | null, chatType: string, mode: SubMode) {
  const added = addSubscriber(chatId, threadId, mode);
  const loc = threadId ? `\n话题 thread_id: ${threadId}` : '';
  const scope = mode === 'all' ? '所有新市场（含 polymarket 也有的）' : '新的 Predict 独有市场';
  const extra =
    mode === 'all'
      ? '\n\n注意：「全部」已包含 Predict 独有，无需再订阅 Predict独有 模式（否则同一市场会收到两条）。'
      : '';
  await reply(
    chatId,
    threadId,
    added
      ? `✅ 已订阅【${modeLabel(mode)}】新市场提醒\n\nchat id: ${chatId}（${chatType}）${loc}\n\n当出现${scope}（未结束 + 在派 PP），会自动推送到${threadId ? '这个话题' : '这里'}。\n用 /unsubscribe 取消本话题全部订阅。${extra}`
      : `这个${threadId ? '话题' : 'chat'}已经订阅【${modeLabel(mode)}】了。\nchat id: ${chatId}${loc}`
  );
}

async function handleUnsubscribe(chatId: number | string, threadId: number | null) {
  const removed = removeAllModes(chatId, threadId);
  const loc = threadId ? `\nthread_id: ${threadId}` : '';
  await reply(
    chatId,
    threadId,
    removed
      ? `🔕 已取消本话题的全部订阅（${removed} 个模式）。\nchat id: ${chatId}${loc}`
      : `这个${threadId ? '话题' : 'chat'}没在订阅列表里。\nchat id: ${chatId}${loc}`
  );
}

async function handleSubscribers(chatId: number | string, threadId: number | null) {
  const subs = getSubscriptions();
  const filePath = getSubscribersFilePath();
  const lines = [
    `📬 订阅列表 (${subs.length})`,
    ...subs.map((s, i) => {
      const here = String(s.chatId) === String(chatId) && (s.threadId ?? null) === (threadId ?? null);
      const t = s.threadId ? ` (话题 ${s.threadId})` : '';
      return `${i + 1}. ${s.chatId}${t} [${modeLabel(s.mode)}]${here ? ' ← 当前' : ''}`;
    })
  ];
  if (filePath) lines.push('', `持久化文件: ${filePath}`);
  else lines.push('', '⚠️ 未配 SUBSCRIBERS_FILE，重新部署后订阅会丢失');
  await reply(chatId, threadId, lines.join('\n'));
}

async function handleId(chatId: number | string, threadId: number | null, chatType: string) {
  const subPO = isSubscribed(chatId, threadId, 'predict_only');
  const subAll = isSubscribed(chatId, threadId, 'all');
  await reply(
    chatId,
    threadId,
    `chat id: ${chatId}\ntype: ${chatType}\nthread_id: ${threadId ?? '(无/General)'}\n订阅·Predict独有: ${subPO ? '是' : '否'}\n订阅·全部: ${subAll ? '是' : '否'}\n---\n实例: ${INSTANCE_ID}\n启动: ${INSTANCE_STARTED}\n版本: ${CODE_VERSION}`
  );
}

async function sendMenu(chatId: number | string, threadId: number | null, prefix = '') {
  await reply(chatId, threadId, `${prefix}请选择操作：`, { reply_markup: MENU_KEYBOARD });
}

async function sendInChunks(chatId: number | string, threadId: number | null, header: string, items: string[]) {
  if (!items.length) {
    await reply(chatId, threadId, header);
    return;
  }
  const MAX = 3800;
  const messages: string[] = [];
  let buf = header;
  for (const item of items) {
    const sep = buf ? '\n\n' : '';
    if (buf.length + sep.length + item.length > MAX) {
      messages.push(buf);
      buf = item;
    } else {
      buf += sep + item;
    }
  }
  if (buf) messages.push(buf);
  // throttle 避免 TG 429（每秒最多 1 条消息到同一 chat）
  for (let i = 0; i < messages.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 1200));
    await reply(chatId, threadId, messages[i]);
  }
}

async function handlePredictOnly(chatId: number | string, threadId: number | null, onlyRewards = true) {
  const status = getCacheStatus();
  if (!status.hasCache) {
    await reply(chatId, threadId, '⏳ 首次拉取 predict.fun 全量市场缓存中...（一次性 60-180 秒，之后查询秒回）');
  } else if (status.ageMs && status.ageMs > (status.ttlMs || 600000)) {
    await reply(chatId, threadId, '⏳ 使用缓存（已触发后台刷新）...');
  }
  try {
    const entry = await getMarketsCachedOrFetch();
    const { markets, pagesFetched, stoppedReason, totalCategories, totalUniqueMarketIds, fetchedAt, durationMs } = entry;
    let predictOnly = filterOutNoise(filterPredictOnly(markets));
    predictOnly = predictOnly.filter((m) => m.tradeable);
    if (onlyRewards) {
      predictOnly = predictOnly.filter((m) => m.hourlyRate > 0);
    }
    predictOnly.sort((a, b) => (b.hourlyRate || 0) - (a.hourlyRate || 0));
    if (!predictOnly.length) {
      const withPoly = markets.length - filterPredictOnly(markets).length;
      await reply(
        chatId,
        threadId,
        `没找到 predict 独有市场（在派 PP）。\nsource: /v1/categories (cached at ${fetchedAt})\n抓取: ${pagesFetched} 页 (stop=${stoppedReason})\n类目数: ${totalCategories}\n市场数: ${totalUniqueMarketIds}\n通过 tradeable+PP 过滤: ${predictOnly.length}\n其中 polymarket 映射: ${withPoly}`
      );
      return;
    }
    void durationMs;
    void fetchedAt;
    const totalFound = predictOnly.length;
    let groups = groupMarketsByCategory(predictOnly);
    groups = groups.filter((g) => g.totalHourlyRate > 0);
    groups.sort((a, b) => (b.totalHourlyRate || 0) - (a.totalHourlyRate || 0));
    if (!groups.length) {
      await reply(chatId, threadId, `没找到正在派 PP 的 predict 独有 event。`);
      return;
    }
    const totalPP = groups.reduce((s, g) => s + g.totalHourlyRate, 0);
    const header = `📊 Predict 独有市场（在派 PP）\n共 ${groups.length} 个 event / ${totalFound} 个市场\n总 PP/h = ${fmt(totalPP, 1)}（抓取 ${pagesFetched} 页 · stop=${stoppedReason}）\n`;

    const MAX_OPTIONS_INLINE = 12;
    const items = groups.map((g, i) => {
      const remain = fmtRemaining(g.endMs);
      const lines = [`${i + 1}. ${g.title}`];
      lines.push(`   总 PP/h: ${fmt(g.totalHourlyRate, 1)}${remain ? ` · ⏰ ${remain}` : ''}`);
      if (g.markets.length > 1) {
        const shown = g.markets.slice(0, MAX_OPTIONS_INLINE);
        lines.push(`   选项 (${g.markets.length}):`);
        for (const m of shown) {
          const pp = m.hourlyRate > 0 ? ` · PP/h ${fmt(m.hourlyRate, 1)}` : '';
          lines.push(`     • ${m.title || '?'}${pp}`);
        }
        if (g.markets.length > MAX_OPTIONS_INLINE) {
          lines.push(`     ...还有 ${g.markets.length - MAX_OPTIONS_INLINE} 个`);
        }
      }
      lines.push(`   ${g.url}`);
      return lines.join('\n');
    });

    await sendInChunks(chatId, threadId, header, items);

    if (groups.length > 200) {
      const fileLines = [
        `Predict 独有市场（未结束）— 按 event 分组`,
        `生成时间: ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
        `共 ${groups.length} 个 event / ${totalFound} 个市场 · 总 PP/h = ${fmt(totalPP, 1)}`,
        `${'='.repeat(60)}`,
        ''
      ];
      for (let i = 0; i < groups.length; i++) {
        const g = groups[i];
        const remain = fmtRemaining(g.endMs);
        fileLines.push(`${i + 1}. ${g.title}`);
        fileLines.push(`   总 PP/h: ${fmt(g.totalHourlyRate, 1)}${remain ? '  剩余: ' + remain : ''}  (${g.markets.length} 个选项)`);
        fileLines.push(`   URL: ${g.url}`);
        for (const m of g.markets) {
          fileLines.push(`     - [${m.id}] ${m.title || '?'}${m.hourlyRate > 0 ? '  PP/h ' + fmt(m.hourlyRate, 1) : ''}`);
        }
        fileLines.push('');
      }
      const date = new Date().toISOString().slice(0, 10);
      const filename = `predict-only-grouped-${date}.txt`;
      await tgSendDocument(chatId, threadId, filename, fileLines.join('\n'), `📎 完整 ${groups.length} 个 event`);
    }
  } catch (err) {
    await reply(chatId, threadId, `❌ 拉取失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleCheckSpreads(chatId: number | string, threadId: number | null) {
  await reply(chatId, threadId, '⏳ 正在跑一次价差检查...');
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
    await reply(chatId, threadId, lines.join('\n'));
  } catch (err) {
    await reply(chatId, threadId, `❌ 检查失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleStatus(chatId: number | string, threadId: number | null) {
  const pairs = loadPairs();
  const cache = getCacheStatus();
  const watcher = getWatcherStatus();
  const subs = getSubscriptions();
  const lines = [
    `🟢 监控状态`,
    `进程内监控: ${globalThis.__spreadMonitorTimer ? '运行中' : '未启动'}`,
    `Bot 长轮询: ${globalThis.__tgBotPolling ? '运行中' : '未启动'}`,
    `配置对数: ${pairs.length}`,
    `轮询间隔: ${process.env.MONITOR_INTERVAL_MS || '60000'} ms`,
    `阈值: ${process.env.ALERT_THRESHOLD || '0.015'}`,
    `Cooldown: ${process.env.ALERT_COOLDOWN_SEC || '300'} s`,
    `最近一次 cycle: ${globalThis.__tgBotLastCycleAt || '(尚未记录)'}`,
    '',
    `📦 Predict 市场缓存`,
    `状态: ${cache.hasCache ? '✅ 已缓存' : '⏳ 未缓存'}${cache.refreshInflight ? '（刷新中）' : ''}`,
    `市场数: ${cache.totalMarkets}`,
    `类目数: ${cache.totalCategories}`,
    `抓取: ${cache.pagesFetched} 页, ${cache.durationMs}ms, stop=${cache.stoppedReason}`,
    `更新于: ${cache.fetchedAt || '(尚未)'}（${cache.ageMs == null ? '-' : Math.round(cache.ageMs / 1000) + 's 前'}）`
  ];
  if (cache.lastError) lines.push(`缓存错误: ${cache.lastError}`);
  lines.push('');
  lines.push(`🔔 新市场提醒`);
  lines.push(`订阅总数: ${subs.length}（Predict独有 ${subs.filter((s) => s.mode === 'predict_only').length} / 全部 ${subs.filter((s) => s.mode === 'all').length}）`);
  lines.push(`噪音过滤词: ${getActiveExcludeKeywords().join(', ') || '(已关闭)'}`);
  lines.push(`· Predict独有: ${watcher.predictOnly.initialized ? '✅' : '⏳'} 已知 ${watcher.predictOnly.knownEvents}${watcher.predictOnly.lastNewAt ? `，上次新发现 ${watcher.predictOnly.lastNewAt}（${watcher.predictOnly.lastNewCount}）` : ''}`);
  lines.push(`· 全部: ${watcher.all.initialized ? '✅' : '⏳'} 已知 ${watcher.all.knownEvents}${watcher.all.lastNewAt ? `，上次新发现 ${watcher.all.lastNewAt}（${watcher.all.lastNewCount}）` : ''}`);
  if (globalThis.__tgBotLastError) lines.push(`Bot 错误: ${globalThis.__tgBotLastError}`);
  await reply(chatId, threadId, lines.join('\n'));
}

async function handleHelp(chatId: number | string, threadId: number | null) {
  const text = [
    '🤖 命令列表',
    '',
    '/menu - 显示主菜单（按钮）',
    '/predict_only - Predict 独有市场（默认只看在派 PP 的，按 event 分组）',
    '/predict_only all - 包含 PP=0 的市场',
    '/subscribe - 订阅 Predict 独有的新市场提醒',
    '/subscribe_all - 订阅全部新市场提醒（含 polymarket 也有的）',
    '/unsubscribe - 取消本话题全部订阅',
    '/subscribers - 查看订阅列表',
    '/id - 查看当前 chat id 和 thread_id',
    '/check - 立即跑一次价差检查',
    '/status - 监控运行状态',
    '/help - 显示这条帮助',
    '',
    '话题群：在目标话题里发 /subscribe，提醒就发到那个话题。'
  ].join('\n');
  await reply(chatId, threadId, text);
}

async function handleCommand(
  chatId: number | string,
  threadId: number | null,
  command: string,
  args: string[],
  chatType: string = 'private'
) {
  const cmd = command.split('@')[0].trim().toLowerCase();
  switch (cmd) {
    case '/start':
    case '/menu':
      await sendMenu(chatId, threadId, '👋 欢迎使用 Predict-Poly 监控机器人。\n\n');
      return;
    case '/subscribe':
      await handleSubscribe(chatId, threadId, chatType, 'predict_only');
      return;
    case '/subscribe_all':
    case '/subscribeall':
      await handleSubscribe(chatId, threadId, chatType, 'all');
      return;
    case '/unsubscribe':
    case '/unsubscribe_all':
      await handleUnsubscribe(chatId, threadId);
      return;
    case '/subscribers':
      await handleSubscribers(chatId, threadId);
      return;
    case '/id':
      await handleId(chatId, threadId, chatType);
      return;
    case '/predict_only':
    case '/predictonly': {
      const includeZeroPP = args.some((a) => a.toLowerCase() === 'all' || a.toLowerCase() === '全部');
      await handlePredictOnly(chatId, threadId, !includeZeroPP);
      return;
    }
    case '/check':
    case '/spreads':
      await handleCheckSpreads(chatId, threadId);
      return;
    case '/refresh':
      await handleRefreshCache(chatId, threadId);
      return;
    case '/status':
      await handleStatus(chatId, threadId);
      return;
    case '/help':
      await handleHelp(chatId, threadId);
      return;
    default:
      await reply(chatId, threadId, `未知命令: ${cmd}\n发 /menu 看主菜单，或 /help 看命令列表。`);
  }
}

async function handleCallback(query: TgCallbackQuery) {
  const data = query.data || '';
  const chatId = query.message?.chat.id;
  const threadId = threadOf(query.message);
  await tg('answerCallbackQuery', { callback_query_id: query.id });
  if (!chatId) return;
  if (!isAllowed(chatId)) {
    await reply(chatId, threadId, '⛔ 未授权。请联系部署者。');
    return;
  }
  const chatType = query.message?.chat.type || 'private';
  switch (data) {
    case 'predict_only':
    case 'predict_only_all':
    case 'predict_only_rewards':
      await handlePredictOnly(chatId, threadId, true);
      break;
    case 'subscribe':
    case 'subscribe_predict_only':
      await handleSubscribe(chatId, threadId, chatType, 'predict_only');
      break;
    case 'subscribe_all':
      await handleSubscribe(chatId, threadId, chatType, 'all');
      break;
    case 'unsubscribe':
      await handleUnsubscribe(chatId, threadId);
      break;
    case 'refresh_cache':
      await handleRefreshCache(chatId, threadId);
      break;
    case 'check_spreads':
      await handleCheckSpreads(chatId, threadId);
      break;
    case 'status':
      await handleStatus(chatId, threadId);
      break;
    case 'help':
      await handleHelp(chatId, threadId);
      break;
    default:
      await reply(chatId, threadId, `未知按钮: ${data}`);
  }
}

// 这些命令无需 isAllowed 鉴权（用户/群组/话题首次接入需要用）
const UNAUTHED_COMMANDS = new Set([
  '/start',
  '/id',
  '/subscribe',
  '/subscribe_all',
  '/subscribeall',
  '/unsubscribe',
  '/unsubscribe_all'
]);

async function handleUpdate(update: TgUpdate) {
  if (update.callback_query) {
    await handleCallback(update.callback_query);
    return;
  }
  const msg = update.message;
  if (!msg?.text) return;
  const chatId = msg.chat.id;
  const threadId = threadOf(msg);
  const chatType = msg.chat.type || 'private';
  const text = msg.text.trim();
  const firstTok = text.split(/\s+/)[0].split('@')[0].toLowerCase();
  const bypassAuth = UNAUTHED_COMMANDS.has(firstTok);

  if (!bypassAuth && !isAllowed(chatId)) {
    await reply(
      chatId,
      threadId,
      `⛔ 未授权。你的 chat id 是 ${chatId}（${chatType}）${threadId ? `\nthread_id: ${threadId}` : ''}。\n直接发 /subscribe 即可订阅新市场提醒。\n要使用其它命令请把这个 id 加到 TELEGRAM_ALLOWED_CHAT_IDS。`
    );
    return;
  }
  if (text.startsWith('/')) {
    const tokens = text.split(/\s+/);
    await handleCommand(chatId, threadId, tokens[0], tokens.slice(1), chatType);
    return;
  }
  await sendMenu(chatId, threadId);
}

async function registerCommandsMenu() {
  try {
    await tg('setMyCommands', {
      commands: [
        { command: 'menu', description: '主菜单' },
        { command: 'predict_only', description: 'Predict 独有市场（在派 PP）' },
        { command: 'subscribe', description: '订阅 Predict 独有新市场' },
        { command: 'subscribe_all', description: '订阅全部新市场(含Poly)' },
        { command: 'unsubscribe', description: '取消本话题订阅' },
        { command: 'subscribers', description: '查看订阅列表' },
        { command: 'id', description: '查看当前 chat id' },
        { command: 'refresh', description: '强制刷新缓存' },
        { command: 'check', description: '立即跑一次价差检查' },
        { command: 'status', description: '监控/缓存状态' },
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
  console.log(`[bot] starting long polling — instance=${INSTANCE_ID} version=${CODE_VERSION} started=${INSTANCE_STARTED}`);

  registerAlertSendFn(sendTextToChat);
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
