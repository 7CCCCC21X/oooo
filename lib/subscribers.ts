import fs from 'node:fs';
import path from 'node:path';

declare global {
  var __subscribers: Set<string> | undefined;
}

function filePath(): string {
  return process.env.SUBSCRIBERS_FILE || '';
}

function load(): Set<string> {
  if (globalThis.__subscribers) return globalThis.__subscribers;
  const set = new Set<string>();
  const main = String(process.env.TELEGRAM_CHAT_ID || '').trim();
  if (main) set.add(main);
  const extra = String(process.env.TELEGRAM_ALLOWED_CHAT_IDS || '').trim();
  if (extra) {
    for (const id of extra.split(/[\s,]+/).filter(Boolean)) {
      set.add(id.trim());
    }
  }
  const f = filePath();
  if (f) {
    try {
      if (fs.existsSync(f)) {
        const data = JSON.parse(fs.readFileSync(f, 'utf-8'));
        if (Array.isArray(data)) for (const id of data) set.add(String(id));
      }
    } catch (err) {
      console.error('[subscribers] load failed:', err instanceof Error ? err.message : err);
    }
  }
  globalThis.__subscribers = set;
  return set;
}

function persist(set: Set<string>): void {
  const f = filePath();
  if (!f) return;
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify([...set], null, 2));
  } catch (err) {
    console.error('[subscribers] persist failed:', err instanceof Error ? err.message : err);
  }
}

export function getSubscribers(): string[] {
  return [...load()];
}

export function isSubscribed(chatId: string | number): boolean {
  return load().has(String(chatId));
}

export function addSubscriber(chatId: string | number): boolean {
  const set = load();
  const id = String(chatId);
  if (set.has(id)) return false;
  set.add(id);
  persist(set);
  return true;
}

export function removeSubscriber(chatId: string | number): boolean {
  const set = load();
  const id = String(chatId);
  if (!set.has(id)) return false;
  set.delete(id);
  persist(set);
  return true;
}

export function getSubscribersFilePath(): string {
  return filePath();
}
