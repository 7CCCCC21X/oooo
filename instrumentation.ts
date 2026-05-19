export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NODE_ENV !== 'production') return;
  const { startBackgroundMonitor } = await import('./lib/monitor');
  startBackgroundMonitor();
  const { startBotLongPolling } = await import('./lib/telegram-bot');
  startBotLongPolling();
  const { addRefreshHook, startBackgroundCacheRefresh } = await import('./lib/predict-cache');
  const { notifyNewMarkets } = await import('./lib/new-markets-alerts');
  addRefreshHook(async (entry) => {
    await notifyNewMarkets(entry);
  });
  startBackgroundCacheRefresh();
}
