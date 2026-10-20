import { getActiveExcludeKeywords, predictMarketUrl, selectEligibleGroups } from './predict-markets';
import {
  analyzeCategoryBySlugOrUrl,
  formatCategoryReport,
  formatScanReport,
  getNegRiskDisplayMin,
  getNegRiskStatus,
  getNegRiskThreshold,
  isNegRiskAlertsEnabled,
  registerNegRiskSendFn,
  scanConvertibleCategories,
  setNegRiskAlertsEnabled,
  setNegRiskDisplayMin,
  setNegRiskThreshold
} from './negrisk';
import { findPredictUrl } from './predict-url';
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

// Telegram 单条上限 4096，留余量。超长文本按行切成多段，不再硬截断。
const TG_MAX_TEXT = 3800;
function splitLongText(text: string, max = TG_MAX_TEXT): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let buf = '';
  for (const line of text.split('\n')) {
    const sep = buf ? '\n' : '';
    if (buf.length + sep.length + line.length > max) {
      if (buf) parts.push(buf);
      // 单行本身超长（极少见）：硬切
      buf = line.length > max ? line.slice(0, max) : line;
    } else {
      buf += sep + line;
    }
  }
  if (buf) parts.push(buf);
  return parts;
}

async function replyLong(chatId: number | string, threadId: number | null, text: string): Promise<void> {
  const parts = splitLongText(text);
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 1200));
    await reply(chatId, threadId, parts[i]);
  }
}

export async function sendTextToChat(chatId: string, text: string, threadId: number | null = null): Promise<void> {
  await replyLong(chatId, threadId, text);
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
    [{ text: '🔁 可转换市场 · Yes买1 总和扫描', callback_data: 'yes_check' }],
    [
      { text: '🔔 订阅·Predict独有', callback_data: 'subscribe_predict_only' },
      { text: '🔔 订阅·全部(含Poly)', callback_data: 'subscribe_all' }
    ],
    [{ text: '🔔 订阅·Yes总和提醒', callback_data: 'subscribe_negrisk' }],
    [{ text: '🔕 取消本话题订阅', callback_data: 'unsubscribe' }],
    [{ text: '🔄 强制刷新缓存', callback_data: 'refresh_cache' }],
    [{ text: 'ℹ️ 监控状态', callback_data: 'status' }, { text: '❓ 帮助', callback_data: 'help' }]
  ]
};

async function handleRefreshCache(chatId: number | string, threadId: number | null) {
  await reply(chatId, threadId, '🔄 已触发后台刷新缓存，60~180 秒后再点查询即可。');
  refreshMarketsCache().catch(() => {});
}

function modeLabel(mode: SubMode): string {
  if (mode === 'all') return '全部(含Poly)';
  if (mode === 'negrisk') return 'Yes总和提醒';
  return 'Predict独有';
}

