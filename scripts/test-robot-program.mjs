import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import "../plugins/robot-studio/kinematics.js";
import "../plugins/robot-studio/program-control.js";

const K = globalThis.RobotCore, P = globalThis.RobotProgramControl;
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
function fixture(options = {}) {
  const config = K.defaultConfig(), home = config.joints.map((j) => j.home);
  const plan = K.planProgram(config, home, [
    { name: "Out", type: "MoveJ", duration: 0.1, q: [20, ...home.slice(1)] },
    { name: "Back", type: "MoveJ", duration: 0.1, q: home },
  ]);
  const commands = [], files = options.files ?? new Map();
  let clock = 1000;
  const machine = { referenced: true, at: clock, status: null };
  function report(state = "Idle", q = home, sdFilename) {
    machine.at = ++clock;
    machine.status = { state, sdFilename,
      mpos: Object.fromEntries(config.joints.map((j, i) => [j.axis.toLowerCase(), q[i] * j.scale + j.zero])),
    };
  }
  report();
  const runner = P.create({ getState: () => machine, now: () => clock,
    call: async (method, params) => {
      commands.push({ method, params });
      if (method === "readFile") {
        if (options.readError) throw Error(options.readError);
        if (!files.has(params.path)) throw Error("Error: HTTP 404");
        return files.get(params.path);
      }
      if (method === "writeFile") {
        options.uploadEntered?.resolve();
        if (options.upload) await options.upload;
        if (options.writeError) throw Error(options.writeError);
        files.set(params.path, options.corrupt ? "truncated" : params.content);
      }
      if (method === "startProgramFile") {
        options.startEntered?.resolve();
        if (options.start) await options.start;
        if (options.startError) throw Error(options.startError);
        return { started: true };
      }
      if (method === "startProgramStream") return { jobId: 42, phase: "streaming", acceptedLine: null };
      if (method === "pauseProgramStream") return { jobId: 42, phase: "paused" };
      if (method === "resumeProgramStream") return { jobId: 42, phase: "streaming", acceptedLine: 10 };
    },
  });
  const calls = (method) => commands.filter((c) => c.method === method);
  const marker = (which) => runner.line(`[MSG:INFO: MSG,${P.sdFile(K.exportGcode(config, plan)).tag}_${which}]`);
  function finish() { marker("DONE"); report(); runner.tick(); }
  return { config, home, plan, commands, files, machine, report, runner, calls, marker, finish,
    advance: (ms) => { clock += ms; }, run: (extra = {}) => runner.run(config, plan, { source: "sd", ...extra }),
  };
}

test("SD saves once, verifies, runs once and waits for physical completion", async () => {
  const f = fixture();
  await f.run();
  assert.equal(f.calls("writeFile").length, 1);
  assert.equal(f.calls("readFile").length, 2);
  assert.ok(f.calls("readFile").every((c) => c.params.fresh && c.params.fs === "sd"));
  assert.equal(f.calls("startProgramFile")[0].params.path, P.SD_PATH);
  const code = f.files.get(P.SD_PATH);
  assert.match(code, /G4 P0\n\(MSG,ROBOT_STUDIO_\w+_DONE\)\nM2\n$/);
  f.report(); f.runner.tick();
  assert.equal(f.runner.active, true, "initial Idle cannot complete a cyclic job");
  f.marker("START");
  f.report("Run", f.plan.samples[20].q, "/sd/robot-studio.nc"); f.runner.tick();
  assert.equal(f.runner.state.phase, "running");
  assert.ok(f.runner.state.percent > 0);
  await f.runner.pause();
  assert.ok(f.calls("sendRealtime").some((c) => c.params.byte === 0x21));
  f.report("Hold", f.plan.samples[20].q, P.SD_PATH); f.runner.tick();
  await f.runner.resume();
  assert.ok(f.calls("sendRealtime").some((c) => c.params.byte === 0x7e));
  f.marker("DONE"); f.runner.tick();
  assert.equal(f.runner.active, true, "completion requires a newer Idle report");
  f.report("Idle", f.home, P.SD_PATH); f.runner.tick();
  assert.equal(f.runner.active, true, "completion waits for the file to close");
  f.finish();
  assert.equal(f.runner.state.phase, "completed");
  assert.equal(f.runner.state.percent, 100);
  for (let i = 0; i < 10; i++) { f.report(); f.runner.tick(); }
  assert.equal(f.calls("startProgramFile").length, 1);
  await f.run();
  assert.equal(f.calls("writeFile").length, 1, "unchanged rerun must not write the SD card");
  assert.equal(f.runner.state.sdReused, true);
});

