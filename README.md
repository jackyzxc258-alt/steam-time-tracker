# 🎮 Steam 游戏时长监控

一个家长友好的网页工具，用于查看孩子在 Steam 上每天玩了多久、玩了哪些游戏。

---

## 架构概览

```
家长浏览器                Vercel (免费)              Supabase (免费)        Steam API
┌──────────┐   静态托管    ┌──────────────┐   读写   ┌──────────────┐   定时拉取   ┌──────────┐
│ index.html│──────────▶  │ 前端静态页     │◀──────▶│ Postgres     │◀──────────│ Steam    │
│ (任何设备) │            │ /api/collect │        │ + 自动 API   │           │ Web API  │
└──────────┘             │ (每30分钟)    │        └──────────────┘           └──────────┘
                         └──────────────┘
```

- **全部免费**：Vercel Hobby + Supabase Free Tier 足以覆盖一个孩子的日常监控。
- **无需自己搭服务器**。

---

## 前置条件

1. **孩子的 Steam 账号**需要设置：
   - 个人资料 → 隐私设置 → **游戏详情设为「公开」**
   - 记下个人资料 URL 末尾的自定义名称（例如 `steamcommunity.com/id/xxx` 中的 `xxx`）

2. **Steam Web API Key**：[在此获取](https://steamcommunity.com/dev/apikey)（用你自己的 Steam 账号登录后即可免费生成）

3. **GitHub 账号**（用于登录 Vercel 和 Supabase）

---

## 部署步骤

### 第一步：创建 Supabase 项目

1. 访问 [supabase.com](https://supabase.com) → 用 GitHub 登录 → **New Project**
2. 填写项目名（如 `steam-tracker`）、设置数据库密码、选择离你最近的区域
3. 创建后，进入 **SQL Editor** → 粘贴以下内容 → **Run**：

   [打开 `supabase/schema.sql`](./supabase/schema.sql) 并复制全部 SQL，在 Supabase SQL Editor 中执行。

4. 进入 **Settings → API**，复制：
   - `Project URL`（例如 `https://xxxxx.supabase.co`）
   - `anon public key`（前端使用）
   - `service_role key`（仅后端使用，**绝对不要泄露到前端**）

### 第二步：配置前端

编辑 `frontend/index.html`，找到这两行并替换：

```js
const SUPABASE_URL = 'YOUR_SUPABASE_URL';          // 替换为你的 Project URL
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY'; // 替换为你的 anon public key
```

### 第三步：部署到 Vercel

1. 访问 [vercel.com](https://vercel.com) → 用 GitHub 登录
2. 将本项目推送到你的 GitHub 仓库：

```bash
cd steam-time-tracker
git init
git add .
git commit -m "Init Steam time tracker"
git remote add origin <你的仓库地址>
git push -u origin main
```

3. 在 Vercel Dashboard → **Add New Project** → 导入你的仓库
4. **Build & Development Settings** 保持默认（无需构建步骤）
5. 在 **Environment Variables** 中添加：

| 变量名 | 值 |
|--------|-----|
| `SUPABASE_URL` | 你的 Supabase Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | 你的 Supabase service_role key |
| `CRON_SECRET` | 自选一个随机字符串（如 `my-secret-123`） |

6. 点击 **Deploy**。

### 第四步：设置定时任务

在 Vercel 项目 Dashboard → **Settings → Cron Jobs**，确认 `vercel.json` 中定义的 `*/30 * * * *` 定时任务已激活。

### 第五步：配置孩子账号信息

1. 打开你部署后的网站（Vercel 会给你一个 `.vercel.app` 域名）
2. 点击右上角 **⚙ 设置**
3. 填入：
   - **Steam ID**：孩子的 Steam 个人资料 URL 末尾名称，或 17 位 Steam64 ID
   - **API Key**：Steam Web API Key
   - **每日时长限制**（可选）：超过后会标红提醒
4. 点击 **💾 保存**

---

## 工作原理

### 数据采集

Vercel Cron 每 30 分钟自动调用 `/api/collect`：

```
Steam GetOwnedGames API
       │
       ▼  playtime_forever (累计分钟)
play_snapshots 表 (每次记录累计值)
       │
       ▼  MAX - MIN = 今日增量
daily_summary 表 (每日游戏时长)
       │
       ▼  Supabase REST API
前端直读，渲染图表
```

### 每日时长计算

- Steam 只返回「累计时长」，不返回「今天玩了多久」
- 我们在同一天内多次采集，用 **当日最后一次累计值 − 第一次累计值** = 当日净时长
- 每天 0 点重置基准

---

## 项目结构

```
steam-time-tracker/
├── frontend/
│   └── index.html          ← 静态仪表盘（唯一的前端文件）
├── api/
│   ├── collect.js          ← Vercel Serverless 函数（代理 Steam API + 写库）
│   └── package.json
├── supabase/
│   └── schema.sql          ← 数据库建表 SQL + PostgreSQL 函数
├── vercel.json             ← Vercel 部署配置（路由 + Cron）
├── .env.example            ← 环境变量模板
└── README.md
```

---

## 常见问题

**Q: 数据一直是空的？**
A: 检查：① Steam 隐私设置是否设为「公开」；② API Key 是否正确；③ Vercel Cron 是否激活；④ 等 30 分钟后刷新。

**Q: 能监控多个孩子吗？**
A: 当前为单账号设计。要支持多个孩子，需要扩展 `child_config` 表增加行，并为每个孩子部署独立实例或改造前端。

**Q: 隐私安全吗？**
A: Steam API Key 存储在 Supabase 数据库中，浏览器不可见；只有你的 Vercel 后端函数能读取。前端展示数据无需登录（建议自行添加 Supabase Auth）。

---

## 技术栈

| 层 | 技术 |
|----|------|
| 前端 | HTML + Chart.js + Supabase JS SDK |
| 后端 | Vercel Serverless Functions (Node.js) |
| 数据库 | Supabase (PostgreSQL) |
| 调度 | Vercel Cron Jobs |
| API 源 | Steam Web API (GetOwnedGames) |
