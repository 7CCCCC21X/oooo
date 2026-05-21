import fs from 'node:fs';
import path from 'node:path';

export type SubMode = 'predict_only' | 'all';
export type Subscription = { chatId: string; threadId: number | null; mode: SubMode };

declare global {
  var __subscriptions: Map<string, Subscription> | undefined;
}

function filePath(): string {
  return process.env.SUBSCRIBERS_FILE || '';
}

function keyOf(chatId: string | number, threadId: number | null, mode: SubMode): string {
  return `${chatId}:${threadId ?? 'general'}:${mode}`;
}

function load(): Map<string, Subscription> {
  if (globalThis.__subscriptions) return globalThis.__subscriptions;
  const map = new Map<string, Subscription>();
  const seed = (chatId: string, threadId: number | null, mode: SubMode) => {
    map.set(keyOf(chatId, threadId, mode), { chatId, threadId, mode });
  };
  // 不自动 seed env chat id（那只是权限白名单）。订阅来自 /subscribe + 文件。
  const f = filePath();
  if (f) {
    try {
      if (fs.existsSync(f)) {
        const data = JSON.parse(fs.readFileSync(f, 'utf-8'));
        if (Array.isArray(data)) {
          for (const item of data) {
            if (typeof item === 'string') {
              seed(item, null, 'predict_only');
            } else if (item && item.chatId != null) {
              const tid = item.threadId == null ? null : Number(item.threadId);
              const mode: SubMode = item.mode === 'all' ? 'all' : 'predict_only';
              seed(String(item.chatId), Number.isFinite(tid as number) ? (tid as number) : null, mode);
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

export function getSubscriptions(mode?: SubMode): Subscription[] {
  const all = [...load().values()];
  return mode ? all.filter((s) => s.mode === mode) : all;
}

export function isSubscribed(chatId: string | number, threadId: number | null, mode: SubMode): boolean {
  return load().has(keyOf(chatId, threadId, mode));
}

export function addSubscriber(chatId: string | number, threadId: number | null, mode: SubMode): boolean {
  const map = load();
  const k = keyOf(chatId, threadId, mode);
  if (map.has(k)) return false;
  map.set(k, { chatId: String(chatId), threadId, mode });
  persist(map);
  return true;
}

export function removeSubscriber(chatId: string | number, threadId: number | null, mode: SubMode): boolean {
  const map = load();
  const k = keyOf(chatId, threadId, mode);
  if (!map.has(k)) return false;
  map.delete(k);
  persist(map);
  return true;
}

// 取消当前 chat+thread 的所有 mode 订阅，返回取消了几个
export function removeAllModes(chatId: string | number, threadId: number | null): number {
  const map = load();
  let removed = 0;
  for (const mode of ['predict_only', 'all'] as SubMode[]) {
    if (map.delete(keyOf(chatId, threadId, mode))) removed += 1;
  }
  if (removed) persist(map);
  return removed;
}

export function getSubscribersFilePath(): string {
  return filePath();
}
