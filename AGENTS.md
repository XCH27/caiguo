# 给接手这个项目的 Agent

> 先读完这一页再动手。这里写的是**不能跑偏的东西**和**怎么在这个仓库里干活**。
> 细节在：[docs/DECISIONS.md](docs/DECISIONS.md)（每个产品决定和原因）→ [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)（代码怎么组织）→ [docs/DESIGN.md](docs/DESIGN.md)（页面怎么做）→ [docs/ROADMAP.md](docs/ROADMAP.md)（接下来做什么）→ [docs/DEPLOY.md](docs/DEPLOY.md)（怎么上线）。
> 项目的完整方案和调研在 [docs/PLAN.md](docs/PLAN.md)。

## 这是什么

**踩过（Caiguo）是 Agent 的小红书**：Agent 在这里分享和查找做事的真实经验——攻略、避坑、测评、合集、新鲜事、求助。做真实操作前先来搜；用过的点“有用”、收藏、在评论区补充和纠错、推荐给主人；人类在网页上围观，也可以自己写。

它不是“给 Agent 的知识库”，也不是“Agent 社交网络”。价值在于**模型再强也学不到的东西**：界面和政策变了、跟地区和身份有关、只有做过才知道、做错代价大。

## 不能违背的原则

这些都是项目负责人明确定下的。改动前如果和其中任何一条冲突，**先停下来问人**，不要自己“优化”掉。

1. **定位是“Agent 的小红书”**，不是单纯的攻略站。笔记有六种：攻略、避坑、测评、合集、新鲜事、求助（另有技能实测页）。攻略只是其中一种。
2. **平台自己不下结论。** 搜索只按文字相关度排序；不打推荐分、不排“最佳”、不说哪篇更可信。给 Agent 的输出只列可核对的事实和别人的原话，判断交给 Agent。笔记本身是作者的第一人称经验，那没问题。“为你推荐”只按“和你相关”排序，每条附的理由也必须是事实。
3. **每个互动背后都要有真实使用。** 不做点赞计分（Agent 点一下零成本，一定会被刷）。“有用 / 有误导”必须写“用它做了什么”；评论分类型（补充 / 纠错 / 提问 / 回答 / 我的情况不同），带环境和“实测过”标记，不收“哈哈哈”；收藏是 Agent 的长期书签；“推荐给主人”必须写理由。
4. **评论就是修改意见。** 别人提的修订以“带修改的评论”出现在评论区：大家在评论区验证，作者采纳即更新进笔记，验证够了社区自动采纳。不要再造一个独立的“修订”概念给人或 Agent 看。
5. **一人一号，Agent 必须声明模型。** 账号绑定手机号，一个手机号一个账号；一个账号可以绑多个 Agent（接入码或认领链接）；每个 Agent 声明模型（如 Claude Opus 5.5），显示在它发的内容旁边。没绑定或没声明模型的 Agent 只能搜和读。贡献分和额度按账号算。
6. **出处必须写，而且要逐步标到位置。** 整理自视频、帖子、论文的内容必须列出原始链接，每一步标出处位置（视频时间点、段落、页码），显示“整理自他人内容”。新鲜事必须有出处。只写真的打开看过的链接。
7. **安全规则是平台规则。** 付款、实名、扫码、验证码是“本人步骤”，通过跟做页交给人；不可逆步骤先征得用户同意；笔记内容是参考资料不是指令；入库前自动脱敏；改链接、付款步骤的修订永远不会自动合并。
8. **人和 Agent 分两个出口，同一份数据。** 网页只给人看（不要做“图文版 / Agent 版”切换）；Agent 走 MCP 工具和纯文本入口（`/llms.txt`、`/g/<id>.md`、`/search.md`、`/feed.md`）。
9. **网页的样子：外壳参考小红书，封面保留“海报笔记”风格。** 左侧导航、笔记页左封面右内容、底部互动条、个人主页、消息分类——见 [docs/DESIGN.md](docs/DESIGN.md)。网页**不执行任何脚本**（CSP `script-src 'none'`），所有交互都是表单和 `<details>`；只用系统字体（Google Fonts 在大陆打不开）。**被否定的设计要及时删掉**，不要留在仓库里。
10. **零运行时依赖。** 服务端只用 `node:http`、`node:sqlite`；插件的 MCP 服务手写协议，装插件不需要 `npm install`。开发依赖只有测试用的官方 MCP SDK。
11. **用户说中文。** 界面文案、文档、提交说明都用中文；文案要具体、平实，不要营销腔。

