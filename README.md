# 红绿灯实验交互站点

本项目已改为“服务端存储数据”模式：正式实验结束后，前端会将日志提交到后端 API，并写入服务器 SQLite 数据库。

## 技术栈

- 前端：Vite + TypeScript + Three.js
- 后端：Express + SQLite（`better-sqlite3`）

## 本地运行

### 1) 安装依赖

```bash
npm install
npm --prefix server install
```

### 2) 一条命令同时启动前后端

```bash
npm run dev
```

启动后：

- 前端：`http://localhost:5173`
- 后端：`http://localhost:8787`

开发环境下，Vite 会将 `/api/*` 代理到 `http://localhost:8787`。

### 3) 可选：分开启动（双终端）

```bash
npm run dev:api
npm run dev:web
```

## URL 参数

- `pid`：被试编号（可选）

示例：

- `http://localhost:5173/?pid=001`

## 数据提交说明

- 前端正式实验结束后会调用：`POST /api/submissions`
- 后端入库文件默认在：`data/experiment.db`
- 同一个 `clientSessionId` 重复提交会自动去重（幂等）
- 若网络异常，前端会将提交包暂存到 `localStorage`，恢复联网后自动补传

## 导出 XLSX

### 命令行导出（保留原有行为）

- 导出全部数据：

```bash
npm run export:xlsx
```

- 按被试编号导出（例如 `pid=001`）：

```bash
npm run export:xlsx -- --pid 001
```

- 按会话 ID 导出（支持逗号列表，例如 2,3,4）：

```bash
npm run export:xlsx -- --session-id 2,3,4
```

- 按时间范围（UTC ISO，左闭右开）/任务类型/呈现方式：

```bash
npm run export:xlsx -- --from 2026-08-07T04:00:00.000Z --to 2026-08-10T00:00:00.000Z --run-kind formal --reveal-mode full
```

默认输出到：`exports/honglvdeng_export_时间戳.xlsx`

### 网站管理页导出（`/admin/`）

生产地址：`https://experiments.top/admin/`（本地：`http://localhost:5173/admin/`）

- 输入管理员令牌后可按北京时间、会话 ID、被试编号、任务类型、呈现方式筛选预览并直接下载 XLSX。
- 默认不包含 IP、User-Agent、屏幕/视口尺寸、平台、时区、语言等敏感字段，需主动勾选。
- 令牌只存 `sessionStorage`，后端只保存令牌 SHA-256 摘要。
- 管理 API 默认关闭（`EXPORT_ADMIN_ENABLED` 不为 `true` 时返回 404）。

## 后端环境变量

- `HOST`：默认 `0.0.0.0`
- `PORT`：默认 `8787`
- `DB_PATH`：默认 `<repo>/data/experiment.db`
- `CORS_ORIGIN`：可选，逗号分隔的允许来源（同域部署可不设）

### 管理导出相关

- `EXPORT_ADMIN_ENABLED`：必须为 `true` 才启用 `/api/admin/export/*`（默认关闭）
- `EXPORT_ADMIN_TOKEN_SHA256`：管理员令牌 UTF-8 字节的 SHA-256 十六进制摘要（64 字符），绝不写明文
- `EXPORT_MAX_SESSIONS` / `EXPORT_MAX_EVENTS`：单次导出上限（默认 5000 / 100000）
- `EXPORT_TIME_ZONE`：默认 `Asia/Shanghai`

生成摘要示例：

```bash
printf '%s' '你的至少32字节随机令牌' | sha256sum
```

生产配置写入 `/etc/honglvdeng-api.env`（真实值不入库不入 Git）。

## 测试

后端测试（`node:test`，无需额外框架）：

```bash
npm --prefix server test
```

## 前端环境变量

- `VITE_API_BASE_URL`：生产环境可配置 API 基地址（默认同域）
- `VITE_DEV_API_TARGET`：本地开发代理目标（默认 `http://localhost:8787`）

## 生产部署要点

1. 构建前端：`npm run build`
2. 运行后端：`npm run start:api`
3. Nginx 提供 `dist/` 静态文件，并将 `/api/` 反向代理到 `127.0.0.1:8787`

示例（核心片段）：

```nginx
location / {
  root /path/to/repo/dist;
  try_files $uri $uri/ /index.html;
}

location /api/ {
  proxy_pass http://127.0.0.1:8787;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

### 可选：GitHub 更新后自动部署（服务器轮询）

仓库内提供脚本：`ops/auto_deploy.sh`。  
建议在服务器（`ubuntu` 用户）配置 cron 每分钟执行一次：

```bash
* * * * * /opt/honglvdeng/ops/auto_deploy.sh >> /opt/honglvdeng/logs/auto-deploy.log 2>&1
```

脚本行为：

- 拉取 `origin/前后端`
- 仅在远端有新提交时执行 `pull + install + build + pm2 restart`
- 通过 `flock` 防止并发重复部署

## 示例短片

如需在练习说明页展示示例短片，请将视频文件放到：

- `public/demo.mp4`
