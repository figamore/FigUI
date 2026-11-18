import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import "../plugins/robot-studio/kinematics.js";
import "../plugins/robot-studio/live-control.js";
import "../plugins/robot-studio/jog-transport.js";
import "../plugins/robot-studio/program-control.js";

const K = globalThis.RobotCore;
test("browser plugin state persists across sessions and isolates controllers and plugins", async () => {
  const ts = (await import("typescript")).default;
  const source = readFileSync(new URL("../src/components/PluginFrame.tsx", import.meta.url), "utf8");
  const start = source.indexOf("async function onMessage(");
  const handler = source.slice(start, source.indexOf("window.addEventListener('message', onMessage)", start));
  const code = ts.transpileModule(handler, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const values = new Map();
  let controller = "http://first.local", failWrites = false, response;
  const frame = { postMessage(message) { response = message; } };
  const context = {
    getBase: () => controller,
    window: { location: { origin: "http://figui.local" } },
    iframeRef: { current: { contentWindow: frame } },
    disposed: false,
    plugin: { id: "robot-studio" },
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem(key, value) {
        if (failWrites) throw Error("Storage full");
        values.set(key, value);
      },
    },
  };
  const onMessage = runInNewContext(`${code}
onMessage`, context);
  const request = async (method, params) => {
    response = undefined;
    await onMessage({ source: frame, data: { type: "fluid-request", id: "storage", method, params } });
    return response;
  };
  const read = () => request("getLocalState");
  const write = (data) => request("setLocalState", { data });
  const data = { project: { config: { name: "Custom robot" } } };
  assert.equal((await read()).result, null);
  assert.equal((await write(data)).error, null);
  assert.deepEqual(JSON.parse(JSON.stringify((await read()).result)), data);
  controller = "http://second.local";
  assert.equal((await read()).result, null);
  controller = "http://first.local";
  context.plugin.id = "another-plugin";
  assert.equal((await read()).result, null);
  context.plugin.id = "robot-studio";
  assert.equal((await read()).result.project.config.name, "Custom robot");
  failWrites = true;
  assert.match((await write({})).error, /Storage full/);
  assert.equal((await read()).result.project.config.name, "Custom robot");
  values.set(values.keys().next().value, "invalid JSON");
  assert.match((await read()).error, /SyntaxError/);
});
test("live transport supports older bridges without HTTP or duplicate motion retries", async () => {
  const create = globalThis.RobotJogTransport.create,
    commands = [],
    command = "$J=G53 G90 G21 X10 F100",
    oldBridge = create({
      canSend: () => true,
      call: async (method, params) => {
        commands.push({ method, params });
        if (method === "sendJog") throw Error("Unknown method: sendJog");
        return null;
      },
    });
  await oldBridge.send(command);
  await oldBridge.send(command.replace("X10", "X20"));
  await oldBridge.cancel();
  await oldBridge.end();
  assert.deepEqual(commands.map((c) => c.method), [
    "sendJog", "sendCommand", "sendCommand", "sendRealtime", "sendRealtime",
  ]);
  assert.deepEqual(commands.slice(-2).map((c) => c.params.byte), [0x85, 0x3f]);
  assert.equal(commands[1].params.command, command);

  for (const message of ["sendJog timed out.", "error:22"]) {
    const requests = [],
      sender = create({
        canSend: () => true,
        call: async (method) => {
          requests.push(method);
          throw Error(message);
        },
      });
    await assert.rejects(sender.send(command), (e) => e.message === message);
    assert.deepEqual(requests, ["sendJog"]);
  }

  let rejectProbe;
  const requests = [],
    stopped = create({
      canSend: () => true,
      call: (method) => {
        requests.push(method);
        return method === "sendJog"
          ? new Promise((_, reject) => { rejectProbe = reject; })
          : Promise.resolve();
      },
    });
  const pending = stopped.send(command);
  await stopped.cancel();
  rejectProbe(Error("Unknown method: sendJog"));
  await pending;
  assert.ok(!requests.includes("sendCommand"), "Stop must discard a delayed fallback move");

  const modernRequests = [],
    modern = create({
      canSend: () => true,
      call: async (method) => { modernRequests.push(method); return "ok"; },
    });
  assert.equal(await modern.send(command), "ok");
  await modern.end();
  assert.deepEqual(modernRequests, ["sendJog", "endJog"]);
});
test("SD assets load sequentially, retry transient failures, and report permanent failures", async () => {
  const html = readFileSync(
    new URL("../plugins/robot-studio/index.html", import.meta.url),
    "utf8",
  );
  const bootstrap = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].find(
    (match) => match[1].includes("loadAsset"),
  )?.[1];
  assert.ok(bootstrap);
  assert.doesNotMatch(html, /<script[^>]+src=/);
  for (const permanentFailure of [false, true]) {
    let onLoad,
      active = 0,
      maximumActive = 0;
    const requests = [],
      failures = new Map();
    const nodes = {
      "viewer-loading": { textContent: "Loading 3D workcell…" },
      message: { textContent: "", classList: { add() {} } },
    };
    runInNewContext(bootstrap, {
      URL,
      setTimeout: (fn) => queueMicrotask(fn),
      window: {
        addEventListener: (event, fn) => {
          assert.equal(event, "load");
          onLoad = fn;
        },
      },
      document: {
        baseURI: "http://controller.test/sd/plugins/robot-studio/",
        getElementById: (id) => nodes[id],
        querySelector: () => ({ sheet: null }),
        createElement: () => ({ remove() {} }),
        head: {
          append(element) {
            const url = new URL(element.src || element.href),
              filename = url.pathname.split("/").at(-1);
            requests.push(url);
            active++;
            maximumActive = Math.max(maximumActive, active);
            queueMicrotask(() => {
              active--;
              const count = failures.get(filename) || 0;
              if (
                filename === "viewer.js" &&
                (permanentFailure || count === 0)
              ) {
                failures.set(filename, count + 1);
                element.onerror();
              } else element.onload();
            });
          },
        },
      },
    });
    assert.equal(requests.length, 0, "No request before page assets finish");
    await onLoad();
    assert.equal(
      maximumActive,
      1,
      "Device must never receive overlapping asset reads",
    );
    assert.deepEqual(
      requests.slice(0, 3).map((url) => url.pathname.split("/").at(-1)),
      ["style.css", "kinematics.js", "viewer-lib.js"],
    );
    assert.equal(requests.find((url) => url.pathname.endsWith("/viewer.js") && url.searchParams.has("robot_retry")).searchParams.get("robot_retry"), "1");
    if (permanentFailure) {
      assert.equal(failures.get("viewer.js"), 3);
      assert.ok(requests.every((url) => !url.pathname.endsWith("/app.js")));
      assert.match(
        nodes["viewer-loading"].textContent,
        /Could not load http:\/\/controller.test\/sd\/plugins\/robot-studio\/viewer.js/,
      );
    } else {
      assert.ok(requests.at(-1).pathname.endsWith("/app.js"));
      assert.equal(nodes.message.textContent, "");
    }
  }
});
const c = K.forearmRollConfig(),
  home = c.joints.map((j) => j.home);
