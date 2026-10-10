# 站内投稿验收记录（2026-10-10）

正式访客投稿、关闭后重复投稿、原生定时镜像、重复运行和人工审核字段保留已有真实证据。本记录区分真实外部结果、模拟检查及历史故障；最终文档提交后的部署回读在交付说明中提供。

## 已完成的实现与验证

- 本轮基于最新 main `2b61768be384e4ec9abc12c84f4c04ff67229f91`。相比此前 `cfc31e8`，新增数据、首页、SEO 和图片变更；投稿接口、投稿页面、审核镜像及相关测试源码未变化。保留其他任务的代码、数据、资产和 Apps Script 文件。
- 修复提交：`0143dc9951768571cb38bc9f71ecda3606ac2da5`；安全错误诊断：`66321bd66fa5bddf185aa2e8d6ffa1f39cb2d416`；Cloudflare 重定向修复：`732ec3f4cbdd7a94a1a205af8706579a62f766c9`，均已推送 GitHub main。
- 本轮完整 82 / 82 项检查通过：Worker 31、投稿页面 12、审核镜像 14、原发布器 25。覆盖超时、验证、限速、重复投稿、异常响应、审核备注保留、分页重扫与重定向凭据保护。这些模拟检查不冒充正式环境故障注入。
- Cloudflare CLI 在配置验收时确认生产流量 100% 使用版本 `e38f1558-7a11-41a3-80ed-e3b4f811fc90`，创建时间 `2026-10-09T21:02:39.471Z`。本次文档整合后如产生新部署，以实际回读更新，不预填新提交或版本。
- `2b61768` 的 **Workers Builds: free-ai-credits** check-run 为 `completed / success`，完成时间 `2026-10-09T21:02:44Z`，与 CLI 的上述生产版本对应。另一个 SEO prerender 检查已有失败，属于新 SEO 任务，未在本投稿任务中修改；不能据此记录全部 GitHub checks 为绿。
- 历史 GitHub **Workers Builds: free-ai-credits** 检查确认 `732ec3f` 成功，版本 `aae632c8-f2ac-4f0d-a95e-7095aa5476e8`；此前 `66321bd` 正式部署也已由 Cloudflare 管理工具确认。未使用 Vercel 状态作上线证据。
- Wrangler 4.149 dry-run 成功；识别静态资产和 5 次 / 60 秒原生限速绑定。
- 正式域名首页、`/submit.html` 返回 200，Server 为 Cloudflare；首页两处入口指向 `./submit.html`，页面包含公开投稿提示、新验证 action 和重复回执逻辑。
- 正式读取接口拒绝非法页码：`/api/submissions/review-feed?page=0` 返回 400。
- 正式读取接口返回 200：测试 Issue #1 先为 open；关闭后带 since 检查点再读，返回 closed、更新时间 `2026-10-09T05:31:21Z`、`has_more:false`。此为真实 GitHub → Cloudflare 读取结果。
- `/src/worker.js`、`/automation/apps-script/SubmissionMirror.js`、`/wrangler.jsonc`、`/.env`、`/tests/submission-worker.test.mjs` 返回 404。
- 本次投稿验收不向数据文件或原内容发布队列写入测试内容，不标记 `active`；其他任务的数据变更另行保留。

## 已完成的生产配置

- `GITHUB_TOKEN` 已存 Cloudflare Secret，fine-grained PAT 仅限 `if-u-can/free-ai-credits`，权限只有 Issues 读写和自动 Metadata 只读，没有 Contents 权限。到期日为 **2026-11-08**，到期前须续换 Cloudflare Secret 并复验读取和投稿。
- `TURNSTILE_SECRET` 已存 Cloudflare Secret；同一 widget 的公开 `TURNSTILE_SITE_KEY` 存于生产后台普通变量，由 `keep_vars:true` 保留。
- Turnstile 为正式 Managed widget，仅允许 `freeegg.iffy.site`，未启用 pre-clearance；前后端使用并验证 `action=submission`。
- `/api/submissions/config` 真实回读 `enabled:true` 且公开 siteKey 存在。连续三次正式 review-feed 请求均返回 200、两个站内测试 Issue（#1、#3）和 `has_more:false`；其他 Issue 不进入投稿审核页。
- 凭据未进入源码、聊天、报告或表格；公开文档不包含私有表格、脚本或账号标识。Apps Script 不存储或读取投稿 GitHub Token，继续使用原 `SPREADSHEET_ID`。

## 复用的 Google 工作流

已查找并复用原私有「免费鸡蛋篮｜正式自动发布队列」。同一文件增加「投稿审核」页，表头已回读确认。保留原「待发布队列」「发布日志」「配置说明」及发布器。

独立 `SubmissionMirror.gs` 已保存至原 Apps Script 项目；从编辑器回读的源码与仓库文件一致。其他任务增加的 Apps Script 文件未修改。镜像不读取投稿 GitHub Token，只使用现有 SPREADSHEET_ID。2026-10-09 曾手动镜像 #1，`mirrored_at=2026-10-09T08:46:01.313Z`；当时只有表头和浏览器面板阻塞的状态已解决。

2026-10-10 实际运行证据（界面时间为 Asia/Shanghai，ISO 时间为 UTC）：

