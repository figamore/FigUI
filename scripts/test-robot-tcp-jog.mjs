import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as THREE from "three";
import "../plugins/robot-studio/kinematics.js";

const K = globalThis.RobotCore;
const gizmoSource = readFileSync(new URL("../plugins/robot-studio/tcp-gizmo.js", import.meta.url), "utf8");
class Target {
  listeners = new Map();
  style = {};
  captures = new Set();
  addEventListener(name, handler) {
    const handlers = this.listeners.get(name) || new Set();
    handlers.add(handler); this.listeners.set(name, handlers);
  }
  removeEventListener(name, handler) { this.listeners.get(name)?.delete(handler); }
  fire(name, event = {}) {
    const e = { pointerId: 1, button: 0, isPrimary: true, preventDefault() {},
      stopImmediatePropagation() { this.consumed = true; }, ...event };
    for (const handler of this.listeners.get(name) || []) handler(e);
    return e;
  }
  getBoundingClientRect() { return { left: 0, top: 0, width: 900, height: 700 }; }
  setPointerCapture(id) { this.captures.add(id); }
  hasPointerCapture(id) { return this.captures.has(id); }
  releasePointerCapture(id) { this.captures.delete(id); }
}
function fixture(frame = "world", onStart = () => true) {
  const window = new Target(), document = new Target(), element = new Target();
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(36, 900 / 700, 1, 10000);
  camera.up.set(0, 0, 1); camera.position.set(550, -800, 650); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
  const controls = { enabled: true }, moves = [];
  let ends = 0;
  const context = { window, document };
  runInNewContext(gizmoSource, context);
  const gizmo = context.createRobotTcpGizmo({ THREE, scene, camera, controls, element,
    label: (_, parent) => {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.Texture() }));
      parent.add(sprite); return sprite;
    }, onStart, onMove: (move) => moves.push(move), onEnd: () => ends++,
  });
  const tcp = K.poseMatrix({ x: 0, y: 0, z: 0, rx: 25, ry: 10, rz: 35 });
  gizmo.update(tcp); gizmo.set({ enabled: true, frame });
  const group = scene.getObjectByName("tcp-jog-handles");
  const screen = (world) => {
    const p = world.clone().project(camera);
    return { clientX: (p.x + 1) * 450, clientY: (1 - p.y) * 350 };
  };
  const begin = (index, pointerId = 1) => {
    const direction = new THREE.Vector3().setComponent(index, 1).applyQuaternion(group.quaternion);
    const point = group.position.clone().addScaledVector(direction, group.scale.x * 0.65);
    element.fire("pointerdown", { ...screen(point), pointerId });
    return { point, direction };
  };
  return { gizmo, group, controls, element, window, document, camera, moves, begin, screen, get ends() { return ends; } };
}

test("TCP arrows constrain signed world/tool dragging to each displayed axis and own the pointer", () => {
  for (const frame of ["world", "tool"]) for (let axis = 0; axis < 3; axis++) {
    const f = fixture(frame), { point, direction } = f.begin(axis);
    assert.equal(f.gizmo.dragging, true, `${frame} ${axis} must be pickable`);
    assert.equal(f.controls.enabled, false);
    assert.equal(f.element.hasPointerCapture(1), true);
    f.element.fire("pointermove", { ...f.screen(point.clone().addScaledVector(direction, 25)), pointerId: 2 });
    assert.equal(f.moves.length, 0, "another pointer cannot move the active drag");
    for (const distance of [25, -15]) {
      f.element.fire("pointermove", f.screen(point.clone().addScaledVector(direction, distance)));
      const move = f.moves.at(-1);
      assert.equal(move.axis, axis);
      assert.ok(Math.abs(move.distance - distance) < 1e-7);
      assert.ok(new THREE.Vector3(...move.direction).distanceTo(direction) < 1e-7);
    }
    f.element.fire("pointerup");
    assert.equal(f.controls.enabled, true);
    assert.equal(f.gizmo.dragging, false);
    assert.equal(f.ends, 1);
    assert.equal(f.element.captures.size, 0);
    f.gizmo.dispose();
  }
});

