// src/admin-export.ts
// /admin/ 导出管理页面：令牌验证 → 筛选 → 预览 → 导出 XLSX。
// 所有数据库文本用 textContent 渲染，不使用 innerHTML；令牌只存 sessionStorage。

import "./admin-export.css";

const TOKEN_KEY = "honglvdeng_admin_token_v1";
const PAGE_SIZE = 50;
const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000; // Asia/Shanghai 固定 UTC+8

const apiBase = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");
const apiUrl = (path: string): string => (apiBase ? `${apiBase}${path}` : path);

// ---------------------------------------------------------------------------
// 类型与状态
// ---------------------------------------------------------------------------

type PreviewItem = {
  id: number;
  participantId: string;
  startedAtChina: string;
  submittedAtChina: string;
  elapsedSec: number;
  money: number;
  violations: number;
  eventCount: number;
  runKind: string;
  revealMode: string;
};

type StatusInfo = {
  timeZone: string;
  maxSessions: number;
  maxEvents: number;
};

type Filters = {
  fromIso: string | null;
  toIso: string | null;
  minId: number | null;
  maxId: number | null;
  participant: string;
  match: "exact" | "contains";
  runKind: "" | "formal" | "practice";
  revealMode: "" | "full" | "sequential";
};

const state = {
  token: sessionStorage.getItem(TOKEN_KEY) ?? "",
  status: null as StatusInfo | null,
  filters: null as Filters | null,
  page: 1,
  total: 0,
  items: [] as PreviewItem[],
  selection: new Set<number>(),
  downloading: false
};

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: Array<Node | string> = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 当前北京时间（无论浏览器时区）。 */
function beijingNow(): Date {
  return new Date(Date.now() + CHINA_OFFSET_MS);
}

/** 北京时间日期 "YYYY-MM-DD"。 */
function beijingDate(date: Date): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/** 北京时间本地输入（datetime-local）→ UTC ISO；非法输入返回 null。 */
function chinaLocalToUtcIso(local: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h) - 8, Number(mi));
  return new Date(utc).toISOString();
}

function setMessage(node: HTMLElement | null, text: string, kind: "ok" | "err" | "" = "") {
  if (!node) return;
  node.textContent = text;
  node.className = `status-line${kind === "ok" ? " ok" : kind === "err" ? " err" : ""}`;
}

function friendlyError(status: number, error: string): string {
  switch (status) {
    case 400:
    case 404:
    case 413:
      return error || "请求参数不合法";
    case 401:
      return "令牌无效或已过期，请重新验证";
    case 403:
      return "来源不被允许，请从实验网站域名访问";
    case 429:
      return "操作过于频繁，请稍后再试";
    default:
      return "服务器内部错误，请稍后重试";
  }
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (body && typeof body.error === "string" && body.error) {
      return friendlyError(res.status, body.error);
    }
  } catch {
    // 非 JSON 响应
  }
  return `请求失败（HTTP ${res.status}）`;
}

function handleUnauthorized() {
  state.token = "";
  sessionStorage.removeItem(TOKEN_KEY);
  showAuthSection();
  setMessage(authStatus, "令牌无效或已过期，请重新验证", "err");
}

