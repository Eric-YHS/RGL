// server/test/export-filters.test.js

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildSessionWhere, escapeLikePattern, normalizeExportFilters } from "../export/filters.js";

test("normalizeExportFilters: 空输入返回全空筛选", () => {
  const result = normalizeExportFilters({});
  assert.equal(result.ok, true);
  assert.deepEqual(result.filters, {
    fromIso: null,
    toIsoExclusive: null,
    minSessionId: null,
    maxSessionId: null,
    participant: "",
    participantMatch: "contains",
    runKind: null,
    revealMode: null
  });
});

test("normalizeExportFilters: 非法 ISO 时间被拒绝", () => {
  assert.equal(normalizeExportFilters({ from: "not-a-time", to: "2026-08-08T00:00:00.000Z" }).ok, false);
  assert.equal(normalizeExportFilters({ from: "2026-08-07T00:00:00.000Z" }).ok, false, "from 与 to 必须成对");
  assert.equal(normalizeExportFilters({ from: "2026-08-08T00:00:00.000Z", to: "2026-08-07T00:00:00.000Z" }).ok, false, "反向时间范围被拒绝");
});

test("normalizeExportFilters: 会话 ID 范围校验", () => {
  assert.equal(normalizeExportFilters({ minSessionId: 0 }).ok, false);
  assert.equal(normalizeExportFilters({ maxSessionId: 1.5 }).ok, false);
  assert.equal(normalizeExportFilters({ minSessionId: 5, maxSessionId: 3 }).ok, false);
  const ok = normalizeExportFilters({ minSessionId: "3", maxSessionId: "9" });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.filters.minSessionId, 3);
  assert.deepEqual(ok.filters.maxSessionId, 9);
});

test("normalizeExportFilters: 枚举与长度校验", () => {
  assert.equal(normalizeExportFilters({ runKind: "bogus" }).ok, false);
  assert.equal(normalizeExportFilters({ revealMode: "bogus" }).ok, false);
  assert.equal(normalizeExportFilters({ participantMatch: "bogus" }).ok, false);
  assert.equal(normalizeExportFilters({ participant: "x".repeat(129) }).ok, false);
  assert.equal(normalizeExportFilters({ participant: "  abc  " }).ok, true);
});

test("buildSessionWhere: 无筛选时无 WHERE", () => {
  const { whereSql, params } = buildSessionWhere(
    normalizeExportFilters({}).filters
  );
  assert.equal(whereSql, "");
  assert.deepEqual(params, []);
});

test("buildSessionWhere: 时间使用左闭右开区间", () => {
  const { whereSql, params } = buildSessionWhere(
    normalizeExportFilters({
      from: "2026-08-07T04:00:00.000Z",
      to: "2026-08-07T16:00:00.000Z"
    }).filters
  );
  assert.match(whereSql, /s\.started_at_iso >= \?/);
  assert.match(whereSql, /s\.started_at_iso < \?/);
  assert.deepEqual(params, ["2026-08-07T04:00:00.000Z", "2026-08-07T16:00:00.000Z"]);
});

test("buildSessionWhere: 精确匹配与包含匹配", () => {
  const exact = buildSessionWhere(
    normalizeExportFilters({ participant: "S001", participantMatch: "exact" }).filters
  );
  assert.match(exact.whereSql, /s\.participant_id = \?/);
  assert.deepEqual(exact.params, ["S001"]);

  const contains = buildSessionWhere(
    normalizeExportFilters({ participant: "S00", participantMatch: "contains" }).filters
  );
  assert.match(contains.whereSql, /s\.participant_id LIKE \? ESCAPE '\\'/);
  assert.deepEqual(contains.params, ["%S00%"]);
});

test("escapeLikePattern: % _ 反斜杠全部转义", () => {
  assert.equal(escapeLikePattern("50%_x\\"), "50\\%\\_x\\\\");
  assert.equal(escapeLikePattern("plain"), "plain");
});

test("buildSessionWhere: 会话 ID 范围、任务类型、呈现方式", () => {
  const { whereSql, params } = buildSessionWhere(
    normalizeExportFilters({
      minSessionId: 42,
      maxSessionId: 50,
      runKind: "formal",
      revealMode: "sequential"
    }).filters
  );
  assert.match(whereSql, /s\.id >= \?/);
  assert.match(whereSql, /s\.id <= \?/);
  assert.match(whereSql, /s\.run_kind = \?/);
  assert.match(whereSql, /s\.reveal_mode = \?/);
  assert.deepEqual(params, [42, 50, "formal", "sequential"]);
});
