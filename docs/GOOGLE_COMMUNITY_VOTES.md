# Google 表中的社区投票

访客只请求本站同域 Cloudflare API。Cloudflare 验证来源、真实目录 ID、匿名网络身份和可选 Turnstile，再向 Google Apps Script 发签名请求。投票保存在既有 `SPREADSHEET_ID` 对应的 Google 表，统计由 Cloudflare 实时代理查询。

**投票不会写入 GitHub、不会进入「待发布队列」、不会调用 `runSync`、不会触发网站构建。** `CommunityVotes.gs` 与已有内容发布器共用项目和表，但使用三个独立工作表。只有人工核查发现活动事实需更正时，维护者才另行通过既有内容审核流程发布。

## 安装到现有 Google 项目

1. 在已连接正式表的 Apps Script 项目新增 `CommunityVotes.gs`，粘贴仓库 `automation/apps-script/CommunityVotes.gs`。保留原 `Core.js`、`GitHub.js`、`Code.js`、manifest 和定时触发器。若项目已有 `doPost`，先合并入口，不能保留两个同名函数覆盖彼此；本仓库原发布器没有 `doPost`。
2. 复用现有 Script Property `SPREADSHEET_ID`。添加 `INTERACTIONS_GOOGLE_SECRET`，使用独立、安全随机且至少 32 字符的共享密钥；同一个值只放在 Apps Script Script Properties 和 Cloudflare Secret。不要放进单元格、源码、浏览器或聊天。不要复用 GitHub token 或匿名身份密钥。
3. 由表格所有者在 Apps Script 编辑器运行 `setupCommunityVotes()`，完成 Google 授权。函数只显式创建下面三个工作表，写入固定表头，已存在的匹配表不清空；表头不匹配会失败。健康检查和统计请求不会偷偷建表。
4. 检查工作表和权限，保护表头、票、限流日志和复核状态列，避免排序单列或直接编辑计票行。保留现有表中其他工作表。日期统一使用北京时间，已有 manifest 的时区为 `Asia/Shanghai`；脚本会将 Google 返回的 Date 对象转换为接口要求的日期/ISO 字符串。
5. 新建或更新 **Web app** 部署：Execute as 选择表格所有者，Who has access 选择 **Anyone**，使 Cloudflare 服务端无需 Google 登录即可请求 `/exec`。实际读写仍必须通过签名校验。组织策略不允许匿名 Web App 时，此方式不能直接启用；不能把登录页当作成功 JSON。使用正式 `/exec` 地址，不能用编辑者专用 `/dev` 地址。修改源码后更新部署版本。
6. Cloudflare 设置 `INTERACTIONS_GOOGLE_URL` 为该 `/exec` 地址，Secret `INTERACTIONS_GOOGLE_SECRET` 为同一共享密钥，另按 [互动配置](./INTERACTIONS.md) 设置稳定的匿名身份 Secret 和可选 Turnstile。这些新属性与原投稿 API 配置独立。
7. 先完成下面的真实验收再宣称上线。本地模拟测试不能证明当前 Google 账户授权、部署版本、访问级别、Google 配额或 Cloudflare 配置已经就绪。

