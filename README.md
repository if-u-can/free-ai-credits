<div align="center">

<img src="assets/wordmark.webp" alt="免费鸡蛋篮" width="420">

# 免费 AI API 额度清单 · 每日更新 · 逐条核实

**一代人有一代人的鸡蛋要领。**

[![在线网站](https://img.shields.io/badge/在线网站-freeegg.iffy.site-FFC531?style=for-the-badge)](https://freeegg.iffy.site/)
[![收录数量](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fif-u-can%2Ffree-ai-credits%2Fmain%2Fdata%2Feggs.json&query=%24.eggs.length&label=已收录&suffix=%20条&color=FF9FB2&style=for-the-badge)](data/eggs.json)
[![数据更新](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fif-u-can%2Ffree-ai-credits%2Fmain%2Fdata%2Feggs.json&query=%24.updated_at&label=数据更新&color=C8F1DE&style=for-the-badge)](data/eggs.json)
[![投稿](https://img.shields.io/badge/投稿-一颗免费鸡蛋-D8EEFF?style=for-the-badge)](https://freeegg.iffy.site/submit.html)

[**🧺 打开网站**](https://freeegg.iffy.site/) · [**📮 投稿**](https://freeegg.iffy.site/submit.html) · [**📏 分级规则**](docs/EGG_GRADING.md) · [**🗂 原始数据**](data/eggs.json)

<img src="assets/eku-hero.webp" alt="Eku 向你递来免费鸡蛋" width="260">

</div>

## 这是什么？

**免费鸡蛋篮**是一个持续更新的**免费 AI API 额度 / 免费大模型调用额度**整理项目。我们不只是堆链接，而是逐条核对：

- 来源是不是**官方页面**，链接还能不能打开
- 送多少额度、支持哪些模型、**要不要绑卡 / 实名**
- **哪天核实的**，活动什么时候结束

每条记录都标明状态：**有效 / 待核实 / 已失效**。过期的活动不会删，会保留并排到最后，免得你白跑一趟。

> 发现免费鸡蛋，不代表已经确认能领。我们尽量核对官方来源、领取条件及活动状态，让每一颗蛋都来路清楚。

## 为什么用它

| 你的烦恼 | 这里怎么处理 |
|---|---|
| “免费额度”满天飞，不知道真假 | 每条都附官方来源和核实日期 |
| 领完才发现要绑信用卡 | 明确标注是否绑卡，官方没写就写“未知” |
| 活动早就结束了 | 失效活动单独标记，永远排最后 |
| 好东西被淹没 | 分「超级 / 优质 / 普通」三档，只有确认有效的才评级 |
| 每天懒得一个个翻 | 每日**早报**看新增，**晚报**看变化与风险提醒 |

## 收录范围

- ✅ 模型厂商、推理平台、云平台提供的**免费 API 额度、新用户赠金、持续免费调用**
- ✅ 真正的**公益站**
- ❌ 普通商业中转站的优惠与赠送活动（公益站除外）

## 分级一句话

只有**已确认有效**的活动才能评为「超级 / 优质 / 普通」；「待核实」和「已失效」是状态，不是价值等级。完整规则见 [收录、分级与发布规则](docs/EGG_GRADING.md)。

## 数据怎么用

所有数据都是公开的 JSON，欢迎直接引用或做二次整理（请注明来源）：

| 文件 | 内容 |
|---|---|
| [`data/eggs.json`](data/eggs.json) | 全部鸡蛋：名称、额度、领取条件、是否绑卡、核实日期、来源、等级 |
| [`data/reports.json`](data/reports.json) | 当天早报 / 晚报 / 超级鸡蛋报 |
| [`data/report-archive.json`](data/report-archive.json) | 往期小报归档 |

## 常见问题

**这些额度是真的吗？**
我们只在核对过官方页面后才标“有效”。但活动可能随时变动，领取前请再看一眼官方公告。

**为什么有的写“未知”？**
官方没写清楚的条件，我们不替官方脑补，宁可标“未知”。

**我发现了新的免费额度怎么办？**
欢迎 [投稿一颗免费鸡蛋](https://freeegg.iffy.site/submit.html)。请附上官方链接，我们会核实后收录。

**你们和这些平台是什么关系？**
没有关系。本站独立整理公开活动信息，不隶属于 Eku 原作者或所收录的任何平台。

## 关于 Eku

网站用的是 VRChat 角色 **Eku** 的二创形象，鸡蛋只是个梗。Logo 和图标是 AI 生成的。

## 参与

- 📮 投稿新的免费额度：[投稿页](https://freeegg.iffy.site/submit.html)
- ⭐ 觉得有用就点个 Star，也欢迎转给需要的朋友
- 🐛 发现过期或错误的信息，直接开 Issue 告诉我们

---

<sub>关键词：免费 AI 额度 · 免费 API · 大模型免费调用 · 新用户赠金 · 公益站 · free AI API credits · free LLM API</sub>

**祝大家都能捡到超级美味的免费鸡蛋！**
