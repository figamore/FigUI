import assert from "node:assert/strict";
import { test } from "node:test";
import "../plugins/robot-studio/kinematics.js";

const K = globalThis.RobotCore;
const config = K.defaultConfig();
const home = config.joints.map((j) => j.home);
const pose = (x) => [x, ...home.slice(1)];
const point = (x, extra = {}) => ({ name: String(x), q: pose(x), type: "MoveJ", duration: 0.1, ...extra });
const codeLines = (plan, model = config) => K.exportGcode(model, plan).split("\n");

test("MoveJ sampling is independent of TCP lever length", () => {
  const segment = K.planSegment(config, home, [0, -60, 0, -90, 0, 0]);
  assert.equal(segment.samples.length, 41);
});

test("tiny joint moves do not retain the forty-command minimum", () => {
  for (const delta of [0.01, 0.1]) {
    const segment = K.planSegment(config, home, pose(delta), { duration: 0.1 });
    assert.ok(segment.samples.length <= 6);
    assert.ok(segment.duration / (segment.samples.length - 1) >= 0.025);
    assert.deepEqual(segment.samples.at(-1).q, pose(delta));
    let previous = 0;
    for (let i = 1; i < segment.samples.length; i++) {
      const a = segment.samples[i - 1], b = segment.samples[i], dt = b.t - a.t;
      const velocity = (b.q[0] - a.q[0]) / dt;
      assert.ok(Math.abs(velocity) <= config.joints[0].velocity);
      assert.ok(Math.abs(velocity - previous) / dt <= config.joints[0].acceleration);
      previous = velocity;
    }
  }
});

test("joint waypoints carry velocity through joins and honor joint limits", () => {
  const plan = K.planProgram(config, home, [point(20), point(50), point(60)]);
  for (let i = 0; i < plan.segments.length - 1; i++) {
    const a = plan.segments[i].samples, b = plan.segments[i + 1].samples;
    const incoming = (a.at(-1).q[0] - a.at(-2).q[0]) / (a.at(-1).t - a.at(-2).t);
    const outgoing = (b[1].q[0] - b[0].q[0]) / (b[1].t - b[0].t);
    assert.ok(incoming > 1 && outgoing > 1, "join must not decelerate to rest");
    assert.ok(Math.abs(incoming - outgoing) < 0.1, "join velocity must be continuous");
    assert.deepEqual(a.at(-1).q, b[0].q);
  }
  let previousVelocity = Array(6).fill(0), previousDt = 0;
  for (const segment of plan.segments) {
    const lo = segment.samples[0].q, hi = segment.samples.at(-1).q;
    segment.samples.forEach(({ q }) => q.forEach((v, j) => {
      assert.ok(v >= Math.min(lo[j], hi[j]) - 1e-9 && v <= Math.max(lo[j], hi[j]) + 1e-9);
    }));
    for (let i = 1; i < segment.samples.length; i++) {
      const a = segment.samples[i - 1], b = segment.samples[i], dt = b.t - a.t;
      previousVelocity = b.q.map((v, j) => {
        const velocity = (v - a.q[j]) / dt;
        assert.ok(Math.abs(velocity) <= config.joints[j].velocity + 1e-8);
        assert.ok(Math.abs(velocity - previousVelocity[j]) / ((dt + (previousDt || dt)) / 2)
          <= config.joints[j].acceleration + 1e-8);
        return velocity;
      });
      previousDt = dt;
    }
  }
  previousVelocity.forEach((v, j) => assert.ok(Math.abs(v) / previousDt <= config.joints[j].acceleration));
});

test("reversals stay inside taught ranges and program speed keeps independent acceleration limits", () => {
  const points = [point(20), point(10), point(40)];
  const plan = K.planProgram(config, home, points, 0.2);
  plan.segments.forEach((segment, index) => {
    assert.deepEqual(segment.samples.at(-1).q, points[index].q);
    const from = index ? points[index - 1].q[0] : 0;
    for (let i = 1; i < segment.samples.length; i++) {
      const a = segment.samples[i - 1], b = segment.samples[i];
      assert.ok(b.q[0] >= Math.min(from, points[index].q[0]) - 1e-9);
      assert.ok(b.q[0] <= Math.max(from, points[index].q[0]) + 1e-9);
      assert.ok(Math.abs(b.q[0] - a.q[0]) / (b.t - a.t) <= config.joints[0].velocity * 0.2);
    }
  });
});