部署执行身份和 `/exec`、`/dev` 的差异依据 [Google Web Apps 文档](https://developers.google.com/apps-script/guides/web)。[Content Service 文档](https://developers.google.com/apps-script/guides/content)说明响应会重定向到 Google 的内容域名，Cloudflare 服务端必须跟随该重定向。[Range.getValues 文档](https://developers.google.com/apps-script/reference/spreadsheet/range#getValues())说明单元格可能返回 Date，脚本在输出前显式归一化。核对日期为 2026-10-09。

## 三个工作表

`社区投票` 每个 `(egg_id,voter_hash)` 只有一行，列为：

```text
egg_id,voter_hash,vote,generation,updated_at,request_sequence,baseline_generation
```

`投票限流` 每个匿名网络一行，列为：

```text
voter_hash,window_start,hits,sequence,journal_json,updated_at
```

`社区复核` 同表容纳 `kind=state` 的队列状态和 `kind=resolution` 的人工核查日志，列为：

```text
egg_id,kind,generation,review_pending,review_requested_at,last_verified,resolution_id,outcome,evidence_url,notes,verified_at,resolved_at,baseline_generation
```

没有原始 IP、浏览器 UUID、API Key 或 GitHub token。`voter_hash` 为 Cloudflare 根据可信边缘网络地址产生的 HMAC。共享公网 IP 共用一票；改变公网 IP 会改变身份。保持身份 Secret 稳定，轮换需要安排旧票处理，不能通过换密钥制造第二张票。

## 协议和计票

Cloudflare POST JSON `{payload,signature}`。`payload` 为 JSON 字符串，`signature` 是用共享 Secret 对该 UTF-8 字符串计算的 HMAC-SHA256，编码为 Base64。payload 包含 `version:1`、`action:health|stats|vote`、毫秒 `timestamp`、稳定请求标识 `requestId`、`voterHash`、`ids`、`dates`，投票另有 `eggId/vote`。Google 拒绝无效签名、超过正负 120 秒的时间、无效字段及任何其他 action。公开协议没有审核、清队或内容发布动作。

Google ContentService 返回 JSON；Apps Script 不能在此输出中设置业务 HTTP 状态，所以错误对象包含 `available:false/code/status/message/retryAfter?`，Cloudflare 将其转换为本站 HTTP 响应。Google 登录 HTML、错误页面、超时或不符合协议的内容都不能转换成零票成功。

票数始终从持久票记录聚合。重复同票不增票；改票替换原选择。每个匿名网络每个固定 60 秒窗口最多 20 次新投票请求，重复同票及改票也计入；同一 `requestId`、同一负载的协议重放不重复计入额度。超限返回 429；重用请求标识却改变负载会拒绝。

Google Sheets 的多次写入**不是数据库事务**。短 Script Lock 防止并发修改同一票；限流行先持久记录已接受请求及递增 sequence，再应用票和复核状态。票写入后复核写入失败，调用返回失败；下一次原请求重试、统计或其他投票会重放未完成日志并修复复核队列。旧 sequence 不覆盖较新的选择。成功及失败退出均在锁内执行 `SpreadsheetApp.flush()`，再释放锁；对账与刷入成功后才返回成功。请求日志只在已重放后裁剪时间窗口，不能手工清掉尚未恢复的日志。

原发布器 `runSync` 及投稿审核镜像 `runIssueMirror` 仍可能持有同一个项目的 Script Lock 最多约 180 秒。新接口只等待锁 1 秒，冲突时返回 `busy` 503 和短重试提示；页面保留真实失败反馈。这是复用当前项目的已知限制，未更改原发布器或镜像的锁及停止语义。接口需扫描票/限流/复核工作表，适合小规模社区；流量增长后要以实际执行时长和 Google 配额评估容量，不能把表格当无限并发数据库。

## 人工复核

至少三张本代次新增坏票、且全部坏票占比至少 60% 才入队。入队之后即使改票也不自动清队。Google 表中的坏票不代表官方宣布失效，不会自动改 `status`、`grade` 或 `quality_score`。

管理员运行 `listCommunityReviews()` 查看真实待复核名单、代次和最近核查日期。逐项重新读取 GitHub main 最新 [EGG_GRADING.md](./EGG_GRADING.md) 与 [CONTENT_GUIDE.md](./CONTENT_GUIDE.md)，查官方条款、申请入口、个人资格、API 适用范围和支付门槛，记录真实证据。需要纠正活动事实时，单独走现有审核发布流程。

完成核查后，设置私有 Script Property `COMMUNITY_REVIEW_RESOLUTION` 为以下 JSON，把示例替换为真实 ID、当前 generation、官方来源、实际日期和核查结论：

```json
{
  "resolutionId": "review-真实活动-实际日期-v1",
  "eggId": "真实egg-id",
  "expectedGeneration": 0,
  "outcome": "confirmed",
  "evidenceUrl": "https://官方当前活动说明",
  "notes": "已重新读取最新规则并实际核查，写清资格、API适用范围和核查结果。",
  "verifiedAt": "2026-10-09"
}
```

运行 `resolveCommunityReview()`，也可从管理员自有脚本传入同样对象。`outcome` 只能是 `confirmed`、`corrected`、`unverifiable`。已有待复核项与 `expectedGeneration` 必须吻合；过时的核查不能清掉新一代队列。函数先写证据日志，再批量写入每张旧坏票的 `baseline_generation` 并刷入，最后清队并增加 generation，写入中断时由下一次统计/重试恢复；同 resolutionId 同证据幂等，改证据必须使用新 ID。每张票只有一个基线代次数字，不把大量身份挤进单个单元格。成功后可删除该输入属性，审核日志仍保留在 `社区复核`。

清队保留全部票，记录当时坏票匿名身份为 baseline。旧坏票重复、或旧坏票改好再改坏都不计作新坏票；需要至少三个此前好票改坏或新匿名网络坏票，且仍满足总体占比，才能再次入队。`lastVerified` 取静态数据核查日期和真实人工核查日期中较新的日期，不表示活动已经确认有效。

## 验收和故障

本地执行 `node --test tests/google-community-votes.test.cjs`。测试真实运行 `.gs` 代码，使用持久模拟 Sheet 服务及签名，不调用线上 Google。覆盖签名/时间/锁、改票和重放、持久限流、部分写入与 flush 失败恢复、占比阈值、人工日志与过时代次、750 张坏票清队、每票 baseline、Google 缓存写入顺序及 Date 单元格。

真实验收需确认：CF 健康检查读到已部署 Google 项目；实际好/坏票及改票在 `社区投票` 保持单行；刷新返回相同统计；复核阈值只写社区复核表；投票前后 GitHub main SHA 与原待发布队列不因投票变化；模拟不可用后页面显示“—”并可重试；完成一次有证据的人工清队并核对日志。保留真实部署版本和非敏感验收结果。

访客能访问本站 Cloudflare 时不需要直连 Google；Cloudflare 到 Google 是服务器端的另一段连接。启用 Turnstile 后浏览器仍需访问 `challenges.cloudflare.com`，须在目标网络实测。Cloudflare、Google 上游或验证服务失败时不能保证提交成功；页面应据实际响应提示重试。
