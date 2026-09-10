// server/admin-export-routes.js
// 管理预览、导出与删除路由：/status、/sessions（GET 预览 / DELETE 删除）、/xlsx。
// 复用 server/export/ 下的共享查询与生成模块，不通过子进程调用 CLI。
//
// 管理页导出规则由后端固定，不依赖前端选择：
//   - 永远只生成会话数据、事件明细、通行按键、闯红灯记录四张表（无导出说明）；
//   - 永远包含原始 UTC 时间、北京时间和敏感技术字段；
//   - 旧页面携带的 sheets / includeChinaTime / includeSensitive 一律忽略。

import { Router } from "express";

import {
  adminEnabled,
  createIpRateLimiter,
  extractClientIp,
  getAdminConfig,
  requireAdmin
} from "./admin-auth.js";
import { normalizeExportFilters } from "./export/filters.js";
import { listSessions, loadExportSnapshot } from "./export/query.js";
import { buildSummaryRows, exportRangeCompact, transformExportRows } from "./export/transform.js";
import { buildWorkbookBuffer } from "./export/workbook.js";

const PAGE_SIZES = [20, 50, 100];

// 管理页导出的固定规则（后端强制，前端无对应开关）。
const ADMIN_EXPORT_SHEETS = ["sessions", "events", "walks", "violations"];
const ADMIN_INCLUDE_CHINA_TIME = true;
const ADMIN_INCLUDE_SENSITIVE = true;

