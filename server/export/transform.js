// server/export/transform.js
// 中文字段名、枚举翻译、UTC/北京时间转换。
// CLI 与网站 API 共用；CLI 的旧列布局通过 options 保持（includeChinaTime=false, includeSensitive=true）。

export const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000; // Asia/Shanghai 无夏令时，固定 UTC+8

const SENSITIVE_COLUMNS = new Set([
  "语言",
  "平台",
  "屏幕宽",
  "屏幕高",
  "视口宽",
  "视口高",
  "时区",
  "IP地址",
  "浏览器标识_原文"
]);

/**
 * 将 UTC ISO 时间格式化为北京时间 "YYYY-MM-DD HH:mm:ss"。
 * 返回文本而非 Excel 序列号，避免显示为 46241.16701。
 */
export function toChinaTime(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return String(iso ?? "");
  const d = new Date(ms + CHINA_OFFSET_MS);
  return [
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`,
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`
  ].join(" ");
}

/** 北京时间紧凑格式 "YYYYMMDD_HHMM"，用于导出文件名。 */
export function toChinaCompact(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "00000000_0000";
  const d = new Date(ms + CHINA_OFFSET_MS);
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}_${pad2(
    d.getUTCHours()
  )}${pad2(d.getUTCMinutes())}`;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * 转换原始查询结果为各工作表的中文行数据。
 * raw: { sessions, events }
 * options: { includeChinaTime: boolean, includeSensitive: boolean }
 * 返回 { sessions, events, walks, violations }，每项 { headers, rows }。
 */
export function transformExportRows(raw, options) {
  const { includeChinaTime, includeSensitive } = options;

  const sessionHeaders = buildHeaders(
    [
      "会话ID",
      "客户端会话ID",
      "被试编号",
      "开始时间",
      ...(includeChinaTime ? ["开始时间_北京时间"] : []),
      "提交时间",
      ...(includeChinaTime ? ["提交时间_北京时间"] : []),
      "任务类型",
      "呈现方式",
      "干预组别",
      "干预材料",
      "干预阅读时长_秒",
      "理解测验回答",
      "规则看法选项",
      "规则看法补充",
      "实验总用时_秒",
      "最终金额_元",
      "闯红灯次数",
      "语言",
      "平台",
      "屏幕宽",
      "屏幕高",
      "视口宽",
      "视口高",
      "时区",
      "IP地址",
      "浏览器标识_原文",
      "入库时间"
    ],
    includeSensitive
  );

  const sessions = raw.sessions.map((row) => {
    const data = {
      会话ID: row.id,
      客户端会话ID: row.client_session_id,
      被试编号: row.participant_id,
      开始时间: row.started_at_iso,
      ...(includeChinaTime ? { 开始时间_北京时间: toChinaTime(row.started_at_iso) } : {}),
      提交时间: row.submitted_at_iso,
      ...(includeChinaTime ? { 提交时间_北京时间: toChinaTime(row.submitted_at_iso) } : {}),
      任务类型: formatRunKind(row.run_kind),
      呈现方式: formatRevealMode(row.reveal_mode),
      干预组别: formatTreatmentGroup(row.treatment),
      干预材料: row.treatment ?? "",
      干预阅读时长_秒: Math.round((row.intervention_ms ?? 0) / 1000),
      理解测验回答: formatComprehensionAnswer(row.comprehension_answer),
      规则看法选项: formatPostRuleAttitude(row.post_rule_attitude),
      规则看法补充: row.post_rule_attitude_text ?? "",
      实验总用时_秒: row.elapsed_sec,
      最终金额_元: row.money,
      闯红灯次数: row.violations,
      语言: formatLanguage(row.language),
      平台: formatPlatform(row.platform),
      屏幕宽: row.screen_width,
      屏幕高: row.screen_height,
      视口宽: row.viewport_width,
      视口高: row.viewport_height,
      时区: formatTimeZone(row.time_zone),
      IP地址: row.ip_address,
      浏览器标识_原文: row.user_agent,
      入库时间: row.created_at
    };
    return pickColumns(data, sessionHeaders);
  });

  const eventHeaders = buildHeaders(
    [
      "事件ID",
      "会话ID",
      "序号",
      "被试编号",
      "开始时间",
      ...(includeChinaTime ? ["开始时间_北京时间"] : []),
      "任务类型",
      "呈现方式",
      "理解测验回答",
      "规则看法选项",
      "规则看法补充",
      "事件",
      "阶段",
      "页面时间_ms",
      "实验用时_秒",
      "信号灯序号",
      "灯色",
      "剩余金额_元",
      "路线进度_0_1",
      "路线进度_0_10",
      "备注",
      "入库时间"
    ],
    true
  );

  const events = raw.events.map((row) =>
    pickColumns(
      {
        事件ID: row.id,
        会话ID: row.session_id,
        序号: row.seq,
        被试编号: row.participant_id,
        开始时间: row.started_at_iso,
        ...(includeChinaTime ? { 开始时间_北京时间: toChinaTime(row.started_at_iso) } : {}),
        任务类型: formatRunKind(row.run_kind),
        呈现方式: formatRevealMode(row.reveal_mode),
        理解测验回答: formatComprehensionAnswer(row.comprehension_answer),
        规则看法选项: formatPostRuleAttitude(row.post_rule_attitude),
        规则看法补充: row.post_rule_attitude_text ?? "",
        事件: formatEvent(row.event),
        阶段: formatPhase(row.phase),
        页面时间_ms: row.t_ms,
        实验用时_秒: row.t_sec,
        信号灯序号: row.light_index,
        灯色: formatLightColor(row.light_color),
        剩余金额_元: row.money,
        路线进度_0_1: row.route_pos_01,
        路线进度_0_10: row.route_pos_10,
        备注: row.note ?? "",
        入库时间: row.created_at
      },
      eventHeaders
    )
  );

  const walkHeaders = buildHeaders(
    [
      "被试编号",
      "开始时间",
      ...(includeChinaTime ? ["开始时间_北京时间"] : []),
      "任务类型",
      "呈现方式",
      "理解测验回答",
      "规则看法选项",
      "规则看法补充",
      "事件",
      "页面时间_ms",
      "实验用时_秒",
      "位置刻度_0_10",
      "阶段",
      "信号灯序号",
      "灯色",
      "剩余金额_元",
      "按键效果"
    ],
    true
  );

  const walks = raw.events
    .filter((row) => row.event === "walk_press")
    .map((row) =>
      pickColumns(
        {
          被试编号: row.participant_id,
          开始时间: row.started_at_iso,
          ...(includeChinaTime ? { 开始时间_北京时间: toChinaTime(row.started_at_iso) } : {}),
          任务类型: formatRunKind(row.run_kind),
          呈现方式: formatRevealMode(row.reveal_mode),
          理解测验回答: formatComprehensionAnswer(row.comprehension_answer),
          规则看法选项: formatPostRuleAttitude(row.post_rule_attitude),
          规则看法补充: row.post_rule_attitude_text ?? "",
          事件: "按下通行键",
          页面时间_ms: row.t_ms,
          实验用时_秒: row.t_sec,
          位置刻度_0_10: row.route_pos_10,
          阶段: formatPhase(row.phase),
          信号灯序号: row.light_index,
          灯色: formatLightColor(row.light_color),
          剩余金额_元: row.money,
          按键效果: formatWalkEffect(row)
        },
        walkHeaders
      )
    );

  const violationHeaders = buildHeaders(
    [
      "被试编号",
      "开始时间",
      ...(includeChinaTime ? ["开始时间_北京时间"] : []),
      "任务类型",
      "呈现方式",
      "理解测验回答",
      "规则看法选项",
      "规则看法补充",
      "事件",
      "页面时间_ms",
      "实验用时_秒",
      "位置刻度_0_10",
      "信号灯序号",
      "剩余金额_元"
    ],
    true
  );

  const violations = raw.events
    .filter((row) => row.event === "violation")
    .map((row) =>
      pickColumns(
        {
          被试编号: row.participant_id,
          开始时间: row.started_at_iso,
          ...(includeChinaTime ? { 开始时间_北京时间: toChinaTime(row.started_at_iso) } : {}),
          任务类型: formatRunKind(row.run_kind),
          呈现方式: formatRevealMode(row.reveal_mode),
          理解测验回答: formatComprehensionAnswer(row.comprehension_answer),
          规则看法选项: formatPostRuleAttitude(row.post_rule_attitude),
          规则看法补充: row.post_rule_attitude_text ?? "",
          事件: "闯红灯",
          页面时间_ms: row.t_ms,
          实验用时_秒: row.t_sec,
          位置刻度_0_10: row.route_pos_10,
          信号灯序号: row.light_index,
          剩余金额_元: row.money
        },
        violationHeaders
      )
    );

  return {
    sessions: { headers: sessionHeaders, rows: sessions },
    events: { headers: eventHeaders, rows: events },
    walks: { headers: walkHeaders, rows: walks },
    violations: { headers: violationHeaders, rows: violations }
  };
}

/**
 * 导出说明工作表内容（AOA）。
 * meta: {
 *   exportedAtIso, modeText, filterText, sessionIdsText,
 *   sessionCount, eventCount, walkCount, violationCount,
 *   firstStartedIso, lastSubmittedIso, includeSensitive
 * }
 */
export function buildSummaryRows(meta) {
  return [
    ["项目", "内容"],
    ["导出时间", `${toChinaTime(meta.exportedAtIso)}（北京时间）`],
    ["导出模式", meta.modeText],
    ["筛选条件", meta.filterText],
    ...(meta.sessionIdsText ? [["指定会话ID", meta.sessionIdsText]] : []),
    ["会话数", meta.sessionCount],
    ["事件数", meta.eventCount],
    ["通行按键数", meta.walkCount],
    ["闯红灯记录数", meta.violationCount],
    ["首个开始时间", meta.firstStartedIso ? `${toChinaTime(meta.firstStartedIso)}（北京时间）` : ""],
    ["最后提交时间", meta.lastSubmittedIso ? `${toChinaTime(meta.lastSubmittedIso)}（北京时间）` : ""],
    ["包含敏感技术字段", meta.includeSensitive ? "是" : "否"],
    ["时间口径", "筛选时间按北京时间（UTC+8）解释；UTC 与北京时间均为文本格式，不会显示为日期序列号"]
  ];
}

/** 从首个开始时间与最后提交时间生成文件名时间范围。 */
export function exportRangeCompact(firstStartedIso, lastSubmittedIso) {
  return {
    from: toChinaCompact(firstStartedIso),
    to: toChinaCompact(lastSubmittedIso)
  };
}

function buildHeaders(headers, includeSensitive) {
  if (includeSensitive) return headers;
  return headers.filter((h) => !SENSITIVE_COLUMNS.has(h));
}

function pickColumns(row, headers) {
  const out = {};
  for (const header of headers) {
    // 保留 null（与旧版 CLI 输出一致：空单元格不写 <v>）；字段自身的 ?? "" 逻辑在行构造时处理。
    out[header] = row[header] ?? null;
  }
  return out;
}

export function formatRunKind(v) {
  return v === "practice" ? "练习" : v === "formal" ? "正式实验" : "";
}

export function formatRevealMode(v) {
  return v === "sequential" ? "逐个呈现" : v === "full" ? "全呈现" : "";
}

export function formatComprehensionAnswer(v) {
  if (v === "yes") return "是";
  if (v === "no") return "否";
  // 多题格式（如 "q1=less;q2=wait"）原样导出，与客户端记录口径一致。
  if (/^q\d+=[a-z_]+(;q\d+=[a-z_]+)*$/.test(v ?? "")) return v;
  return "";
}

export function formatTreatmentGroup(v) {
  const id = String(v ?? "").trim().toUpperCase();
  if (id.startsWith("C")) return "控制组";
  if (id.startsWith("P")) return "正面治理组";
  if (id.startsWith("N")) return "负面治理组";
  return "";
}

export function formatPostRuleAttitude(v) {
  switch (v) {
    case "A":
      return "A.我严格遵守，因为这是规则。";
    case "B":
      return "B.我有时未遵守，因为等待时间太长，扣钱太多。";
    case "C":
      return "C.我觉得只要无人监督，为了效率（省钱）可以适当变通。";
    case "D":
      return "D.我以为按钮随时能点，没太在意红灯。";
    default:
      return "";
  }
}

export function formatPhase(v) {
  switch (v) {
    case "idle":
      return "未开始";
    case "moving":
      return "走向红绿灯";
    case "waiting_red":
      return "红灯等待";
    case "moving_to_finish":
      return "冲向终点";
    case "finished":
      return "已完成";
    default:
      return String(v ?? "");
  }
}

export function formatLightColor(v) {
  if (v === "red") return "红";
  if (v === "green") return "绿";
  return "";
}

export function formatEvent(v) {
  switch (v) {
    case "start":
      return "开始";
    case "arrive_light":
      return "到达红绿灯";
    case "light_green":
      return "绿灯亮起";
    case "walk_press":
      return "按下通行键";
    case "pass_light":
      return "通过红绿灯";
    case "violation":
      return "闯红灯";
    case "finish":
      return "到达终点";
    case "attention_lost":
      return "注意力/可见性中断";
    case "attention_restored":
      return "恢复实验";
    default:
      return String(v ?? "");
  }
}

export function formatLanguage(v) {
  const text = String(v ?? "").trim();
  if (!text) return "";
  if (text.startsWith("zh")) return "中文";
  if (text.startsWith("en")) return "英文";
  return text;
}

export function formatPlatform(v) {
  const text = String(v ?? "").trim();
  if (!text) return "";
  if (/iphone/i.test(text)) return "苹果手机";
  if (/ipad/i.test(text)) return "苹果平板";
  if (/mac/i.test(text)) return "苹果电脑";
  if (/win/i.test(text)) return "Windows电脑";
  if (/android|linux arm|armv8/i.test(text)) return "安卓设备";
  if (/linux/i.test(text)) return "Linux电脑";
  return text;
}

export function formatTimeZone(v) {
  const text = String(v ?? "").trim();
  if (!text) return "";
  if (text === "Asia/Shanghai") return "中国标准时间(UTC+8)";
  return text;
}

export function formatWalkEffect(row) {
  if (row.phase === "waiting_red" && row.light_color === "red") return "闯红灯通行";
  if (row.phase === "waiting_red" && row.light_color === "green") return "绿灯通行（遵守规则）";
  return "无效果";
}
