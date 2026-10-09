# Sheets → GitHub 发布

正式队列使用 Google Apps Script 原生每分钟触发器。审核后的任务更新 `if-u-can/free-ai-credits` 的 `main`，再由现有 Cloudflare Git 构建发布。无需 npm、外部调度器或网站源码修改。源码位于 `automation/apps-script/`，测试为 `node --test tests/automation-sync.test.cjs`。

## 安装与私有配置

1. 正式表必须有「待发布队列」和「发布日志」两个工作表，第一行严格按以下顺序填写字段；保护结果列，负载列使用纯文本。
2. 在 [Apps Script](https://script.google.com/) 创建独立项目，由 `SPREADSHEET_ID` 连接正式表；也可使用表中「扩展程序 → Apps Script」的绑定项目。源码按 `Core.js`、`GitHub.js`、`Code.js` 顺序合并后一次贴进项目的 `Code.gs`，或分别建三个源文件。在项目设置开启 manifest 显示，将 `appsscript.json` 内容写入 manifest。独立项目无需绑定到表，也无需发布 Web App。
3. 创建 GitHub **Fine-grained personal access token**：Resource owner 为仓库所有者；Only select repositories 只选 `free-ai-credits`；Repository permissions 仅 `Contents: Read and write`，Metadata 的自动只读权限保留。不要增加 Actions、Issues、组织或其他仓库权限。受保护 main 拒绝提交时按权限失败处理，不能绕过。
4. 在 Apps Script **项目设置 → 脚本属性（Script Properties）**设置：`GITHUB_TOKEN`（唯一 token 存放处）、`SPREADSHEET_ID`（表 URL 中 `/d/` 后的 ID）、`MODE=TEST`、`PAUSED=false`。不要把 token 放在单元格、源代码、负载、日志或提交里。
5. 运行 `runSelfTests`（只验证本地逻辑），再运行 `checkConfiguration`（检查属性和表头，**不验证 GitHub 权限**）。首次由账户所有者完成 Google 授权。运行 `installMinuteTrigger`；同一安装账户只会保留一个 `runSync` 每分钟触发器。不要由多个账户重复安装。
6. 完成下述 A、B、C 的真实验收之后，才设置 `PRODUCTION_READY=A,B,C`、`MODE=PRODUCTION`。该属性是验收记录门闩，不代表脚本自行完成了线上验收。

队列表头：

```text
task_id,operation,target,payload_json,review_status,publish_at,sync_status,error,attempts,next_attempt_at,commit_sha,payload_hash,reviewed_by,reviewed_at,updated_at
```

日志表头：

```text
executed_at,task_id,target,commit_sha,result,detail,payload_hash
```

## 入队与负载

`task_id` 必须稳定且不复用给另一件事。先填 `payload_json` 并核实来源，审核通过后设 `review_status=APPROVED`、`reviewed_by=ChatGPT`、`reviewed_at=带时区ISO时间`、`sync_status=PENDING`、`attempts=0`。不满足审核状态的行不会执行；已标 APPROVED 但缺有效审核时间或审核时间在未来的行会 FAILED。`publish_at` 可留空；有值时使用带时区 ISO 时间，例如 `2026-10-09T08:00:00+08:00`。将来的任务到时间才执行，触发器不保证精确到秒。

同步只允许以下操作与固定 target：

| operation | target | 用途 |
|---|---|---|
| `test.write` | `tests/automation-write-test.txt` | 仅 TEST，真实权限和回读验收 |
| `egg.upsert` | `data/eggs.json` | 按稳定 id 新增或部分字段修改 |
| `report.set` | `data/reports.json` | 最新 slot 与 `data/report-archive.json` 同一提交 |
| `archive.upsert` | `data/report-archive.json` | 当期修订或超级专题 |

生产负载必须包含 `rules` 和 `evidence`。每次准备写入都读取 main 的两份规范及数据；`grading_sha` 和 `content_sha` 是 GitHub Contents API 返回的 **blob SHA**，不是 commit SHA 或本地文件 SHA256。来源 URL 应是人工核实过的官方页面；`verified:true` 是审核者对实际核实的声明，脚本不会访问来源页或替审核者判断 API 价值与领取资格。评级仍严格按 `docs/EGG_GRADING.md`；不得把只知道免费网页、旧索引或 404 的活动提升为有效。

已有鸡蛋修改示例（示例文字及 SHA 必须替换为当前 main 的实际内容与证据）：

```json
{
  "record": {"id":"existing-egg-id","verification_note":"本次实际核实后的说明"},
  "expected": {"verification_note":"当前 main 的旧说明，逐字相同"},
  "rules": {"grading_sha":"CURRENT_GRADING_BLOB_SHA","content_sha":"CURRENT_CONTENT_BLOB_SHA"},
  "evidence": {"verified":true,"urls":["https://official.example/offer"],"checked_at":"2026-10-09T00:00:00Z"}
}
```

只提交要改的字段；每个变化字段在 `expected` 写当前旧值，缺失字段以 `null` 表示。当前值已等于目标值时直接视为无变化；其余前值不一致则失败，不覆盖别人更新。id 必须是非空字符串。嵌套对象和数组视为整个字段替换，expected 必须包含完整前值，期望保留的未知子字段也要包含在目标值里；例外是 `quality_breakdown` 自动保留其未知子字段，`review_history` 只允许保留原有完整前缀并追加真实核查，不能删除/重写既有记录。新增记录使用 `expected:{}`，提供完整 `id/name/type/description/status/credits/models/requirements/discovered_at/verified_at/verification_note/url/official_source_url/claim_url/payment_required/source_type/grade/grade_reason/quality_score`。非 active 的 grade 必须为 null；active 必须有有效等级、验证日期与领取 URL。模型数组和质量分 0–100 必须有效。若提供 `quality_breakdown`，`free_api_value/model_usefulness/claim_convenience/validity_and_limits` 必须为非负数，分别不超过 35/25/25/15，总和必须等于 quality_score。脚本不会根据面额或分数自动升档。

日报示例（首次该 slot 为 null 时 `expected:null`；已有时使用当前 **完整 slot 对象**）：

```json
{
  "slot":"morning",
  "record":{"date":"2026-10-09","title":"实际日报标题","summary":"已完成核实的真实变化","highlights":["实际核实的要点"],"tip":""},
  "archive_id":"2026-10-09-morning",
  "expected":null,
  "completed":true,
  "rules":{"grading_sha":"CURRENT_GRADING_BLOB_SHA","content_sha":"CURRENT_CONTENT_BLOB_SHA"},
  "evidence":{"verified":true,"urls":["https://official.example/offer"],"checked_at":"2026-10-09T00:00:00Z"}
}
```

`completed:true` 只能在实际完成日报并经审核后填写。日报至少包含 `date/title/summary/highlights/tip`；不得把“等待出刊”变成带日期的历史。最新日期不能倒退。日报的 slot 和同一天 archive 条目使用稳定 id，修订当期、保留其他日期和未知字段。已有同 kind+date 不同 id 会失败，应使用原 id。

`archive.upsert` 的 `record` 使用 `id/kind/date` 加要更新字段，`expected` 提供变化字段前值；也必须有 `completed:true/rules/evidence`。新记录提供完整日报字段。新超级专题额外提供 `egg_id/official_source_url/claim_url`，该 egg 必须仍是 active+super；同 egg 不重复出专题。已有专题的失效更正可以把 `status` 更新为对应 egg 的 expired/unverifiable/excluded，不能冒充新发现。修改 archive 不会自动替代最新 slot；日常早晚报应使用 `report.set`。

测试写入示例：

```json
{"content":"A 的唯一测试文字及时间\n","expected":"测试文件在 main 的完整旧文本，包含原换行"}
```

`expected:null` 只用于该固定测试文件确实不存在时。错误前值会停止，不会凭空覆盖现有文件。测试模式拒绝全部生产操作；生产模式拒绝测试写入。

## 提交、恢复与错误

每轮持有 Script Lock，最多处理 3 行，180 秒预算；每个 GitHub 请求前检查预算（正在进行的网络请求可能延迟返回）。空队列、未审核、暂停、未来任务和未到重试时间均无 GitHub 请求。

所有文件从同一个 main HEAD 读取当前 blob SHA，使用 Git Trees 和以该 HEAD 为父的 commit，最后 `force:false` 更新 main。409/422 最多重新读取合并 3 次；同字段变化安全失败，其他文件/记录变化保留。只要有变更，负载与仓库收据 `automation/receipts/<SHA256(task_id)>.json` 同一提交；收据包含任务、负载摘要、目标文件与 blob SHA。提交后逐个读取该 commit 的文件与收据确认，才在 Sheet 记录 SYNCED（内部事务结果 SUCCESS）。日报即使只修复 archive 也回读两个文件。数据根 updated_at 按北京时间日期填写。

负载摘要覆盖 operation、target、规范化 JSON 和 publish_at。同任务重放通过仓库收据找回创建提交并验证，不重复应用旧 patch，因此不会撤回后续更新。同 ID 不同摘要失败；同 ID 的重复队列行不同负载在写入前失败。同 ID 同负载恢复真实提交，允许测试 B 将原行改回 PENDING。

NO_CHANGE 不创建 commit 或收据，记录已确认 HEAD。为避免后来更新被旧无变化任务撤回，Script Properties 的 `DONE_<任务ID摘要>` 保存短账本；不要删除这些属性或复用 ID。若迁移项目，需连同这份无变化账本迁移。SYNCED 的长期恢复依据是仓库收据。

| 状态/错误 | 处理 |
|---|---|
| SYNCED | 文件与收据回读成功；commit_sha 是真实创建提交 |
| NO_CHANGE | 没有新提交；commit_sha 是本次确认的 HEAD |
| VERIFY_PENDING | 写入响应不确定或回读失败；保留任务与负载，按收据恢复，不能称发布成功 |
| RETRY | 429/5xx/网络或连续 ref 竞争；1、2、4、8 分钟指数预约重试，不阻塞等待 |
| FAILED | 非法 JSON、缺字段、前值冲突、规范变化、权限错误或累计 5 次失败；原 payload 不改 |
| 401/403 | 全局 PAUSED=true，当前行 FAILED 并停止本轮；核对 token、仓库、main 规则后由维护者恢复 |

修复失败任务先查日志和仓库现状。规则变化或前值冲突需重新核实、更新 expected/rules、重新审核，并给更改后的负载使用 **新任务 ID**。响应不确定时应先以原 ID、原负载恢复。耗尽 5 次但需要继续验证时，先检查真实提交，再将 attempts=0、sync_status=PENDING；不能因错误就换 ID 重发同一项写入。日志只写安全错误和标识，不包含 token、API 原始响应。同步中人工修改负载/审核字段时，旧结果只记日志，不写回新负载的状态。

Sheet 写回先保存 commit_sha、摘要等元数据，再写日志并显式 flush，最后才写 sync_status。元数据、日志或刷入发生暂时错误时，保持 VERIFY_PENDING（Sheets 完全不可用时保留原可执行状态）并停止本轮；下轮按原任务收据恢复，不再提交。日志追加成功但响应丢失也可恢复；成功日志按 task_id/payload_hash/commit_sha 去重。同一任务重放可恢复状态，沿用原成功日志。已经确认提交而仅 Sheet 日志未完成的任务达到尝试上限后仍可只读收据恢复，不允许继续写 GitHub。

暂停只需 `PAUSED=true`；`stopSync` 同时删除当前安装账户的 runSync 触发器。正在执行的单个任务不能取消，但每项任务之间重读暂停开关，不继续本轮下一项。恢复设置 `PAUSED=false` 并在需要时重新运行 `installMinuteTrigger`。

## 真实验收

- A：使用真实 token 和账户授权，以新 task_id 修改固定测试文件；确认 GitHub main 实际 commit、文件、收据、Sheet SYNCED/日志，以及原生定时执行记录。`runSelfTests` 和 Node 模拟测试不能代替 A。
- B：原任务原负载只把状态改回 PENDING；确认回收相同创建 commit，GitHub 没有新提交，Sheet 状态恢复且成功日志的任务、摘要、提交一致（同键不重复追加）。
- C：非法 JSON、缺字段、测试文件错误 expected，确认 FAILED 且 GitHub 没变化。权限拒绝需确认全局暂停，不能绕过。
- D：A/B/C 全过后才启用生产；用经过当前官方证据核实的最小字段变化，确认真实 main 提交和 Cloudflare 正式域名部署到该数据。GitHub 提交成功本身不能称“网站已上线”。

## 配额

截至 2026-10-09，[Google 官方配额表](https://developers.google.com/apps-script/guides/services/quotas)列明个人账户触发器累计运行 90 分钟/日、URL Fetch 20,000 次/日，Workspace 对应 6 小时与 100,000 次；单次脚本 6 分钟，Script Properties 总存储 500 KB。配额按用户计，可变；每分钟空跑也消耗触发器运行时间，空闲零 GitHub 请求降低 URL Fetch 消耗。请查看实际执行记录，出现配额异常暂停排查；无变化账本累积接近属性限额时迁移保存账本后再维护，不能随意清掉幂等记录。

GitHub main 使用非强制引用更新，依据 [GitHub REST update reference](https://docs.github.com/en/rest/git/refs?apiVersion=2022-11-28#update-a-reference)。仓库分支保护、token 有效期和账户权限仍由 GitHub 执行。