test("save-only and a reopened plugin reuse verified SD content without starting motion", async () => {
  const f = fixture();
  await f.run({ saveOnly: true });
  assert.equal(f.runner.state.phase, "saved");
  assert.equal(f.calls("startProgramFile").length, 0);
  assert.equal(f.calls("sendRealtime").length, 0);
  const reopened = fixture({ files: f.files });
  await reopened.run();
  assert.equal(reopened.calls("writeFile").length, 0);
  assert.equal(reopened.calls("startProgramFile").length, 1);
});

test("changed or externally replaced programs are saved again", async () => {
  const f = fixture();
  await f.run({ saveOnly: true });
  f.plan.samples[10].q[0] += 0.01;
  await f.run({ saveOnly: true });
  assert.equal(f.calls("writeFile").length, 2);
  f.files.set(P.SD_PATH, "G1 X999\nM2\n");
  await f.run({ saveOnly: true });
  assert.equal(f.calls("writeFile").length, 3);
});

test("read failures, failed writes and corrupt verification never start a job", async () => {
  for (const options of [{ readError: "HTTP 503" }, { writeError: "Upload failed" }, { corrupt: true }]) {
    const f = fixture(options);
    await assert.rejects(f.run());
    assert.equal(f.calls("startProgramFile").length, 0);
    assert.equal(f.calls("sendRealtime").length, 0, "failed preparation must not reset the robot");
    if (options.readError) assert.equal(f.calls("writeFile").length, 0);
  }
});

test("Stop, a changed start pose and reference loss during upload prevent execution", async () => {
  for (const change of ["stop", "position", "reference"]) {
    const upload = deferred(), entered = deferred();
    const f = fixture({ upload: upload.promise, uploadEntered: entered });
    const pending = f.run();
    await entered.promise;
    await assert.rejects(f.run(), /already active/);
    if (change === "stop") f.runner.stop();
    else if (change === "position") f.report("Idle", [10, ...f.home.slice(1)]);
    else f.machine.referenced = false;
    assert.equal(f.runner.busy, true);
    upload.resolve();
    if (change === "stop") await pending;
    else await assert.rejects(pending, /moved|reference/);
    assert.equal(f.calls("startProgramFile").length, 0);
    assert.equal(f.calls("sendRealtime").length, 0);
  }
});

test("ambiguous SD starts and controller errors stop without replaying the start", async () => {
  const f = fixture({ startError: "startProgramFile timed out" });
  await assert.rejects(f.run(), /timed out/);
  assert.equal(f.calls("startProgramFile").length, 1);
  assert.ok(f.calls("sendRealtime").some((c) => c.params.byte === 0x18));
  const g = fixture(); await g.run();
  g.runner.line("error:20");
  assert.equal(g.runner.state.phase, "error");
  assert.ok(g.calls("sendRealtime").some((c) => c.params.byte === 0x18));
  const rejected = fixture({ startError: "Controller command channel is busy" });
  await assert.rejects(rejected.run(), /busy/);
  assert.equal(rejected.calls("sendRealtime").length, 0, "an explicit rejection must not reset someone else's job");
});

test("short cyclic jobs can complete between polls using their own completion marker", async () => {
  const f = fixture(); await f.run();
  f.runner.line("[MSG:INFO: MSG,ROBOT_STUDIO_WRONG_DONE]");
  f.report(); f.runner.tick();
  assert.equal(f.runner.active, true);
  f.finish();
  assert.equal(f.runner.state.phase, "completed");
});

test("missing start/completion evidence and incorrect final positions are not successes", async () => {
  const f = fixture(); await f.run();
  f.advance(11000); f.report(); f.runner.tick();
  assert.equal(f.runner.state.phase, "error");
  const g = fixture(); await g.run(); g.marker("START");
  g.report(); g.runner.tick(); g.advance(3100); g.report(); g.runner.tick();
  assert.match(g.runner.state.error, /completion marker/);
  const h = fixture(); await h.run(); h.marker("DONE");
  h.report("Idle", [5, ...h.home.slice(1)]); h.runner.tick();
  assert.match(h.runner.state.error, /final waypoint/);
});

