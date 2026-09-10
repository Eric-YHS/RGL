import type { ExperimentConfig, LogEvent, Phase, LightColor } from "./types";
import { csvEscape } from "./utils";

type Cell = string | number;

// Timeline events persisted with the submission. Milestone events (start /
// arrive_light / light_green / pass_light / finish) let researchers reconstruct
// the wait/run-red duration and the rule-breaking dummy without assuming fixed
// timings. comprehension_answer is now persisted both as an event and as a
// dedicated field. post_rule_attitude / post_rule_attitude_text are handled
// separately (they update fields rather than the event log).
const PERSISTED_EVENTS = new Set<string>([
  "start",
  "arrive_light",
  "light_green",
  "walk_press",
  "pass_light",
  "violation",
  "finish",
  "comprehension_answer",
  "attention_lost",
  "attention_restored"
]);

export type SessionMeta = {
  participantId: string;
  startedAtIso: string;
  runKind: "practice" | "formal";
  treatment: string;
};

export type ClientDeviceInfo = {
  userAgent: string;
  language: string;
  platform: string;
  screenWidth: number;
  screenHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  timeZone: string;
};

export type SubmissionSummary = {
  elapsedSec: number;
  money: number;
  violations: number;
};

export type SessionSubmission = {
  clientSessionId: string;
  participantId: string;
  startedAtIso: string;
  submittedAtIso: string;
  runKind: SessionMeta["runKind"];
  revealMode: ExperimentConfig["revealMode"];
  treatment: string;
  interventionMs: number;
  comprehensionAnswer: string;
  postRuleAttitude: "A" | "B" | "C" | "D" | "";
  postRuleAttitudeText: string;
  summary: SubmissionSummary;
  device: ClientDeviceInfo;
  events: LogEvent[];
};

export class ExperimentLogger {
  private readonly config: ExperimentConfig;
  private readonly meta: SessionMeta;
  private readonly events: LogEvent[] = [];
  private comprehensionAnswer = "";
  private postRuleAttitude: "A" | "B" | "C" | "D" | "" = "";
  private postRuleAttitudeText = "";

  constructor(config: ExperimentConfig, meta: SessionMeta) {
    this.config = config;
    this.meta = meta;
  }

  log(args: {
    nowMs: number;
    tSec: number;
    event: string;
    phase: Phase;
    lightIndex: number | null;
    lightColor: LightColor | null;
    money: number;
    routePos01?: number;
    routePos10?: number;
    note?: string;
  }): void {
    if (args.event === "comprehension_answer") {
      // Only accept known-safe formats: legacy "yes"/"no" or the new
      // multi-question pattern (e.g. "q1=less;q2=wait").  Values come
      // from radio buttons, never from free-text input.
      if (
        args.note === "yes" ||
        args.note === "no" ||
        (typeof args.note === "string" && /^q\d+=[a-z_]+(;q\d+=[a-z_]+)*$/.test(args.note))
      ) {
        this.comprehensionAnswer = args.note;
      }
      // Falls through to persist as a timeline event as well.
    }
    if (args.event === "post_rule_attitude") {
      if (args.note === "A" || args.note === "B" || args.note === "C" || args.note === "D") {
        this.postRuleAttitude = args.note;
      }
      return;
    }
    if (args.event === "post_rule_attitude_text") {
      if (typeof args.note === "string") this.postRuleAttitudeText = args.note;
      return;
    }
    if (!PERSISTED_EVENTS.has(args.event)) return;

    this.events.push({
      tMs: Math.round(args.nowMs),
      tSec: Number(args.tSec.toFixed(3)),
      event: args.event,
      phase: args.phase,
      lightIndex: args.lightIndex,
      lightColor: args.lightColor,
      money: Number(args.money.toFixed(2)),
      routePos01: args.routePos01 === undefined ? undefined : Number(args.routePos01.toFixed(3)),
      routePos10: args.routePos10 === undefined ? undefined : Number(args.routePos10.toFixed(3)),
      note: args.note
    });
  }

  getEvents(): readonly LogEvent[] {
    return this.events;
  }