async function apiRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${state.token}`);
  const res = await fetch(apiUrl(path), { ...init, headers });
  if (res.status === 401) handleUnauthorized();
  return res;
}

// ---------------------------------------------------------------------------
// DOM 引用
// ---------------------------------------------------------------------------

const app = document.getElementById("admin-app")!;
let authSection: HTMLElement;
let authStatus: HTMLElement;
let tokenInput: HTMLInputElement;
let mainSection: HTMLElement;
let fromInput: HTMLInputElement;
let toInput: HTMLInputElement;
let minIdInput: HTMLInputElement;
let maxIdInput: HTMLInputElement;
let participantInput: HTMLInputElement;
let matchSelect: HTMLSelectElement;
let runKindSelect: HTMLSelectElement;
let revealModeSelect: HTMLSelectElement;
let filterStatus: HTMLElement;
let previewSummary: HTMLElement;
let previewBody: HTMLElement;
let pageInfo: HTMLElement;
let prevPageBtn: HTMLButtonElement;
let nextPageBtn: HTMLButtonElement;
let selectPageBtn: HTMLButtonElement;
let clearSelectionBtn: HTMLButtonElement;
let chinaTimeCheckbox: HTMLInputElement;
let sensitiveCheckbox: HTMLInputElement;
let limitHint: HTMLElement;
let exportAllBtn: HTMLButtonElement;
let exportSelectedBtn: HTMLButtonElement;
let downloadStatus: HTMLElement;
let sheetCheckboxes: Array<{ key: string; input: HTMLInputElement }> = [];
let selectAllInput: HTMLInputElement;

// ---------------------------------------------------------------------------
// 页面构建
// ---------------------------------------------------------------------------

function buildPage() {
  app.replaceChildren();

  const header = el("header", { class: "page-header" }, [
    el("h1", {}, ["红绿灯实验 · 数据导出管理"]),
    el(
      "p",
      { class: "page-sub" },
      ["仅供管理员使用；页面不对外公开，实验页面不提供入口。"]
    )
  ]);
  app.append(header);

  // A. 管理员验证
  authSection = el("section", { class: "card" });
  tokenInput = el("input", {
    id: "token-input",
    type: "password",
    placeholder: "管理员令牌",
    autocomplete: "off",
    spellcheck: "false"
  }) as HTMLInputElement;
  const verifyBtn = el("button", { class: "primary", id: "verify-btn" }, ["验证"]);
  authStatus = el("p", { class: "status-line", id: "auth-status" });
  authSection.append(
    el("h2", {}, ["管理员验证"]),
    el("p", { class: "hint" }, ["输入管理员导出令牌后开始使用。令牌仅保存在当前标签页，关闭标签页后失效。"]),
    el("div", { class: "row" }, [tokenInput, verifyBtn]),
    authStatus
  );
  app.append(authSection);

  // B/C/D. 主区域
  mainSection = el("section", { id: "main-section" });
  mainSection.hidden = true;
  app.append(mainSection);

  // B. 筛选条件
  fromInput = el("input", { type: "datetime-local", id: "from-input" }) as HTMLInputElement;
  toInput = el("input", { type: "datetime-local", id: "to-input" }) as HTMLInputElement;
  minIdInput = el("input", { type: "number", min: "1", placeholder: "不限", id: "min-id" }) as HTMLInputElement;
  maxIdInput = el("input", { type: "number", min: "1", placeholder: "不限", id: "max-id" }) as HTMLInputElement;
  participantInput = el("input", { type: "text", placeholder: "被试编号", id: "participant-input" }) as HTMLInputElement;
  matchSelect = el("select", { id: "match-select" }, [el("option", { value: "contains" }, ["包含"]), el("option", { value: "exact" }, ["精确"])]) as HTMLSelectElement;
  runKindSelect = el("select", { id: "run-kind" }, [el("option", { value: "" }, ["全部"]), el("option", { value: "formal" }, ["正式实验"]), el("option", { value: "practice" }, ["练习"])]) as HTMLSelectElement;
  revealModeSelect = el("select", { id: "reveal-mode" }, [el("option", { value: "" }, ["全部"]), el("option", { value: "full" }, ["全呈现"]), el("option", { value: "sequential" }, ["逐个呈现"])]) as HTMLSelectElement;

  const quickBtns = el("div", { class: "quick-btns" });
  const quickDefs: Array<[string, () => void]> = [
    ["今天", () => setQuickRange(1)],
    ["最近 7 天", () => setQuickRange(7)],
    ["最近 30 天", () => setQuickRange(30)],
    ["全部", () => clearQuickRange()]
  ];
  for (const [label, handler] of quickDefs) {
    const btn = el("button", { class: "quick" }, [label]);
    btn.addEventListener("click", handler);
    quickBtns.append(btn);
  }

  const queryBtn = el("button", { class: "primary", id: "query-btn" }, ["查询"]);
  const resetBtn = el("button", { id: "reset-btn" }, ["重置"]);
  filterStatus = el("p", { class: "status-line", id: "filter-status" });

  const filterCard = el("section", { class: "card" }, [
    el("h2", {}, ["筛选条件"]),
    el("div", { class: "filter-group" }, [el("span", { class: "label" }, ["快捷时间"]), quickBtns]),
    el("div", { class: "filter-grid" }, [
      el("label", {}, [el("span", {}, ["开始时间（北京时间）"]), fromInput]),
      el("label", {}, [el("span", {}, ["结束时间（北京时间，不含该时刻）"]), toInput]),
      el("label", {}, [el("span", {}, ["最小会话 ID"]), minIdInput]),
      el("label", {}, [el("span", {}, ["最大会话 ID"]), maxIdInput]),
      el("label", {}, [el("span", {}, ["被试编号"]), participantInput]),
      el("label", {}, [el("span", {}, ["匹配方式"]), matchSelect]),
      el("label", {}, [el("span", {}, ["任务类型"]), runKindSelect]),
      el("label", {}, [el("span", {}, ["呈现方式"]), revealModeSelect])
    ]),
    el("div", { class: "row" }, [queryBtn, resetBtn, filterStatus])
  ]);
  mainSection.append(filterCard);

  // C. 会话预览表
  selectAllInput = el("input", { type: "checkbox", id: "select-all" }) as HTMLInputElement;
  previewBody = el("tbody", { id: "preview-body" });
  previewSummary = el("p", { class: "status-line", id: "preview-summary" });
  pageInfo = el("span", { class: "page-info", id: "page-info" });
  prevPageBtn = el("button", { id: "prev-page" }, ["上一页"]) as HTMLButtonElement;
  nextPageBtn = el("button", { id: "next-page" }, ["下一页"]) as HTMLButtonElement;
  selectPageBtn = el("button", { id: "select-page-btn" }, ["全选当前页"]) as HTMLButtonElement;
  clearSelectionBtn = el("button", { id: "clear-selection-btn" }, ["清空选择"]) as HTMLButtonElement;

  const table = el("table", { class: "preview-table" }, [
    el("thead", {}, [
      el("tr", {}, [
        el("th", { class: "col-check" }, [selectAllInput]),
        el("th", {}, ["会话 ID"]),
        el("th", {}, ["被试编号"]),
        el("th", {}, ["开始时间（北京）"]),
        el("th", {}, ["提交时间（北京）"]),
        el("th", {}, ["实验总用时"]),
        el("th", {}, ["最终金额"]),
        el("th", {}, ["闯红灯次数"]),
        el("th", {}, ["事件条数"]),
        el("th", {}, ["任务类型"]),
        el("th", {}, ["呈现方式"])
      ])
    ]),
    previewBody
  ]);

  const previewCard = el("section", { class: "card" }, [
    el("h2", {}, ["会话预览"]),
    previewSummary,
    table,
    el("div", { class: "row" }, [pageInfo, prevPageBtn, nextPageBtn, el("span", { class: "spacer" }), selectPageBtn, clearSelectionBtn])
  ]);
  mainSection.append(previewCard);

  // D. 导出选项
  chinaTimeCheckbox = el("input", { type: "checkbox", id: "china-time" }) as HTMLInputElement;
  chinaTimeCheckbox.checked = true;
  sensitiveCheckbox = el("input", { type: "checkbox", id: "sensitive" }) as HTMLInputElement;
  const sheetContainer = el("div", { class: "checkbox-group" });
  const sheetDefs: Array<[string, string]> = [
    ["summary", "导出说明"],
    ["sessions", "会话数据"],
    ["events", "事件明细"],
    ["walks", "通行按键"],
    ["violations", "闯红灯记录"]
  ];
  sheetCheckboxes = sheetDefs.map(([key, label]) => {
    const input = el("input", { type: "checkbox" }) as HTMLInputElement;
    input.checked = true;
    const wrap = el("label", { class: "checkbox" }, [input, el("span", {}, [label])]);
    sheetContainer.append(wrap);
    return { key, input };
  });

  limitHint = el("p", { class: "status-line hint", id: "limit-hint" });
  exportAllBtn = el("button", { class: "primary", id: "export-all-btn" }, ["导出全部筛选结果"]) as HTMLButtonElement;
  exportSelectedBtn = el("button", { id: "export-selected-btn" }, ["仅导出已勾选会话"]) as HTMLButtonElement;
  downloadStatus = el("p", { class: "status-line", id: "download-status" });

  const exportCard = el("section", { class: "card" }, [
    el("h2", {}, ["导出"]),
    el("div", { class: "filter-group" }, [el("span", { class: "label" }, ["工作表"]), sheetContainer]),
    el("label", { class: "checkbox" }, [chinaTimeCheckbox, el("span", {}, ["增加北京时间列（同时保留原始 UTC 时间）"])]),
    el("label", { class: "checkbox" }, [
      sensitiveCheckbox,
      el("span", {}, ["包含敏感技术字段（IP 地址、User-Agent 原文、屏幕/视口尺寸、平台、时区、语言）"])
    ]),
    limitHint,
    el("div", { class: "row" }, [exportAllBtn, exportSelectedBtn]),
    downloadStatus
  ]);
  mainSection.append(exportCard);

  // 事件绑定
  verifyBtn.addEventListener("click", verifyToken);
  tokenInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") verifyToken();
  });
  queryBtn.addEventListener("click", runQuery);
  resetBtn.addEventListener("click", resetFilters);
  selectAllInput.addEventListener("change", () => toggleSelectPage(selectAllInput.checked));
  selectPageBtn.addEventListener("click", () => toggleSelectPage(true));
  clearSelectionBtn.addEventListener("click", () => {
    state.selection.clear();
    renderPreview();
  });
  prevPageBtn.addEventListener("click", () => {
    if (state.page > 1) {
      state.page -= 1;
      runPreview();
    }
  });
  nextPageBtn.addEventListener("click", () => {
    const maxPage = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
    if (state.page < maxPage) {
      state.page += 1;
      runPreview();
    }
  });
  exportAllBtn.addEventListener("click", () => exportXlsx({ mode: "filters", filters: state.filters! }));
  exportSelectedBtn.addEventListener("click", () => {
    if (state.selection.size === 0) return;
    exportXlsx({ mode: "ids", sessionIds: [...state.selection].sort((a, b) => a - b) });
  });
  sensitiveCheckbox.addEventListener("change", () => {
    if (sensitiveCheckbox.checked) {
      const ok = window.confirm(
        "包含敏感技术字段后，导出文件将包含 IP 地址、User-Agent 原文、屏幕/视口尺寸、平台、时区、语言等个人信息。确认继续？"
      );
      if (!ok) sensitiveCheckbox.checked = false;
    }
  });

  if (state.token) {
    verifyToken();
  } else {
    showAuthSection();
  }
}

function showAuthSection() {
  mainSection.hidden = true;
  authSection.hidden = false;
  tokenInput.focus();
}

function showMainSection() {
  authSection.hidden = true;
  mainSection.hidden = false;
  limitHint.textContent = `单次导出上限：${state.status?.maxSessions ?? 5000} 个会话 / ${state.status?.maxEvents ?? 100000} 个事件；时间按北京时间（UTC+8）解释。`;
}

// ---------------------------------------------------------------------------
// 认证
// ---------------------------------------------------------------------------

async function verifyToken() {
  const raw = tokenInput.value.trim();
  if (!raw) {
    setMessage(authStatus, "请输入管理员令牌", "err");
    return;
  }
  setMessage(authStatus, "正在验证…", "");
  try {
    const res = await fetch(apiUrl("/api/admin/export/status"), {
      headers: { Authorization: `Bearer ${raw}` }
    });
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      setMessage(authStatus, await readErrorMessage(res), "err");
      return;
    }
    if (!res.ok) {
      setMessage(authStatus, await readErrorMessage(res), "err");
      return;
    }
    const body = (await res.json()) as { ok: boolean; timeZone: string; maxSessions: number; maxEvents: number };
    state.token = raw;
    sessionStorage.setItem(TOKEN_KEY, raw);
    state.status = { timeZone: body.timeZone, maxSessions: body.maxSessions, maxEvents: body.maxEvents };
    showMainSection();
    await runQuery();
  } catch {
    setMessage(authStatus, "网络错误，无法连接服务器", "err");
  }
}

// ---------------------------------------------------------------------------
// 筛选与预览
// ---------------------------------------------------------------------------

function readFilters(): Filters | null {
  const from = chinaLocalToUtcIso(fromInput.value);
  const to = chinaLocalToUtcIso(toInput.value);
  if (fromInput.value && !from) {
    setMessage(filterStatus, "开始时间格式不正确", "err");
    return null;
  }
  if (toInput.value && !to) {
    setMessage(filterStatus, "结束时间格式不正确", "err");
    return null;
  }
  if (from && to && from >= to) {
    setMessage(filterStatus, "开始时间必须早于结束时间", "err");
    return null;
  }
  const minId = minIdInput.value ? Number(minIdInput.value) : null;
  const maxId = maxIdInput.value ? Number(maxIdInput.value) : null;
  if ((minId !== null && (!Number.isInteger(minId) || minId < 1)) || (maxId !== null && (!Number.isInteger(maxId) || maxId < 1))) {
    setMessage(filterStatus, "会话 ID 必须是正整数", "err");
    return null;
  }
  if (minId !== null && maxId !== null && minId > maxId) {
    setMessage(filterStatus, "最小会话 ID 不能大于最大会话 ID", "err");
    return null;
  }
  return {
    fromIso: from,
    toIso: to,
    minId,
    maxId,
    participant: participantInput.value.trim(),
    match: matchSelect.value === "exact" ? "exact" : "contains",
    runKind: runKindSelect.value as Filters["runKind"],
    revealMode: revealModeSelect.value as Filters["revealMode"]
  };
}

async function runQuery() {
  const filters = readFilters();
  if (!filters) return;
  state.filters = filters;
  state.page = 1;
  await runPreview();
}

function setQuickRange(days: number) {
  const now = beijingNow();
  const from = new Date(now.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
  from.setUTCHours(0, 0, 0, 0);
  const to = new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
  fromInput.value = `${beijingDate(from)}T00:00`;
  toInput.value = `${beijingDate(to)}T00:00`;
  runQuery();
}

function clearQuickRange() {
  fromInput.value = "";
  toInput.value = "";
  runQuery();
}

function resetFilters() {
  fromInput.value = "";
  toInput.value = "";
  minIdInput.value = "";
  maxIdInput.value = "";
  participantInput.value = "";
  matchSelect.value = "contains";
  runKindSelect.value = "";
  revealModeSelect.value = "";
  state.selection.clear();
  runQuery();
}

function buildQueryString(filters: Filters): string {
  const params = new URLSearchParams();
  if (filters.fromIso) params.set("from", filters.fromIso);
  if (filters.toIso) params.set("to", filters.toIso);
  if (filters.minId !== null) params.set("minSessionId", String(filters.minId));
  if (filters.maxId !== null) params.set("maxSessionId", String(filters.maxId));
  if (filters.participant) {
    params.set("participant", filters.participant);
    params.set("participantMatch", filters.match);
  }
  if (filters.runKind) params.set("runKind", filters.runKind);
  if (filters.revealMode) params.set("revealMode", filters.revealMode);
  params.set("page", String(state.page));
  params.set("pageSize", String(PAGE_SIZE));
  return params.toString();
}

async function runPreview() {
  if (!state.filters) return;
  setMessage(filterStatus, "查询中…", "");
  try {
    const res = await apiRequest(`/api/admin/export/sessions?${buildQueryString(state.filters)}`);
    if (!res.ok) {
      setMessage(filterStatus, await readErrorMessage(res), "err");
      renderPreview();
      return;
    }
    const body = (await res.json()) as { ok: boolean; total: number; page: number; items: PreviewItem[] };
    state.total = body.total;
    state.items = body.items;
    setMessage(filterStatus, "", "");
    renderPreview();
  } catch {
    setMessage(filterStatus, "网络错误，无法连接服务器", "err");
  }
}

function renderPreview() {
  const maxPage = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
  setMessage(
    previewSummary,
    `筛选命中 ${state.total} 条，已勾选 ${state.selection.size} 条${describeActiveFilters()}`,
    ""
  );
  pageInfo.textContent = `第 ${state.page} / ${maxPage} 页（每页 ${PAGE_SIZE} 条）`;
  prevPageBtn.disabled = state.page <= 1;
  nextPageBtn.disabled = state.page >= maxPage;

  previewBody.replaceChildren();
  selectAllInput.checked = state.items.length > 0 && state.items.every((item) => state.selection.has(item.id));

  for (const item of state.items) {
    const checkbox = el("input", { type: "checkbox" }) as HTMLInputElement;
    checkbox.checked = state.selection.has(item.id);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selection.add(item.id);
      else state.selection.delete(item.id);
      renderPreview();
    });
    const tr = el("tr", {}, [
      el("td", { class: "col-check" }, [checkbox]),
      el("td", { class: "num" }, [String(item.id)]),
      el("td", {}, [item.participantId || "—"]),
      el("td", {}, [item.startedAtChina]),
      el("td", {}, [item.submittedAtChina]),
      el("td", { class: "num" }, [`${item.elapsedSec.toFixed(1)} 秒`]),
      el("td", { class: "num" }, [`${item.money.toFixed(2)} 元`]),
      el("td", { class: "num" }, [String(item.violations)]),
      el("td", { class: "num" }, [String(item.eventCount)]),
      el("td", {}, [item.runKind === "formal" ? "正式实验" : item.runKind === "practice" ? "练习" : "—"]),
      el("td", {}, [item.revealMode === "full" ? "全呈现" : item.revealMode === "sequential" ? "逐个呈现" : "—"])
    ]);
    previewBody.append(tr);
  }

  if (state.items.length === 0) {
    const tr = el("tr", {}, [el("td", { colspan: "11", class: "empty" }, ["没有匹配的会话"])]);
    previewBody.append(tr);
  }

  exportAllBtn.disabled = state.total === 0 || state.downloading;
  exportSelectedBtn.disabled = state.selection.size === 0 || state.downloading;
  selectPageBtn.disabled = state.items.length === 0;
  clearSelectionBtn.disabled = state.selection.size === 0;
}

function toggleSelectPage(checked: boolean) {
  for (const item of state.items) {
    if (checked) state.selection.add(item.id);
    else state.selection.delete(item.id);
  }
  renderPreview();
}

function describeActiveFilters(): string {
  const f = state.filters;
  if (!f) return "";
  const parts: string[] = [];
  if (f.fromIso || f.toIso) {
    const fromText = f.fromIso ? toChinaText(f.fromIso) : "不限";
    const toText = f.toIso ? toChinaText(f.toIso) : "不限";
    parts.push(`时间 ${fromText} 至 ${toText}`);
  }
  if (f.minId !== null || f.maxId !== null) {
    parts.push(`会话 ID ${f.minId ?? "不限"}–${f.maxId ?? "不限"}`);
  }
  if (f.participant) parts.push(`被试编号${f.match === "exact" ? "精确" : "包含"}“${f.participant}”`);
  if (f.runKind) parts.push(`任务类型：${f.runKind === "formal" ? "正式实验" : "练习"}`);
  if (f.revealMode) parts.push(`呈现方式：${f.revealMode === "full" ? "全呈现" : "逐个呈现"}`);
  return parts.length > 0 ? `（${parts.join("；")}）` : "（全部会话）";
}

function toChinaText(iso: string): string {
  const d = new Date(Date.parse(iso) + CHINA_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(
    d.getUTCHours()
  )}:${pad2(d.getUTCMinutes())}`;
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