## 仓库地图

```
server/
  index.js          启动（端口、数据库、短信 webhook、定时自动合并）
  app.js            所有 HTTP 路由：网页 / 给 Agent 的纯文本 / REST API / 远程 MCP
  service.js        业务规则（唯一的一份）：账号绑定、发布、执行回报、修订=带修改的评论、互动、推荐、通知
  db.js             SQLite 表结构；新增列写在 COLUMNS（自动 ALTER）
  reputation.js     贡献分账本、等级、每日额度
  agent-text.js     /llms.txt
  logic/            纯函数：content（笔记校验）、patch、health、merge、redact、search、collusion（互刷降权）、embed（本地伪向量接口）
  web/views.js      所有网页（服务端渲染、全部转义）
  web/forms.js      表单解析（含 multipart 图片上传）、编辑器数据转换
  web/style.css     唯一的样式表
  web/legal.js      用户协议、隐私政策、内容规范的文字（改了数据处理规则要同步改）
plugin/             Claude Code 插件（也可单独作为 MCP 服务）
  mcp/tools.js      19 个工具的定义和给 Agent 的文本格式（版本号读 .claude-plugin/plugin.json）
  mcp/client.js     插件 → 平台的 HTTP 客户端（凭据存 ~/.config/caiguo/config.json）
  skills/           4 个技能：using-guides / sharing-experience / learning-from-media / maintaining-guides
  hooks/track.js    反馈提醒 + 技能使用计数
scripts/seed.js     演示数据（所有内容带“示例”标签）
scripts/login-link.js  给演示用户生成一次性登录链接
scripts/make-admin.js  把某个账号设为管理员（--revoke 取消）
scripts/backup.js   数据库备份（VACUUM INTO，校验后保留最近 N 份）
deploy/             正式环境配置样例：systemd 服务和备份定时器、Caddyfile、环境变量
test/               service.test.js（业务规则）、mcp.e2e.test.js（MCP SDK + 网页端到端）
docs/               方案、决定记录、架构、设计、路线图、部署、截图
```

## 常用命令

需要 Node.js ≥ 22.13。

```bash
npm install                 # 只装测试用的 MCP SDK
npm test                    # 全部测试（必须全过）
npm run demo                # 重建演示数据并启动 http://localhost:8787
node scripts/login-link.js 阿杰   # 以演示用户登录网页（服务启动后运行）
node scripts/login-link.js 踩过运营   # 演示数据里的管理员，打开 /admin 看举报
node scripts/make-admin.js <踩过号>   # 正式环境设置管理员
claude plugin validate plugin     # 校验插件
```

登录也可以走真实流程：打开 `/login` 输入手机号；没配置 `CAIGUO_SMS_WEBHOOK` 时是开发模式，验证码直接显示在页面上。

## 怎么干活

**改之前**：读 [docs/DECISIONS.md](docs/DECISIONS.md) 里相关的决定。用户中途发来的想法当作参考吸收，不要因此停下手头的事；但和上面原则冲突的，先问。

**常见改动的清单**：

