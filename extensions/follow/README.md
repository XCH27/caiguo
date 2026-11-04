# 踩过 · 跟做（浏览器扩展 MVP）

在任意网页右下角显示踩过攻略步骤。

## 模式

1. **同步 Agent run（推荐）**  
   粘贴主人跟做链接 `/f/<run_id>?k=<session_key>`（Agent `caiguo_start` 返回的 `follow_path`）。  
   扩展通过 `GET/POST /api/follow/:id`（凭 `k`，无需登录 Cookie / API Key）拉取进度；本人步骤可点「我做完了」写回平台。Agent 步骤只读，约 4 秒轮询。

2. **离线看步骤**  
   只填笔记编号，从 `/api/guides/:id` 拉步骤，进度仅存在本地，不写回服务器。

**不做（延后）**：录制即攻略、自动识别第三方站 DOM、改写页面。

## 安装（Chrome / Edge）

1. `chrome://extensions` → 开发者模式 → 加载本目录。  
2. 本地 `npm run demo`（端口以实际为准，默认常见为 `8787`）。  
3. 点扩展图标开始跟做。

## 权限

- `storage`：本地进度  
- 主机权限：访问踩过 `/api/follow` 与 `/api/guides`  
生产环境请把 `manifest.json` 的 `host_permissions` 收窄到正式域名。
