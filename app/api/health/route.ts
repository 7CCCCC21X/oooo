import { NextResponse } from 'next/server';
import { CODE_VERSION, PROCESS_STARTED } from '@/lib/version';
import { getPredictLimiterStatus } from '@/lib/predict-limiter';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  return NextResponse.json({
    ok: true,
    version: CODE_VERSION,
    processStarted: PROCESS_STARTED,
    now: new Date().toISOString(),
    cacheTimerActive: !!globalThis.__predictCacheTimer,
    negriskTimerActive: !!globalThis.__negRiskTimer,
    botPolling: !!globalThis.__tgBotPolling,
    botLastEventAt: globalThis.__tgBotLastCycleAt || null,
    botLastError: globalThis.__tgBotLastError || null,
    hasTelegram: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
    hasPredictApiKey: !!process.env.PREDICT_API_KEY,
    predictLimiter: getPredictLimiterStatus(),
    env: process.env.NODE_ENV || 'development'
  });
}
