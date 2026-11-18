import assert from "node:assert/strict";
import { test } from "node:test";
import { createCycloidalProject } from "./create-cycloidal-robot.mjs";

// Synthetic fixtures, not assumptions about the user's motors or drivers.
const calibration = () =>
  Array.from({ length: 6 }, () => ({
    motorStepsPerRev: 200,
    microsteps: 16,
    stepsPerUnit: 320,
  }));

test("J1–J5 use 20:1 reduction while J6 uses direct-drive pulse counts", () => {
  const inputs = calibration();
  inputs[1].stepsPerUnit = 400;
  inputs[5].direction = -1;
  const project = createCycloidalProject(inputs);
  project.config.joints.forEach((joint, i) => {
    const pulses = Math.abs(joint.scale) * 360 * inputs[i].stepsPerUnit;
    assert.ok(Math.abs(pulses - 200 * 16 * (i === 5 ? 1 : 20)) < 1e-8);
  });
  assert.ok(project.config.joints[5].scale < 0);
});
test("already degree-calibrated controller does not receive the gearbox ratio twice", () => {
  const inputs = calibration();
  inputs.forEach((drive, i) => (drive.stepsPerUnit = (200 * 16 * (i === 5 ? 1 : 20)) / 360));
  createCycloidalProject(inputs).config.joints.forEach((joint) =>
    assert.equal(joint.scale, 1),
  );
});
test("drawing dimensions produce the measured zero-pose reach without extra tool length", () => {
  const project = createCycloidalProject(calibration());
  const pose = globalThis.RobotCore.forward(
    project.config,
    [0, 0, 0, 0, 0, 0],
  ).pose;
  assert.ok(Math.abs(pose.x - 276.839) < 1e-8);
  assert.ok(Math.abs(pose.z - 108.292) < 1e-8);
  assert.ok(Math.abs(pose.y) < 1e-8);
});
test("missing motor resolution or any missing axis prevents generating a motion mapping", () => {
  for (const key of ["motorStepsPerRev", "microsteps", "stepsPerUnit"]) {
    const inputs = calibration();
    inputs[4][key] = null;
    assert.throws(() => createCycloidalProject(inputs), /must be specified/);
  }
  assert.throws(
    () => createCycloidalProject(calibration().slice(0, 4)),
    /all six joints/,
  );
});
