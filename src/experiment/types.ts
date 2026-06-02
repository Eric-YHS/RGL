export type RevealMode = "full" | "sequential";

export type ExperimentConfig = {
  revealMode: RevealMode;
  numLights: number;
  segmentDurationSec: number;
  redWaitSec: number;
  startMoney: number;
  moneyLossPerSec: number;
};

export type Phase = "idle" | "moving" | "waiting_red" | "moving_to_finish" | "finished";

export type LightColor = "red" | "green";

export type ExperimentState = {
  phase: Phase;
  lightIndex: number; // 1..numLights (当前/目标信号灯)
  elapsedSec: number;
  money: number;
  violations: number;
  passedOutcome: Array<"green" | "run_red" | null>;
  lightGreenAtSecByIndex: Array<number | null>;

  segmentProgressSec: number; // moving / moving_to_finish 时有效
  waitingSinceSec: number | null; // waiting_red 时有效
  greenAtSec: number | null; // waiting_red 时有效
  autoPassAtSec: number | null; // 绿灯后自动通行的时间点
  waitingForWalkSec: number | null; // 绿灯后等待参与者点击"移动"的起始时间
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
