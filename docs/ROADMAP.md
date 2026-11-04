# 路线图

> 已完成的版本记录在 [PLAN.md](PLAN.md) 第 0 节和 git 历史里。这里只列**还没做的**，按优先级排序。
> 做完一项就从这里删掉，并在 PLAN.md 的“现在做到了哪一步”里补一行。

## P0 上线前必须做

| 事项 | 说明 |
|---|---|
| 接入正式短信服务 | `CAIGUO_SMS_WEBHOOK` 接阿里云 / 腾讯云短信（需要签名和模板备案）。现在是开发模式，验证码显示在页面上 |
| 部署 | 文档和配置样例已备好（[DEPLOY.md](DEPLOY.md)、`deploy/`、`scripts/backup.js`，`CAIGUO_ENV=production` 有启动检查）。需要负责人准备服务器、域名、备案、短信转发服务后照做 |
| 真实内容冷启动 | 演示数据的出处是 `example.com` 占位、截图是线框图。上线前清空演示数据，用真实做过的 20–30 件事写首批笔记（建议从“开发者开户和配置”开始） |
| 法务审核 | `/terms` `/privacy` `/rules` 已按平台实际做法写了草稿（`server/web/legal.js`），需要法务审核、填写运营方主体和联系方式 |

## P1 体验和质量

| 事项 | 说明 |
|---|---|
| 语义搜索 | 生产搜索已用 `hybridScore`（关键词为主 + 本地哈希伪向量为辅，见 `logic/embed.js`）。真语义仍待 Postgres + pgvector：替换 `embedText` 即可（D7：不按质量加权） |
| 推荐改进 | 冷启动弱偏置 + 环境画像已做（见 PLAN）；usage/浏览噪声权重仍可微调 |
| 性能 | `guide_stats`、列表批量预取版本/runs/usage、发布 similarTitles 已做（见 PLAN）；真向量检索仍待 Postgres |

## P2 扩展

| 事项 | 说明 |
|---|---|
| MCP Apps 跟做页 | 在支持的 AI 应用里内嵌跟做页（D8） |
| 浏览器扩展 | **跟做模式 MVP 已入库** `extensions/follow`（浮层显示步骤，见该目录 README）。仍缺：录制即攻略、与 Agent run 同步、生产域名收窄 host_permissions |
| 接入更多运行时 | Coopanion World、dsh 插件、OpenClaw 技能、QQ 机器人 |
| 团队私有空间 | 团队内部笔记先在私有层验证，再晋升到公共层 |

## 待负责人决定

- 仓库现在是公开的（Public），要不要改私有。
- 许可证：仓库里是 MIT，确认是否要开源以及用哪个许可证。
- 主分支叫 `master`，要不要改成 `main`。
- 上线后的域名、服务器所在地（影响 ICP 备案和短信服务选择）。
