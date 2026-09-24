const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/experiment/engine.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;
const wrapper = { exports: {} };
new Function("module", "exports", compiled)(wrapper, wrapper.exports);
const { ExperimentEngine } = wrapper.exports;
const config = {
  revealMode: "full", numLights: 1, segmentDurationSec: 4,
  redWaitSec: 12, startMoney: 25, moneyLossPerSec: 1
};

function run(times, pressAt) {
  const events = [];
  const engine = new ExperimentEngine(config, { log: event => events.push(event) });
  engine.start(0);
  for (const t of times) {
    if (t === pressAt) engine.pressWalk(t);
    else engine.tick(t);
  }
  return { engine, events };
}

const normal = run([4000, 15999, 16000, 20000]);
assert.equal(normal.engine.state.phase, "finished");
assert.equal(normal.engine.state.elapsedSec, 20);
assert.equal(normal.engine.getWaitingSec(), 12);
assert.equal(normal.engine.getRecordedMoney(), 5);
assert.equal(normal.engine.state.violations, 0);
assert.equal(normal.events.find(e => e.event === "pass_light")?.note, "green");
assert.equal(normal.events.some(e => e.event === "walk_press"), false);

const early = run([4000, 5000, 9000], 5000);
assert.equal(early.engine.state.phase, "finished");
assert.equal(early.engine.getWaitingSec(), 1);
assert.equal(early.engine.getRecordedMoney(), 16);
assert.equal(early.engine.state.violations, 1);
assert.equal(early.events.find(e => e.event === "pass_light")?.note, "run_red");

const beforeLight = run([3999, 4000, 16000, 20000], 3999);
assert.equal(beforeLight.engine.state.violations, 0);
assert.equal(beforeLight.engine.getWaitingSec(), 12);

const delayedRender = run([30000]);
assert.equal(delayedRender.engine.state.phase, "finished");
assert.equal(delayedRender.engine.state.elapsedSec, 20);
assert.equal(delayedRender.engine.getWaitingSec(), 12);
assert.equal(delayedRender.engine.getRecordedMoney(), 5);
console.log("Engine: automatic green, red violation, wait cap, payout floor and delayed render passed.");