  toWalkPressSheetAoa(): Cell[][] {
    const header = [
      "被试编号",
      "开始时间(ISO)",
      "任务类型",
      "呈现方式",
      "理解测验回答",
      "规则看法选项",
      "规则看法补充",
      "事件(按WALK)",
      "页面时间(ms)",
      "实验用时(秒)",
      "位置刻度(0-10)",
      "阶段",
      "信号灯序号",
      "灯色",
      "剩余金额(元)",
      "按键效果"
    ];

    const rows = this.events
      .filter((e) => e.event === "walk_press")
      .map((e) => [
        this.meta.participantId,
        this.meta.startedAtIso,
        formatRunKind(this.meta.runKind),
        formatRevealMode(this.config.revealMode),
        formatComprehensionAnswer(this.comprehensionAnswer),
        formatPostRuleAttitude(this.postRuleAttitude),
        this.postRuleAttitudeText,
        "按下WALK",
        e.tMs,
        e.tSec,
        e.routePos10 ?? "",
        formatPhase(e.phase),
        e.lightIndex ?? "",
        formatLightColor(e.lightColor),
        e.money,
        formatWalkEffect(e)
      ]);

    return [header, ...rows];
  }

  toViolationSheetAoa(): Cell[][] {
    const header = [
      "被试编号",
      "开始时间(ISO)",
      "任务类型",
      "呈现方式",
      "理解测验回答",
      "规则看法选项",
      "规则看法补充",
      "事件(闯红灯)",
      "页面时间(ms)",
      "实验用时(秒)",
      "位置刻度(0-10)",
      "信号灯序号",
      "剩余金额(元)"
    ];

    const rows = this.events
      .filter((e) => e.event === "violation")
      .map((e) => [
        this.meta.participantId,
        this.meta.startedAtIso,
        formatRunKind(this.meta.runKind),
        formatRevealMode(this.config.revealMode),
        formatComprehensionAnswer(this.comprehensionAnswer),
        formatPostRuleAttitude(this.postRuleAttitude),
        this.postRuleAttitudeText,
        "闯红灯",
        e.tMs,
        e.tSec,
        e.routePos10 ?? "",
        e.lightIndex ?? "",
        e.money
      ]);

    return [header, ...rows];
  }

  toWalkPressCsv(): string {
    return aoaToCsv(this.toWalkPressSheetAoa());
  }

  toViolationCsv(): string {
    return aoaToCsv(this.toViolationSheetAoa());
  }

  buildSubmission(args: {
    clientSessionId: string;
    submittedAtIso: string;
    summary: SubmissionSummary;
    device: ClientDeviceInfo;
    interventionMs?: number;
  }): SessionSubmission {
    return {
      clientSessionId: args.clientSessionId,
      participantId: this.meta.participantId,
      startedAtIso: this.meta.startedAtIso,
      submittedAtIso: args.submittedAtIso,
      runKind: this.meta.runKind,
      revealMode: this.config.revealMode,
      treatment: this.meta.treatment,
      interventionMs: Math.max(0, Math.round(args.interventionMs ?? 0)),
      comprehensionAnswer: this.comprehensionAnswer,
      postRuleAttitude: this.postRuleAttitude,
      postRuleAttitudeText: this.postRuleAttitudeText,
      summary: {
        elapsedSec: Number(args.summary.elapsedSec.toFixed(3)),
        money: Number(args.summary.money.toFixed(2)),
        violations: Math.max(0, Math.floor(args.summary.violations))
      },
      device: args.device,
      events: this.events.map((e) => ({ ...e }))
    };
  }
}

function aoaToCsv(aoa: Cell[][]): string {
  return aoa.map((r) => r.map(csvEscape).join(",")).join("\n") + "\n";
}

function formatRevealMode(revealMode: ExperimentConfig["revealMode"]): string {
  if (revealMode === "full") return "全呈现";
  if (revealMode === "sequential") return "逐个呈现";
  return String(revealMode);
}

function formatRunKind(runKind: SessionMeta["runKind"]): string {
  return runKind === "practice" ? "练习" : "正式实验";
}

function formatComprehensionAnswer(answer: string): string {
  if (answer === "yes") return "是";
  if (answer === "no") return "否";
  // New multi-question format (e.g. "q1=less;q2=wait").
  // Only pass through validated patterns; fall back to empty string
  // for anything unexpected (defense in depth — values originate from
  // radio buttons, not free-text input).
  if (/^q\d+=[a-z_]+(;q\d+=[a-z_]+)*$/.test(answer)) return answer;
  return "";
}

function formatPostRuleAttitude(answer: "A" | "B" | "C" | "D" | ""): string {
  switch (answer) {
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

function formatPhase(phase: Phase): string {
  switch (phase) {
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
  }
}

function formatLightColor(color: LightColor | null): string {
  if (color === "red") return "红";
  if (color === "green") return "绿";
  return "";
}

function formatWalkEffect(e: LogEvent): string {
  if (e.phase === "waiting_red" && e.lightColor === "red") return "闯红灯通行";
  if (e.phase === "waiting_red" && e.lightColor === "green") return "绿灯通行（遵守规则）";
  return "无效果";
}
