import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import "../plugins/robot-studio/kinematics.js";

const K = globalThis.RobotCore;
const source = readFileSync(new URL("../src/lib/pluginSession.ts", import.meta.url), "utf8");
const factory = source.slice(source.indexOf("export function createPluginSessionStore"), source.indexOf("export const pluginSession"))
  .replace("export function", "function");
const sessionContext = {};
runInNewContext(ts.transpileModule(factory, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sessionContext);

test("connection interruptions archive calibration without restoring motion authorization", () => {
  const store = sessionContext.createPluginSessionStore();
  const saved = { key: "robot", zeros: [1, 2, 3, 4, 5, 6], project: { name: "unsaved" } };
  store.write("robot", 0, saved);
  store.invalidate("connection");
  assert.equal(store.read("robot").data, null);
  assert.equal(store.read("robot").recovery, saved);
  assert.equal(store.read("other").recovery, null);
  for (let i = 0; i < 4; i++) store.invalidate("connection");
  assert.equal(store.read("robot").recovery, saved);
  assert.throws(() => store.write("robot", 0, saved), /session changed/);
  store.write("robot", store.read("robot").generation, saved);
  assert.equal(store.read("robot").data, saved);
  assert.equal(store.read("robot").recovery, null);
});

test("reset, homing, alarm, explicit invalidation and controller switches discard recovery", () => {
  for (const cause of ["reset", "homing", "alarm", "controller"]) {
    const store = sessionContext.createPluginSessionStore();
    store.write("robot", 0, { reference: true });
    store.invalidate("connection"); store.invalidate(cause); store.invalidate("connection");
    assert.equal(store.read("robot").recovery, null);
  }
  let controller = "first";
  const store = sessionContext.createPluginSessionStore(() => controller);
  store.write("robot", 0, { reference: true }); store.invalidate("connection");
  const old = store.read("robot").generation;
  controller = "second";
  assert.equal(store.read("robot").recovery, null);
  assert.equal(store.read("robot").reason, "controller");
  assert.throws(() => store.write("robot", old, { reference: true }), /session changed/);
  store.write("robot", store.read("robot").generation, { reference: true });
  store.invalidate("connection");
  store.write("robot", store.read("robot").generation, null);
  assert.equal(store.read("robot").recovery, null);
});

const app = readFileSync(new URL("../plugins/robot-studio/app.js", import.meta.url), "utf8");
const functions = app.slice(app.indexOf("  function referenceKey("), app.indexOf("  async function rememberReference(")) +
  app.slice(app.indexOf("  function clearReference("), app.indexOf("  async function restoreReference("));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture() {
  const config = K.defaultConfig(), calls = [], nodes = {};
  const zeros = [10, 20, 30, 40, 50, 60], actual = [15, -70, 20, -60, 30, 40];
  const node = (id) => nodes[id] ??= { checked: id === "recovery-confirmed", open: true, close() { this.open = false; } };
  const context = {
    K, config, calls, nodes, embedded: true, referenced: false, referenceReason: "connection",
    revision: 7, recoveryRevision: 7, recoveryGeneration: 2, recoveryPending: false,
    projectVersion: 1, savedVersion: 1, hasSavedProject: true,
    program: { busy: false }, programPreparing: false, endEffectorBusy: false,
    live: { active: false, busy: false }, holding: false, livePreferred: true, liveFault: true,
    reportedQ: null, fresh: true, $: node,
    document: { querySelectorAll: () => [] },
    status: { state: "Idle", mpos: Object.fromEntries(config.joints.map((j, i) => [j.axis.toLowerCase(), actual[i] + zeros[i]])) },
    referenceAvailable: () => context.fresh,
    project: () => ({ config: context.config }),
    invalidate: () => { context.revision++; },
    setPose: (pose) => { context.target = pose; }, currentTarget() {}, rememberBrowserProject() {}, projectChanged() {}, updateMachine() {}, message() {},
    call: async (method, params) => {
      calls.push({ method, params });
      if (method === "getSessionState") return structuredClone(context.controllerSession);
      if (method === "setSessionState" && context.commit) await context.commit;
    },
  };
  runInNewContext(functions, context);
  context.controllerSession = { generation: 2, reason: "connection", data: null,
    recovery: { key: context.referenceKey(), zeros, project: { config } },
  };
  return { context, calls, nodes, actual, zeros, node };
}

test("recovery restores old offsets and current joint pose without a motion command", async () => {
  const f = fixture();
  await f.context.recoverReference();
  assert.equal(f.context.referenced, true);
  assert.deepEqual(Array.from(f.context.config.joints, (j) => j.zero), f.zeros);
  assert.deepEqual(Array.from(f.context.target), f.actual);
  assert.equal(f.context.livePreferred, false);
  assert.equal(f.node("enable-machine").checked, false);
  assert.deepEqual(f.calls.map((c) => c.method), ["getSessionState", "setSessionState"]);
  assert.equal(f.context.controllerSession.recovery, null);
});

test("unchecked confirmation, stale coordinates, incompatible calibration and joint limits block recovery", async () => {
  for (const change of ["unchecked", "stale", "mapping", "limits", "busy", "session", "revision", "missing"]) {
    const f = fixture(), c = f.context;
    if (change === "unchecked") f.node("recovery-confirmed").checked = false;
    if (change === "stale") c.fresh = false;
    if (change === "mapping") c.config.joints[0].scale = 2;
    if (change === "limits") c.status.mpos.x = 9999;
    if (change === "busy") c.program.busy = true;
    if (change === "session") c.controllerSession.generation++;
    if (change === "revision") c.revision++;
    if (change === "missing") delete c.status.mpos.c;
    await c.recoverReference();
    assert.equal(c.referenced, false, change);
    assert.ok(!f.calls.some((call) => call.method === "setSessionState"), change);
  }
});

test("a disconnect or setup change during the commit cannot activate the reference", async () => {
  for (const kind of ["connection", "setup"]) {
    const f = fixture(), gate = deferred(); f.context.commit = gate.promise;
    const pending = f.context.recoverReference();
    // Allow the getSessionState response to reach the commit await.
    await Promise.resolve();
    if (kind === "connection") f.context.controllerSession.generation++;
    else f.context.revision++;
    gate.resolve(); await pending;
    assert.equal(f.context.referenced, false);
    assert.match(f.node("recover-error").textContent, /changed/);
  }
});

test("connection-only clearing retains the candidate; calibration changes discard it", () => {
  const f = fixture(), recovery = f.context.controllerSession.recovery;
  f.context.clearReference("connection", { recoverable: true });
  assert.equal(f.context.controllerSession.recovery, recovery);
  assert.equal(f.calls.length, 0, "connection handler must not delete the host recovery copy");
  f.context.clearReference("configuration changed");
  assert.equal(f.context.controllerSession.recovery, null);
  assert.equal(f.calls[0].params.data, null);
});
