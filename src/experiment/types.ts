export type RevealMode = "full" | "sequential";

export type ExperimentConfig = {
  revealMode: RevealMode;
  numLights: number;
  segmentDurationSec: number;
  redWaitSec: number;
  startMoney: number;
  moneyLossPerSec: number;
};

export type Phase = "idle" | "moving" | "waiting_red" | "finished";

export type LightColor = "red" | "green";

export type ExperimentState = {
  phase: Phase;
  lightIndex: number; // 1..numLights (当前/目标信号灯)
  elapsedSec: number;
  money: number;
  violations: number;
  passedOutcome: Array<"green" | "run_red" | null>;
  lightGreenAtSecByIndex: Array<number | null>;

  segmentProgressSec: number; // moving 时有效
  waitingSinceSec: number | null; // waiting_red 时有效
  greenAtSec: number | null; // waiting_red 时有效
  autoPassAtSec: number | null; // 绿灯后自动通行的时间点
  currentLightColor: LightColor;
};

export type LogEvent = {
  tMs: number;
  tSec: number;
  event: string;
  phase: Phase;
  lightIndex: number | null;
  lightColor: LightColor | null;
  money: number;
  routePos01?: number;
  routePos10?: number;
  note?: string;
};
