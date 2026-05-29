// 价差提醒开关：运行时通过 /spread_off /spread_on 切换，默认看 env
// DISABLE_SPREAD_ALERTS=1 → 启动即关闭；否则启动即开。
// 状态进程内保存，进程重启回到默认值。

declare global {
  var __spreadAlertsEnabled: boolean | undefined;
  var __spreadAlertsChangedAt: string | undefined;
  var __spreadAlertsChangedBy: string | undefined;
}

function defaultEnabled(): boolean {
  return process.env.DISABLE_SPREAD_ALERTS !== '1';
}

export function isSpreadAlertsEnabled(): boolean {
  if (typeof globalThis.__spreadAlertsEnabled === 'boolean') return globalThis.__spreadAlertsEnabled;
  const v = defaultEnabled();
  globalThis.__spreadAlertsEnabled = v;
  return v;
}

export function setSpreadAlertsEnabled(enabled: boolean, changedBy?: string): { changed: boolean; enabled: boolean } {
  const current = isSpreadAlertsEnabled();
  if (current === enabled) return { changed: false, enabled };
  globalThis.__spreadAlertsEnabled = enabled;
  globalThis.__spreadAlertsChangedAt = new Date().toISOString();
  globalThis.__spreadAlertsChangedBy = changedBy || '';
  return { changed: true, enabled };
}

export function getSpreadAlertsStatus() {
  return {
    enabled: isSpreadAlertsEnabled(),
    defaultEnabled: defaultEnabled(),
    changedAt: globalThis.__spreadAlertsChangedAt ?? null,
    changedBy: globalThis.__spreadAlertsChangedBy ?? null
  };
}
