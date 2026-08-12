// server/admin-export-routes.js
// 管理预览与导出路由：/status、/sessions、/xlsx。
// 复用 server/export/ 下的共享查询与生成模块，不通过子进程调用 CLI。

import { Router } from "express";

import {
  createIpRateLimiter,
  extractClientIp,
  getAdminConfig,
  requireAdmin
} from "./admin-auth.js";
import { normalizeExportFilters } from "./export/filters.js";
import { listSessions, loadExportRows, resolveSessionIds } from "./export/query.js";
import { buildSummaryRows, exportRangeCompact, transformExportRows } from "./export/transform.js";
import { buildWorkbookBuffer, SHEET_KEYS } from "./export/workbook.js";

const PAGE_SIZES = [20, 50, 100];

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

  // GET /status —— 令牌验证 + 能力信息（登录验证限流：每 IP 10 分钟 20 次）。
  router.get("/status", limiterVerify, requireAdmin, (req, res) => {
    const { timeZone, maxSessions, maxEvents } = getAdminConfig();
    res.json({ ok: true, timeZone, maxSessions, maxEvents });
  });

  // GET /sessions —— 筛选、分页、预览。
  router.get("/sessions", requireAdmin, limiterPreview, (req, res) => {
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
  router.post("/xlsx", requireAdmin, limiterDownload, (req, res) => {
    const startedAt = Date.now();
    const ipAddress = extractClientIp(req);

    const parsed = parseExportBody(req.body);
    if (!parsed.ok) {
      auditLog({ ipAddress, ok: false, reason: parsed.error, durationMs: Date.now() - startedAt });
      res.status(400).json({ ok: false, error: parsed.error });
      return;
    }
    const { selection, sheets, includeSensitive, includeChinaTime } = parsed;

    try {
      const resolved = resolveSessionIds(db, selection);

      if (selection.mode === "filters" && resolved.sessionIds.length === 0) {
        auditLog({
          ipAddress,
          ok: false,
          reason: "empty-result",
          durationMs: Date.now() - startedAt
        });
        res.status(400).json({ ok: false, error: "当前条件没有可导出的会话" });
        return;
      }

      const raw = loadExportRows(db, resolved.sessionIds);

      if (selection.mode === "ids" && raw.sessions.length === 0) {
        auditLog({
          ipAddress,
          ok: false,
          reason: "no-such-sessions",
          requestedIds: selection.sessionIds.length,
          durationMs: Date.now() - startedAt
        });
        res.status(404).json({ ok: false, error: "选择的会话不存在" });
        return;
      }

      const { maxSessions, maxEvents } = getAdminConfig();
      if (raw.sessions.length > maxSessions) {
        auditLog({
          ipAddress,
          ok: false,
          reason: "session-limit",
          sessions: raw.sessions.length,
          maxSessions,
          durationMs: Date.now() - startedAt
        });
        res
          .status(413)
          .json({ ok: false, error: `会话数超过单次导出上限（${maxSessions}），请缩小筛选范围` });
        return;
      }
      if (raw.events.length > maxEvents) {
        auditLog({
          ipAddress,
          ok: false,
          reason: "event-limit",
          events: raw.events.length,
          maxEvents,
          durationMs: Date.now() - startedAt
        });
        res
          .status(413)
          .json({ ok: false, error: `事件数超过单次导出上限（${maxEvents}），请缩小筛选范围` });
        return;
      }

      const data = transformExportRows(raw, { includeChinaTime, includeSensitive });

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
        includeSensitive
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
        { sheets }
      );

      auditLog({
        ipAddress,
        ok: true,
        mode: selection.mode,
        filters: describeFilters(selection),
        sessions: raw.sessions.length,
        events: raw.events.length,
        includeSensitive,
        includeChinaTime,
        sheets,
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
    if (!Array.isArray(body.selection.sessionIds)) {
      return fail("sessionIds must be an array");
    }
    const { maxSessions } = getAdminConfig();
    if (body.selection.sessionIds.length === 0) {
      return fail("sessionIds must not be empty");
    }
    if (body.selection.sessionIds.length > maxSessions) {
      return fail(`sessionIds exceeds maximum (${maxSessions})`);
    }
    const sessionIds = [];
    for (let i = 0; i < body.selection.sessionIds.length; i += 1) {
      const value = Number(body.selection.sessionIds[i]);
      if (!Number.isInteger(value) || value <= 0) {
        return fail(`sessionIds[${i}] must be a positive integer`);
      }
      sessionIds.push(value);
    }
    selection = { mode: "ids", sessionIds };
  } else {
    return fail('selection.mode must be "filters" or "ids"');
  }

  const sheets = readSheets(body.sheets);
  if (!sheets.ok) return sheets;

  const includeSensitive = readBoolean(body.includeSensitive, false);
  const includeChinaTime = readBoolean(body.includeChinaTime, true);

  return {
    ok: true,
    selection,
    sheets: sheets.value,
    includeSensitive,
    includeChinaTime
  };
}

function readSheets(value) {
  if (value === undefined || value === null) return success([...SHEET_KEYS]);
  if (!Array.isArray(value) || value.length === 0) {
    return fail("sheets must be a non-empty array");
  }
  const seen = new Set();
  for (const key of value) {
    if (typeof key !== "string" || !SHEET_KEYS.includes(key)) {
      return fail(`sheets must be a subset of: ${SHEET_KEYS.join(", ")}`);
    }
    seen.add(key);
  }
  return success(SHEET_KEYS.filter((key) => seen.has(key)));
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

function readBoolean(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return value === true || value === "true";
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
