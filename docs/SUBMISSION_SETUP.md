# 网站投稿 → GitHub Issues 配置

访客在 /submit.html 填写 → 同域 Worker POST /api/submissions → GitHub 自动创建 [投稿] Issue，无需 GitHub 登录和 D1。

## Cloudflare 配置（需要管理员操作）

在 Workers 和 Pages → free-ai-credits → 设置 → 变量和机密添加：

- GITHUB_TOKEN（**Secret**）：GitHub Fine-grained PAT，资源只授权 if-u-can/free-ai-credits，权限 **Issues: Read and write**，不要额外授权 Contents。
- TURNSTILE_SECRET（**Secret**）：Cloudflare Turnstile Widget Secret Key。
- TURNSTILE_SITE_KEY（普通变量）：Cloudflare Turnstile Widget Site Key；Widget 的 hostname 填 freeegg.iffy.site。

不要把任何密钥复制到 GitHub 仓库、前端代码、Issues 或聊天。变量保存后，按 Cloudflare 提示重新部署 Worker。

Cloudflare Builds 必须使用当前 Worker 名称 free-ai-credits，根目录仓库根目录，默认 deploy 命令 npx wrangler deploy。wrangler.jsonc 保证静态资源与 API 共用 Worker，.assetsignore 排除服务端文件。

访问 https://freeegg.iffy.site/api/submissions/config 检查 enabled=true 后，使用真实浏览器 Turnstile 和非敏感测试数据投稿一次，核对 GitHub Issues 确实出现 [投稿] 记录。密钥没配齐会返回 disabled，前端按钮禁用，**不是投稿已上线**。

公开接口已要求同源、格式、长度校验及 Turnstile 服务端验证；推荐在 Cloudflare WAF 额外设置 /api/submissions 的请求速率限制。审查这些 Issue 时需读取 docs/EGG_GRADING.md；**不自动写入 data/eggs.json**。