test("dwells and gripper commands remain stopping boundaries", () => {
  const points = [point(20), point(20, { duration: 2 }), point(40, { endEffector: "close" }), point(50)];
  const gripper = { open: "M67 E0 Q5", close: "M67 E0 Q10\nG4 P0.5\nM67 E0 Q0" };
  const plan = K.planProgram(config, home, points, 1, gripper);
  const code = codeLines(plan);
  assert.equal(code.filter((line) => line === "G4 P2.02").length, 1, "stationary samples become one hold");
  const action = code.indexOf("M67 E0 Q10");
  assert.ok(action > 0);
  assert.equal(code[action - 2], "G4 P0");
  const after = code.slice(action + 1).find((line) => line.startsWith("G93"));
  for (const axis of "XYZABC") assert.match(after, new RegExp(` ${axis}[-\\d]`));
});

test("compact export preserves every rounded machine endpoint and inverse-time duration", () => {
  const model = structuredClone(config);
  model.joints[0].scale = -2;
  model.joints[0].zero = 10;
  const plan = K.planProgram(model, home, [point(20), point(50)]);
  const lines = codeLines(plan, model).filter((line) => line.startsWith("G93"));
  const position = {};
  let duration = 0;
  assert.equal(lines.length, plan.samples.length - 1);
  lines.forEach((line, i) => {
    for (const match of line.matchAll(/([XYZABC])(-?[\d.]+)/g)) position[match[1]] = Number(match[2]);
    model.joints.forEach((joint, j) => assert.equal(position[joint.axis],
      Number((plan.samples[i + 1].q[j] * joint.scale + joint.zero).toFixed(5))));
    duration += 60 / Number(line.match(/F([\d.]+)/)[1]);
  });
  assert.ok(Math.abs(duration - plan.duration) < 1e-6);
  assert.ok(lines.slice(1).every((line) => Buffer.byteLength(line + "\n") < 40));
  assert.ok(!codeLines(plan).some((line) => line.startsWith("G4")));
});

test("sub-resolution samples preserve travel time without introducing mid-motion dwells", () => {
  const plan = { samples: [
    { q: pose(0), t: 0 }, { q: pose(0.000001), t: 0.1 }, { q: pose(1), t: 1 },
    { q: pose(1), t: 1.05 }, { q: pose(1.000001), t: 1.1 }, { q: pose(2), t: 2 },
  ] };
  const lines = codeLines(plan);
  assert.ok(!lines.some((line) => line.startsWith("G4")));
  assert.equal(lines.filter((line) => line.startsWith("G93")).length, 2);
  assert.ok(lines.filter((line) => line.startsWith("G93")).every((line) => line.endsWith("F60")));
});

test("Cartesian segments and gripper actions are not reshaped by joint blending", () => {
  const a = K.planSegment(config, pose(0), pose(10));
  const b = { ...K.planSegment(config, pose(10), pose(20)), type: "MoveL" };
  const c = K.withEndEffector(K.planSegment(config, pose(20), pose(30)), "close", { close: "M67 E0 Q10" });
  const original = { samples: [a.samples[0]], segments: [a, b, c], duration: 0 };
  const result = K.blendProgram(config, original);
  assert.deepEqual(result.segments, original.segments);
  assert.ok(result.samples.at(-1).commands);
});

test("unequal-duration six-axis curves keep shared velocity and mapped endpoints", () => {
  const points = [
    { q: [10, -70, 15, -80, 5, 30], type: "MoveJ", duration: 1 },
    { q: [25, -50, 10, -60, 20, 60], type: "MoveJ", duration: 10 },
    { q: [40, -40, 20, -40, 30, 90], type: "MoveJ", duration: 1 },
  ];
  const plan = K.planProgram(config, home, points);
  plan.segments.forEach((segment, index) => {
    assert.ok(segment.duration >= points[index].duration);
    assert.deepEqual(segment.samples.at(-1).q, points[index].q);
    const first = segment.samples[0].q, last = segment.samples.at(-1).q;
    for (let i = 1; i < segment.samples.length; i++) {
      const a = segment.samples[i - 1], b = segment.samples[i];
      b.q.forEach((value, j) => {
        assert.ok(value >= Math.min(first[j], last[j]) - 1e-9 && value <= Math.max(first[j], last[j]) + 1e-9);
        assert.ok(Math.abs(value - a.q[j]) / (b.t - a.t) <= config.joints[j].velocity + 1e-9);
      });
    }
  });
  const last = codeLines(plan).filter((line) => line.startsWith("G93")).at(-1);
  for (const [j, axis] of [..."XYZABC"].entries()) assert.match(last, new RegExp(`${axis}${points.at(-1).q[j]}(?: |$)`));
});
