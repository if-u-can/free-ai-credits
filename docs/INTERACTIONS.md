# 社区反馈：Cloudflare 接收，Google Sheets 存票

访客投票 → 同域 Cloudflare Worker 校验并签名 → Google Apps Script 确认写入 Google Sheets → Worker 返回统计。**所有社区票、限流记录和复核队列都存 Google 表格；投票不写 GitHub、不修改静态 JSON，也不触发网站构建。** 页面每次从 API 读取最新票数。

社区「好蛋 / 坏蛋」是社区信号，不自动改变活动 `status`、`grade`、`quality_score` 或说明。达到阈值只进入人工复核队列。人工查证后若确有内容变化，再按最新 main 的 [EGG_GRADING.md](./EGG_GRADING.md)、[CONTENT_GUIDE.md](./CONTENT_GUIDE.md) 和原有审核发布流程更新活动事实。原投稿 API 及成熟 `runSync` 发布器保持独立。

## Google 配置

代码在 [`automation/apps-script/CommunityVotes.gs`](../automation/apps-script/CommunityVotes.gs)，放入现有 Apps Script 项目，复用已经授权的 `SPREADSHEET_ID`。无需新建表格、增加投票触发器或改动 `runSync`。

1. 在 Apps Script 编辑器添加 `CommunityVotes.gs`，复制仓库同名文件内容。
2. 项目设置 → 脚本属性，保留现有 `SPREADSHEET_ID`，增加 `INTERACTIONS_GOOGLE_SECRET`：安全随机生成的至少 32 字节独立共享密钥。只在私密设置中填写；不要写入源码、表格单元格、聊天或前端。这项与 Cloudflare 中的同名 Secret 必须完全一致。
3. 在编辑器选择并运行 `setupCommunityVotes()`，完成必要 Google 权限授权。它在现有表格安装三个独立标签，不改原发布队列：

   | 标签 | 内容 |
   |---|---|
   | 社区投票 | 每个 egg + 匿名网络身份的当前唯一票、更新时间和请求序号 |
   | 投票限流 | 持久化限流窗口、次数、请求序号及恢复日志 |
   | 社区复核 | `kind=state` 的队列状态、代次和旧坏票基线；`kind=resolution` 的人工核实记录 |

4. 部署 → 新建部署 → Web 应用：执行身份选部署者，访问范围选允许 Worker 无登录调用的「任何人」。使用正式 `/exec` 地址，不能使用仅编辑者可访问的 `/dev` 地址。若账户管理政策不允许这种访问，Worker 会看到登录页并返回不可用；不要移除 HMAC 校验来绕过配置问题。
5. 保存正式地址 `https://script.google.com/macros/s/部署ID/exec`。脚本更新后通过「管理部署」更新 Web 应用版本；只保存编辑器源码不会更新既有 `/exec` 的已部署版本。

健康检查和普通请求不会自动创建工作表。缺配置、表缺失或表头异常时返回不可用。Web 应用入口只处理签名的 `health`、`stats`、`vote`，不提供匿名管理员清队或发布接口。

## Cloudflare 配置

必须作为 **Cloudflare Worker + Static Assets** 部署；静态托管无法执行 API。现有投稿 `GITHUB_TOKEN`、投稿 Turnstile 与社区投票配置相互独立。

在现有 Worker 配置以下值，保持密钥只存在私密设置：

- `INTERACTIONS_GOOGLE_URL`：普通变量，上一节正式 Google `/exec` 地址。只允许 `https://script.google.com/macros/s/.../exec`，不能带用户名、密码、查询参数或 fragment。
- `INTERACTIONS_GOOGLE_SECRET`：Secret，与 Google 脚本属性中的同名共享密钥一致，至少 32 字节。
- `INTERACTIONS_ID_SECRET`：Secret，另一份至少 32 字节的独立随机密钥，用于匿名网络身份，不发送给 Google。
- 可选 `INTERACTIONS_TURNSTILE_SITE_KEY`：普通变量，及 `INTERACTIONS_TURNSTILE_SECRET`：Secret。两项必须同时配置；任何一项缺失都停用投票。Widget hostname 配置实际站点域名，action 为 `egg-vote`。默认不配置也有服务器身份去重与 Google 持久限流。

可用 `npx wrangler secret put INTERACTIONS_GOOGLE_SECRET`、`npx wrangler secret put INTERACTIONS_ID_SECRET` 在私密终端提示内填写。没有创建或输出密钥的仓库脚本。无需数据库绑定或迁移。

