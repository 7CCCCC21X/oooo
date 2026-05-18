import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const auth = request.headers.get('authorization') || '';
  const querySecret = request.nextUrl.searchParams.get('secret') || '';
  return auth === `Bearer ${secret}` || querySecret === secret;
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const customText = request.nextUrl.searchParams.get('text') || '';
  const text = customText || `✅ Predict-Poly monitor test\n时间: ${new Date().toISOString()}\n如果你收到这条，说明 Telegram 推送通道工作正常。`;

  if (!token) {
    return NextResponse.json({ ok: false, error: 'TELEGRAM_BOT_TOKEN is not set in env' }, { status: 400 });
  }
  if (!chatId) {
    return NextResponse.json({ ok: false, error: 'TELEGRAM_CHAT_ID is not set in env' }, { status: 400 });
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true })
    });
    const body = await response.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = body;
    }
    return NextResponse.json(
      {
        ok: response.ok,
        status: response.status,
        chatIdEcho: chatId,
        tokenHint: `${token.slice(0, 6)}...${token.slice(-4)}`,
        telegramResponse: parsed
      },
      { status: response.ok ? 200 : 502 }
    );
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
