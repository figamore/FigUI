import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as THREE from "three";
import "../plugins/robot-studio/kinematics.js";

const K = globalThis.RobotCore;
const source = readFileSync(
  new URL("../plugins/robot-studio/viewer.js", import.meta.url),
  "utf8",
);

// Use real Three.js geometry/transforms, replacing only browser/GPU plumbing.
async function fixture(config, options = {}) {
  let scene, camera;
  const context = {
    RobotCore: K,
    RobotGraphics: {
      THREE: {
        ...THREE,
        WebGLRenderer: class {
          shadowMap = {};
          domElement = { setAttribute() {}, remove() {} };
          setPixelRatio() {}
          setSize() {}
          render(next, nextCamera) {
            scene = next;
            camera = nextCamera;
          }
          dispose() {}
        },
      },
      OrbitControls: class {
        target = new THREE.Vector3();
        update() {}
        dispose() {}
      },
    },
    document: {
      hidden: false,
      createElement: () => ({
        getContext: () => ({
          beginPath() {},
          roundRect() {},
          fill() {},
          stroke() {},
          fillText() {},
        }),
      }),
    },
    devicePixelRatio: 1,
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame() {
      return 1;
    },
    cancelAnimationFrame() {},
  };
  runInNewContext(source, context);
  const viewer = await context.createRobotViewer(
    { clientWidth: 900, clientHeight: 700, appendChild() {} },
    config,
    config.joints.map((j) => j.home),
    options,
  );
  const robot = scene.children.find((child) => child.isGroup);
  return { viewer, robot, scene, camera };
}

test("configuration guides measure actual DH lengths and live edits preserve the camera", async () => {
  const config = K.defaultConfig();
  config.base = { x: 80, y: -30, z: 100, rx: 15, ry: 20, rz: 35 };
  const { viewer, scene, camera } = await fixture(config, { measurements: true });
  viewer.update([30, -65, 80, -35, 60, 25]);
  const guide = scene.getObjectByName("configuration-measurement");
  assert.equal(guide.visible, false);
  const endpoints = guide.children.filter((part) => part.isMesh);
  const f = K.forward(config, [30, -65, 80, -35, 60, 25]);
  for (const [i, key] of ["d1", "a2", "a3", "d4", "d5", "d6"].entries()) {
    viewer.measurement(key);
    assert.equal(guide.visible, true);
    const elbow = f.origins[i].map((value, axis) => value + f.axes[i][axis] * config.joints[i].d);
    near(endpoints[0].position, key[0] === "a" ? elbow : f.origins[i]);
    near(endpoints[1].position, key[0] === "a" ? K.position(f.frames[i + 1]) : elbow);
    assert.ok(Math.abs(endpoints[0].position.distanceTo(endpoints[1].position) - Math.abs(config.joints[i][key[0]])) < 1e-7);
  }
  const position = camera.position.clone();
  config.joints[1].a = -90;
  viewer.configure(config, config.joints.map((j) => j.home), { fit: false });
  assert.ok(camera.position.equals(position), "typing must preserve orbit and zoom");
  viewer.measurement("a2");
  assert.ok(Math.abs(endpoints[0].position.distanceTo(endpoints[1].position) - 90) < 1e-7);
  viewer.fit();
  assert.ok(!camera.position.equals(position), "Fit must frame the edited arm");
  viewer.configure(K.forearmRollConfig(), K.forearmRollConfig().joints.map((j) => j.home));
  assert.equal(guide.visible, false, "Dimension guides must hide for a custom joint layout");
  viewer.dispose();
});

const near = (actual, expected) =>
  assert.ok(
    actual.distanceTo(new THREE.Vector3(...expected)) < 1e-7,
    `${actual.toArray()} differs from ${expected}`,
  );

