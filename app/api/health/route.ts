import { NextResponse } from 'next/server';
import { CODE_VERSION, PROCESS_STARTED } from '@/lib/version';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  return NextResponse.json({
    ok: true,
    version: CODE_VERSION,
    processStarted: PROCESS_STARTED,
    now: new Date().toISOString(),
    monitorRunning: !!globalThis.__spreadMonitorTimer,
    botPolling: !!globalThis.__tgBotPolling,
    botLastEventAt: globalThis.__tgBotLastCycleAt || null,
    botLastError: globalThis.__tgBotLastError || null,
    hasTelegram: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID)
  });
}
