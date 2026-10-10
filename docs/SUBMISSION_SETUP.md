# 网站投稿 → GitHub Issues → 私有审核表

访客在 `/submit.html` 填表，同域 Worker 接收 `POST /api/submissions`，创建待审核 `[投稿]` Issue，无需 GitHub 登录，提交后仍留在本站。仓库公开，投稿内容也公开；页面提醒不要填写个人信息或凭据。无需 D1，不自动收录或评级。

## Cloudflare 运行时配置

Workers 和 Pages → **free-ai-credits** → 设置 → **运行时变量和密钥 / 生产**（不是构建变量）：

| 名称 | 类型 | 值的来源 |
|---|---|---|
| `GITHUB_TOKEN` | **Secret** | Fine-grained PAT，仅选 `if-u-can/free-ai-credits`，仅 **Issues: Read and write**；保留自动 Metadata 只读，不加 Contents |
| `TURNSTILE_SECRET` | **Secret** | Turnstile widget 的 Secret Key |
| `TURNSTILE_SITE_KEY` | 普通变量 | 同一 widget 的公开 Site Key |

Turnstile 使用 Managed widget，允许 hostname `freeegg.iffy.site`。前端使用 `action=submission`，服务端同时验证 action、hostname 和成功状态。不要使用测试密钥作为正式配置。两份 Secret 只存 Cloudflare Secret，不放前端、GitHub、表格、Apps Script 属性、报告或聊天。原内容发布器的 Contents token 是另一用途，不能拿来做投稿。

保存后按 Cloudflare 界面提示部署。Builds 继续使用根目录 `/`、生产分支 `main`、`npx wrangler deploy`。`wrangler.jsonc` 的 `keep_vars:true` 保留后台普通 Site Key 变量；包含静态资产、`/api/*` 优先路由及原生 `SUBMISSION_RATE_LIMITER`（namespace `1791529201`，5 次 / 60 秒），部署自动配置，无需数据库。

访问 `https://freeegg.iffy.site/api/submissions/config`，须有 `enabled:true` 和公开 siteKey。`enabled:false` 只表示未配齐，不能称投稿成功。

## 防刷、错误与重复投稿

- 同源、精确 JSON 类型、8192 **字节**流式上限、字段校验、诱饵字段与服务端 Turnstile 验证。
- 原生限速按连接 IP 计数；超额返回 429、`Retry-After: 60`，限速故障停止投稿。共享网络共用配额；计数是每 Cloudflare 地点的近似值，见 [Cloudflare 限速说明](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)。
- 上游单次请求最多 10 秒、合计预算 20 秒；页面请求最多 30 秒。失败保留表单，支持原页重新验证，不暴露上游原始响应、凭据或 IP。
- 对 HTTPS 活动 URL（移除 fragment、保留 path/query）生成 SHA-256 标记，先查询所有状态的 Issue，兼容旧投稿。找到则返回原 Issue；查询失败不创建。POST 响应不确定时重试也先查询。
- 同一 Worker 实例合并相同 URL 的并发请求。GitHub 查询和创建不是跨实例原子事务，极端跨实例并发仍可能重复；审核时合并线索。不同 query 视为不同 URL。
- 成功仅代表 Issue 已创建或已存在，不代表信息有效或审核通过。

## 复用原有私有表格

使用「免费鸡蛋篮｜正式自动发布队列」，同一文件新增 **投稿审核** 工作表。表格 ID / 私有 URL 不放公开网页或仓库；镜像沿用现有 Apps Script 的 `SPREADSHEET_ID`。原「待发布队列」「发布日志」只处理核查后另行批准的内容发布。

新页第一行：

```text
issue_number,issue_url,title,submitted_at,issue_updated_at,issue_state,submission_body,review_status,review_notes,mirrored_at
```

将 `automation/apps-script/SubmissionMirror.js` 作为独立 `SubmissionMirror.gs` 加到原 Apps Script 项目，保留现有文件与属性。不部署 Web App，不公开表格。它从现有 Worker 的 `GET /api/submissions/review-feed` 读取公开 Issue；Apps Script 不存储或读取投稿 GitHub Token，五分钟镜像一次。忽略 PR，仅处理站内投稿标记；按 issue_number 更新，保留人工审核状态 / 备注，新行为 `PENDING`。关闭 Issue 只同步 closed，不推断审核通过。文本防单元格公式注入。

