import type { ExperimentConfig, ExperimentState, LightColor } from "./types";
import type { ExperimentLogger } from "./logger";

const MAX_DT_SEC = 0.1;

export class ExperimentEngine {
  private readonly config: ExperimentConfig;
  private readonly logger: ExperimentLogger;

  private startedAtMs: number | null = null;
  private lastTickMs: number | null = null;
  private pausedAtMs: number | null = null;

  state: ExperimentState;

  constructor(config: ExperimentConfig, logger: ExperimentLogger) {
    this.config = config;
    this.logger = logger;
    this.state = this.createInitialState();
  }

  private createInitialState(): ExperimentState {
    return {
      phase: "idle",
      lightIndex: 1,
      elapsedSec: 0,
      money: this.config.startMoney,
      violations: 0,
      passedOutcome: Array.from({ length: this.config.numLights + 1 }, () => null),
      lightGreenAtSecByIndex: Array.from({ length: this.config.numLights + 1 }, () => null),
      segmentProgressSec: 0,
      waitingSinceSec: null,
      greenAtSec: null,
      autoPassAtSec: null,
      waitingForWalkSec: null,
      currentLightColor: "red"
    };
  }

  reset(nowMs: number): void {
    this.startedAtMs = null;
    this.lastTickMs = null;
    this.pausedAtMs = null;
    this.state = this.createInitialState();

    this.logger.log({
      nowMs,
      tSec: 0,
      event: "reset",
      phase: this.state.phase,
      lightIndex: null,
      lightColor: null,
      money: this.state.money
    });
  }

  start(nowMs: number): void {
    if (this.state.phase !== "idle") return;
    this.startedAtMs = nowMs;
    this.lastTickMs = nowMs;
    this.pausedAtMs = null;
    this.state.phase = "moving";
    this.state.elapsedSec = 0;
    this.state.money = this.config.startMoney;
    this.state.lightIndex = 1;
    this.state.passedOutcome = Array.from({ length: this.config.numLights + 1 }, () => null);
    this.state.lightGreenAtSecByIndex = Array.from({ length: this.config.numLights + 1 }, () => null);
    this.state.segmentProgressSec = 0;
    this.state.waitingSinceSec = null;
    this.state.greenAtSec = null;
    this.state.autoPassAtSec = null;
    this.state.waitingForWalkSec = null;
    this.state.currentLightColor = "red";
    this.state.violations = 0;

    this.logger.log({
      nowMs,
      tSec: 0,
      event: "start",
      phase: this.state.phase,
      lightIndex: this.state.lightIndex,
      lightColor: null,
      money: this.state.money
    });
  }

  pressWalk(nowMs: number): void {
    this.tick(nowMs);

    const tSec = this.getNowTsec(nowMs);
    const routePos01 = this.getRouteProgress01();
    const routePos10 = this.getRoutePosScale10();
    this.logger.log({
      nowMs,
      tSec,
      event: "walk_press",
      phase: this.state.phase,
      lightIndex: this.state.phase === "idle" ? null : this.state.lightIndex,
      lightColor: this.state.phase === "waiting_red" ? this.state.currentLightColor : null,
      money: this.state.money,
      routePos01,
      routePos10: Number(routePos10.toFixed(3))
    });

    // Effective only while waiting at the light. Red -> run the red light
    // (rule-breaking); green -> proceed normally (rule-following).
    if (this.state.phase === "waiting_red") {
      if (this.state.currentLightColor === "red") {
        this.runRedLight(nowMs, tSec);
      } else {
        this.passOnGreen(nowMs, tSec);
      }
    }
  }

  tick(nowMs: number): void {
    if (this.state.phase === "idle" || this.state.phase === "finished") return;
    if (this.lastTickMs === null || this.startedAtMs === null || this.pausedAtMs !== null) return;

    const rawDt = (nowMs - this.lastTickMs) / 1000;
    const dtSec = Math.max(0, Math.min(MAX_DT_SEC, rawDt));
    this.lastTickMs = nowMs;

    this.state.elapsedSec = this.getNowTsec(nowMs);
    this.state.money = this.getMoneyAtElapsed(this.state.elapsedSec);

    // Phase: moving toward the traffic light
    if (this.state.phase === "moving") {
      this.state.segmentProgressSec += dtSec;
      if (this.state.segmentProgressSec >= this.config.segmentDurationSec) {
        this.state.segmentProgressSec = this.config.segmentDurationSec;
        this.arriveAtLight(nowMs);
      }
      return;
    }

    // Phase: waiting at red light
    if (this.state.phase === "waiting_red") {
      const greenAtSec = this.state.greenAtSec;
      if (
        greenAtSec !== null &&
        this.state.elapsedSec >= greenAtSec &&
        this.state.currentLightColor !== "green"
      ) {
        this.state.currentLightColor = "green";
        this.state.waitingForWalkSec = this.state.elapsedSec;
        this.logger.log({
          nowMs,
          tSec: this.state.elapsedSec,
          event: "light_green",
          phase: this.state.phase,
          lightIndex: this.state.lightIndex,
          lightColor: "green",
          money: this.state.money
        });
      }
      // The circle stays at the light until the participant clicks "移动".
      // Clicking during red counts as running the red light (rule-breaking);
      // clicking after it turns green counts as rule-following.
      return;
    }

    // Phase: moving from traffic light to finish line
    if (this.state.phase === "moving_to_finish") {
      this.state.segmentProgressSec += dtSec;
      if (this.state.segmentProgressSec >= this.config.segmentDurationSec) {
        this.state.segmentProgressSec = this.config.segmentDurationSec;
        this.finish(nowMs, this.state.elapsedSec);
      }
      return;
    }
  }