test("primitive housings follow solver axes for parallel-elbow presets, custom dimensions and generic DH", async () => {
  const custom = K.defaultConfig();
  custom.joints[1].a = -240;
  custom.joints[2].a = -220;
  custom.base = { x: 80, y: -30, z: 100, rx: 15, ry: 20, rz: 35 };
  custom.tool = { x: 20, y: -10, z: 60, rx: 5, ry: 10, rz: 15 };
  for (const config of [
    K.defaultConfig(),
    K.parallelElbowConfig("compact"),
    custom,
    K.forearmRollConfig(),
  ]) {
    const { viewer, robot, scene } = await fixture(config);
    const meshes = robot.children.filter((child) => child.isMesh);
    assert.equal(meshes.length, 46);
    assert.equal(
      new Set(meshes.map((mesh) => mesh.geometry)).size,
      3,
      "Arm parts share three reusable primitive buffers",
    );
    assert.ok(
      meshes.reduce((sum, mesh) => sum + mesh.geometry.index.count / 3, 0) <=
        10000,
    );
    const geometries = new Set(meshes.map((mesh) => mesh.geometry));
    for (const q of [
      config.joints.map((j) => j.home),
      [34, -45, 70, 22, -38, 100],
    ]) {
      viewer.update(q);
      const f = K.visualGeometry(config, q);
      for (let i = 0; i < 6; i++) {
        const housing = meshes[i * 7];
        assert.equal(housing.visible, true);
        near(housing.position, f.centers[i]);
        near(
          new THREE.Vector3(0, 1, 0).applyQuaternion(housing.quaternion),
          f.axes[i],
        );
        for (const part of meshes.slice(i * 7, i * 7 + 7)) {
          assert.ok(
            [
              ...part.position.toArray(),
              ...part.scale.toArray(),
              ...part.quaternion.toArray(),
            ].every(Number.isFinite),
          );
        }
      }
      const tip = scene.children.find(
        (child) => child.geometry?.type === "SphereGeometry",
      );
      near(tip.position, K.position(f.tcp));
    }
    viewer.configure(
      config,
      config.joints.map((j) => j.home),
    );
    assert.equal(robot.children.filter((child) => child.isMesh).length, 46);
    assert.ok(
      robot.children
        .filter((child) => child.isMesh)
        .every((mesh) => geometries.has(mesh.geometry)),
    );
    viewer.dispose();
  }
});

test("wrist rotation stays visible and link tubes connect adjacent housings", async () => {
  const config = K.defaultConfig(),
    q = [34, -45, 70, 22, -38, 100];
  const { viewer, robot } = await fixture(config);
  viewer.update(q);
  const meshes = robot.children.filter((child) => child.isMesh);
  const f = K.visualGeometry(config, q);
  const endpoint = (mesh, y) =>
    new THREE.Vector3(0, y, 0)
      .multiply(mesh.scale)
      .applyQuaternion(mesh.quaternion)
      .add(mesh.position);
  for (let i = 0; i < 6; i++) {
    const link = meshes[i * 7 + 4],
      offset = meshes[i * 7 + 5];
    near(endpoint(link, -0.5), f.centers[i]);
    const next = f.centers[i + 1] || K.position(f.frames[6]);
    if (offset.visible) {
      near(endpoint(link, 0.5), endpoint(offset, -0.5).toArray());
      near(endpoint(offset, 0.5), next);
    } else near(endpoint(link, 0.5), next);
  }
  const marker = meshes[5 * 7 + 3],
    before = marker.position.clone();
  q[5] += 30;
  viewer.update(q);
  assert.ok(
    before.distanceTo(marker.position) > 1,
    "Off-center marker exposes flange roll",
  );
  viewer.selectJoint(5);
  assert.equal(meshes[5 * 7 + 1].material, marker.material);
  viewer.dispose();
});