更新这些配置后重新部署 Worker。访问 `/api/interactions/config`：只有签名的 Google 健康检查成功才返回 `available:true`。随后用实际浏览器投票、改票和刷新，并在「社区投票」确认唯一记录和真实持久化。未部署或未配置时显示反馈暂不可用，不是假零票。

本地预览运行 `./scripts/preview-worker.ps1`，默认 `http://127.0.0.1:8787`。脚本把运行时持久化目录放在仓库外，避免 Wrangler 监听 `.wrangler` 文件写入造成重载循环。未连接 Google 时可以验证不可用状态；需要联调时在被 Git 忽略的 `.dev.vars` 中私密配置 Google 地址与测试 Secret。不要把本地开发服务器暴露为可伪造边缘 IP 请求头的公开计票服务。

`.assetsignore` 排除脚本、测试和私密配置；不要在公开资源根目录保存凭据、工作表导出或审核文件。

## 前端 API

所有返回为 JSON，`Cache-Control: no-store`，无跨站 CORS 授权。投票要求本站 `Origin`，拒绝 `Sec-Fetch-Site: cross-site`；请求体最多 4096 **字节**，只接受 JSON。静态目录之外的 egg ID 在 Worker 内拒绝，不能创建虚构活动。

- `GET /api/interactions/config`：`{"available":true}`；启用投票 Turnstile 时另有 `turnstileSiteKey`。Google 健康检查失败、Secret 或完整验证配置缺失时为 `{"available":false}`。
- `GET /api/interactions?ids=id1,id2`：一次 1–60 个真实目录 ID。成功 `{"available":true,"eggs":{"id1":{"good":0,"bad":0,"myVote":null,"reviewPending":false,"reviewRequestedAt":null,"lastVerified":"2026-10-09"}}}`。只在 Google 真实读取成功后展示零票。`lastVerified` 为静态 `verified_at` 与人工核实记录中较新的真实日期。
- `POST /api/interactions/vote`：`{"eggId":"真实ID","vote":"good"}`，或 `bad`；启用验证时带 `turnstileToken`。成功 `{"available":true,"egg":{"id":"真实ID","good":1,"bad":0,"myVote":"good","reviewPending":false,"reviewRequestedAt":null,"lastVerified":"2026-10-09"}}`。Worker 必须收到 Google 对该 egg 和该票选的成功确认才响应成功。
- 失败 `{"available":false,"code":"错误码","message":"说明"}`。Google 故障、超时、登录页面、非 JSON 或错误的数据结构都为 `503 unavailable`；缺可信网络身份为 `503 identity_unavailable`。另有 `400 invalid_ids/invalid_vote/challenge_required`、`403 invalid_origin/challenge_failed`、`405 method_not_allowed`、`413 payload_too_large`、`415 unsupported_media_type`、`429 rate_limited`、`503 busy`。限流和脚本锁繁忙响应带秒数 `Retry-After`。

Worker 的 Google 请求超时为 12 秒；失败不代表 Google 一定没有写入。访客刷新或重试会读取、恢复既有唯一票，不会把同一网络的同一 egg 计作第二票。

## 私密转发协议和防刷

Worker 使用共享密钥对下列 `payload` **原始 UTF-8 字符串**计算 HMAC-SHA256，签名为标准 Base64；只向配置的 Google Web 应用 POST `{"payload":"JSON字符串","signature":"Base64签名"}`。不把共享密钥放入 URL。

```json
{
  "version": 1,
  "action": "vote",
  "timestamp": 1791513600000,
  "requestId": "服务器生成的UUID",
  "voterHash": "64位匿名网络HMAC十六进制",
  "ids": ["真实ID"],
  "dates": {"真实ID": "2026-10-09"},
  "eggId": "真实ID",
  "vote": "good"
}
```

`health` 使用空 `ids`、空 `dates`、`voterHash:null`；`stats` 使用 requested IDs 和日期。日期未知时为 `null`。Google 校验签名、120 秒时间窗口和输入，再在短 ScriptLock 下操作表格。健康检查也要签名。Google Content Service 的正常内容重定向会跟随，最终必须是有效 JSON；登录重定向不能作为计票成功。

匿名身份只来自 Cloudflare 边缘写入的 `CF-Connecting-IP`，经独立身份 Secret 的 HMAC-SHA256 后发送给 Google。表格不保存原始 IP、客户端 UUID 或 Cookie；不信任 `X-Forwarded-For`。同一公网 IP 对每个 egg 一票，可改好/坏，重复同票不增加计数；清浏览器存储不会增票。共享公网 IP 的访客共用一票，更换公网 IP 会改变身份。面对代理池可启用 Turnstile 和 Cloudflare 入口限流；Turnstile 开启时必须服务端验证成功、hostname 和 `egg-vote` action。

