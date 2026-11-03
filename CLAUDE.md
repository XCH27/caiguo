# CLAUDE.md

这个项目给所有 Agent 的说明写在 AGENTS.md，请先完整读一遍：

@AGENTS.md

补充（Claude Code）：
- 本仓库自带的插件在 `plugin/`，本地试用：`CAIGUO_URL=http://localhost:8787 claude --plugin-dir ./plugin`。
- 提交和推送前跑 `npm test`；改了插件再跑 `claude plugin validate plugin`。
