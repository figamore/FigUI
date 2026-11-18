import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import "../plugins/robot-studio/kinematics.js";

// Calibration input is deliberately required: steps_per_mm alone does not
// identify either motor steps/revolution or driver microstep resolution.
export function createCycloidalProject(calibration) {
  const K = globalThis.RobotCore;
  if (!Array.isArray(calibration) || calibration.length !== 6)
    throw new Error("Provide calibration for all six joints in J1–J6 order.");
  const config = K.forearmRollConfig();
  config.name = "Cycloidal 6R · J1–J5 20:1 / J6 direct";
  config.joints[0].d = 108.292;
  config.joints[1].a = 97.7;
  config.joints[3].d = 107.351;
  config.joints[5].d = 71.788;
  // The drawing's 71.788 mm reaches the tool end: do not add a second extension.
  config.tool = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 };
  const positive = (value, name) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
      throw new Error(`${name} must be specified as a positive number.`);
    return value;
  };
  config.joints.forEach((joint, i) => {
    const drive = calibration[i];
    if (!drive || typeof drive !== "object")
      throw new Error(`J${i + 1}: calibration is missing.`);
    const motorSteps = positive(
      drive.motorStepsPerRev,
      `J${i + 1} motor steps/revolution`,
    );
    const microsteps = positive(drive.microsteps, `J${i + 1} microsteps`);
    const stepsPerUnit = positive(
      drive.stepsPerUnit,
      `J${i + 1} FluidNC steps_per_mm`,
    );
    const direction = drive.direction ?? 1;
    if (![1, -1].includes(direction))
      throw new Error(`J${i + 1}: direction must be +1 or -1.`);
    // J1–J5 use the cycloidal reducers; J6 couples directly to the tool.
    const ratio = i === 5 ? 1 : 20;
    const pulsesPerDegree = (motorSteps * microsteps * ratio) / 360;
    joint.scale = (direction * pulsesPerDegree) / stepsPerUnit;
    joint.zero = drive.zero ?? 0;
    // Initial commissioning limits, not measured payload/torque capabilities.
    joint.velocity = 10;
    joint.acceleration = 20;
    if (drive.maxRate !== undefined)
      joint.velocity = Math.min(
        joint.velocity,
        positive(drive.maxRate, `J${i + 1} max rate`) /
          (60 * Math.abs(joint.scale)),
      );
    if (drive.acceleration !== undefined)
      joint.acceleration = Math.min(
        joint.acceleration,
        positive(drive.acceleration, `J${i + 1} acceleration`) /
          Math.abs(joint.scale),
      );
  });
  return K.validateProject({
    format: "figui-robot-studio",
    version: 1,
    config,
    q: config.joints.map((joint) => joint.home),
    points: [],
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [, , calibrationPath, outputPath] = process.argv;
  if (!calibrationPath || !outputPath)
    throw new Error(
      "Usage: node scripts/create-cycloidal-robot.mjs calibration.json robot-project.json",
    );
  const project = createCycloidalProject(
    JSON.parse(readFileSync(calibrationPath, "utf8")),
  );
  writeFileSync(outputPath, JSON.stringify(project, null, 2) + "\n");
  console.log(`Wrote ${outputPath}`);
}