export function createAdminExportRouter({ db }) {
  const router = Router();

  const limiterVerify = createIpRateLimiter({
    windowMs: 10 * 60 * 1000,
    max: readLimitEnv("EXPORT_VERIFY_MAX_PER_10MIN", 20)
  });
  const limiterPreview = createIpRateLimiter({
    windowMs: 60 * 1000,
    max: readLimitEnv("EXPORT_PREVIEW_MAX_PER_MIN", 60)
  });
  const limiterDownload = createIpRateLimiter({
    windowMs: 10 * 60 * 1000,
    max: readLimitEnv("EXPORT_DOWNLOAD_MAX_PER_10MIN", 10)
  });

  // 统一安全响应头。
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store, private");
    res.set("Pragma", "no-cache");
    res.set("X-Content-Type-Options", "nosniff");
    next();
  });

  // 功能开关检查最先执行：关闭时一律 404，不消耗限流额度（不会变成 429）。
  router.use(adminEnabled);

  // 各接口顺序固定为：功能开关 → IP 限流 → Origin 检查 → Bearer 令牌检查 → 业务处理。
  // 限流必须在令牌校验前执行，使错误/缺失令牌也不能无限尝试。

  // GET /status —— 令牌验证 + 能力信息（登录验证限流：每 IP 10 分钟 20 次）。
  router.get("/status", limiterVerify, requireAdmin, (req, res) => {
    const { timeZone, maxSessions, maxEvents } = getAdminConfig();
    res.json({ ok: true, timeZone, maxSessions, maxEvents });
  });

  // GET /sessions —— 筛选、分页、预览。
  router.get("/sessions", limiterPreview, requireAdmin, (req, res) => {
    const parsed = parsePreviewQuery(req.query);
    if (!parsed.ok) {
      res.status(400).json({ ok: false, error: parsed.error });
      return;
    }

    let result;
    try {
      result = listSessions(db, parsed.filters, {
        page: parsed.page,
        pageSize: parsed.pageSize
      });
    } catch (error) {
      console.error("[GET /api/admin/export/sessions] failed:", error);
      res.status(500).json({ ok: false, error: "Internal error" });
      return;
    }

    res.json({
      ok: true,
      total: result.total,
      page: parsed.page,
      pageSize: parsed.pageSize,
      items: result.items
    });
  });

  // POST /xlsx —— 生成并下载 XLSX（内存生成，直接响应）。
  // 四张表、北京时间和敏感字段由后端固定；旧请求携带的 sheets / includeChinaTime /
  // includeSensitive 可接收但必须忽略，不能改变实际结果。
  router.post("/xlsx", limiterDownload, requireAdmin, (req, res) => {
    const startedAt = Date.now();
    const ipAddress = extractClientIp(req);

    const parsed = parseExportBody(req.body);
    if (!parsed.ok) {
      auditLog({ ipAddress, ok: false, reason: parsed.error, durationMs: Date.now() - startedAt });
      res.status(400).json({ ok: false, error: parsed.error });
      return;
    }
    const { selection } = parsed;

    try {
      const { maxSessions, maxEvents } = getAdminConfig();
      // 在同一只读事务快照内完成：解析会话集合 → 存在性校验 → 数量上限 → 明细读取。
      const snapshot = loadExportSnapshot(db, selection, { maxSessions, maxEvents });

      if (!snapshot.ok) {
        switch (snapshot.reason) {
          case "empty-result":
            auditLog({
              ipAddress,
              ok: false,
              reason: "empty-result",
              durationMs: Date.now() - startedAt
            });
            res.status(400).json({ ok: false, error: "当前条件没有可导出的会话" });
            return;
          case "session-limit":
            auditLog({
              ipAddress,
              ok: false,
              reason: "session-limit",
              sessions: snapshot.sessionCount,
              maxSessions,
              durationMs: Date.now() - startedAt
            });
            res
              .status(413)
              .json({ ok: false, error: `会话数超过单次导出上限（${maxSessions}），请缩小筛选范围` });
            return;
          case "event-limit":
            auditLog({
              ipAddress,
              ok: false,
              reason: "event-limit",
              events: snapshot.eventCount,
              maxEvents,
              durationMs: Date.now() - startedAt
            });
            res
              .status(413)
              .json({ ok: false, error: `事件数超过单次导出上限（${maxEvents}），请缩小筛选范围` });
            return;
          case "missing-ids":
            // 不向外暴露具体缺失 ID，也不生成部分工作簿。
            auditLog({
              ipAddress,
              ok: false,
              reason: "missing-ids",
              requestedCount: snapshot.requestedCount,
              foundCount: snapshot.foundCount,
              missingCount: snapshot.missingCount,
              durationMs: Date.now() - startedAt
            });
            res.status(404).json({ ok: false, error: "选择的部分或全部会话不存在" });
            return;
          default:
            throw new Error(`unknown snapshot result: ${snapshot.reason}`);
        }
      }

      const raw = snapshot; // { sessions, events }

      const data = transformExportRows(raw, {
        includeChinaTime: ADMIN_INCLUDE_CHINA_TIME,
        includeSensitive: ADMIN_INCLUDE_SENSITIVE
      });

      const summaryMeta = {
        exportedAtIso: new Date().toISOString(),
        modeText: selection.mode === "ids" ? "仅导出勾选会话" : "导出全部筛选结果",
        filterText: describeFilters(selection),
        sessionIdsText:
          selection.mode === "ids" ? selection.sessionIds.join(", ") : "",
        sessionCount: raw.sessions.length,
        eventCount: raw.events.length,
        walkCount: data.walks.rows.length,
        violationCount: data.violations.rows.length,
        firstStartedIso: raw.sessions.length > 0 ? raw.sessions[0].started_at_iso : null,
        lastSubmittedIso: raw.sessions.length > 0
          ? raw.sessions[raw.sessions.length - 1].submitted_at_iso
          : null,
        includeSensitive: ADMIN_INCLUDE_SENSITIVE
      };

      const range = exportRangeCompact(
        summaryMeta.firstStartedIso ?? new Date().toISOString(),
        summaryMeta.lastSubmittedIso ?? new Date().toISOString()
      );
      const fileName = `honglvdeng_${range.from}_to_${range.to}_${raw.sessions.length}_sessions.xlsx`;

      const buffer = buildWorkbookBuffer(
        {
          summaryRows: buildSummaryRows(summaryMeta),
          sessions: data.sessions,
          events: data.events,
          walks: data.walks,
          violations: data.violations
        },
        { sheets: ADMIN_EXPORT_SHEETS }
      );

      auditLog({
        ipAddress,
        ok: true,
        mode: selection.mode,
        filters: describeFilters(selection),
        sessions: raw.sessions.length,
        events: raw.events.length,
        includeSensitive: ADMIN_INCLUDE_SENSITIVE,
        includeChinaTime: ADMIN_INCLUDE_CHINA_TIME,
        sheets: ADMIN_EXPORT_SHEETS,
        durationMs: Date.now() - startedAt
      });

      res.set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.set("Content-Disposition", `attachment; filename*=UTF-8''${fileName}`);
      res.send(buffer);
    } catch (error) {
      console.error("[POST /api/admin/export/xlsx] failed:", error);
      auditLog({ ipAddress, ok: false, reason: "internal", durationMs: Date.now() - startedAt });
      res.status(500).json({ ok: false, error: "导出失败，请稍后重试" });
    }
  });

  // DELETE /sessions —— 删除已勾选会话（关联事件级联删除，不可恢复）。
  // 守卫顺序与其它接口一致：功能开关 → IP 限流 → Origin → Bearer 令牌 → 参数校验 → 删除。
  // 复用下载限流器（EXPORT_DOWNLOAD_MAX_PER_10MIN），不新增环境变量。
  router.delete("/sessions", limiterDownload, requireAdmin, (req, res) => {
    const startedAt = Date.now();
    const ipAddress = extractClientIp(req);

    const parsed = parseDeleteBody(req.body);
    if (!parsed.ok) {
      // 超过 EXPORT_MAX_SESSIONS 上限返回 413，其余参数错误返回 400。
      const status = parsed.tooMany ? 413 : 400;
      auditLog({
        ipAddress,
        ok: false,
        operation: "delete-sessions",
        reason: parsed.error,
        durationMs: Date.now() - startedAt
      });
      res.status(status).json({ ok: false, error: parsed.error });
      return;
    }

    try {
      const result = deleteSessions(db, parsed.sessionIds);
      if (!result.ok) {
        // 任一 ID 不存在：一个也不删除，响应不暴露具体缺失 ID。
        auditLog({
          ipAddress,
          ok: false,
          operation: "delete-sessions",
          reason: "missing-ids",
          requestedCount: result.requestedCount,
          foundCount: result.foundCount,
          missingCount: result.missingCount,
          durationMs: Date.now() - startedAt
        });
        res.status(404).json({ ok: false, error: "选择的部分或全部会话不存在" });
        return;
      }

      auditLog({
        ipAddress,
        ok: true,
        operation: "delete-sessions",
        requestedCount: parsed.sessionIds.length,
        foundCount: parsed.sessionIds.length,
        deletedSessions: result.deletedSessions,
        deletedEvents: result.deletedEvents,
        durationMs: Date.now() - startedAt
      });

      res.json({
        ok: true,
        deletedSessions: result.deletedSessions,
        deletedEvents: result.deletedEvents
      });
    } catch (error) {
      console.error("[DELETE /api/admin/export/sessions] failed:", error);
      auditLog({
        ipAddress,
        ok: false,
        operation: "delete-sessions",
        reason: "internal",
        durationMs: Date.now() - startedAt
      });
      res.status(500).json({ ok: false, error: "删除失败，请稍后重试" });
    }
  });

  return router;
}