test("Stop after dispatch resets, but reconnects never reset the newly connected controller", async () => {
  for (const kind of ["stop", "reconnect"]) {
    const start = deferred(), entered = deferred();
    const f = fixture({ start: start.promise, startEntered: entered });
    const pending = f.run(); await entered.promise;
    if (kind === "stop") f.runner.stop(); else f.runner.connectionChanged();
    start.resolve(); await pending;
    assert.equal(f.calls("sendRealtime").some((c) => c.params.byte === 0x18), kind === "stop");
    assert.equal(f.runner.active, false);
  }
});

test("a different SD job or control takeover relinquishes Robot Studio ownership", async () => {
  const f = fixture(); await f.run();
  f.report("Run", f.home, "/other.nc"); f.runner.tick();
  assert.match(f.runner.state.error, /Another SD program/);
  assert.ok(!f.calls("sendRealtime").some((c) => c.params.byte === 0x18));
  const g = fixture(); await g.run(); g.runner.controlTaken();
  assert.ok(g.calls("sendRealtime").some((c) => c.params.byte === 0x21));
  assert.equal(g.runner.active, false);
});

test("browser streaming still uses owned job controls and never touches the SD card", async () => {
  const f = fixture(); await f.run({ source: "stream" });
  assert.equal(f.calls("startProgramStream").length, 1);
  assert.equal(f.calls("readFile").length + f.calls("writeFile").length, 0);
  await f.runner.pause(); await f.runner.resume();
  assert.equal(f.calls("pauseProgramStream")[0].params.jobId, 42);
  f.runner.stream({ jobId: 42, phase: "completed" });
  f.runner.tick(); assert.equal(f.runner.active, true);
  f.report(); f.runner.tick(); assert.equal(f.runner.state.phase, "completed");
});

test("the host validates SD paths and rechecks physical position after closing the jog channel", async () => {
  const ts = (await import("typescript")).default;
  const source = readFileSync(new URL("../src/components/PluginFrame.tsx", import.meta.url), "utf8");
  const cases = source.slice(source.indexOf("case 'startProgramFile':"), source.indexOf("case 'getProgramStreamState':"));
  const code = ts.transpileModule(`globalThis.dispatch = (msg, reply) => { switch (msg.method) { ${cases} } };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  async function attempt({ path = P.SD_PATH, moved = false, blocked = false, connected = true, position = 0 } = {}) {
    const commands = [], gate = deferred();
    const machine = { connected, statusReceived: true, controllerResetPending: false,
      status: { state: "Idle", mpos: { x: 0, y: 0, z: 0, a: 0, b: 0, c: 0 } },
    };
    const context = {
      useMachineStore: { getState: () => machine },
      useGCodeSenderStore: { getState: () => ({ phase: "idle" }) },
      pluginSession: { read: () => ({ generation: 1 }) }, plugin: { id: "robot-studio" },
      streamStartPending: false, streamBusy: () => false, streamStartGeneration: 0,
      streamJobId: null, streamGeneration: 0, disposed: false,
      jogSender: { close: () => gate.promise },
      sendRaw: (command) => { if (blocked) return false; commands.push(command); return true; },
    };
    runInNewContext(code, context);
    const result = new Promise((resolve) => context.dispatch({ method: "startProgramFile", params: { path,
      startPosition: [..."XYZABC"].map((axis) => ({ axis, position, tolerance: 0.25 })),
    } }, (value, error) => resolve({ value, error })));
    if (moved) machine.status.mpos.x = 1;
    gate.resolve();
    return { ...(await result), commands };
  }
  const success = await attempt();
  assert.equal(success.value.started, true);
  assert.deepEqual(success.commands, ["$SD/Run=/robot-studio.nc"]);
  for (const options of [{ moved: true }, { connected: false }, { blocked: true }, { position: null }, { path: "/file.nc\nG1X100" }]) {
    const result = await attempt(options);
    assert.ok(result.error);
    assert.equal(result.commands.length, 0);
  }
});

test("execution source persists while older projects default to browser streaming", () => {
  const config = K.defaultConfig();
  const project = { format: "figui-robot-studio", version: 1, config, q: config.joints.map((j) => j.home), points: [] };
  assert.equal(K.validateProject(project).programSource, "stream");
  assert.equal(K.validateProject({ ...project, programSource: "sd" }).programSource, "sd");
  assert.throws(() => K.validateProject({ ...project, programSource: "network" }), /program source/);
});
