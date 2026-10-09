# 站内投稿验收记录（2026-10-09）

本记录区分真实外部结果与模拟检查，不代表所有链路已通过。

## 已完成的实现与验证

- 修复提交：`0143dc9951768571cb38bc9f71ecda3606ac2da5`；安全错误诊断：`66321bd66fa5bddf185aa2e8d6ffa1f39cb2d416`；Cloudflare 重定向修复：`732ec3f4cbdd7a94a1a205af8706579a62f766c9`，均已推送 GitHub main。
- 82 项检查通过：Worker 31、投稿页面 12、审核镜像 14、原发布器 25。覆盖超时、验证、限速、重复投稿、异常响应、审核备注保留、分页重扫与重定向凭据保护。
- GitHub 的 **Workers Builds: free-ai-credits** 检查确认 `732ec3f` 成功，版本 `aae632c8-f2ac-4f0d-a95e-7095aa5476e8`。此前 `66321bd` 的正式部署记录也已由 Cloudflare 管理工具确认。未使用 Vercel 状态作上线证据。
- Wrangler 4.148.0 dry-run 成功；识别静态资产和 5 次 / 60 秒原生限速绑定。
- 正式域名首页、`/submit.html` 返回 200，Server 为 Cloudflare；首页两处入口指向 `./submit.html`，页面包含公开投稿提示、新验证 action 和重复回执逻辑。
- 正式读取接口拒绝非法页码：`/api/submissions/review-feed?page=0` 返回 400。
- 正式读取接口返回 200：测试 Issue #1 先为 open；关闭后带 since 检查点再读，返回 closed、更新时间 `2026-10-09T05:31:21Z`、`has_more:false`。此为真实 GitHub → Cloudflare 读取结果。
- `/src/worker.js`、`/automation/apps-script/SubmissionMirror.js`、`/wrangler.jsonc`、`/.env`、`/tests/submission-worker.test.mjs` 返回 404。
- 此改动不修改 `data/`，不触发原内容发布队列。

## 复用的 Google 工作流

已查找并复用原私有「免费鸡蛋篮｜正式自动发布队列」。同一文件增加「投稿审核」页，表头已回读确认。保留原「待发布队列」「发布日志」「配置说明」及发布器。

独立 `SubmissionMirror.gs` 已保存至原 Apps Script 项目；从编辑器回读的源码与仓库文件一致。镜像不读取投稿 GitHub Token，只使用现有 SPREADSHEET_ID；五分钟触发器尚未安装，真实写入 / 定时执行未验证。

Google 直接公开读取 GitHub 的真实诊断返回 HTTP 403、额度剩余 0。因此改为读取同站 Worker 的公开投稿接口。镜像网络失败保留检查点，下一轮重试；人工审核状态 / 备注不会被同步覆盖。

## 实际测试 Issue

[Issue #1：链路测试，请勿收录](https://github.com/if-u-can/free-ai-credits/issues/1) 通过已连接 GitHub 工具真实创建；已以 not_planned 关闭并保留审计。正文明确它是非活动测试，不得收录。它**没有经过访客页面或 Worker 创建接口**，不得当作访客端到端成功证据。

## 尚未通过的真实链路

截至本轮检查，`/api/submissions/config` 返回 `enabled:false, siteKey:null`，实际投稿 POST 返回 503 配置提示。Cloudflare Secret 名称列表为空；只检查名称，没有读取任何值。运行时需要 GITHUB_TOKEN、TURNSTILE_SECRET 两份 Secret，以及同一 Turnstile widget 的公开 TURNSTILE_SITE_KEY；步骤见 [配置说明](SUBMISSION_SETUP.md)。凭据必须由用户直接填到 Cloudflare，不能发送到聊天或表格。

审核读取接口曾返回 502、`code:UPSTREAM_REQUEST`。在不带任何凭据的真实 Cloudflare 预览环境复现：`redirect:"error"` 触发 TypeError（边缘运行环境仅支持 follow / manual），GitHub 请求没有发出。直接请求同一个公开 GitHub API 返回 200、额度剩余 57；因此这次 Worker 失败不是 Google 的公共请求配额问题。修复为 `redirect:"manual"`，既不跟随重定向，也不把授权头转发到其他目标；3xx 作为上游失败处理。

表格目前只有表头，尚无测试 Issue 行。Chrome 提示另一个扩展面板占用，阻止执行 Apps Script；需要完成或关闭该面板后继续。

正式匿名读取同时出现 200 和上游 HTTP 403（接口安全返回 503）。尚不能称读取已稳定；需要 Cloudflare 的 Issues Token 完成认证链路后复验。六次连续正式读取未观测到 429，不把它作为严格限速证明。

另在真实 Cloudflare NRT 预览环境使用与正式配置相同的原生限速绑定（namespace 1791529201、5 / 60 秒），单次调用中对同一个独立测试 key 连续计数八次，结果为前六次允许、后两次拒绝。确认绑定实际可拒绝超额调用，也证实它是每 Cloudflare 地点的近似计数，不是严格全球五次额度。此探测未访问 GitHub / Issue / 凭据，临时预览已停止；模拟另覆盖 429 和 Retry-After 响应。

待完成：认证后的稳定读取、镜像实际写入及重复 / closed / 人工备注保留验证、五分钟原生触发器执行，以及真实 Turnstile 访客投稿和相同 URL 重投。无需重构或新增数据库；这些证据齐备前不能称全链路已验收。