test("TCP drag cancels on capture loss, cancellation, Escape, focus loss, hiding, frame changes and disposal", () => {
  for (const cancel of [
    (f) => f.element.fire("pointercancel"), (f) => f.element.fire("lostpointercapture"),
    (f) => f.window.fire("keydown", { key: "Escape" }), (f) => f.window.fire("blur"),
    (f) => { f.document.hidden = true; f.document.fire("visibilitychange"); },
    (f) => f.gizmo.set({ enabled: false }), (f) => f.gizmo.set({ enabled: true, frame: "tool" }),
    (f) => f.gizmo.dispose(),
  ]) {
    const f = fixture(); f.begin(0); cancel(f);
    assert.equal(f.gizmo.dragging, false); assert.equal(f.controls.enabled, true); assert.equal(f.ends, 1);
    f.element.fire("pointermove", { clientX: 100, clientY: 100 });
    assert.equal(f.moves.length, 0); f.gizmo.dispose();
    assert.equal([...f.element.listeners.values()].reduce((n, handlers) => n + handlers.size, 0), 0);
  }
  const f = fixture("world", () => false); f.begin(0);
  assert.equal(f.gizmo.dragging, false); assert.equal(f.controls.enabled, true); f.gizmo.dispose();
});

test("TCP handles track the configured TCP and stay screen-sized across zoom", () => {
  const f = fixture(), before = f.group.scale.x;
  f.camera.position.multiplyScalar(2); f.camera.updateMatrixWorld(); f.gizmo.refresh();
  assert.ok(Math.abs(f.group.scale.x / before - 2) < 1e-7);
  f.gizmo.update(K.poseMatrix({ x: 30, y: 40, z: 50, rx: 0, ry: 0, rz: 0 }));
  assert.deepEqual(f.group.position.toArray(), [30, 40, 50]);
  f.camera.position.set(30, 40, 1000); f.camera.lookAt(f.group.position); f.camera.updateMatrixWorld(); f.gizmo.refresh();
  assert.equal(f.group.getObjectByName("tcp-jog-z").visible, false, "end-on axes must not start unstable drags");
  f.gizmo.dispose();
});

const app = readFileSync(new URL("../plugins/robot-studio/app.js", import.meta.url), "utf8");
function dragFixture() {
  const config = K.defaultConfig(), shown = [25, -65, 80, -35, 60, 25], feedback = [];
  let pose = [...shown], edits = 0;
  const context = { K, config, tcpJogEnabled: true, tcpDrag: null, tcpDragUpdating: false,
    tcpPushEnabled: false, tcpPushShift: false, tcpJogJoint: -1, refreshTcpJog() {},
    programPreparing: false, program: { busy: false }, endEffectorBusy: false, restoringSettings: false,
    playback: null, holding: false, directJog: null, live: { active: false, busy: false },
    document: { querySelector: () => null }, displayedJoints: () => [...pose],
    message: (text) => feedback.push(text), $: () => ({ textContent: "" }), currentTarget() {},
    setPose(q) { pose = K.validateJoints(config, q); edits++; },
    call() { throw Error("A virtual drag must not dispatch machine commands"); },
  };
  runInNewContext(app.slice(app.indexOf("  function startTcpDrag("), app.indexOf("  function previewCartesianWorkingPose()")), context);
  return { context, config, feedback, get pose() { return pose; }, get edits() { return edits; } };
}

test("TCP IK drags preserve orientation, reject unreachable targets and recover from the last valid pose", () => {
  for (let axis = 0; axis < 3; axis++) {
    const f = dragFixture(), start = K.forward(f.config, f.pose).tcp;
    assert.equal(f.context.startTcpDrag(), true);
    const direction = [0, 0, 0]; direction[axis] = 1;
    f.context.dragTcp({ axis, direction, distance: 5 });
    assert.equal(f.edits, 1);
    const actual = K.forward(f.config, f.pose).tcp;
    assert.ok(K.norm(K.rotationError(start, actual)) * K.DEG < 0.05);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(actual[i * 4 + 3] - start[i * 4 + 3] - (i === axis ? 5 : 0)) < 0.05);
    const valid = [...f.pose];
    f.context.dragTcp({ axis, direction, distance: 100000 });
    assert.deepEqual(f.pose, valid); assert.equal(f.edits, 1);
    f.context.dragTcp({ axis, direction, distance: -3 });
    assert.equal(f.edits, 2); assert.equal(f.context.tcpDrag.failed, false);
    f.context.endTcpDrag(); assert.equal(f.context.tcpDrag, null);
  }
  for (const flag of ["programPreparing", "endEffectorBusy", "restoringSettings", "playback", "holding", "directJog"]) {
    const f = dragFixture(); f.context[flag] = true;
    assert.equal(f.context.startTcpDrag(), false, flag);
  }
});