function parsePreviewQuery(query) {
  const from = optionalString(query.from, 64);
  const to = optionalString(query.to, 64);
  if ((from.ok && from.value !== "") !== (to.ok && to.value !== "")) {
    return fail("from and to must be provided together");
  }

  const normalized = normalizeExportFilters({
    from: from.ok && from.value ? from.value : undefined,
    to: to.ok && to.value ? to.value : undefined,
    minSessionId: query.minSessionId,
    maxSessionId: query.maxSessionId,
    participant: query.participant,
    participantMatch: query.participantMatch,
    runKind: query.runKind,
    revealMode: query.revealMode
  });
  if (!normalized.ok) return normalized;

  const page = readPositiveInt(query.page, 1, "page");
  if (!page.ok) return page;

  const rawPageSize = query.pageSize === undefined ? 50 : Number(query.pageSize);
  const pageSize = Number.isInteger(rawPageSize) && PAGE_SIZES.includes(rawPageSize)
    ? rawPageSize
    : null;
  if (pageSize === null) return fail("pageSize must be one of: 20, 50, 100");

  return {
    ok: true,
    filters: normalized.filters,
    page: page.value,
    pageSize
  };
}

function parseExportBody(body) {
  if (!isRecord(body)) return fail("body must be a JSON object");
  if (!isRecord(body.selection)) return fail("selection must be an object");

  const { mode } = body.selection;
  let selection;
  if (mode === "filters") {
    const normalized = normalizeExportFilters(body.selection.filters);
    if (!normalized.ok) return normalized;
    selection = { mode: "filters", filters: normalized.filters };
  } else if (mode === "ids") {
    const parsed = parseSessionIdList(body.selection.sessionIds, "sessionIds");
    if (!parsed.ok) return parsed;
    selection = { mode: "ids", sessionIds: parsed.ids };
  } else {
    return fail('selection.mode must be "filters" or "ids"');
  }

  // 只解析 selection。旧页面发送的 sheets / includeChinaTime / includeSensitive
  // 不读取、不校验、不影响结果；导出内容由 ADMIN_EXPORT_* 固定。
  return { ok: true, selection };
}

