# 服务器迁移指南（一年到期换机）

> 适用场景：服务器到期后迁移到新服务器。代码在 GitHub / GitLab 均有完整副本，
> 真正需要搬的只有「配置 + 数据库 + 密钥 + 少量图片」，总量约 30~50MB。

## 1. 先分清：要搬什么、不用搬什么

| 内容 | 路径 | 是否迁移 | 说明 |
| --- | --- | --- | --- |
| 环境变量 | `backend/.env` | ✅ 必须 | SMTP、Bangumi OAuth、代理、`PUBLIC_BASE` 等；权限 600，不入 git |
| 数据库 | `backend/data/bangumi-blog.db` | ✅ 必须 | SQLite 主库（用户/会话/博客/收藏同步等），线上约 23MB |
| Web Push 密钥 | `backend/data/vapid.json` | ✅ 必须 | 丢了需用户重新订阅推送 |
| 用户上传 | `backend/uploads/` | ✅ 必须 | 目前很小（约 8KB） |
| 站点图片 | `backend/news-img/` | ✅ 必须 | 公告/资讯图等，线上约 29MB |
| 图片缓存 | `backend/img-cache/` | ❌ 可再生 | 新机器访问后自动重建（线上约 75MB，不用搬） |
| 代码 | GitHub/GitLab 仓库 | ❌ 重新 clone | 直接 `git clone` 最新，不手动搬 |
| 依赖 / 构建产物 | `node_modules`、`frontend/dist` | ❌ 重新生成 | `pnpm install && pnpm build` |
| 日志 / 旧备份 | `backend/logs/`、`backend/data/*.bak*`、`/www/backup/` | ❌ 不用搬 | 历史备份，到期前可清理 |

> 提示：线上已有每日自动备份任务（`backend/backup.js` → `/www/backup/bangumi-blog/`，保留 7 天，
> 每天一份 `VACUUM INTO` 的完整 db）。迁移兜底也可以直接用里面最新一份 `.db` 文件。

## 2. 换机前建议提前做的事