Google 直接访问 GitHub 的公共请求曾在实际测试中返回 403、`remaining=0`，因此采用此同站只读接口。Worker 若已配置 GitHub Secret，使用它读取本仓库；未配置时仅尝试公开读取。配置了无效 Token 时不会绕回匿名请求。读取接口仅返回 GitHub 原已公开的站内投稿七项字段、`has_more` 和原始页最大更新时间 `source_latest_updated_at`，不返回私有表 ID、审核备注或凭据；只接受限定页码 / ISO 检查点，按连接 IP 限速并设超时。读取失败保留检查点等待重试。访客投稿仍须配齐三项配置后才能启用。

安装核验：运行 `checkIssueMirrorConfiguration` → `diagnoseIssueMirror` → `runIssueMirror` → 回读表内结果 → `installIssueMirrorTrigger`。确认 `runIssueMirror` 五分钟原生触发器及实际定时执行。安装只去重镜像触发器，不删除 `runSync`；暂停用 `stopIssueMirrorTrigger`。诊断只输出固定环节、状态码和数量，不输出投稿正文、表格内容或异常原文。

共享 Script Lock 避免与原发布器同时写表。网络 / 限速 / 表格错误保留检查点，下一轮重试；Issue 保存在 GitHub。每轮最多五页、180 秒，未完整扫描时不推进检查点，下轮从第一页重查。原始页最大更新时间包含普通 Issue / PR；扫描期间任何源记录移动都要求重扫，防止过滤后的分页漏过旧投稿。超过 500 条积压需人工调整有限批次或补同步，不代表已全部同步。触发器说明见 [Google 官方文档](https://developers.google.com/apps-script/guides/triggers/installable)。

审核状态不触发发布。必须从当前 main 读取 `docs/EGG_GRADING.md` 和 `docs/CONTENT_GUIDE.md`，核实官方额度、API 适用范围、资格与有效期，再按 `docs/SHEETS_AUTOMATION.md` 单独准备发布任务。投稿功能**不写 `data/eggs.json`，不标记 active**。

## 验收

本地：`node --test tests/submission-worker.test.mjs tests/submission-page.test.mjs tests/submission-mirror.test.cjs tests/automation-sync.test.cjs`。模拟不能代替以下真实验收：

1. 核对 Cloudflare main 构建成功、正式部署版本、域名和对应代码；Vercel 状态不作证据。
2. 在正式浏览器用真实 Turnstile 和非敏感资料投稿，确认站内回执和 GitHub Issue。
3. 同 URL 再投，包括关闭后重试，确认指向原 Issue、不增记录。
4. 等原生镜像触发器执行，回读单行 PENDING；重跑不多行，关闭后同步 closed，人工备注保留。
5. 验证失败、超限、跨站来源、上游异常应有安全错误，数据文件和发布队列不得出现测试内容。关闭测试 Issue 并保留验收说明。

Secret 没配齐必须报告访客路径**未完成**，不得用连接器创建 Issue 冒充网站投稿成功。

## 2026-10-10 完成记录

生产三项配置已齐，config 真实回读 `enabled:true` 且公开 siteKey 存在。GitHub PAT 仅本仓库 Issues 读写和 Metadata 只读，到期日为 **2026-11-08**；请在到期前续换 Cloudflare Secret，并复验读取和投稿。Turnstile 使用仅允许 `freeegg.iffy.site` 的正式 Managed widget，未启用 pre-clearance；公开 Site Key 由生产后台变量与 `keep_vars:true` 保留。

正式访客经过真实 Turnstile 创建测试 Issue #3；关闭后用同 URL 加 fragment 再投，返回已有 #3。五分钟原生 `runIssueMirror` 已安装并实际完成定时同步，原 `runSync` 保留；#3 入原私有审核页，复跑未增加重复行，人工 `REJECTED` 和备注保留。本次未将测试内容写入原发布队列或数据文件。Issue #1 仍为连接器创建的早期测试，不作为访客投稿证据。

详细时间、重复运行日志、回读结果及模拟与真实证据边界，见 [投稿验收记录](SUBMISSION_TEST_RESULTS.md)。凭据只保存在 Cloudflare Secret，不在此文档记录密钥或私有标识。