type ExportSelection =
  | { mode: "filters"; filters: Filters }
  | { mode: "ids"; sessionIds: number[] };

async function exportXlsx(selection: ExportSelection) {
  if (state.downloading) return;
  const sheets = sheetCheckboxes.filter((entry) => entry.input.checked).map((entry) => entry.key);
  const payload = {
    selection: selection.mode === "filters"
      ? {
          mode: "filters",
          filters: {
            from: selection.filters.fromIso ?? undefined,
            to: selection.filters.toIso ?? undefined,
            minSessionId: selection.filters.minId ?? undefined,
            maxSessionId: selection.filters.maxId ?? undefined,
            participant: selection.filters.participant || undefined,
            participantMatch: selection.filters.match,
            runKind: selection.filters.runKind || undefined,
            revealMode: selection.filters.revealMode || undefined
          }
        }
      : selection,
    sheets,
    includeSensitive: sensitiveCheckbox.checked,
    includeChinaTime: chinaTimeCheckbox.checked
  };

  state.downloading = true;
  renderPreview();
  setMessage(downloadStatus, "正在生成 XLSX…", "");
  try {
    const res = await apiRequest("/api/admin/export/xlsx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      setMessage(downloadStatus, await readErrorMessage(res), "err");
      return;
    }
    const blob = await res.blob();
    const fileName = filenameFromDisposition(res.headers.get("Content-Disposition")) ?? "honglvdeng_export.xlsx";
    const url = URL.createObjectURL(blob);
    const link = el("a", { href: url, download: fileName });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    setMessage(downloadStatus, `已导出：${fileName}`, "ok");
  } catch {
    setMessage(downloadStatus, "网络错误，下载失败", "err");
  } finally {
    state.downloading = false;
    renderPreview();
  }
}

function filenameFromDisposition(value: string | null): string | null {
  if (!value) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(value);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      return star[1];
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(value);
  return plain ? plain[1] : null;
}

// ---------------------------------------------------------------------------

buildPage();
