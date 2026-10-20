# Predict.fun 否转换 · Yes 总和看板 + Telegram 机器人

盯 predict.fun 上的多结果（NegRisk）类目：所有结果的 **Yes 买1 加起来超过 100¢** 时，买「否」→ 转换成其余结果的「是」→ 按买1 卖出，每份赚 `Σ Yes买1 − 100`（未扣手续费）。附带 Predict 独有市场（没有 Polymarket 映射、在派 PP）的 PP/h 列表和新市场提醒。

## 页面

- `/` 看板：可转换类目的 Σ Yes 买1（提醒阈值 / 显示下限、单类目链接查询、每行重新查）、Predict 独有 PP/h 按 event 分组、市场缓存完整性与后台任务状态；每 60 秒自动刷新。旧链接 `/dashboard` 自动转到 `/`。
- `/predict-only` Predict 独有市场 + PP/h：过滤出 `polymarketConditionIds` 为空的市场，按 PP/h 排序。

## API

- `GET /api/negrisk?min=95&limit=50` — 上次扫描结果，按显示下限筛选；`?scan=1` 立即扫一次（与后台扫描互斥，进行中返回 409；手动扫描结果写入「上次扫描」，不推送）；`?slug=<链接或slug>` 查单个类目。
- `GET /api/predict-only?hasActiveRewards=1&minHourlyRate=N&debug=1` — predict 独有市场（`complete` 表示抓取是否翻到底，`filterStats` 是筛选漏斗各步计数）
- `GET /api/predict-cache` / `?refresh=1` — 市场缓存状态 / 触发重抓
- `GET /api/health` — 健康检查：版本、后台定时器、bot 状态
- `GET /api/test-telegram?secret=...` — 测试 Telegram 推送通道

## 可转换(NegRisk)市场：Yes 买1 总和

多结果类目（比如"哪个赛区夺冠"）里，1 份某结果的「否」可以转换成其余每个结果各 1 份「是」。所以当类目里所有结果的 Yes 买1 价之和 > 100¢ 时：买 否 → 转换 → 按买1 价卖出其余 Yes。

- 发链接（或 `/yes <链接>`）：查该类目每个结果的 Yes 买1/卖1、总和，以及"持否转换后可卖 vs 直接卖否"（转换后可卖 = Σ − 该结果买1，直接卖否 = 100 − 该结果卖1）。
- `/yes_check [下限|all]`：扫描缓存里全部可转换类目，列出总和 ≥ 下限的（低于提醒阈值的也显示，✅ 标出达标的）。不带参数用 `/yes_show` 设的默认下限（默认 95¢）。
- 后台每 `NEGRISK_CHECK_INTERVAL_MS`（默认 5 分钟）扫一遍，总和 ≥ 阈值的类目推送到 `/subscribe_yes` 订阅的话题（没订阅就发 `TELEGRAM_CHAT_ID` + `TELEGRAM_THREAD_ID`）；消息末尾附带"接近阈值"的类目（显示下限 ≤ 总和 < 提醒阈值，最多 5 个）。手动扫描期间恰好到点的后台扫描会跳过该轮。
- 阈值默认 100¢，`/yes_threshold 101` 随时改（持久化到 `NEGRISK_STATE_FILE`）；`/yes_off` `/yes_on` 开关。
- 是否可转换按接口的 `isNegRisk` / `negRiskOnChainId` 判断；接口没给这些字段时退化为"≥3 个结果的类目"。

## 市场抓取与筛选

数据来自 `/v1/categories`（市场嵌在 category 里），抓取规则：

- 默认带 `status=OPEN` 让服务端过滤掉已结算类目（`PREDICT_CATEGORY_STATUS`，设 `none` 全量抓）；接口拒绝该参数或返回空时自动退回全量。
- 单页 429/5xx/超时 会指数退避重试（`PREDICT_FETCH_RETRIES`，默认 4 次）。
- 翻页到 `PREDICT_CACHE_MAX_PAGES`（默认 500）或中途报错时标记为「不完整」，看板、bot 列表头部和 `/status` 会提示；不完整且比上一份缓存少很多时不覆盖旧缓存。

筛选口径（bot `/predict_only`、订阅推送、`/api/predict-only`、看板共用 `selectEligibleMarkets`）：
`polymarketConditionIds` 为空 → 去噪音关键词 → 可交易（市场/交易状态未关闭、所属类目未 RESOLVED、未到期、`closed`/`active` 标记）→ PP/h > 0。

## Telegram 机器人

long polling，`ENABLE_TG_BOT=0` 关闭。主要命令：`/menu` `/yes <链接>` `/yes_check` `/yes_show` `/yes_threshold` `/yes_on` `/yes_off` `/subscribe_yes` `/predict_only` `/subscribe` `/subscribe_all` `/unsubscribe` `/refresh` `/status` `/help`。话题群里在目标话题发订阅命令，提醒就发到那个话题。

## 后台任务

Railway 是长进程容器，`instrumentation.ts` 在生产启动时拉起：市场缓存每 `PREDICT_CACHE_TTL_MS`（默认 10 分钟）重抓一次并触发新市场提醒；可转换类目扫描每 5 分钟一次。仅在 `NODE_ENV=production` 启用，`npm run dev` 不会跑后台。

## Railway 部署

1. 把仓库连到 Railway，新建 service 选 GitHub 仓库。
2. Railway 会自动用 Nixpacks 检测到 Next.js，按 `railway.json` 跑 `npm ci && npm run build` → `npm run start`。
3. Settings → Variables 配：
   - `PREDICT_API_KEY` 必填
   - `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` 想要提醒就配
   - `SUBSCRIBERS_FILE` / `NEGRISK_STATE_FILE` 挂 Volume 后指到持久目录，订阅和阈值才不会随重新部署丢失
   - 其余可选项见 `.env.example`
4. Settings → Networking → Generate Domain，拿到公开域名。
5. 打开 `https://<your-app>.up.railway.app/api/health` 确认 `version` 是当前版本、`cacheTimerActive` / `negriskTimerActive` / `botPolling` 为 true。

## 本地运行

```bash
npm install
cp .env.example .env.local
# 填好 PREDICT_API_KEY
npm run dev
```

http://localhost:3000 （dev 模式不启动后台任务，看板上用「重新抓取市场缓存」和「立即重扫」手动填充）
