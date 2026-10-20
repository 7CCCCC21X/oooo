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
- `GET /api/predict-only?hasActiveRewards=1&minHourlyRate=N&debug=1` — predict 独有市场（响应里 `complete` 表示抓取是否翻到底，`filterStats` 是筛选漏斗各步计数）

## 市场抓取与筛选

数据来自 `/v1/categories`（市场嵌在 category 里），抓取规则：

- 默认带 `status=OPEN` 让服务端过滤掉已结算类目（`PREDICT_CATEGORY_STATUS`，设 `none` 全量抓）；接口拒绝该参数或返回空时自动退回全量。
- 单页 429/5xx/超时 会指数退避重试（`PREDICT_FETCH_RETRIES`，默认 4 次），不再一次失败就截断整个列表。
- 翻页到 `PREDICT_CACHE_MAX_PAGES`（默认 500）或中途报错时标记为「不完整」，bot 列表头部和 `/status` 会提示；不完整且比上一份缓存少很多时不覆盖旧缓存。

筛选口径（bot `/predict_only`、订阅推送、`/api/predict-only` 共用 `selectEligibleMarkets`）：
`polymarketConditionIds` 为空 → 去噪音关键词 → 可交易（市场/交易状态未关闭、所属类目未 RESOLVED、未到期、`closed`/`active` 标记）→ PP/h > 0。
- `GET /api/health` — 健康检查 + 监控状态

## 可转换(NegRisk)市场：Yes 买1 总和

多结果类目（比如"哪个赛区夺冠"）里，1 份某结果的「否」可以转换成其余每个结果各 1 份「是」。所以当类目里**所有结果的 Yes 买1 价之和 > 100¢** 时：买 否 → 转换 → 按买1 价卖出其余 Yes，每份赚 `Σ Yes买1 − 100`（未扣手续费）。

- 发链接（或 `/yes <链接>`）：查该类目每个结果的 Yes 买1/卖1、总和，以及"持否转换后可卖 vs 直接卖否"。
- `/yes_check [下限|all]`：扫描缓存里全部可转换类目，列出总和 ≥ 下限的（低于提醒阈值的也显示，✅ 标出达标的）。不带参数用 `/yes_show` 设的默认下限（默认 95¢）。
- 提醒消息末尾附带"接近阈值"的类目（显示下限 ≤ 总和 < 提醒阈值，最多 5 个）。
- `GET /api/negrisk?min=95` 读上次扫描结果（`scan=1` 立即扫一次）；`GET /api/negrisk?slug=<链接或slug>` 查单个类目。
- 后台每 `NEGRISK_CHECK_INTERVAL_MS`（默认 5 分钟）扫一遍，总和 ≥ 阈值的类目推送到 `/subscribe_yes` 订阅的话题（没订阅就发 `TELEGRAM_CHAT_ID`）。
- 阈值默认 100¢，`/yes_threshold 101` 随时改（持久化到 `NEGRISK_STATE_FILE`）；`/yes_off` `/yes_on` 开关。
- 是否可转换按接口的 `isNegRisk` / `negRiskOnChainId` 判断；接口没给这些字段时退化为"≥3 个结果的类目"。

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