async function handleSubscribe(chatId: number | string, threadId: number | null, chatType: string, mode: SubMode) {
  const added = addSubscriber(chatId, threadId, mode);
  const loc = threadId ? `\n话题 thread_id: ${threadId}` : '';
  if (mode === 'negrisk') {
    await reply(
      chatId,
      threadId,
      added
        ? `✅ 已订阅【Yes总和提醒】\n\nchat id: ${chatId}（${chatType}）${loc}\n\n可转换(NegRisk)类目里所有结果的 Yes 买1 加起来 ≥ ${getNegRiskThreshold()}¢ 时推送到${threadId ? '这个话题' : '这里'}。\n改阈值: /yes_threshold 101\n取消: /unsubscribe`
        : `这个${threadId ? '话题' : 'chat'}已经订阅【Yes总和提醒】了。\nchat id: ${chatId}${loc}`
    );
    return;
  }
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
  const MAX = TG_MAX_TEXT;
  const messages: string[] = [];
  let buf = header;
  for (const item of items) {
    const sep = buf ? '\n\n' : '';
    if (buf.length + sep.length + item.length > MAX) {
      if (buf) messages.push(buf);
      // 单个 item 超过一条消息：按行拆开，最后一段继续作为当前 buf 累积
      const pieces = splitLongText(item, MAX);
      messages.push(...pieces.slice(0, -1));
      buf = pieces[pieces.length - 1];
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
    const { markets, pagesFetched, stoppedReason, totalCategories, totalUniqueMarketIds, fetchedAt, complete, pageSize, statusFilter } = entry;
    // 与订阅推送 / API 同一套筛选口径
    const { groups, stats } = selectEligibleGroups(markets, { predictOnly: true, requireRewards: onlyRewards });
    // 抓取没翻到底（页数上限 / 中途报错）时提醒，否则用户以为这就是全部
    const crawlNote = complete
      ? ''
      : `\n⚠️ 抓取未翻到底（${pagesFetched} 页 × 每页约 ${pageSize || '?'} 个类目，stop=${stoppedReason}），列表可能不完整。可用 /refresh 重抓或调大 PREDICT_CACHE_MAX_PAGES`;
    if (!groups.length) {
      await reply(
        chatId,
        threadId,
        [
          `没找到 predict 独有市场${onlyRewards ? '（在派 PP）' : ''}。`,
          `source: /v1/categories (cached at ${fetchedAt}, status=${statusFilter ?? 'none'})`,
          `抓取: ${pagesFetched} 页 (stop=${stoppedReason}, 完整=${complete ? '是' : '否'})`,
          `类目数: ${totalCategories} · 市场数: ${totalUniqueMarketIds}`,
          `筛选漏斗: 全部 ${stats.input} → 去 polymarket ${stats.afterPolymarket} → 去噪音 ${stats.afterNoise} → 可交易 ${stats.afterTradeable} → 有 PP ${stats.afterRewards}`
        ].join('\n') + crawlNote
      );
      return;
    }
    const totalFound = stats.output;
    const totalPP = groups.reduce((s, g) => s + g.totalHourlyRate, 0);
    const header =
      `📊 Predict 独有市场${onlyRewards ? '（在派 PP）' : '（全部）'}\n共 ${groups.length} 个 event / ${totalFound} 个市场\n` +
      `总 PP/h = ${fmt(totalPP, 1)}（抓取 ${pagesFetched} 页 · stop=${stoppedReason}）\n` +
      `筛选: 全部 ${stats.input} → 独有 ${stats.afterPolymarket} → 去噪音 ${stats.afterNoise} → 可交易 ${stats.afterTradeable} → 有 PP ${stats.afterRewards}` +
      crawlNote + '\n';

    // 选项全部列出，不再截断；超长由 sendInChunks 按行拆成多条消息
    const items = groups.map((g, i) => {
      const remain = fmtRemaining(g.endMs);
      const lines = [`${i + 1}. ${g.title}`];
      lines.push(`   总 PP/h: ${fmt(g.totalHourlyRate, 1)}${remain ? ` · ⏰ ${remain}` : ''}`);
      if (g.markets.length > 1) {
        lines.push(`   选项 (${g.markets.length}):`);
        for (const m of g.markets) {
          const pp = m.hourlyRate > 0 ? ` · PP/h ${fmt(m.hourlyRate, 1)}` : '';
          lines.push(`     • ${m.title || '?'}${pp}`);
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

async function handleStatus(chatId: number | string, threadId: number | null) {
  const cache = getCacheStatus();
  const watcher = getWatcherStatus();
  const subs = getSubscriptions();
  const lines = [
    `🟢 运行状态`,
    `Bot 长轮询: ${globalThis.__tgBotPolling ? '运行中' : '未启动'}`,
    `最近收到消息: ${globalThis.__tgBotLastCycleAt || '(尚未记录)'}`,
    '',
    `📦 Predict 市场缓存`,
    `状态: ${cache.hasCache ? '✅ 已缓存' : '⏳ 未缓存'}${cache.refreshInflight ? '（刷新中）' : ''}`,
    `市场数: ${cache.totalMarkets}`,
    `类目数: ${cache.totalCategories}`,
    `抓取: ${cache.pagesFetched} 页（每页约 ${cache.pageSize || '?'}）, ${cache.durationMs}ms, stop=${cache.stoppedReason}`,
    `完整性: ${cache.complete == null ? '-' : cache.complete ? '✅ 翻到底' : '⚠️ 未翻到底（页数上限或中途报错）'} · 服务端过滤 status=${cache.statusFilter ?? 'none'}`,
    `更新于: ${cache.fetchedAt || '(尚未)'}（${cache.ageMs == null ? '-' : Math.round(cache.ageMs / 1000) + 's 前'}）`
  ];
  if (cache.lastError) lines.push(`缓存错误: ${cache.lastError}`);
  lines.push('');
  lines.push(`🔔 新市场提醒`);
  lines.push(`订阅总数: ${subs.length}（Predict独有 ${subs.filter((s) => s.mode === 'predict_only').length} / 全部 ${subs.filter((s) => s.mode === 'all').length} / Yes总和 ${subs.filter((s) => s.mode === 'negrisk').length}）`);
  lines.push(`噪音过滤词: ${getActiveExcludeKeywords().join(', ') || '(已关闭)'}`);
  lines.push(`· Predict独有: ${watcher.predictOnly.initialized ? '✅' : '⏳'} 已知 ${watcher.predictOnly.knownEvents}${watcher.predictOnly.lastNewAt ? `，上次新发现 ${watcher.predictOnly.lastNewAt}（${watcher.predictOnly.lastNewCount}）` : ''}`);
  lines.push(`· 全部: ${watcher.all.initialized ? '✅' : '⏳'} 已知 ${watcher.all.knownEvents}${watcher.all.lastNewAt ? `，上次新发现 ${watcher.all.lastNewAt}（${watcher.all.lastNewCount}）` : ''}`);
  const nr = getNegRiskStatus();
  lines.push('');
  lines.push(`🔁 可转换市场 Yes 总和检查`);
  lines.push(`提醒: ${nr.enabled ? '✅ 开启' : '🔕 关闭'} · 提醒阈值 ${nr.thresholdCents}¢ · 显示下限 ${nr.displayMinCents}¢ · 每 ${Math.round(nr.intervalMs / 60000)} 分钟 · cooldown ${nr.cooldownSec}s · 定时器 ${nr.timerActive ? '运行中' : '未启动'}`);
  lines.push(`订阅话题: ${nr.subscribers}${nr.subscribers ? '' : '（无，发到 TELEGRAM_CHAT_ID）'}`);
  if (nr.lastCycle) {
    const c = nr.lastCycle;
    lines.push(
      `上次扫描: ${c.at} · 候选 ${c.candidates} / 预过滤 ${c.prefiltered} / 查询 ${c.scanned} · ${c.requests} 次请求 ${Math.round(c.durationMs / 1000)}s · 达标 ${c.hits} · 已推送 ${c.alertsSent}`
    );
    if (c.topSum != null) lines.push(`最高: ${c.topSum.toFixed(1)}¢ ${c.topTitle}`);
    if (c.detectMode) lines.push(`判定: ${c.detectMode === 'flag' ? '接口 isNegRisk' : '启发式(≥3 结果)'}`);
    if (c.error) lines.push(`扫描错误: ${c.error}`);
  } else {
    lines.push('上次扫描: (尚未)');
  }
  if (globalThis.__tgBotLastError) lines.push(`Bot 错误: ${globalThis.__tgBotLastError}`);
  await reply(chatId, threadId, lines.join('\n'));
}

// ---------- 可转换市场 / Yes 买1 总和 ----------

async function handleYes(chatId: number | string, threadId: number | null, input: string) {
  const target = (input || '').trim();
  if (!target) {
    await reply(
      chatId,
      threadId,
      '用法: /yes <predict.fun 链接或 slug>\n例: /yes https://predict.fun/market/xxx\n直接把链接发给我也可以。'
    );
    return;
  }
  await reply(chatId, threadId, '⏳ 正在查每个结果的 Yes 订单簿...');
  try {
    const a = await analyzeCategoryBySlugOrUrl(target);
    await replyLong(chatId, threadId, formatCategoryReport(a, getNegRiskThreshold()));
  } catch (err) {
    await reply(chatId, threadId, `❌ 查询失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// 解析 "95" / "95¢" / "all" / "全部" 为显示下限；无参数用持久化的下限；不合法返回 undefined
function parseFloorArg(args: string[]): { minCents: number; error?: string } {
  if (!args.length) return { minCents: getNegRiskDisplayMin() };
  const raw = args[0].trim().toLowerCase();
  if (raw === 'all' || raw === '全部' || raw === '0') return { minCents: 0 };
  const n = Number(raw.replace(/[¢%,，]/g, ''));
  if (!Number.isFinite(n) || n < 0 || n > 1000) return { minCents: getNegRiskDisplayMin(), error: `下限无效: ${args[0]}（要 0-1000 的数字，单位 ¢，或 all）` };
  return { minCents: n };
}

async function handleYesCheck(chatId: number | string, threadId: number | null, args: string[] = []) {
  const { minCents, error } = parseFloorArg(args);
  if (error) {
    await reply(chatId, threadId, `❌ ${error}`);
    return;
  }
  await reply(chatId, threadId, `⏳ 正在扫描全部可转换类目，列出 Σ Yes 买1 ≥ ${minCents}¢ 的（按结果数可能要几十秒）...`);
  try {
    const scan = await scanConvertibleCategories();
    await replyLong(chatId, threadId, formatScanReport(scan, { minCents }));
  } catch (err) {
    await reply(chatId, threadId, `❌ 扫描失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleYesShow(chatId: number | string, threadId: number | null, args: string[]) {
  const current = getNegRiskDisplayMin();
  if (!args.length) {
    await reply(
      chatId,
      threadId,
      `当前显示下限: ${current}¢（/yes_check 和提醒里"接近阈值"会列出 Σ Yes 买1 ≥ 这个值的类目，低于提醒阈值 ${getNegRiskThreshold()}¢ 的也显示）\n设置: /yes_show 90\n只看一次不改设置: /yes_check 90`
    );
    return;
  }
  const { minCents, error } = parseFloorArg(args);
  if (error) {
    await reply(chatId, threadId, `❌ ${error}`);
    return;
  }
  const set = setNegRiskDisplayMin(minCents);
  if (set == null) {
    await reply(chatId, threadId, `❌ 下限无效: ${args[0]}`);
    return;
  }
  const warn = set >= getNegRiskThreshold() ? `\n⚠️ 下限不低于提醒阈值 ${getNegRiskThreshold()}¢，这样就只显示达标的` : '';
  await reply(chatId, threadId, `✅ 显示下限已改为 ${set}¢（原 ${current}¢）${warn}`);
}

async function handleYesThreshold(chatId: number | string, threadId: number | null, args: string[]) {
  const current = getNegRiskThreshold();
  if (!args.length) {
    await reply(chatId, threadId, `当前阈值: ${current}¢（所有结果 Yes 买1 之和 ≥ 这个值就提醒）\n设置: /yes_threshold 101`);
    return;
  }
  const raw = args[0].replace(/[¢%,，]/g, '');
  const set = setNegRiskThreshold(Number(raw));
  if (set == null) {
    await reply(chatId, threadId, `❌ 阈值无效: ${args[0]}（要 0-1000 之间的数字，单位 ¢）`);
    return;
  }
  await reply(chatId, threadId, `✅ 阈值已改为 ${set}¢（原 ${current}¢）\n${isNegRiskAlertsEnabled() ? '' : '⚠️ 提醒当前是关闭的，/yes_on 开启'}`.trim());
}

async function handleYesToggle(chatId: number | string, threadId: number | null, enabled: boolean) {
  const r = setNegRiskAlertsEnabled(enabled);
  await reply(
    chatId,
    threadId,
    r.changed
      ? enabled
        ? `✅ Yes 总和提醒已开启（阈值 ${getNegRiskThreshold()}¢）`
        : '🔕 Yes 总和提醒已关闭（扫描继续跑，/status 能看结果，但不推送）'
      : `Yes 总和提醒本来就是${enabled ? '开启' : '关闭'}的。`
  );
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
    '/yes <链接> - 查该类目所有结果的 Yes 买1 并求和（直接发链接也行）',
    '/yes_check [下限|all] - 扫描全部可转换类目，列出 Yes 买1 总和 ≥ 下限的（低于提醒阈值的也显示）',
    '/yes_show [下限] - 查看/设置默认显示下限（¢，默认 95）',
    '/yes_threshold [数值] - 查看/设置提醒阈值（¢，默认 100）',
    '/yes_on /yes_off - 开关 Yes 总和提醒',
    '/subscribe_yes - 本话题订阅 Yes 总和提醒',
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
      await sendMenu(chatId, threadId, '👋 欢迎使用 Predict 监控机器人。\n\n');
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
    case '/yes':
    case '/negrisk':
    case '/convert':
      await handleYes(chatId, threadId, args.join(' '));
      return;
    case '/yes_check':
    case '/yescheck':
    case '/negrisk_check':
      await handleYesCheck(chatId, threadId, args);
      return;
    case '/yes_show':
    case '/yesshow':
    case '/yes_min':
    case '/yes_display':
      await handleYesShow(chatId, threadId, args);
      return;
    case '/yes_threshold':
    case '/yesthreshold':
    case '/threshold':
      await handleYesThreshold(chatId, threadId, args);
      return;
    case '/yes_on':
    case '/yeson':
      await handleYesToggle(chatId, threadId, true);
      return;
    case '/yes_off':
    case '/yesoff':
      await handleYesToggle(chatId, threadId, false);
      return;
    case '/subscribe_yes':
    case '/subscribeyes':
    case '/subscribe_negrisk':
      await handleSubscribe(chatId, threadId, chatType, 'negrisk');
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
    case 'subscribe_negrisk':
      await handleSubscribe(chatId, threadId, chatType, 'negrisk');
      break;
    case 'yes_check':
      await handleYesCheck(chatId, threadId);
      break;
    case 'unsubscribe':
      await handleUnsubscribe(chatId, threadId);
      break;
    case 'refresh_cache':
      await handleRefreshCache(chatId, threadId);
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
  // 直接发 predict.fun 链接 → 当作 /yes 查询
  const url = findPredictUrl(text);
  if (url) {
    await handleYes(chatId, threadId, url);
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
        { command: 'yes', description: '查链接类目的 Yes 买1 总和' },
        { command: 'yes_check', description: '扫描可转换类目 Yes 买1 总和（可带下限）' },
        { command: 'yes_show', description: '查看/设置显示下限' },
        { command: 'yes_threshold', description: '查看/设置 Yes 总和提醒阈值' },
        { command: 'subscribe_yes', description: '订阅 Yes 总和提醒' },
        { command: 'subscribe', description: '订阅 Predict 独有新市场' },
        { command: 'subscribe_all', description: '订阅全部新市场(含Poly)' },
        { command: 'unsubscribe', description: '取消本话题订阅' },
        { command: 'subscribers', description: '查看订阅列表' },
        { command: 'id', description: '查看当前 chat id' },
        { command: 'refresh', description: '强制刷新缓存' },
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
  registerNegRiskSendFn(sendTextToChat);
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