  getRouteProgress01(): number {
    if (this.state.phase === "idle") return 0;
    if (this.state.phase === "finished") return 1;

    const seg = this.config.segmentDurationSec;
    const fraction = Math.min(1, this.state.segmentProgressSec / seg);

    if (this.state.phase === "moving") {
      // Moving to light: 0 .. 0.5
      return (fraction * 0.5);
    }

    if (this.state.phase === "waiting_red") {
      // At light: 0.5
      return 0.5;
    }

    if (this.state.phase === "moving_to_finish") {
      // Moving to finish: 0.5 .. 1.0
      return 0.5 + fraction * 0.5;
    }

    return 0;
  }

  getCurrentLightColor(): LightColor | null {
    if (this.state.phase === "waiting_red") return this.state.currentLightColor;
    return null;
  }

  pause(nowMs: number): void {
    if (this.state.phase === "idle" || this.state.phase === "finished") return;
    if (this.pausedAtMs !== null) return;
    this.tick(nowMs);
    this.pausedAtMs = nowMs;
  }

  resume(nowMs: number): void {
    if (this.pausedAtMs === null) return;
    if (this.startedAtMs !== null) {
      this.startedAtMs += nowMs - this.pausedAtMs;
    }
    this.lastTickMs = nowMs;
    this.pausedAtMs = null;
  }

  private arriveAtLight(nowMs: number): void {
    this.state.phase = "waiting_red";
    this.state.waitingSinceSec = this.state.elapsedSec;
    this.state.greenAtSec = this.state.elapsedSec + this.config.redWaitSec;
    this.state.lightGreenAtSecByIndex[this.state.lightIndex] = this.state.greenAtSec;
    this.state.autoPassAtSec = null;
    this.state.waitingForWalkSec = null;
    this.state.currentLightColor = "red";

    this.logger.log({
      nowMs,
      tSec: this.state.elapsedSec,
      event: "arrive_light",
      phase: this.state.phase,
      lightIndex: this.state.lightIndex,
      lightColor: "red",
      money: this.state.money
    });
  }

  private runRedLight(nowMs: number, tSec: number): void {
    this.state.passedOutcome[this.state.lightIndex] = "run_red";
    this.state.violations += 1;

    const routePos01 = this.getRouteProgress01();
    const routePos10 = this.getRoutePosScale10();

    this.logger.log({
      nowMs,
      tSec,
      event: "pass_light",
      phase: this.state.phase,
      lightIndex: this.state.lightIndex,
      lightColor: "red",
      money: this.state.money,
      routePos01,
      routePos10: Number(routePos10.toFixed(3)),
      note: "run_red"
    });

    this.logger.log({
      nowMs,
      tSec,
      event: "violation",
      phase: this.state.phase,
      lightIndex: this.state.lightIndex,
      lightColor: "red",
      money: this.state.money,
      routePos01,
      routePos10: Number(routePos10.toFixed(3)),
      note: "run_red"
    });

    this.startMovingToFinish(nowMs, tSec, "run_red");
  }

  private passOnGreen(nowMs: number, tSec: number): void {
    const routePos01 = this.getRouteProgress01();
    const routePos10 = this.getRoutePosScale10();

    this.logger.log({
      nowMs,
      tSec,
      event: "pass_light",
      phase: this.state.phase,
      lightIndex: this.state.lightIndex,
      lightColor: "green",
      money: this.state.money,
      routePos01,
      routePos10: Number(routePos10.toFixed(3)),
      note: "green"
    });

    this.startMovingToFinish(nowMs, tSec, "green");
  }

  private startMovingToFinish(nowMs: number, tSec: number, reason: "green" | "run_red"): void {
    this.state.passedOutcome[this.state.lightIndex] = reason;
    this.state.phase = "moving_to_finish";
    this.state.segmentProgressSec = 0;

    this.logger.log({
      nowMs,
      tSec,
      event: "start_move_to_finish",
      phase: this.state.phase,
      lightIndex: this.state.lightIndex,
      lightColor: null,
      money: this.state.money,
      note: reason
    });
  }

  private finish(nowMs: number, tSec: number): void {
    this.state.phase = "finished";

    this.logger.log({
      nowMs,
      tSec,
      event: "finish",
      phase: this.state.phase,
      lightIndex: this.state.lightIndex,
      lightColor: null,
      money: this.state.money
    });
  }

  private getNowTsec(nowMs: number): number {
    if (this.startedAtMs === null) return 0;
    return (nowMs - this.startedAtMs) / 1000;
  }

  private getMoneyAtElapsed(elapsedSec: number): number {
    const chargedSeconds = Math.floor(Math.max(0, elapsedSec));
    return Math.max(0, this.config.startMoney - this.config.moneyLossPerSec * chargedSeconds);
  }

  private getRoutePosScale10(): number {
    return this.getRouteProgress01() * (this.config.numLights * 2);
  }
}
