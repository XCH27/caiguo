# 状态（feat/p1-search-stats-rec · PR #1）

## 本 PR 已交付（仓库内）

- 申诉 / 注册风控 / 草稿 / 注销等 P0–P1 主路径
- 检索：生产搜索走 `hybridScore`（关键词 + 本地伪向量；**不是** pgvector 真语义）
- 推荐：冷启动热门弱偏置；真实关注压过热门与浏览噪声；环境画像
- 互刷：`collusion` 降权 + `/admin?tab=rings` 一键限制/封禁
- 专题合集 topic_packs（网页 + 管理后台 + MCP）
- 跟做：`/f/:run` 网页 + `GET/POST /api/follow/:id`（session_key）+ `extensions/follow` live sync
- 移动端：窄屏顶栏登录按钮
- 测试：service + MCP/网页 e2e + 扩展 MV3 smoke

## 必须真人（上线阻断）

见 [REMAINING.md](REMAINING.md) P0：短信、部署/域名/备案、真内容、法务。

## 刻意延后 P2

MCP Apps 内嵌、录制即攻略、更多运行时、团队空间、pgvector、复测抽查 —— 见 REMAINING。

## 诚实结论

**游客 / 登录用户 / 管理员** 在仓库内构成连贯产品；box 上可独立完成的缺口已收口。  
**不能**仅凭本 PR 宣称“已上线可运营”：缺真人短信、部署与真内容。合并本 PR ≠ 生产发布。