const project = () => ({
  format: "figui-robot-studio",
  version: 1,
  config: structuredClone(c),
  q: [...home],
  points: [],
  endEffector: K.validateEndEffector(),
  programMaximums: true,
  jogMaximums: true,
  programSource: "stream",
});
const near = (a, b, tolerance = 1e-8) =>
  assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);

test("standard DH forward transform agrees with a hand-computed zero pose", () => {
  const f = K.forward(c, [0, 0, 0, 0, 0, 0]);
  // At zero the upper arm, forearm, flange and tool extend along world +X.
  near(f.pose.x, 320 + 260 + 75 + 80);
  near(f.pose.y, 0);
  near(f.pose.z, 180);
  [f.tcp[2], f.tcp[6], f.tcp[10]].forEach((v, i) => near(v, [1, 0, 0][i]));
});
test("forearm-roll preset has the requested axis relationships throughout articulation", () => {
  const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
  for (const q of [
    home,
    [80, 20, -60, 140, 45, -120],
    [-150, -40, 110, -160, -70, 250],
  ]) {
    const f = K.forward(c, q);
    near(Math.abs(dot(f.axes[1], f.axes[2])), 1); // shoulder / elbow parallel
    near(dot(f.axes[2], f.axes[3]), 0); // elbow / forearm roll perpendicular
    near(dot(f.axes[3], f.axes[4]), 0); // forearm roll / wrist bend perpendicular
    near(dot(f.axes[4], f.axes[5]), 0); // wrist bend / tool rotation perpendicular
    const forearm = K.sub(f.origins[4], f.origins[2]);
    near(K.norm(forearm), c.joints[3].d);
    near(dot(forearm, f.axes[3]), K.norm(forearm));
    const wrist = K.forward(
      c,
      q.map((v, i) => (i === 3 ? v + 15 : v)),
    );
    f.origins[4].forEach((v, i) => near(v, wrist.origins[4][i]));
  }
  for (const i of [0, 3]) {
    near(c.joints[i].max - c.joints[i].min, 360);
    const low = [...home],
      high = [...home];
    low[i] = -180;
    high[i] = 180;
    K.forward(c, low).tcp.forEach((v, k) => near(v, K.forward(c, high).tcp[k]));
  }
});
test("tool rotation changes orientation without displacing the coaxial TCP", () => {
  const target = [...home];
  target[5] += 90;
  const a = K.forward(c, home).tcp,
    b = K.forward(c, target).tcp;
  K.position(a).forEach((v, i) => near(v, K.position(b)[i]));
  near(K.norm(K.rotationError(b, a)), Math.PI / 2);
});
test("projects without optional joint names retain their original geometry", () => {
  const saved = project();
  saved.config.joints.forEach((j) => delete j.name);
  saved.config.joints[2].a = 260;
  saved.config.joints[2].alpha = 0;
  saved.config.joints[2].offset = 0;
  assert.deepEqual(K.validateProject(saved), saved);
});
test("base and tool transforms compose in their local frames", () => {
  const modified = structuredClone(c);
  modified.base = { x: 100, y: -20, z: 50, rx: 20, ry: -15, rz: 45 };
  modified.tool = { x: 20, y: -30, z: 100, rx: 10, ry: 30, rz: 70 };
  const f = K.forward(modified, home);
  const noFrames = structuredClone(c);
  noFrames.base = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 };
  noFrames.tool = { ...noFrames.base };
  const expected = K.multiply(
    K.multiply(K.poseMatrix(modified.base), K.forward(noFrames, home).tcp),
    K.poseMatrix(modified.tool),
  );
  f.tcp.forEach((v, i) => near(v, expected[i]));
  const solved = K.inverse(
    modified,
    f.tcp,
    home.map((v) => v + 5),
  );
  assert.ok(solved.ok);
});
test("IK recovers reachable position and orientation across multiple poses", () => {
  for (const target of [
    [20, 20, 80, -110, -70, 25],
    [-30, 60, 30, -80, -50, 60],
    [90, -20, 95, -60, -90, 120],
    [-80, 90, -50, 10, 45, -130],
  ]) {
    const matrix = K.forward(c, target).tcp,
      r = K.inverse(c, matrix, home);
    assert.ok(r.ok, JSON.stringify(r));
    K.validateJoints(c, r.q);
    const actual = K.forward(c, r.q).tcp;
    assert.ok(K.norm(K.sub(K.position(matrix), K.position(actual))) < 0.15);
    assert.ok(K.norm(K.rotationError(matrix, actual)) * K.DEG < 0.1);
  }
});
test("rotation log detects exactly 180 degrees and Euler singularities round-trip", () => {
  const identity = K.identity(),
    halfTurn = K.poseMatrix({ x: 0, y: 0, z: 0, rx: 180, ry: 0, rz: 0 });
  near(K.norm(K.rotationError(halfTurn, identity)), Math.PI);
  for (const ry of [-90, 90]) {
    const m = K.poseMatrix({ x: 3, y: 4, z: 5, rx: 27, ry, rz: 65 }),
      out = K.poseMatrix(K.matrixPose(m));
    m.forEach((v, i) => near(v, out[i]));
  }
  const middle = K.interpolatePose(identity, halfTurn, 0.5);
  near(K.norm(K.rotationError(middle, identity)), Math.PI / 2);
});
test("unreachable and joint-constrained targets fail without modifying their seed", () => {
  const seed = [...home],
    target = K.forward(c, home).tcp;
  target[3] = 10000;
  assert.equal(K.inverse(c, target, seed).ok, false);
  assert.deepEqual(seed, home);
  const limited = structuredClone(c);
  limited.joints.forEach((j) => {
    j.min = j.home - 0.01;
    j.max = j.home + 0.01;
  });
  assert.equal(
    K.inverse(limited, K.forward(c, [50, 10, 50, -60, -40, 50]).tcp, home).ok,
    false,
  );
});
test("MoveJ timing bounds sampled velocities and accelerations, including endpoints", () => {
  const speed = 0.2,
    acceleration = 0.35,
    p = K.planSegment(c, home, [160, -100, 140, 150, 100, 300], {
      duration: 0.1,
      speed,
      acceleration,
    });
  assert.ok(p.duration > 0.1);
  assert.deepEqual(p.samples[0].q, home);
  assert.deepEqual(p.samples.at(-1).q, [160, -100, 140, 150, 100, 300]);
  for (let j = 0; j < 6; j++) {
    let previous = 0;
    const dt = p.duration / (p.samples.length - 1);
    for (let i = 1; i < p.samples.length; i++) {
      const velocity = (p.samples[i].q[j] - p.samples[i - 1].q[j]) / dt;
      assert.ok(Math.abs(velocity) <= c.joints[j].velocity * speed + 1e-8);
      assert.ok(
        Math.abs(velocity - previous) / dt <=
          c.joints[j].acceleration * acceleration + 1e-8,
      );
      previous = velocity;
    }
    assert.ok(
      Math.abs(previous) / dt <= c.joints[j].acceleration * acceleration + 1e-8,
    );
  }
});
test("MoveL samples follow the Cartesian line and shortest orientation interpolation", () => {
  const to = [10, 40, 60, -100, -85, 10],
    p = K.planSegment(c, home, to, { type: "MoveL", speed: 0.25 });
  const a = K.forward(c, home).tcp,
    b = K.forward(c, to).tcp;
  p.samples.forEach((sample, i) => {
    const t = i / (p.samples.length - 1),
      s = t * t * t * (10 + t * (-15 + 6 * t)),
      expected = K.interpolatePose(a, b, s),
      actual = K.forward(c, sample.q).tcp;
    assert.ok(K.norm(K.sub(K.position(expected), K.position(actual))) < 0.15);
    assert.ok(K.norm(K.rotationError(expected, actual)) * K.DEG < 0.1);
  });
});
test("MoveL rejects an unsolved intermediate path even with valid endpoint joint poses", () => {
  const endpoint = [-150, -80, 120, 90, 100, 200];
  K.validateJoints(c, endpoint);
  assert.throws(
    () => K.planSegment(c, home, endpoint, { type: "MoveL" }),
    /MoveL cannot be solved at/,
  );
  assert.doesNotThrow(() =>
    K.planSegment(c, home, endpoint, { type: "MoveJ" }),
  );
});
test("project validation rejects malformed geometry, unsafe mappings and invalid waypoints atomically", () => {
  assert.deepEqual(
    K.validateProject(JSON.parse(JSON.stringify(project()))),
    project(),
  );
  for (const mutate of [
    (p) => (p.version = 2),
    (p) => p.config.joints.pop(),
    (p) => (p.config.joints[0].scale = 0),
    (p) => (p.config.joints[0].a = NaN),
    (p) => (p.config.joints[0].axis = "Y"),
    (p) => (p.config.joints[0].home = 999),
    (p) => (p.config.joints[0].velocity = -1),
    (p) => (p.q[0] = Infinity),
    (p) => (p.points = [{ name: "Bad", type: "MoveL", duration: 0, q: home }]),
    (p) => (p.config.base.x = "0"),
  ]) {
    const p = project();
    mutate(p);
    assert.throws(() => K.validateProject(p));
  }
});
test("G-code has explicit machine coordinates, inverse time feeds, dwell handling, and start precondition", () => {
  const changed = structuredClone(c);
  changed.joints[0].scale = -2;
  changed.joints[0].zero = 10;
  const p = K.planProgram(changed, home, [
    { type: "MoveJ", duration: 1, q: [10, ...home.slice(1)] },
    { type: "MoveJ", duration: 1, q: [10, ...home.slice(1)] },
  ]);
  const code = K.exportGcode(changed, p);
  assert.match(code, /START REQUIRED: X10\.00000/);
  assert.match(code, /G93 G53 G1 X-10(?:\s|$)/m);
  assert.match(code, /G4 P/);
  assert.ok(code.endsWith("G94\nM2\n"));
  assert.doesNotMatch(code, /NaN|Infinity/);
  const firstMotion = code.split("\n").find((line) => line.startsWith("G93 "));
  near(
    Number(firstMotion.match(/ F([\d.]+)/)[1]),
    60 / (p.samples[1].t - p.samples[0].t),
    1e-5,
  );
});
test("machine conversion requires all six reported positions and honors direction/zero", () => {
  const mapped = structuredClone(c);
  mapped.joints[0].scale = -2;
  mapped.joints[0].zero = 30;
  const mpos = Object.fromEntries(
    mapped.joints.map((j, i) => [
      j.axis.toLowerCase(),
      home[i] * j.scale + j.zero,
    ]),
  );
  K.machineJoints(mapped, { mpos }).forEach((v, i) => near(v, home[i]));
  delete mpos.c;
  assert.throws(() => K.machineJoints(mapped, { mpos }));
  assert.throws(() => K.jogCommand(c, home, home, 0.25));
  assert.throws(() => K.jogCommand(c, home, home, 0));
  assert.match(
    K.jogCommand(mapped, home, [20, ...home.slice(1)], 0.25),
    /^\$J=G53 G90 G21 X-10\.00000 .* F[\d.]+$/,
  );
});
test("store manifest contains every flat plugin asset", () => {
  const root = new URL("../plugins/robot-studio/", import.meta.url),
    manifest = JSON.parse(readFileSync(new URL("plugin.json", root), "utf8"));
  for (const file of manifest.files) {
    assert.ok(!file.includes("/"));
    assert.ok(existsSync(new URL(file, root)), file);
  }
  const registry = JSON.parse(
    readFileSync(new URL("../plugins/registry.json", import.meta.url), "utf8"),
  );
  assert.ok(
    registry.plugins.some(
      (p) => p.id === "robot-studio" && p.version === manifest.version,
    ),
  );
});