Google 持久限流每个匿名网络每固定 60 秒最多 20 次投票请求，重复票和改票也计入。同一个签名 `requestId` 重放不会重复扣限流；同 ID 不同 payload 被拒绝。请求日志先持久化，再按序恢复唯一 ballot 与复核状态，避免部分写入后重试丢票或重复票；较旧重放不会覆盖后来的改票。成功返回前执行 `SpreadsheetApp.flush()`。Google Sheets 没有数据库事务，写入故障依靠日志重放恢复，不将部分成功伪装为完整成功。

**保持身份 Secret 稳定**：直接轮换会生成新匿名身份，旧票仍在；轮换必须安排旧匿名票处理。匿名票与工作表日志保留在 Google 表格中，由管理员按实际站点数据政策维护，不同步到 GitHub。

社区接口与现有 `runSync` 和投稿审核镜像 `runIssueMirror` 共用同一个 Apps Script 项目的 ScriptLock。发布器或镜像持锁较久时，健康检查、投票和读取可能暂时返回 `503 busy`（配置 API 显示不可用），稍后重试即可。这里没有修改成熟发布器或镜像的锁策略；Google 执行限额和表格读写延迟仍是实际运行边界。

## 人工复核

触发条件为至少 3 张本复核代次的新增坏票，且全量坏票比例至少 60%。首次触发记录时间；之后改票不会自动清队，须人工核查。

1. 在 Apps Script 编辑器运行 `listCommunityReviews()`，获得待复核 egg ID、generation 和请求日期；也可在「社区复核」筛选 `kind=state`、`review_pending=true`。
2. 逐项读取最新 main 分级和内容规则，实查官方活动条款、领取入口、资格及 API 可用范围。票多本身不能证明活动失效；有证据的内容变化才走原发布器。社区计票函数永远不调用发布器或 GitHub。
3. 在私密的脚本属性 `COMMUNITY_REVIEW_RESOLUTION` 中保存以下 JSON，使用真实 ID、当前 generation、独立 resolutionId、核实日期、官方 HTTPS 证据和实际结论：

   ```json
   {
     "resolutionId": "2026-10-09-reviewed-unique-id",
     "eggId": "真实ID",
     "expectedGeneration": 0,
     "outcome": "confirmed",
     "evidenceUrl": "https://官方证据页面",
     "notes": "已阅读最新版规则；这里写真实查验的资格、入口和结论。",
     "verifiedAt": "2026-10-09"
   }
   ```

4. 在编辑器运行 `resolveCommunityReview()`。只允许拥有该 Apps Script 编辑/执行权限的管理员操作。`outcome` 为 `confirmed`、`corrected` 或 `unverifiable`；有日期、证据及结论要求。公开 `doPost` 不接受清队动作。

审核先保存 resolution 日志，再清队、更新核验日期、递增 generation 并记录旧坏票身份基线。重试同一 resolutionId 与内容是幂等操作；不同内容复用 ID、过时 generation 不能清掉新一轮复核。不要手工直接改队列状态、删除坏票或伪造核验日期。

总票数保留。清队时已经投坏的身份，无论重复提交还是改好后再改坏，都不能作为本轮新增坏票立即重入；仍需 3 个此前不在坏票基线中的网络身份新增坏票，并再次满足总比例阈值，才重新入队。人工日志保存在同一「社区复核」标签的 `kind=resolution` 行。

## 验证和官方依据

`node --test tests/backend-interactions.test.mjs` 验证 Cloudflare 实际接口、签名 payload、匿名身份、同源/输入限制、Google 错误与超时、健康检查、返回数据校验及可选 Turnstile。`node --test tests/backend-google-integration.test.mjs` 贯通 Worker 签名到实际 Apps Script `doPost`、唯一票、改票和复核；`node --test tests/google-community-votes.test.cjs` 验证真实 Apps Script 源码通过可持久化 Sheets 测试适配器的重放、限流和故障恢复行为。它们是本地证据，不代表 Google Web 应用或 Worker 已部署；正式配置仍需浏览器和实际表格联调。

部署与权限依据：[Google Web 应用](https://developers.google.com/apps-script/guides/web)；JSON 与重定向依据：[Content Service](https://developers.google.com/apps-script/guides/content)；并发锁依据：[LockService](https://developers.google.com/apps-script/reference/lock/lock-service)；签名依据：[Utilities HMAC](https://developers.google.com/apps-script/reference/utilities/utilities#computehmacsha256signaturevalue-key)；人机验证依据：[Cloudflare Turnstile 服务端校验](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)。核对日期：2026-10-09。
