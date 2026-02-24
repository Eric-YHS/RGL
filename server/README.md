# API 服务

## 安装与启动

```bash
npm --prefix server install
npm --prefix server run dev
```

## 健康检查

- `GET /api/health`

## 提交接口

- `POST /api/submissions`
- `Content-Type: application/json`

请求体主要字段：

- `clientSessionId`
- `participantId`
- `startedAtIso`
- `submittedAtIso`
- `runKind`
- `revealMode`
- `comprehensionAnswer`
- `postRuleAttitude`
- `postRuleAttitudeText`
- `summary`（`elapsedSec` / `money` / `violations`）
- `device`
- `events[]`

## 数据库

默认路径：`../data/experiment.db`

表：

- `sessions`
- `events`

重复 `clientSessionId` 会去重，不会重复写入。

## 导出 XLSX

```bash
npm --prefix server run export:xlsx
```

可选参数：

- `--db <path>`：指定 sqlite 路径
- `--out <path>`：指定 xlsx 输出路径
- `--pid <id>`：按 `participant_id` 过滤
- `--session-id <id>`：按 `sessions.id` 过滤

示例：

```bash
npm --prefix server run export:xlsx -- --pid 001
npm --prefix server run export:xlsx -- --session-id 2
```
