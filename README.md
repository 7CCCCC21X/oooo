# Predict.fun × Polymarket 价差监控

监控 predict.fun 和 polymarket 两边订单簿顶层的价差，并提供一个 "Predict 独有市场" 页面（拉所有 predict 市场，过滤出没有对应 polymarket 映射的）。

## 页面

- `/` 价差监控：根据 `config/pairs.json` 或浏览器本地配置，实时对比 predict.fun 和 polymarket 的 bid/ask，达阈值高亮 + 可推送 Telegram。
- `/predict-only` Predict 独有市场：调用 predict.fun 全量 markets 接口，过滤出 `polymarketConditionIds` 为空的市场，按 volume / liquidity / 结束日期排序，支持搜索。

## API

- `GET /api/spreads` 用服务器配置查价差。
- `POST /api/spreads` body `{ pairs: [...] }` 用浏览器临时配置查价差。
- `POST /api/resolve` body `{ predictMarketId }` 自动从 predict.fun 抓 polymarketConditionIds，生成 pairs。
- `GET /api/cron?secret=...` 给 GitHub Actions / Vercel Cron 调用，触发 Telegram 提醒。
- `GET /api/predict-only?includeClosed=0&limit=100&maxPages=50` 拉所有 predict 市场，返回独有列表。

## 环境变量

参考 `.env.example`。`PREDICT_API_KEY` 必填，只在服务端使用，前端不会暴露。

## 本地运行

```bash
npm install
cp .env.example .env.local
# 填好 PREDICT_API_KEY
npm run dev
```

访问 http://localhost:3000

## 部署到 Vercel

把仓库连接到 Vercel，在 Project Settings → Environment Variables 配置：

- `PREDICT_API_KEY`
- `CRON_SECRET`（GitHub Actions 调用 /api/cron 时验证）
- `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`（可选）
- `ALERT_THRESHOLD` 默认 0.015
- `MIN_SIZE` 默认 0
- `FEE_BUFFER` 默认 0
- `ALERT_COOLDOWN_SEC` 默认 300

## GitHub Actions

`.github/workflows/monitor.yml` 每 5 分钟 ping 一次 `/api/cron`，需要在 GitHub Secrets 配置：

- `CRON_URL` 形如 `https://your-app.vercel.app/api/cron`
- `CRON_SECRET` 和 Vercel 环境变量一致
