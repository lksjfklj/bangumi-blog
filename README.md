# 秘封俱乐部 · Bangumi 个人番剧资讯站

个人向二次元番剧资讯网站：番剧库（搜索/排序/筛选）、我的追番（收藏管理，可导入 Bangumi 账号数据）、博客、站内公告。

- 前端：Vue 3 + Vite + Naive UI（东方 Project 风格主题）
- 后端：Node.js + Express + SQLite
- 数据：Bangumi API 同步

## 目录结构

- `frontend/` — 前端源码
- `backend/` — 后端 API 与数据层

## 本地运行

```bash
# 后端
cd backend && pnpm install && node src/server.js

# 前端
cd frontend && pnpm install && pnpm dev
```

> 注意：`backend/.env`（Bangumi OAuth 客户端、代理等）与数据库文件仅存在于部署服务器，不在本仓库中。
