// server/export/filters.js
// 参数校验、筛选条件标准化、SQL WHERE 构造。
// CLI 与网站 API 共用：先 normalizeExportFilters 校验并标准化，再 buildSessionWhere 生成 SQL。

export const RUN_KINDS = ["practice", "formal"];
export const REVEAL_MODES = ["full", "sequential"];
export const PARTICIPANT_MATCHES = ["exact", "contains"];
export const MAX_PARTICIPANT_LEN = 128;
export const MAX_SESSION_ID = 2_147_483_647;

/**
 * 校验并标准化筛选输入。
 * 输入（全部可选）：
 *   from, to           UTC ISO 字符串，成对出现，左闭右开（started_at_iso >= from 且 < to）
 *   minSessionId, maxSessionId  正整数
 *   participant        被试编号搜索词（trim 后可为空 = 不筛选）
 *   participantMatch   "exact" | "contains"（默认 "contains"）
 *   runKind            "practice" | "formal"
 *   revealMode         "full" | "sequential"
 * 返回 { ok: true, filters } 或 { ok: false, error }。
 */
export function normalizeExportFilters(input) {
  if (!isRecord(input)) return fail("filters must be an object");

  let fromIso = null;
  let toIsoExclusive = null;
  if (input.from !== undefined || input.to !== undefined) {
    if (typeof input.from !== "string" || typeof input.to !== "string") {
      return fail("from and to must both be ISO time strings");
    }
    fromIso = parseIso(input.from);
    if (!fromIso) return fail("from must be a valid ISO time");
    toIsoExclusive = parseIso(input.to);
    if (!toIsoExclusive) return fail("to must be a valid ISO time");
    if (fromIso >= toIsoExclusive) return fail("from must be earlier than to");
  }

  const minSessionId = optionalInt(input.minSessionId, 1, MAX_SESSION_ID, "minSessionId");
  if (!minSessionId.ok) return minSessionId;
  const maxSessionId = optionalInt(input.maxSessionId, 1, MAX_SESSION_ID, "maxSessionId");
  if (!maxSessionId.ok) return maxSessionId;
  if (minSessionId.value !== null && maxSessionId.value !== null && minSessionId.value > maxSessionId.value) {
    return fail("minSessionId must be <= maxSessionId");
  }

  const participant = optionalString(input.participant, MAX_PARTICIPANT_LEN, "participant");
  if (!participant.ok) return participant;

  const participantMatch = optionalEnum(input.participantMatch, PARTICIPANT_MATCHES, "contains");
  if (!participantMatch.ok) return participantMatch;

  const runKind = optionalEnum(input.runKind, RUN_KINDS, null);
  if (!runKind.ok) return runKind;

  const revealMode = optionalEnum(input.revealMode, REVEAL_MODES, null);
  if (!revealMode.ok) return revealMode;

  return {
    ok: true,
    filters: {
      fromIso,
      toIsoExclusive,
      minSessionId: minSessionId.value,
      maxSessionId: maxSessionId.value,
      participant: participant.value,
      participantMatch: participantMatch.value,
      runKind: runKind.value,
      revealMode: revealMode.value
    }
  };
}

/**
 * 构造针对别名 s 的 WHERE 子句（参数全部使用占位符绑定，不拼接用户文本）。
 */
export function buildSessionWhere(filters) {
  const clauses = [];
  const params = [];

  if (filters.fromIso !== null) {
    clauses.push("s.started_at_iso >= ?");
    params.push(filters.fromIso);
  }
  if (filters.toIsoExclusive !== null) {
    clauses.push("s.started_at_iso < ?");
    params.push(filters.toIsoExclusive);
  }
  if (filters.minSessionId !== null) {
    clauses.push("s.id >= ?");
    params.push(filters.minSessionId);
  }
  if (filters.maxSessionId !== null) {
    clauses.push("s.id <= ?");
    params.push(filters.maxSessionId);
  }
  if (filters.participant) {
    if (filters.participantMatch === "exact") {
      clauses.push("s.participant_id = ?");
      params.push(filters.participant);
    } else {
      clauses.push("s.participant_id LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLikePattern(filters.participant)}%`);
    }
  }
  if (filters.runKind !== null) {
    clauses.push("s.run_kind = ?");
    params.push(filters.runKind);
  }
  if (filters.revealMode !== null) {
    clauses.push("s.reveal_mode = ?");
    params.push(filters.revealMode);
  }

  return {
    whereSql: clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`,
    params
  };
}

// 转义 LIKE 通配符 %、_ 以及转义符本身（\\），保证 contains 匹配按字面处理。
export function escapeLikePattern(value) {
  return String(value).replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function parseIso(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString();
}

function optionalInt(value, min, max, name) {
  if (value === undefined || value === null || value === "") return success(null);
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    return fail(`${name} must be an integer in [${min}, ${max}]`);
  }
  return success(n);
}

function optionalString(value, max, name) {
  if (value === undefined || value === null) return success("");
  if (typeof value !== "string") return fail(`${name} must be a string`);
  const normalized = value.trim();
  if (normalized.length > max) return fail(`${name} must be <= ${max} chars`);
  return success(normalized);
}

function optionalEnum(value, allowed, fallback) {
  if (value === undefined || value === null || value === "") return success(fallback);
  if (typeof value !== "string" || !allowed.includes(value)) {
    return fail(`must be one of: ${allowed.join(", ")}`);
  }
  return success(value);
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