- `installIssueMirrorTrigger` 在 12:09:15 完成，耗时 2.64 秒；触发器页确认 `runIssueMirror` 五分钟任务与原 `runSync` 同时保留。
- 原生时间驱动 `runIssueMirror` 在 12:12:46 完成，耗时 4.419 秒；原 `runSync` 仍成功运行。
- #3 首轮入表由原生触发器完成，没有手动首轮写入。第三行回读为 #3、`closed`、`PENDING`，`mirrored_at=2026-10-10T04:12:49.803Z`。
- 人工将 H3 改为 `REJECTED`，I3 设为「端到端测试，非活动，请勿收录；人工备注保留验收。」；随后更新 #3 正文审计，源 `updated_at=2026-10-10T04:14:09Z`。
- 手动 `runIssueMirror` 的执行日志为 12:15:56 → 12:15:58 完成；重复运行日志为 12:16:13 → 12:16:15 完成。
- 复跑后再次回读 A1:J6，仍恰好两条数据（#1、#3）。#3 的源更新时间为 `2026-10-10T04:14:09Z`，状态为 `closed` / `REJECTED`，人工备注逐字保留，正文新审计备注已同步，`mirrored_at=2026-10-10T04:15:01.452Z`；没有增加重复行。
- 仅对审核页现有两行调整排版：A2:J3 垂直 TOP / CLIP、I2:I3 WRAP、行高 100；数据未变化。网页和表格原生截图已检查。

本次仅向投稿审核页写入测试镜像和审核备注，没有向原发布队列或 `data/eggs.json` 写入测试内容，没有标记 `active`。关闭 Issue 不代表审核通过；人工审核状态也不触发发布。

Google 直接公开读取 GitHub 的真实诊断返回 HTTP 403、额度剩余 0。因此改为读取同站 Worker 的公开投稿接口。镜像网络失败保留检查点，下一轮重试；人工审核状态 / 备注不会被同步覆盖。

## 实际测试 Issue

2026-10-10 在 Chrome 正式 `/submit.html` 页面完成真实 Turnstile 验证，站内 POST 创建 [测试 Issue #3](https://github.com/if-u-can/free-ai-credits/issues/3)，创建时间 `2026-10-10T04:10:31Z`。这是访客页面 → Worker → GitHub 创建接口的真实证据。

#3 已以 `not_planned` 关闭，关闭时间 `2026-10-10T04:12:45Z`。关闭后使用相同 URL 加 `#repeat` 片段，在正式页面重新验证并投稿；页面返回已有 #3，没有创建新 Issue。此结果验证移除 fragment 的 URL 去重及所有状态查询。#1、#3 均为非活动测试，不得收录或评级。

[Issue #1：链路测试，请勿收录](https://github.com/if-u-can/free-ai-credits/issues/1) 通过已连接 GitHub 工具真实创建；已以 not_planned 关闭并保留审计。正文明确它是非活动测试，不得收录。它**没有经过访客页面或 Worker 创建接口**，不得当作访客端到端成功证据。

## 已解决的历史故障

未完成配置时，config 曾返回 `enabled:false, siteKey:null`，投稿 POST 返回 503，Cloudflare Secret 名称列表为空。生产三项配置现已完成，启用状态及正式投稿证据见上文。步骤见 [配置说明](SUBMISSION_SETUP.md)；凭据只通过 Cloudflare Secret 配置保存，不进入聊天或表格。

审核读取接口曾返回 502、`code:UPSTREAM_REQUEST`。在不带任何凭据的真实 Cloudflare 预览环境复现：`redirect:"error"` 触发 TypeError（边缘运行环境仅支持 follow / manual），GitHub 请求没有发出。直接请求同一个公开 GitHub API 返回 200、额度剩余 57；因此这次 Worker 失败不是 Google 的公共请求配额问题。修复为 `redirect:"manual"`，既不跟随重定向，也不把授权头转发到其他目标；3xx 作为上游失败处理。

正式匿名读取曾同时出现 200 和上游 HTTP 403（接口安全返回 503）；现已用配置后的认证读取连续三次 200 复验。此前六次连续正式读取未观测到 429，不作为严格限速证明。

## 真实拒绝与限速边界

正式投稿接口完成三项真实负面检查，响应只返回安全 message，均未创建 Issue：

| 请求 | HTTP 状态 |
|---|---|
| 外站 Origin 的 POST | 403 |
| JSON `{}` 缺少必填字段 | 400 |
| 格式错误的 JSON | 400 |

另在真实 Cloudflare NRT 预览环境使用与正式配置相同的原生限速绑定（namespace 1791529201、5 / 60 秒），单次调用中对同一个独立测试 key 连续计数八次，结果为前六次允许、后两次拒绝。确认绑定实际可拒绝超额调用，也证实它是每 Cloudflare 地点的近似计数，不是严格全球五次额度。此探测未访问 GitHub / Issue / 凭据，临时预览已停止；模拟另覆盖 429 和 Retry-After 响应。

同一 Worker 实例合并相同 URL 的并发请求；GitHub 查询和创建不是跨实例原子事务，极端跨实例并发仍可能重复。实际关闭后重投没有增加 Issue，不等于跨实例并发去重已获真实原子性验证。超时、上游异常、持久化失败与重试的模拟证据仍归于上述 82 项检查，不称为本轮正式环境故障注入。

最终文档提交后的实际部署回读在交付说明中提供，不预填新提交或版本。PAT 到期前续换并复验，不改变最小 Issues 权限。