test("two-finger gripper follows the tool frame and changes jaw spacing without changing FK", async () => {
  const config = K.defaultConfig();
  config.base = { x: 80, y: -30, z: 100, rx: 15, ry: 20, rz: 35 };
  config.tool = { x: 20, y: -10, z: 60, rx: 5, ry: 10, rz: 15 };
  const before = structuredClone(config), q = [34, -45, 70, 22, -38, 100];
  const { viewer, robot } = await fixture(config);
  const gripper = () => robot.getObjectByName("end-effector-gripper");
  const opening = () => {
    const left = gripper().getObjectByName("gripper-left-jaw");
    const right = gripper().getObjectByName("gripper-right-jaw");
    return right.position.x - left.position.x;
  };
  for (const angles of [q, [0, -90, 0, -90, 0, 90]]) {
    viewer.update(angles);
    const f = K.forward(config, angles), radius = (K.visualSizes(config).radii[5] * 1.9) / 5;
    robot.updateMatrixWorld(true);
    const transform = new THREE.Matrix4().set(...f.tcp).scale(new THREE.Vector3(radius, radius, radius));
    transform.elements.forEach((value, i) => assert.ok(Math.abs(gripper().matrixWorld.elements[i] - value) < 1e-7));
    const open = opening();
    viewer.gripper("close");
    assert.ok(opening() < open / 2, "Both fingers must visibly close symmetrically");
    assert.equal(gripper().userData.action, "close");
    const left = gripper().getObjectByName("gripper-left-jaw");
    const right = gripper().getObjectByName("gripper-right-jaw");
    assert.equal(left.position.x, -right.position.x);
    viewer.gripper("open");
    assert.equal(opening(), open);
  }
  viewer.gripper("close");
  viewer.configure(config, q);
  assert.equal(gripper().userData.action, "close", "Rebuilding preserves the displayed gripper state");
  const geometries = new Set();
  gripper().traverse((part) => { if (part.isMesh) geometries.add(part.geometry); });
  assert.equal(geometries.size, 2, "Gripper parts reuse the cylinder and box buffers");
  assert.deepEqual(config, before, "Visual jaws must not edit tool geometry or TCP calibration");
  viewer.dispose();
});

test("50/90/80/50/50/50 arm has a connected base and scale-consistent geometry and helpers", async () => {
  const config = K.defaultConfig();
  config.joints[0].d = 50;
  config.joints[1].a = -90;
  config.joints[2].a = -80;
  config.joints[3].d = config.joints[4].d = config.joints[5].d = 50;
  const q = config.joints.map((j) => j.home);
  const f = K.visualGeometry(config, q);
  const { viewer, robot, scene } = await fixture(config);
  const meshes = robot.children.filter((child) => child.isMesh);
  const pedestal = meshes[42],
    foot = meshes[43];
  const endpoint = (mesh, y) =>
    new THREE.Vector3(0, y, 0)
      .multiply(mesh.scale)
      .applyQuaternion(mesh.quaternion)
      .add(mesh.position);
  assert.equal(pedestal.visible, true);
  near(endpoint(pedestal, -0.5), K.position(f.frames[0]));
  near(endpoint(pedestal, 0.5), f.centers[0]);
  assert.ok(
    meshes[7].scale.x >= 12,
    "Small-arm housing thickness must also reflect the 50 mm offsets",
  );
  const ground = scene.children.find(
    (child) => child.geometry?.type === "PlaneGeometry",
  );
  assert.ok(Math.abs(endpoint(foot, -0.5).z - ground.position.z) < 1e-7);
  const tcp = scene.children.find((child) => child.type === "AxesHelper");
  const helperScale = new THREE.Vector3().setFromMatrixScale(tcp.matrix).x;
  assert.ok(
    95 * helperScale < 25,
    "TCP axes must fit the small wrist",
  );
  const initial = robot.children.map((child) => ({
    position: child.position.clone(),
    scale: child.scale.clone(),
  }));
  const marker = scene.children.find(
    (child) => child.geometry?.type === "SphereGeometry",
  );
  const tipScale = marker.scale.x;
  for (const factor of [0.1, 4]) {
    const scaled = structuredClone(config);
    scaled.joints.forEach((j) => {
      j.a *= factor;
      j.d *= factor;
    });
    viewer.configure(scaled, q);
    robot.children
      .filter((child) => child.isMesh || child.isSprite)
      .forEach((child) => {
        const i = robot.children.indexOf(child);
        near(
          child.position,
          initial[i].position.clone().multiplyScalar(factor).toArray(),
        );
        if (child.isMesh && child.visible)
          near(
            child.scale,
            initial[i].scale.clone().multiplyScalar(factor).toArray(),
          );
      });
    assert.ok(Math.abs(marker.scale.x - tipScale * factor) < 1e-7);
    assert.ok(
      Math.abs(
        new THREE.Vector3().setFromMatrixScale(tcp.matrix).x -
          helperScale * factor,
      ) < 1e-7,
    );
  }
  viewer.dispose();
});