1. 确认仓库最新代码已推送到 GitHub / GitLab（`git status` 干净）。
2. 在旧机器跑一次一键打包（见 §3），确认归档能正常生成和解压。
3. 提前核对容易忘的外部配置：
   - [bgm.tv 开发者后台](https://bgm.tv/dev/app) 的「回调地址」（换 IP/域名必须同步改）；
   - SMTP 授权码（与机器无关，原样可用）；
   - 出口代理（`BANGUMI_PROXY` / `WATCH_PROXY` 指向新机器的 mihomo/clash）。

## 3. 方案 A：一键打包（推荐）

仓库已提供 `scripts/backup-migrate.sh`，在**旧服务器部署目录**运行：

```bash
cd /www/wwwroot/bangumi-blog          # 真实部署目录
bash scripts/backup-migrate.sh        # 默认输出到 /www/backup/bangumi-blog/migrate-<时间戳>.tar.gz
# 也可指定输出目录：
# bash scripts/backup-migrate.sh /root
```

脚本特点：

- SQLite 用 `VACUUM INTO` 生成一致性快照，**服务运行中也能打包**，不依赖 `-wal/-shm`；
- 自动带上 `.env`（保留 600 权限）、`data/vapid.json`、`uploads/`、`news-img/`；
- 自动排除 `img-cache/`、`node_modules`、`frontend/dist`、日志、历史 `.bak*` 备份。

归档内路径以 `backend/...` 开头，恢复时解压到仓库根目录即可。

## 4. 方案 B：手动打包（不用脚本）

```bash
systemctl stop bangumi-blog           # 停服最稳（不停服请用上文的 VACUUM INTO 方式）
cd /www/wwwroot/bangumi-blog/backend
tar czf /root/migrate-$(date +%F).tar.gz \
  .env data/bangumi-blog.db data/vapid.json uploads news-img
systemctl start bangumi-blog
scp /root/migrate-*.tar.gz root@新服务器IP:/root/
```

## 5. 新服务器部署

### 5.1 准备环境（Ubuntu/Debian 示例）

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs
corepack enable pnpm || npm i -g pnpm
node --version    # 需要 Node >= 22.5（backend 使用 node:sqlite）
```

### 5.2 拉代码 + 还原数据

```bash
cd /www/wwwroot
git clone <GitHub 或 GitLab 仓库地址> bangumi-blog
cd bangumi-blog
tar xzf /root/migrate-<时间戳>.tar.gz     # 覆盖 backend/.env、data/ 等
chmod 600 backend/.env
```

### 5.3 装依赖 + 构建前端

```bash
cd /www/wwwroot/bangumi-blog/frontend
pnpm install && pnpm build
cd ../backend
pnpm install --prod
```

### 5.4 修改 `.env` 中与「地址」相关的项

```bash
nano backend/.env
# 至少要核对：
#   PUBLIC_BASE=<新站点地址>                例如 http://新IP:8088 或 https://域名
#   BANGUMI_REDIRECT_URI=<新的 Bangumi 回调地址>（与 bgm.tv 后台白名单一致）
#   COOKIE_SECURE=1                          保持不变（HTTPS 反代后面）
#   SMTP_* / BANGUMI_CLIENT_ID / BANGUMI_CLIENT_SECRET / OWNER_BANGUMI_UID / ADMIN_TOKEN 保持原值
#   BANGUMI_PROXY / WATCH_PROXY              改成新机器上的代理地址
```

### 5.5 创建 systemd 服务

`/etc/systemd/system/bangumi-blog.service`（与旧机保持一致）：

```ini
[Unit]
Description=Bangumi Blog Node Backend
After=network.target

[Service]
Type=simple
WorkingDirectory=/www/wwwroot/bangumi-blog/backend
ExecStart=/usr/local/bin/node --experimental-sqlite src/server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
User=root
Group=root
StandardOutput=append:/www/wwwroot/bangumi-blog/backend/logs/app.log
StandardError=append:/www/wwwroot/bangumi-blog/backend/logs/app.log

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now bangumi-blog
systemctl status bangumi-blog
curl http://127.0.0.1:8088/api/health     # 确认服务健康
```

### 5.6 宝塔 / nginx / WAF / 证书

- 新建站点并配置 HTTPS 证书（阿里云免费证书或 Let's Encrypt），把域名解析到新 IP；
- 8088 反向代理。**务必保留** XFF 规整（堵 XFF 伪造的关键），例如：

```nginx
location /api/ {
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;   # 不信任客户端传来的 XFF
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://127.0.0.1:8088;
}
```

- 若使用 BTWAF，重新接入新站点并确认规则（安全头 / HSTS / TLS 版本）与旧机一致。

## 6. 换 IP / 域名最容易漏的 3 个坑

1. **Bangumi OAuth 回调白名单**：换 IP/域名后必须去 [bgm.tv 开发者后台](https://bgm.tv/dev/app) 把
   应用回调地址改成新地址（与 `.env` 的 `BANGUMI_REDIRECT_URI` 一致），否则「登录 Bangumi」会直接失败。
2. **出口代理**：`BANGUMI_PROXY` / `WATCH_PROXY` 指向旧机器本机代理；新机器也要配置 mihomo/clash，
   否则 Bangumi API 抓取 / RSS 可能超时或失败。
3. **SMTP 授权码**：QQ 邮箱授权码与机器无关，原样搬过去即可用，不用重新申请。

## 7. 上线验证清单

- [ ] `curl http://127.0.0.1:8088/api/health` 正常
- [ ] 匿名访问首页 / 番剧详情 / 博客文章，图片能加载（`img-cache` 重建初期会略慢）
- [ ] 用站长 Bangumi 账号登录，手动触发一次收藏同步成功
- [ ] 只读访客（viewer）链接可看追番数据、不可修改
- [ ] 发一封邮箱验证码能收到
- [ ] 旧服务器停机后，新 IP / 域名访问正常，HTTPS 无告警
- [ ] nginx 安全头与 `X-Forwarded-For $remote_addr` 生效（curl -I 检查）

## 8. 切换与善后

- 建议新机先跑通（可先用临时域名/IP），再停旧机，观察 2~3 天无异常后释放旧资源；
- 旧机器数据保留到到期日，确认新机稳定后再删除 `/www/backup/` 与迁移包；
- 迁移包含 `.env`（含 SMTP 授权码、OAuth secret 等），用完请安全删除，不要上传到任何代码仓库。

## 9. 平时备份建议

- 数据库：线上已有 `backend/backup.js` 每日备份任务（保留 7 天）；
- `.env`：**不在**每日备份里，建议手动另存一份到本地 / 密码管理器；
- 换机演练：每季度跑一次 `bash scripts/backup-migrate.sh` 并试解压，确保到期时不会手忙脚乱。