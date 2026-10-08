# 免费鸡蛋 🥚

可爱又略微抽象的免费 AI API 额度情报站。静态前端，无框架依赖，兼容 Cloudflare Pages 与 Vercel。

## 页面和数据
- `index.html`：主页面（含原创 CSS 吉祥物、早晚报、筛选和投稿）
- `data/eggs.json`：鸡蛋列表；字段 id,name,type,description,status,credits,models,requirements,discovered_at,verified_at,verification_note,url。
- `data/reports.json`：`morning`、`evening` 日报；字段 date,title,summary。
- `.github/ISSUE_TEMPLATE/submit-egg.yml`：投稿表单（GitHub Issue，投稿者需要登录 GitHub）。

## 数据准则
- `active` 必须有可追溯官方证据和最近验证结果；无法核实用 `pending`。
- `expired` 保留展示，并写明最近核实时间与失效原因。
- 商业中转站羊毛暂不收录，仅接受可核实的公益站。
- 发现时间和核实时间应是真实事件时间，不得将旧活动“补录日”伪装成实际发现时间（首批历史线索仅作为待核实示例）。
- 修改 JSON 并推送 GitHub 后，Git 集成会触发自动部署。自动生成日报/无人值守提交 GitHub 需另外验证定时任务能力。

## 部署
Cloudflare Pages：Connect to Git → `if-u-can/free-ai-credits` → framework `None` → build command 留空 → output directory `/`。
Vercel：无框架静态项目，根目录直接部署。

## 视觉参考
原创鸡蛋角色、中文互联网软萌且略抽象的表情包氛围；没有直接使用 EKU 模型或第三方表情包原图。