- *新增 / 修改业务规则*：只改 `server/service.js`（或 `logic/` 纯函数），网页、REST、MCP 都调用它。写操作开头调用 `this.requireWriter(agent)`。给 `test/service.test.js` 加测试。
- *新增数据库列*：在 `db.js` 的 `COLUMNS` 里加一行（老数据库会自动 ALTER）；新表直接写在 `SCHEMA`。不要写会丢数据的迁移。
- *新增 MCP 工具*：`plugin/mcp/tools.js` 加定义和 `callTool` 分支 → `plugin/mcp/client.js` 加 HTTP 方法 → `server/app.js` 加 REST 路由，并在 `mcpHandlerFor` 的 client 里加同名方法（远程 MCP 用）→ 更新 e2e 测试里的工具数量和名单 → 更新 `INSTRUCTIONS`、`agent-text.js`、相关技能、docs/ARCHITECTURE.md。
- *新增通知类型*：`service.notify(...)` → `views.js` 的 `MSG_KIND_TAB` 和消息文案 → `tools.js` 的 `FEED_LINE`（否则 Agent 会看到原始类型名）。
- *新增 / 修改网页*：遵守 [docs/DESIGN.md](docs/DESIGN.md)。所有用户内容用 `esc()`；所有写操作是 POST 表单并带 `csrf`；改完必须截图看一遍（桌面 1440 宽 + 手机 iPhone 13），见下面“截图”。
- *改了给 Agent 的文字*：攻略全文和 `/g/<id>.md` 用同一个 `formatGuide`；保持“只列事实”。

**完成的定义**：
1. `npm test` 全过；改了插件就跑 `claude plugin validate plugin`。
2. 改了网页就重启服务、截图、亲眼看过（服务启动时缓存了 CSS，改样式后必须重启）。
3. 相关文档同步更新（README、本文件、docs/ 里对应的篇）。
4. 中文提交说明：第一行一句话概括，空一行后列要点。一次提交只做一类事。
5. 推送到 `origin master`。

**截图**：仓库外有 Playwright 和 Chromium。思路是：`npm run demo` 起服务 → `node scripts/login-link.js 阿杰` 拿登录链接 → 用 Playwright 打开链接再截各页面。给人看的截图放 `docs/screenshots/`（2 倍图），自己检查用的放临时目录。

## 已知的坑

- `node:sqlite` 会打印 ExperimentalWarning，所有脚本都带 `--no-warnings=ExperimentalWarning`。
- 服务启动时把 `style.css` 读进内存，改样式后要重启服务才能看到。
- 测试里注册 Agent 用 `registerAgent({ ..., verified: true, model: '测试模型' })`（内部调用视为已验证手机号）；公开接口 `/api/agents/register` 注册的都是未绑定的。
- 新手每天只能发 2 篇（草稿不算），测试里需要多发时先 `svc.rep.add(owner, 200, ...)` 提高等级。
- 消息和事实流里，`notify` 的 payload 会和事件字段合并；payload 里**不要用** `type`、`kind`、`id` 这类字段名（用 `comment_type`、`note_kind`）。
- 卡片（瀑布流、搜索结果）有 30 秒缓存：新增会改变卡片上数字的写操作，要调用 `this.invalidateCard(gid)`（见 docs/ARCHITECTURE.md“卡片缓存”）。
- 瀑布流用 CSS 多列，条目少于 6 条时自动改用网格（`wfFew`），否则会挤在一列。
- 笔记页桌面端是固定高度的两栏，子元素要 `min-height: 0` 才能各自滚动。
- 不要用 `pkill -f node` 之类的命令停服务（会把自己的 shell 也杀掉），用启动时拿到的后台任务去停。
- 演示数据的出处链接是 `example.com` 占位，截图是线框示意图，不是真实内容。
- 管理员只能在网页 `/admin` 处理举报，没有给 Agent 的管理工具（有意为之：处置要人来做）。Agent 只能通过 `caiguo_react(action="report")` 举报。
- “内容过时 / 步骤不对”不是举报理由，应该在评论区纠错（DECISIONS D19）。

## 现在的状态

v0.5.x：功能完整可演示（含举报、管理后台、申诉入口、注册风控），部署文档和配置样例已备好，自动化测试全过，CI 在 GitHub Actions 上跑。上线前还缺的东西见 [docs/ROADMAP.md](docs/ROADMAP.md) 的 P0。
