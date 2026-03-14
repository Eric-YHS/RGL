import type { ExperimentConfig, ExperimentState, LightColor } from "./types";
import type { ExperimentLogger } from "./logger";

const MAX_DT_SEC = 0.1;
const GREEN_GO_DELAY_SEC = 0.6;

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
    // Ensure state is up-to-date at the moment of interaction (more accurate phase/position logging).
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

    if (this.state.phase === "waiting_red" && this.state.currentLightColor === "red") {
      this.passLight(nowMs, tSec, "run_red");
    }
  }

  tick(nowMs: number): void {
    if (this.state.phase === "idle" || this.state.phase === "finished") return;
    if (this.lastTickMs === null || this.startedAtMs === null || this.pausedAtMs !== null) return;

    const rawDt = (nowMs - this.lastTickMs) / 1000;
    const dtSec = Math.max(0, Math.min(MAX_DT_SEC, rawDt));
    this.lastTickMs = nowMs;

    this.state.elapsedSec = this.getNowTsec(nowMs);
    this.state.money = Math.max(
      0,
      this.config.startMoney - this.config.moneyLossPerSec * this.state.elapsedSec
    );

    if (this.state.phase === "moving") {
      this.state.segmentProgressSec += dtSec;
      if (this.state.segmentProgressSec >= this.config.segmentDurationSec) {
        this.state.segmentProgressSec = this.config.segmentDurationSec;
        this.arriveAtLight(nowMs);
      }
      return;
    }

    if (this.state.phase === "waiting_red") {
      const greenAtSec = this.state.greenAtSec;
      if (greenAtSec !== null && this.state.elapsedSec >= greenAtSec) {
        if (this.state.currentLightColor !== "green") {
          this.state.currentLightColor = "green";
          this.state.autoPassAtSec = this.state.elapsedSec + GREEN_GO_DELAY_SEC;
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
      }

      if (
        this.state.currentLightColor === "green" &&
        this.state.autoPassAtSec !== null &&
        this.state.elapsedSec >= this.state.autoPassAtSec
      ) {
        this.passLight(nowMs, this.state.elapsedSec, "green");
      }
    }
  }

  getRouteProgress01(): number {
    const n = this.config.numLights;
    if (this.state.phase === "idle") return 0;
    if (this.state.phase === "finished") return 1;

    const completedLights = this.state.lightIndex - 1;
    const segmentFraction =
      this.state.phase === "moving"
        ? this.state.segmentProgressSec / this.config.segmentDurationSec
        : 1;

    const progress = (completedLights + segmentFraction) / n;
    return Math.max(0, Math.min(1, progress));
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

  private passLight(nowMs: number, tSec: number, reason: "green" | "run_red"): void {
    this.state.passedOutcome[this.state.lightIndex] = reason;

    const routePos01 = this.getRouteProgress01();
    const routePos10 = this.getRoutePosScale10();
    this.logger.log({
      nowMs,
      tSec,
      event: "pass_light",
      phase: this.state.phase,
      lightIndex: this.state.lightIndex,
      lightColor: this.state.phase === "waiting_red" ? this.state.currentLightColor : null,
      money: this.state.money,
      routePos01,
      routePos10: Number(routePos10.toFixed(3)),
      note: reason
    });

    if (reason === "run_red") {
      this.state.violations += 1;
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
    }

    if (this.state.lightIndex >= this.config.numLights) {
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
      return;
    }

    this.state.lightIndex += 1;
    this.state.phase = "moving";
    this.state.segmentProgressSec = 0;
    this.state.waitingSinceSec = null;
    this.state.greenAtSec = null;
    this.state.autoPassAtSec = null;
    this.state.currentLightColor = "red";
  }

  private getNowTsec(nowMs: number): number {
    if (this.startedAtMs === null) return 0;
    return (nowMs - this.startedAtMs) / 1000;
  }

  private getRoutePosScale10(): number {
    return this.getRouteProgress01() * (this.config.numLights * 2);
  }
}
