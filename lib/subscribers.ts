import fs from 'node:fs';
import path from 'node:path';

export type Subscription = { chatId: string; threadId: number | null };

declare global {
  var __subscriptions: Map<string, Subscription> | undefined;
}

function filePath(): string {
  return process.env.SUBSCRIBERS_FILE || '';
}

function keyOf(chatId: string | number, threadId: number | null): string {
  return `${chatId}:${threadId ?? 'general'}`;
}

function load(): Map<string, Subscription> {
  if (globalThis.__subscriptions) return globalThis.__subscriptions;
  const map = new Map<string, Subscription>();
  const seed = (chatId: string, threadId: number | null) => {
    map.set(keyOf(chatId, threadId), { chatId, threadId });
  };
  // 注意：不再自动 seed TELEGRAM_CHAT_ID / TELEGRAM_ALLOWED_CHAT_IDS。
  // 那两个只做权限白名单，不应自动订阅，否则提醒会跑到默认话题。
  // 订阅完全来自 /subscribe（记录 chatId + threadId）和 SUBSCRIBERS_FILE。
  const f = filePath();
  if (f) {
    try {
      if (fs.existsSync(f)) {
        const data = JSON.parse(fs.readFileSync(f, 'utf-8'));
        if (Array.isArray(data)) {
          for (const item of data) {
            if (typeof item === 'string') {
              seed(item, null);
            } else if (item && item.chatId != null) {
              const tid = item.threadId == null ? null : Number(item.threadId);
              seed(String(item.chatId), Number.isFinite(tid as number) ? (tid as number) : null);
            }
          }
        }
      }
    } catch (err) {
      console.error('[subscribers] load failed:', err instanceof Error ? err.message : err);
    }
  }
  globalThis.__subscriptions = map;
  return map;
}

function persist(map: Map<string, Subscription>): void {
  const f = filePath();
  if (!f) return;
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify([...map.values()], null, 2));
  } catch (err) {
    console.error('[subscribers] persist failed:', err instanceof Error ? err.message : err);
  }
}

export function getSubscriptions(): Subscription[] {
  return [...load().values()];
}

export function isSubscribed(chatId: string | number, threadId: number | null = null): boolean {
  return load().has(keyOf(chatId, threadId));
}

export function addSubscriber(chatId: string | number, threadId: number | null = null): boolean {
  const map = load();
  const k = keyOf(chatId, threadId);
  if (map.has(k)) return false;
  map.set(k, { chatId: String(chatId), threadId });
  persist(map);
  return true;
}

export function removeSubscriber(chatId: string | number, threadId: number | null = null): boolean {
  const map = load();
  const k = keyOf(chatId, threadId);
  if (!map.has(k)) return false;
  map.delete(k);
  persist(map);
  return true;
}

export function getSubscribersFilePath(): string {
  return filePath();
}
