# 部署

> 单机部署：一台 Linux 服务器 + 域名 + Caddy（自动 HTTPS）+ systemd。没有其他依赖。
> 配置样例都在 [`deploy/`](../deploy)。上线前还要做的事（短信、内容冷启动、法务审核）见 [ROADMAP.md](ROADMAP.md) 的 P0。

## 1. 准备

- Node.js ≥ 22.13（用到内置的 `node:sqlite`）。
- 一个域名，解析到服务器。服务器在大陆的话需要 ICP 备案。
- 短信服务（阿里云 / 腾讯云短信），需要签名和“登录验证码”模板审核通过。

## 2. 安装

```bash
sudo useradd --system --home /var/lib/caiguo --shell /usr/sbin/nologin caiguo
sudo mkdir -p /opt/caiguo /var/lib/caiguo /etc/caiguo
sudo git clone https://github.com/XCH27/caiguo.git /opt/caiguo
sudo chown -R caiguo:caiguo /var/lib/caiguo
```

```bash
sudo cp /opt/caiguo/deploy/caiguo.env.example /etc/caiguo/caiguo.env
sudo chmod 600 /etc/caiguo/caiguo.env && sudo chown caiguo:caiguo /etc/caiguo/caiguo.env
```

不需要 `npm install`：服务端零运行时依赖（`npm install` 只装测试用的 MCP SDK）。

## 3. 配置（/etc/caiguo/caiguo.env）

| 变量 | 必填 | 说明 |
|---|---|---|
| `CAIGUO_ENV=production` | 是 | 打开启动检查：下面三项缺一项就拒绝启动 |
| `CAIGUO_PHONE_PEPPER` | 是 | 手机号哈希密钥，`openssl rand -hex 32` 生成。**上线后不能再换**，换了所有旧账号的手机号都对不上。和数据库备份分开保存 |
| `CAIGUO_SMS_WEBHOOK` | 是 | 平台发验证码时 `POST` 到这个地址，见下面“短信” |
| `CAIGUO_PUBLIC_URL` | 是 | `https://` 开头的正式地址。登录 cookie 会带 `Secure`；认领链接、登录链接用它拼地址 |
| `CAIGUO_TRUST_PROXY=1` | 在 Caddy / Nginx 后面时必须 | 否则所有人的 IP 都是 127.0.0.1，按 IP 的验证码限流（每 IP 每小时 20 次）会被所有人共用 |
| `CAIGUO_DB` | 否 | 默认 `data/caiguo.db`；正式环境放 `/var/lib/caiguo/caiguo.db` |
| `PORT` | 否 | 默认 8787，只监听给 Caddy 用 |
| `CAIGUO_SMS_TOKEN` | 否 | 调用短信 webhook 时带 `Authorization: Bearer …` |
| `CAIGUO_ALLOW_VIRTUAL=1` | 否 | 放开虚拟运营商号段（170/171/162/165/167），默认拒绝 |

### 短信

平台不直接对接短信厂商（签名算法、模板各家不同），而是调用你的一个转发服务：

```
POST $CAIGUO_SMS_WEBHOOK
Authorization: Bearer $CAIGUO_SMS_TOKEN
Content-Type: application/json

{"phone": "13800001111", "code": "123456", "template": "login"}
```

转发服务调用阿里云 `SendSms` 或腾讯云 `SendSms`，5 秒内返回即可（平台不等结果，失败只记日志）。可以用云函数写，十几行。
平台这边已经做了：每个号码 1 分钟 1 次、每天 10 次；每个 IP 每小时 20 次；同一个码错 5 次失效；只存哈希。

## 4. 启动

```bash
sudo cp /opt/caiguo/deploy/caiguo.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now caiguo
journalctl -u caiguo -f
```

HTTPS（Caddy 会自动申请证书）：

```bash
sudo cp /opt/caiguo/deploy/Caddyfile /etc/caddy/Caddyfile   # 改成你的域名
sudo systemctl reload caddy
```

设置管理员（先用自己的手机号在网页上登录一次，拿到“踩过号”）：

```bash
cd /opt/caiguo && sudo -u caiguo env CAIGUO_DB=/var/lib/caiguo/caiguo.db node --no-warnings=ExperimentalWarning scripts/make-admin.js <踩过号>
```

## 5. 备份

`scripts/backup.js` 用 SQLite 的 `VACUUM INTO` 在服务运行时生成一致的副本，校验后保留最近 14 份：

```bash
sudo cp /opt/caiguo/deploy/caiguo-backup.service /opt/caiguo/deploy/caiguo-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now caiguo-backup.timer
```

备份只在本机还不够：再把 `/var/lib/caiguo/backups/` 每天同步到另一台机器或对象存储（如 `rclone sync`）。
恢复：停服务 → 把某个备份复制成 `caiguo.db` → 启动。

## 6. 升级

```bash
cd /opt/caiguo && sudo git pull && sudo systemctl restart caiguo
```

数据库结构变化是自动的：新表在 `SCHEMA` 里 `CREATE TABLE IF NOT EXISTS`，新列在 `COLUMNS` 里启动时 `ALTER TABLE ADD COLUMN`。项目约定不做删列、改类型这类会丢数据的迁移。升级前先手动跑一次备份。

## 7. 上线检查

- [ ] `CAIGUO_ENV=production` 下能启动（启动检查通过）
- [ ] 用真实手机号收到验证码并登录；页面上**不再**显示验证码
- [ ] 数据库是空的（启动日志没有“还有演示数据”的提醒）。不要用 `npm run demo` 的数据库
- [ ] 设置了至少一个管理员，`/admin` 能打开
- [ ] `https://域名/llms.txt` 能打开；插件里 `CAIGUO_URL` 指向正式地址后 `caiguo_search` 正常
- [ ] 备份定时器在跑（`systemctl list-timers | grep caiguo`），异地同步配好了
- [ ] 用户协议、隐私政策、内容规范经过法务审核（`/terms` `/privacy` `/rules` 现在是草稿）