test("Standard arm DH has independently computed zero and bent poses", () => {
  const c = K.defaultConfig();
  assert.equal(c.name, "Standard arm · 6-axis");
  const f = K.forward(c, [0, 0, 0, 0, 0, 0]);
  near(f.pose.x, -1150);
  near(f.pose.y, -250);
  near(f.pose.z, 40);
  const bent = K.forward(c, [0, 0, 90, 0, 90, 0]);
  near(bent.pose.x, -490);
  near(bent.pose.y, -160);
  near(bent.pose.z, -490);
  assert.deepEqual(
    c.joints.map((j) => j.offset),
    [0, 0, 0, 0, 0, 0],
  );
  assert.equal(c.tool.z, 0);
});
test("Parallel-elbow layouts keep shoulder, elbow and wrist 1 parallel at arbitrary poses", () => {
  for (const model of ["standard", "compact", "medium", "extended"]) {
    const c = K.parallelElbowConfig(model);
    assert.ok(K.isParallelElbowLayout(c));
    for (const q of [
      [0, -90, 90, -90, -90, 0],
      [34, -45, 70, 22, -38, 100],
    ]) {
      const f = K.visualGeometry(c, q);
      const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
      near(dot(f.axes[1], f.axes[2]), 1);
      near(dot(f.axes[2], f.axes[3]), 1);
      near(dot(f.axes[3], f.axes[4]), 0);
      near(dot(f.axes[4], f.axes[5]), 0);
      // Rendered housings lie on the exact solver axes, not a second model.
      f.centers.forEach((center, i) => {
        const d = K.sub(center, f.origins[i]);
        near(Math.abs(dot(d, f.axes[i])), K.norm(d));
      });
      const result = K.inverse(
        c,
        f.tcp,
        q.map((v) => v + 5),
      );
      assert.ok(result.ok, JSON.stringify(result));
    }
  }
});
test("upright home aligns both long links and wrist vertically with the flange outward", () => {
  for (const model of ["standard", "compact", "medium", "extended"]) {
    const c = K.parallelElbowConfig(model),
      home = K.uprightHome(c),
      f = K.forward(c, home);
    assert.deepEqual(c.joints.map((j) => j.home), home);
    assert.deepEqual(home, [0, -90, 0, -90, 0, 0]);
    for (const i of [1, 2]) {
      const link = K.sub(K.position(f.frames[i + 1]), K.position(f.frames[i]));
      near(link[0], 0);
      near(link[1], 0);
      near(link[2], -c.joints[i].a);
    }
    // Wrist 2 rises above wrist 1; the flange extends horizontally along
    // the same outward axis as the shoulder, as in the reference image.
    const wrist = K.sub(f.origins[5], f.origins[4]);
    near(wrist[0], 0);
    near(wrist[1], 0);
    near(wrist[2], c.joints[4].d);
    near(f.tcp[2], 0);
    near(f.tcp[6], -1);
    near(f.tcp[10], 0);
    const flange = K.sub(K.position(f.tcp), f.origins[5]);
    flange.forEach((v, i) => near(v, f.axes[1][i] * c.joints[5].d));
    c.joints[3].min = -45;
    assert.throws(() => K.uprightHome(c), /J4/);
  }
  assert.throws(() => K.uprightHome(K.forearmRollConfig()), /parallel-elbow/);
});
test("custom link dimensions feed the same FK, IK and MoveL planner", () => {
  const c = K.defaultConfig();
  c.joints[0].d = 110;
  c.joints[1].a = -240;
  c.joints[2].a = -220;
  c.joints[3].d = 90;
  c.joints[4].d = 65;
  c.joints[5].d = 55;
  const from = [0, -90, 90, -90, -90, 0],
    to = [5, -85, 85, -85, -85, 5];
  const segment = K.planSegment(c, from, to, { type: "MoveL" });
  assert.ok(segment.samples.length > 2);
  const target = K.forward(c, to).tcp,
    actual = K.forward(c, segment.samples.at(-1).q).tcp;
  assert.ok(K.norm(K.sub(K.position(target), K.position(actual))) < 0.15);
});
test("manual reference maps all six current positions to home without mutating the project", () => {
  const c = K.defaultConfig();
  c.joints[1].scale = -2;
  const before = structuredClone(c),
    status = {
      state: "Idle",
      mpos: { x: 10, y: 20, z: 30, a: 40, b: 50, c: 60 },
    };
  const referenced = K.referenceConfig(c, status);
  assert.deepEqual(c, before);
  K.machineJoints(referenced, status).forEach((v, i) =>
    near(v, c.joints[i].home),
  );
  assert.equal(referenced.joints[1].zero, -160);
  for (const state of ["Jog", "Alarm", "Run"])
    assert.throws(() => K.referenceConfig(c, { ...status, state }));
  for (const invalid of [undefined, NaN, Infinity, "0"]) {
    assert.throws(() =>
      K.referenceConfig(c, {
        state: "Idle",
        mpos: { ...status.mpos, b: invalid },
      }),
    );
  }
});
test("viewer is a local classic bundle compatible with opaque-origin plugin frames", () => {
  const html = readFileSync(
    new URL("../plugins/robot-studio/index.html", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(html, /importmap|cdn.jsdelivr/);
  assert.match(html, /viewer-lib\.js/);
  const viewer = readFileSync(
    new URL("../plugins/robot-studio/viewer.js", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(viewer, /import\(/);
  assert.match(viewer, /K\.visualGeometry/);
  assert.doesNotMatch(html + viewer, /gunzipSync/);
});

const L = globalThis.RobotLiveControl;
function liveFixture(options = {}) {
  const config = K.defaultConfig(),
    commands = [],
    stops = [];
  let clock = 1000,
    cancels = 0;
  const state = {
    enabled: true,
    q: config.joints.map((j) => j.home),
    state: "Idle",
    at: clock,
    speed: 0.25,
  };
  const control = L.create({
    getConfig: () => config,
    getState: () => state,
    now: () => clock,
    send: async (command) => {
      commands.push(command);
      return options.send ? options.send(command) : "ok";
    },
    cancel: async () => {
      cancels++;
      if (options.cancel) await options.cancel();
    },
    onStop: (reason) => stops.push(reason),
  });
  return {
    config,
    state,
    control,
    commands,
    stops,
    get cancels() {
      return cancels;
    },
    advance(ms, report = false) {
      clock += ms;
      if (report) state.at = clock;
    },
    arrive(command = commands.at(-1)) {
      state.q = config.joints.map((j, i) => {
        const match = command.match(new RegExp(`${j.axis}(-?[\\d.]+)`));
        return match ? (Number(match[1]) - j.zero) / j.scale : state.q[i];
      });
      clock += 250;
      state.at = clock;
      state.state = "Idle";
    },
  };
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
test("live goals use one continuous axis move at joint velocity and honor gearing direction", () => {
  const c = K.defaultConfig(),
    q = c.joints.map((j) => j.home);
  c.joints[1].scale = -2;
  c.joints[1].zero = 30;
  const r = L.goal(c, q, 1, 300, 0.25);
  near(r.q[1], 300);
  r.q.forEach((v, i) => {
    if (i !== 1) near(v, q[i]);
  });
  assert.equal(r.command, "$J=G53 G90 G21 Y-570.00000 F300.0000");
  assert.throws(() => L.goal(c, q, 2, 181, 0.25));
  assert.throws(() => L.goal(c, q, 8, 0, 0.25));
});
test("one angle request is one uninterrupted move, with no microscopic restart loop", async () => {
  const f = liveFixture();
  f.control.start();
  f.control.setTarget(0, 20);
  await f.control.tick();
  assert.equal(f.commands[0], "$J=G53 G90 G21 X20.00000 F150.0000");
  for (let i = 1; i <= 8; i++) {
    f.advance(500, true);
    f.state.state = "Jog";
    f.state.q[0] = i * 2;
    await f.control.tick();
  }
  assert.equal(f.commands.length, 1);
  assert.equal(f.cancels, 0);
  assert.equal(f.control.active, true);
  f.arrive();
  await f.control.tick();
  assert.equal(f.control.busy, false);
  await f.control.tick();
  assert.equal(f.commands.length, 1);
});
test("same-direction target extensions blend while Jog and have at most two planner endpoints", async () => {
  const f = liveFixture();
  f.control.start();
  f.control.setTarget(0, 20);
  await f.control.tick();
  f.advance(150, true);
  f.state.state = "Jog";
  f.state.q[0] = 5;
  f.control.setTarget(0, 30);
  await f.control.tick();
  assert.equal(f.commands.length, 2);
  for (let angle = 40; angle <= 80; angle += 10) {
    f.control.setTarget(0, angle);
    f.advance(150, true);
    await f.control.tick();
  }
  assert.equal(f.commands.length, 2);
  assert.equal(f.cancels, 0);
  f.advance(150, true);
  f.state.q[0] = 20;
  await f.control.tick();
  assert.equal(f.commands.length, 3);
  assert.equal(f.commands[2], "$J=G53 G90 G21 X80.00000 F150.0000");
});
test("shorter targets, reversals and joint changes cancel old goals before a fresh Idle restart", async () => {
  for (const [joint, angle] of [
    [0, 10],
    [0, -10],
    [1, -45],
  ]) {
    const f = liveFixture();
    f.control.start();
    f.control.setTarget(0, 20);
    await f.control.tick();
    f.advance(150, true);
    f.state.state = "Jog";
    f.state.q[0] = 5;
    f.control.setTarget(joint, angle);
    await flush();
    assert.equal(f.cancels, 1);
    await f.control.tick();
    assert.equal(f.commands.length, 1, "No command during deceleration");
    f.advance(200, true);
    f.state.state = "Idle";
    f.state.q[0] = 6;
    await f.control.tick();
    assert.equal(f.commands.length, 2);
    assert.match(
      f.commands[1],
      new RegExp(`${f.config.joints[joint].axis}${angle.toFixed(5)}`),
    );
    assert.equal(
      f.commands[1].match(/ [XYZABC]-?[\d.]+/g).length,
      1,
      "Never commands other joints",
    );
  }
});
test("rapid targets before dispatch keep only the newest destination", async () => {
  const f = liveFixture();
  f.control.start();
  for (let a = 1; a <= 100; a++) f.control.setTarget(0, a);
  await f.control.tick();
  assert.equal(f.commands.length, 1);
  assert.match(f.commands[0], /X100\.00000/);
});
test("slow transport prevents overlapping writes and stopped delayed sends are cancelled again", async () => {
  let resolve;
  const f = liveFixture({ send: () => new Promise((r) => (resolve = r)) });
  f.control.start();
  f.control.setTarget(0, 20);
  const sending = f.control.tick();
  f.control.setTarget(0, 40);
  await f.control.tick();
  assert.equal(f.commands.length, 1);
  f.control.stop();
  assert.equal(f.control.active, false);
  assert.equal(f.cancels, 1);
  assert.throws(() => f.control.start(), /finish cancelling/);
  resolve("ok");
  await sending;
  assert.equal(f.cancels, 2);
  f.advance(100, true);
  f.control.start();
  await f.control.tick();
  assert.equal(f.commands.length, 1, "Stopped destinations cannot replay");
});
test("jog-button release cancels motion while keeping live mode ready for another joint", async () => {
  const f = liveFixture();
  f.control.start();
  f.control.setTarget(0, 360);
  await f.control.tick();
  f.control.release();
  await flush();
  assert.equal(f.control.active, true);
  assert.equal(f.cancels, 1);
  f.advance(250, true);
  f.state.q[0] = 2;
  await f.control.tick();
  assert.equal(f.control.busy, false);
  assert.equal(f.commands.length, 1);
  f.control.setTarget(1, -360);
  await f.control.tick();
  assert.equal(f.commands.length, 2);
  assert.match(f.commands[1], /Y-360\.00000/);
});
test("late jog cancellation responses preserve live mode after release and retarget", async () => {
  for (const action of ["release", "retarget"]) {
    let reject;
    const f = liveFixture({ send: () => new Promise((resolve, fail) => { reject = fail; }) });
    f.control.start();
    f.control.setTarget(0, 20);
    const pendingTick = f.control.tick();
    if (action === "release") f.control.release();
    else f.control.setTarget(1, -45);
    reject(Error("Error: Jog cancelled"));
    await pendingTick;
    await flush();
    assert.equal(f.control.active, true, action);
    assert.deepEqual(f.stops, [], action);
    assert.equal(f.commands.length, 1);
    if (action === "release") f.control.setTarget(1, -45);
    await f.control.tick();
    assert.equal(f.commands.length, 1, "Wait for fresh Idle after cancel");
    f.advance(200, true);
    const nextTick = f.control.tick();
    assert.equal(f.commands.length, 2, "Next joint is usable without re-enabling live mode");
    assert.match(f.commands[1], /Y-45\.00000/);
    f.control.release();
    reject(Error("Jog cancelled"));
    await nextTick;
  }
});

test("unexpected cancellations and real errors still stop live control", async () => {
  for (const response of ["Error: Jog cancelled", "error:22", "sendJog timed out."]) {
    let reject;
    const f = liveFixture({ send: () => new Promise((resolve, fail) => { reject = fail; }) });
    f.control.start();
    f.control.setTarget(0, 20);
    const pendingTick = f.control.tick();
    if (response !== "Error: Jog cancelled") f.control.release();
    reject(Error(response));
    await pendingTick;
    assert.equal(f.control.active, false);
    assert.equal(f.stops[0], response);
  }
});

test("cancellation must finish before another mode can take ownership", async () => {
  let finish;
  const f = liveFixture({ cancel: () => new Promise((r) => (finish = r)) });
  f.control.start();
  f.control.setTarget(0, 20);
  await f.control.tick();
  f.control.stop();
  assert.ok(f.control.busy);
  assert.throws(() => f.control.start(), /finish cancelling/);
  finish();
  await flush();
  assert.equal(f.control.busy, false);
});
test("missing telemetry, disarming and invalid controller state stop live motion", async () => {
  for (const cause of ["stale", "disabled", "alarm", "invalid"]) {
    const f = liveFixture();
    f.control.start();
    f.control.setTarget(0, 20);
    await f.control.tick();
    if (cause === "stale") f.advance(2100);
    if (cause === "disabled") f.state.enabled = false;
    if (cause === "alarm") f.state.state = "Alarm";
    if (cause === "invalid") f.state.q[2] = Infinity;
    await f.control.tick();
    assert.equal(f.control.active, false, cause);
    assert.equal(f.cancels, 1, cause);
    f.state.enabled = true;
    f.state.state = "Idle";
    f.advance(10, true);
    await f.control.tick();
    assert.equal(f.commands.length, 1);
  }
});
test("acknowledged command errors stop the scheduler and are surfaced", async () => {
  const f = liveFixture({ send: async () => "error:9" });
  f.control.start();
  f.control.setTarget(0, 20);
  await f.control.tick();
  assert.equal(f.control.active, false);
  assert.match(f.stops[0], /error:9/);
  assert.equal(f.cancels, 1);
});
test("long moves remain continuous while progressing, and a stalled joint times out", async () => {
  const f = liveFixture();
  f.control.start();
  f.control.setTarget(0, 100);
  await f.control.tick();
  for (let i = 1; i <= 10; i++) {
    f.advance(1000, true);
    f.state.state = "Jog";
    f.state.q[0] = i * 2;
    await f.control.tick();
    assert.ok(f.control.active);
  }
  assert.equal(f.commands.length, 1);
  f.advance(5100, true);
  await f.control.tick();
  assert.equal(f.control.active, false);
  assert.match(f.stops[0], /not making progress/);
});
test("speed changes replan a moving goal and retain live mode", async () => {
  const f = liveFixture();
  f.control.start();
  f.control.setTarget(0, 20);
  await f.control.tick();
  f.state.speed = 0.5;
  f.advance(150, true);
  f.state.state = "Jog";
  f.state.q[0] = 3;
  await f.control.tick();
  await flush();
  assert.equal(f.cancels, 1);
  assert.ok(f.control.active);
  f.advance(250, true);
  f.state.state = "Idle";
  await f.control.tick();
  assert.match(f.commands[1], /F300\.0000$/);
});
test("live enable is motionless and requires fresh Idle telemetry", () => {
  const f = liveFixture();
  f.state.state = "Jog";
  assert.throws(() => f.control.start(), /Idle/);
  f.state.state = "Idle";
  f.state.enabled = false;
  assert.throws(() => f.control.start(), /manual reference/);
  f.state.enabled = true;
  f.advance(2100);
  assert.throws(() => f.control.start(), /stale/);
  f.advance(1, true);
  f.control.start();
  assert.equal(f.commands.length, 0);
});
test("failed cancellation disables control without recursive cancel requests", async () => {
  const f = liveFixture({
    cancel: async () => {
      throw Error("disconnected");
    },
  });
  f.control.start();
  f.control.setTarget(0, 20);
  await f.control.tick();
  f.control.release();
  await flush();
  assert.equal(f.control.active, false);
  assert.equal(f.cancels, 1);
  assert.match(f.stops[0], /cancel failed/);
});

test("held jogs stream bounded endpoints before Idle and cancel on release", async () => {
  const f = liveFixture();
  f.control.start();
  f.control.setTarget(0, 360, { jog: true });
  await f.control.tick();
  assert.equal(f.commands[0], "$J=G53 G90 G21 X5.00000 F150.0000");
  f.advance(150, true);
  f.state.state = "Jog";
  f.state.q[0] = 1;
  await f.control.tick();
  assert.equal(f.commands[1], "$J=G53 G90 G21 X10.00000 F150.0000");
  f.advance(1000, true);
  f.state.q[0] = 3;
  await f.control.tick();
  assert.equal(f.commands.length, 2);
  f.advance(1000, true);
  f.state.q[0] = 5;
  await f.control.tick();
  assert.equal(f.commands[2], "$J=G53 G90 G21 X15.00000 F150.0000");
  f.control.release();
  await flush();
  assert.equal(f.cancels, 1);
  assert.ok(f.control.active);
  f.advance(250, true);
  f.state.state = "Idle";
  await f.control.tick();
  assert.equal(f.commands.length, 3);
});