function parseDeleteBody(body) {
  if (!isRecord(body)) return fail("body must be a JSON object");
  const parsed = parseSessionIdList(body.sessionIds, "sessionIds");
  if (!parsed.ok) return parsed;
  return { ok: true, sessionIds: parsed.ids };
}

/**
 * 解析会话 ID 列表（导出 ids 模式与删除接口共用）：
 * 非空数组、每项严格为 JSON number 类型的唯一正整数（不接收数字字符串，
 * 不做任何隐式/显式字符串转数字转换）；超过 EXPORT_MAX_SESSIONS 时 tooMany 为 true（删除接口返回 413）。
 */
function parseSessionIdList(value, name) {
  if (!Array.isArray(value)) return fail(`${name} must be an array`);
  if (value.length === 0) return fail(`${name} must not be empty`);
  const { maxSessions } = getAdminConfig();
  if (value.length > maxSessions) {
    return { ok: false, error: `${name} exceeds maximum (${maxSessions})`, tooMany: true };
  }
  const ids = [];
  const seen = new Set();
  for (let i = 0; i < value.length; i += 1) {
    // 按原始值严格校验：数字字符串（如 "42"）、布尔、null、小数、零、负数一律 400。
    const raw = value[i];
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
      return fail(`${name}[${i}] must be a positive integer`);
    }
    if (seen.has(raw)) {
      // 重复 ID 在参数校验阶段拒绝，避免“请求数量”与“删除/导出数量”口径不一致。
      return fail(`${name}[${i}] must not contain duplicates`);
    }
    seen.add(raw);
    ids.push(raw);
  }
  return { ok: true, ids };
}

// ---------------------------------------------------------------------------
// 会话删除（单写事务，级联删除关联事件）
// ---------------------------------------------------------------------------

// 会话 ID 用 json_each 展开，避免 SQLite 999 个绑定变量的上限。
function idListWhere(alias, column, json) {
  return {
    sql: `${alias}.${column} IN (SELECT CAST(value AS INTEGER) FROM json_each(?))`,
    params: [json]
  };
}

