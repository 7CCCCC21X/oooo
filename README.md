# Predict.fun × Polymarket 价差监控

监控 predict.fun 和 polymarket 两边订单簿顶层的价差，并提供一个 "Predict 独有市场 + PP/h" 页面（拉所有 predict 市场，过滤出没有对应 polymarket 映射的，并显示每小时奖励）。

## 页面

- `/` 价差监控：根据 `config/pairs.json` 或浏览器本地配置，实时对比 predict.fun 和 polymarket 的 bid/ask，达阈值高亮 + Telegram 推送。
- `/predict-only` Predict 独有市场 + PP/h：调用 predict.fun 全量 markets 接口，过滤出 `polymarketConditionIds` 为空的市场，按 PP/h 排序，可选只看 `hasActiveRewards`。

## API

- `GET /api/spreads` — 服务器配置查价差
- `POST /api/spreads` — body `{ pairs: [...] }` 用临时配置查价差
- `POST /api/resolve` — body `{ predictMarketId }` 自动生成 pairs
- `GET /api/cron?secret=...` — 手动触发一次监控周期
- `GET /api/predict-only?hasActiveRewards=1&minHourlyRate=N&debug=1` — predict 独有市场
- `GET /api/health` — 健康检查 + 监控状态

## 后台监控

Railway 是长进程容器，所以 Telegram 提醒直接由 Next.js 进程内的 `setInterval` 跑（`instrumentation.ts` 在生产启动时拉起）。不需要外部 cron。

- `ENABLE_INPROCESS_MONITOR=1` 启用（默认开）
- `MONITOR_INTERVAL_MS=60000` 间隔毫秒（默认 1 分钟）
- `ALERT_COOLDOWN_SEC=300` 同一组合的提醒冷却（默认 5 分钟）

> 仅在 `NODE_ENV=production` 启用，`npm run dev` 不会跑后台，免得开发时刷屏。

## Railway 部署

1. 把仓库连到 Railway，新建 service 选 GitHub 仓库。
2. Railway 会自动用 Nixpacks 检测到 Next.js，按 `railway.json` 跑 `npm ci && npm run build` → `npm run start`。
3. Settings → Variables 配：
   - `PREDICT_API_KEY` 必填
   - `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` 想要提醒就配
   - `CRON_SECRET` 给 `/api/cron` 加保护
   - `ALERT_THRESHOLD` 默认 0.015
   - `MIN_SIZE` / `FEE_BUFFER` / `ALERT_COOLDOWN_SEC` 可选
   - `MONITOR_INTERVAL_MS` 后台轮询频率，默认 60000
4. Settings → Networking → Generate Domain，拿到公开域名。
5. 打开 `https://<your-app>.up.railway.app/api/health` 确认 `monitorRunning: true`。

## 本地运行

```bash
npm install
cp .env.example .env.local
# 填好 PREDICT_API_KEY
npm run dev
```

http://localhost:3000

（dev 模式不会启动后台监控；想测推送可以手动 `curl http://localhost:3000/api/cron?secret=...`）
