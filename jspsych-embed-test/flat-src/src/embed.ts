import { initJsPsych as fallbackInitJsPsych } from "jspsych";
import fallbackHtmlButtonResponse from "@jspsych/plugin-html-button-response";
import "./embed.css";

declare global {
  interface Window {
    initJsPsych?: typeof fallbackInitJsPsych;
    jsPsychHtmlButtonResponse?: typeof fallbackHtmlButtonResponse;
    onCredamoEndTrialFinish?: (csv: string) => void;
  }
}

type TaskSubmission = {
  clientSessionId?: string;
  participantId?: string;
  startedAtIso?: string;
  submittedAtIso?: string;
  runKind?: string;
  revealMode?: string;
  comprehensionAnswer?: string;
  postRuleAttitude?: string;
  postRuleAttitudeText?: string;
  summary?: {
    elapsedSec?: number;
    money?: number;
    violations?: number;
  };
  events?: unknown[];
  manipulationAnswers?: string;
};

const query = new URLSearchParams(window.location.search);
const participantId = (query.get("pid") ?? query.get("participant_id") ?? "").trim();
const submissionMode = import.meta.env.VITE_SUBMISSION_MODE ?? "test";
const CONTINUE_SURVEY_EVENT = "honglvdeng:continue-survey";
let completed = false;
let pendingCompletionPayload: TaskSubmission | null = null;

// On Credamo, use its supported jsPsych 7.1.2 and end-trial bridge. The bundled
// fallback keeps the ZIP runnable for local visual testing outside Credamo.
const initJsPsych = window.initJsPsych ?? fallbackInitJsPsych;
const jsPsychHtmlButtonResponse =
  window.jsPsychHtmlButtonResponse ?? fallbackHtmlButtonResponse;
const jsPsych = initJsPsych({
  display_element: "jspsych-target"
});

function toEndTrialData(payload: TaskSubmission): Record<string, unknown> {
  return {
    phase: "formal_task",
    participant_id: payload.participantId ?? participantId,
    client_session_id: payload.clientSessionId ?? "",
    started_at_iso: payload.startedAtIso ?? "",
    submitted_at_iso: payload.submittedAtIso ?? "",
    run_kind: payload.runKind ?? "formal",
    reveal_mode: payload.revealMode ?? "",
    comprehension_answer: payload.comprehensionAnswer ?? "",
    post_rule_attitude: payload.postRuleAttitude ?? "",
    post_rule_attitude_text: payload.postRuleAttitudeText ?? "",
    elapsed_sec: payload.summary?.elapsedSec ?? null,
    money: payload.summary?.money ?? null,
    violations: payload.summary?.violations ?? null,
    events_json: JSON.stringify(payload.events ?? [])
    , manipulation_answers: payload.manipulationAnswers ?? ""
  };
}

function showMissingCredamoBridge(): void {
  const target = document.querySelector<HTMLElement>("#jspsych-target");
  if (!target) return;
  target.innerHTML = `
    <section class="embed-complete">
      <h1>任务已完成</h1>
      <p>当前页面未加载见数的完成回调。请在见数平台中运行本 ZIP，而不是直接打开本地文件。</p>
    </section>
  `;
}

function completeInCredamo(payload: TaskSubmission): void {
  if (completed) return;
  completed = true;
  document.body.classList.add("embed-completed");
  const endTrial = {
    type: jsPsychHtmlButtonResponse,
    stimulus: `
      <section class="embed-complete">
        <h1>实验已完成</h1>
        <p>点击下方按钮后继续完成见数问卷。</p>
      </section>
    `,
    choices: ["继续答题"],
    data: toEndTrialData(payload),
    on_finish: () => {
      const finish = window.onCredamoEndTrialFinish;
      if (typeof finish === "function") {
        finish(jsPsych.data.get().csv());
        return;
      }
      // Only used outside Credamo, where the platform bridge does not exist.
      window.setTimeout(showMissingCredamoBridge, 0);
    }
  };
  void jsPsych.run([endTrial]);
}

window.addEventListener(CONTINUE_SURVEY_EVENT, (event) => {
  const detail =
    event instanceof CustomEvent && typeof event.detail === "object" && event.detail !== null
      ? (event.detail as TaskSubmission)
      : null;
  completeInCredamo(detail ?? pendingCompletionPayload ?? {});
});

const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const requestUrl =
    typeof input === "string"
      ? new URL(input, window.location.href)
      : input instanceof URL
        ? input
        : new URL(input.url, window.location.href);
  const method = (
    init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")
  ).toUpperCase();

  if (method === "POST" && requestUrl.pathname.endsWith("/api/submissions")) {
    let payload: TaskSubmission = {};
    try {
      payload = typeof init?.body === "string" ? (JSON.parse(init.body) as TaskSubmission) : {};
    } catch {
      payload = {};
    }
    pendingCompletionPayload = payload;

    if (submissionMode === "formal") {
      return originalFetch(input, init);
    }

    // Test mode deliberately avoids the production API and database.
    return new Response(JSON.stringify({ ok: true, sessionId: 0, deduplicated: false }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  return originalFetch(input, init);
};

void import("./task-main").catch((error: unknown) => {
  document.body.classList.add("embed-completed");
  const target = document.querySelector<HTMLElement>("#jspsych-target");
  if (target) target.textContent = `任务加载失败：${String(error)}`;
});