/** 统计给定会话 ID 中有多少个真实存在。 */
function countExistingSessions(db, sessionIds) {
  const where = idListWhere("s", "id", JSON.stringify(sessionIds));
  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM sessions s WHERE ${where.sql}`)
    .get(...where.params);
  return total;
}

/**
 * 在单个 SQLite 写事务内删除会话：
 * 1. 确认 PRAGMA foreign_keys = ON（保证 events 级联删除生效）。
 * 2. 一次性检查所有 sessionIds 是否存在；任一缺失返回 missing-ids，一个也不删除。
 * 3. 删除前统计这些会话的事件数量。
 * 4. 删除 sessions，events 由 ON DELETE CASCADE 自动删除。
 * 5. 校验实际删除的会话数与请求数一致，否则抛错回滚。
 * 返回 { ok: false, reason: "missing-ids", ... } 或 { ok: true, deletedSessions, deletedEvents }。
 */
function deleteSessions(db, sessionIds) {
  return db.transaction(() => {
    if (db.pragma("foreign_keys", { simple: true }) !== 1) {
      throw new Error("PRAGMA foreign_keys must be ON before deleting sessions");
    }

    const found = countExistingSessions(db, sessionIds);
    if (found !== sessionIds.length) {
      return {
        ok: false,
        reason: "missing-ids",
        requestedCount: sessionIds.length,
        foundCount: found,
        missingCount: sessionIds.length - found
      };
    }

    const json = JSON.stringify(sessionIds);
    const eventWhere = idListWhere("e", "session_id", json);
    const { total: deletedEvents } = db
      .prepare(`SELECT COUNT(*) AS total FROM events e WHERE ${eventWhere.sql}`)
      .get(...eventWhere.params);

    // SQLite 的 DELETE 不支持表别名，改用无别名的等价写法。
    const info = db
      .prepare(`DELETE FROM sessions WHERE id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))`)
      .run(json);
    if (info.changes !== sessionIds.length) {
      throw new Error(`deleted ${info.changes} sessions, expected ${sessionIds.length}`);
    }

    // 级联删除兜底校验：这些会话的事件必须已全部消失，否则回滚。
    const { total: remaining } = db
      .prepare(`SELECT COUNT(*) AS total FROM events e WHERE ${eventWhere.sql}`)
      .get(...eventWhere.params);
    if (remaining !== 0) {
      throw new Error(`cascade delete incomplete: ${remaining} events remain`);
    }

    return { ok: true, deletedSessions: info.changes, deletedEvents };
  })();
}


function describeFilters(selection) {
  if (selection.mode === "ids") {
    return `指定会话 ID（${selection.sessionIds.length} 个）`;
  }
  const f = selection.filters;
  const parts = [];
  if (f.fromIso) parts.push(`开始时间 ≥ ${f.fromIso}（UTC）`);
  if (f.toIsoExclusive) parts.push(`开始时间 < ${f.toIsoExclusive}（UTC）`);
  if (f.minSessionId !== null || f.maxSessionId !== null) {
    parts.push(`会话 ID ∈ [${f.minSessionId ?? "-"}, ${f.maxSessionId ?? "-"}]`);
  }
  if (f.participant) {
    parts.push(
      `被试编号${f.participantMatch === "exact" ? "精确" : "包含"} "${f.participant}"`
    );
  }
  if (f.runKind) parts.push(`任务类型: ${f.runKind === "formal" ? "正式实验" : "练习"}`);
  if (f.revealMode) parts.push(`呈现方式: ${f.revealMode === "full" ? "全呈现" : "逐个呈现"}`);
  return parts.length > 0 ? parts.join("；") : "无筛选条件（全部会话）";
}

function auditLog(entry) {
  console.log(JSON.stringify({ audit: "admin-export", at: new Date().toISOString(), ...entry }));
}

function optionalString(value, max) {
  if (value === undefined || value === null) return success("");
  if (typeof value !== "string") return fail("must be a string");
  if (value.length > max) return fail(`must be <= ${max} chars`);
  return success(value);
}

function readPositiveInt(value, fallback, name) {
  if (value === undefined || value === null || value === "") return success(fallback);
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return fail(`${name} must be a positive integer`);
  return success(n);
}

function readLimitEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function fail(error) {
  return { ok: false, error };
}

function success(value) {
  return { ok: true, value };
}
