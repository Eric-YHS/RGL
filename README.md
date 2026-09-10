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
- `treatment`：干预材料编号（可选），取值为 `C1`–`C5`（控制组科普文）、`P1`–`P5`（正面治理组）、`N1`–`N5`（负面治理组）。通常由见数平台随机化后传入，与问卷中的操纵检验题目联动。

示例：

- `http://localhost:5173/?pid=001`
- `http://localhost:5173/?pid=001&treatment=N3`

未传 `treatment` 时的兜底分配：有 `pid` 则按 `pid` 确定性哈希分组（同一被试退出再进仍进入同一组）；无 `pid` 则随机分配并持久化到 `localStorage`。

## 实验流程（9.10 版）

欢迎页 → 设备与显示区域检查 → 指导语 → 理解测试（2 题）→ 任务准备 → 练习任务 → 练习完成 → **干预材料**（练习后、正式任务前展示一篇，强制最低阅读 15 秒，记录阅读时长）→ 任务准备（可返回导语/继续练习/进入决策任务）→ 正式决策任务 → 任务完成（收益明细）→ 操纵检验跳转页（不允许返回，仅前往见数问卷）。

## 数据提交说明

- 前端正式实验结束后会调用：`POST /api/submissions`
- 后端入库文件默认在：`data/experiment.db`
- 同一个 `clientSessionId` 重复提交会自动去重（幂等）
- 若网络异常，前端会将提交包暂存到 `localStorage`，恢复联网后自动补传
- 提交包含 `treatment`（干预材料编号）与 `interventionMs`（干预阅读时长毫秒）；旧库启动时自动 `ALTER TABLE` 迁移，历史行默认为空
- 「会话数据」导出表固定包含：`干预组别`、`干预材料`、`干预阅读时长_秒` 三列（位于「呈现方式」之后）

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
- 管理页导出内容由后端固定，无任何勾选控件：
  - 固定导出四张工作表，顺序为：`会话数据`、`事件明细`、`通行按键`、`闯红灯记录`（不再生成“导出说明”）；
  - 固定包含原始 UTC 时间、北京时间和敏感技术字段（IP 地址、User-Agent 原文、屏幕/视口尺寸、平台、时区、语言）；
  - 旧页面携带的 `sheets` / `includeChinaTime` / `includeSensitive` 参数会被忽略，不能改变实际结果。
- 令牌只存 `sessionStorage`，后端只保存令牌 SHA-256 摘要。
- 管理 API 默认关闭（`EXPORT_ADMIN_ENABLED` 不为 `true` 时返回 404）。
- `ids` 模式（仅导出勾选会话）为全量语义：任一指定会话 ID 不存在时整个请求返回 404，不生成部分工作簿；重复 ID 在参数校验阶段返回 400。
- 限流按可信客户端 IP 计（见下方环境变量），客户端伪造 `X-Forwarded-For` 不能绕过。

### 会话删除（`/admin/` 表格底部按钮）

- 勾选会话后在表格底部点击“删除已勾选会话（N）”，经确认后调用：

  ```http
  DELETE /api/admin/export/sessions
  Content-Type: application/json
  Authorization: Bearer <admin-token>

  { "sessionIds": [1, 2, 3, 4] }
  ```

  成功响应：`{ "ok": true, "deletedSessions": 4, "deletedEvents": 26 }`。
- `sessionIds` 必须是非空、唯一、正整数数组；空数组、重复 ID、字符串、小数、零或负数返回 `400`；超过 `EXPORT_MAX_SESSIONS` 上限返回 `413`。
- 全量存在语义：任一 ID 不存在时返回 `404` 且一个也不删除，响应不暴露具体缺失 ID；不支持按筛选条件批量删除。
- 关联事件通过 `events.session_id ... ON DELETE CASCADE` 在同一 SQLite 写事务内级联删除，任何异常都会完整回滚；删除前会校验 `PRAGMA foreign_keys = ON`。
- 删除依据始终是当前列表里的 `sessions.id`，不能用 IP、User-Agent 等易变化字段对应会话。
- 删除接口复用下载限流器（`EXPORT_DOWNLOAD_MAX_PER_10MIN`，与 `/xlsx` 共享同一额度），不新增环境变量。
- 删除不可恢复：上线前请先备份 SQLite 数据库；本轮不实现回收站和恢复功能。

## 后端环境变量

- `HOST`：默认 `0.0.0.0`
- `PORT`：默认 `8787`
- `DB_PATH`：默认 `<repo>/data/experiment.db`
- `CORS_ORIGIN`：可选，逗号分隔的允许来源（同域部署可不设）

### 管理导出相关

- `EXPORT_ADMIN_ENABLED`：必须为 `true` 才启用 `/api/admin/export/*`（默认关闭）
- `EXPORT_ADMIN_TOKEN_SHA256`：管理员令牌 UTF-8 字节的 SHA-256 十六进制摘要（64 字符），绝不写明文
- `EXPORT_MAX_SESSIONS` / `EXPORT_MAX_EVENTS`：单次导出上限（默认 5000 / 100000）；超限在读取明细前终止，返回 413
- `EXPORT_VERIFY_MAX_PER_10MIN`：`/status` 验证限流（默认每 IP 20 次/10 分钟）
- `EXPORT_PREVIEW_MAX_PER_MIN`：`/sessions` 预览限流（默认每 IP 60 次/分钟）
- `EXPORT_DOWNLOAD_MAX_PER_10MIN`：`/xlsx` 下载与 `DELETE /sessions` 删除共享限流（默认每 IP 10 次/10 分钟）
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

该命令通过 `server/test-runner.js` 跨平台启动：只运行 `server/test/` 下 `*.test.js` 文件（不把 `helpers.js` 等辅助模块计入测试数），Windows 与 Linux、Node 18 及以上均可直接执行。

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
  # 覆盖客户端传入值（不使用 $proxy_add_x_forwarded_for，避免信任用户伪造的链首地址）
  proxy_set_header X-Forwarded-For $remote_addr;
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
