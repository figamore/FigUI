/* Locally bundled WebGL viewer; geometry and planning share RobotCore FK. */
globalThis.createRobotViewer = async function (container, config, initialQ, options = {}) {
  if (!globalThis.RobotGraphics) throw Error("Local 3D library did not load.");
  const { THREE, OrbitControls } = globalThis.RobotGraphics;
  const K = RobotCore;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#303030");
  scene.fog = new THREE.Fog("#303030", 2400, 6500);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.domElement.setAttribute(
    "aria-label",
    "Interactive 3D robot. Drag to orbit, scroll to zoom, right-drag to pan.",
  );
  renderer.domElement.setAttribute("role", "img");
  container.appendChild(renderer.domElement);
  const camera = new THREE.PerspectiveCamera(36, 1, 1, 20000);
  camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.94;
  controls.minDistance = 100;
  controls.maxDistance = 6000;
  scene.add(new THREE.HemisphereLight(0xf0f0ec, 0x383838, 2));
  const key = new THREE.DirectionalLight(0xfffaf2, 3.2);
  key.position.set(400, -500, 1200);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, {
    left: -1100,
    right: 1100,
    top: 1100,
    bottom: -1100,
    near: 1,
    far: 4000,
  });
  key.shadow.bias = -0.0005;
  key.shadow.normalBias = 1;
  scene.add(key, key.target);
  const rim = new THREE.DirectionalLight(0xdbe4ec, 2.5);
  rim.position.set(-600, 350, 650);
  scene.add(rim);
  const fill = new THREE.DirectionalLight(0xd0d2d5, 1.5);
  fill.position.set(500, 600, 300);
  scene.add(fill);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(12000, 12000),
    new THREE.MeshStandardMaterial({ color: 0x303030, roughness: 0.95 }),
  );
  ground.position.z = -12;
  ground.receiveShadow = true;
  scene.add(ground);
  const grid = new THREE.GridHelper(3600, 36, 0x686868, 0x494949);
  grid.rotation.x = Math.PI / 2;
  grid.position.z = -11;
  scene.add(grid);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(690, 692, 128),
    new THREE.MeshBasicMaterial({
      color: 0x858585,
      transparent: true,
      opacity: 0.22,
      side: THREE.DoubleSide,
    }),
  );
  ring.position.z = -10;
  scene.add(ring);
  const robot = new THREE.Group();
  scene.add(robot);
  const mats = {
    shell: new THREE.MeshStandardMaterial({
      color: 0xd6dce2,
      metalness: 0.3,
      roughness: 0.43,
    }),
    joint: new THREE.MeshStandardMaterial({
      color: 0x657680,
      metalness: 0.15,
      roughness: 0.5,
    }),
    dark: new THREE.MeshStandardMaterial({
      color: 0x303336,
      metalness: 0.2,
      roughness: 0.55,
    }),
    accent: new THREE.MeshStandardMaterial({
      color: 0xa9bbc4,
      metalness: 0.25,
      roughness: 0.3,
      emissive: 0x202b30,
      emissiveIntensity: 0.15,
    }),
    ghost: new THREE.MeshStandardMaterial({
      color: 0xedb36c,
      transparent: true,
      opacity: 0.25,
      depthWrite: false,
      roughness: 0.55,
    }),
  };
  const boxGeometry = new THREE.BoxGeometry(1, 1, 1),
    cylinder = new THREE.CylinderGeometry(1, 1, 1, 24),
    sphere = new THREE.SphereGeometry(1, 20, 12),
    housingGeometry = new THREE.LatheGeometry(
      [
        [0, -0.5],
        [0.84, -0.5],
        [0.95, -0.46],
        [1, -0.37],
        [1, 0.37],
        [0.95, 0.46],
        [0.84, 0.5],
        [0, 0.5],
      ].map(([radius, height]) => new THREE.Vector2(radius, height)),
      20,
    );
  const up = new THREE.Vector3(0, 1, 0),
    v = (a) => new THREE.Vector3(...a);
  let proportions,
    parts = [],
    labels = [],
    frameHelpers = [],
    lastQ = initialQ,
    framesVisible = false,
    pathVisible = true,
    labelsVisible = false,
    gripperAction = "open",
    gripper = null,
    gripperJaws = [],
    ghostParts = [],
    ghostGripper = null,
    targetQ = null,
    ghostPoseQ = null,
    selectedJoint = -1,
    jogJoint = -1,
    jogFrame = "tool",
    selectedMeasurement = null;
  function mesh(material, geometry = cylinder, parent = robot) {
    const m = new THREE.Mesh(geometry, material);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  }
  function between(m, a, b, r) {
    const av = v(a),
      bv = v(b),
      d = bv.clone().sub(av);
    m.visible = d.length() > 0.01;
    m.position.copy(av.add(bv).multiplyScalar(0.5));
    m.quaternion.setFromUnitVectors(up, d.clone().normalize());
    m.scale.set(r, Math.max(0.01, d.length()), r);
  }
  function along(m, center, axis, r, len) {
    between(
      m,
      center.map((p, i) => p - (axis[i] * len) / 2),
      center.map((p, i) => p + (axis[i] * len) / 2),
      r,
    );
  }
  function label(text, parent = robot) {
    const canvas = document.createElement("canvas");
    canvas.width = 96;
    canvas.height = 56;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#282828";
    ctx.beginPath();
    ctx.roundRect(2, 2, 92, 52, 4);
    ctx.fill();
    ctx.strokeStyle = "#777777";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = "#eeeeee";
    ctx.font = "500 25px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 48, 28);
    const texture = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: texture,
        depthTest: false,
        transparent: true,
      }),
    );
    sprite.scale.set(32, 19, 1);
    sprite.renderOrder = 5;
    parent.add(sprite);
    return sprite;
  }
  function buildGripper() {
    gripper = new THREE.Group();
    gripper.name = "end-effector-gripper";
    robot.add(gripper);
    const block = (parent, material, size, position) => {
      const part = mesh(material, boxGeometry, parent);
      part.scale.set(...size);
      part.position.set(...position);
      return part;
    };
    const mount = mesh(mats.dark, cylinder, gripper);
    mount.rotation.x = Math.PI / 2;
    mount.position.z = 0.22;
    mount.scale.set(0.85, 0.44, 0.85);
    block(gripper, mats.shell, [3.2, 1.8, 1.3], [0, 0, 1.05]);
    block(gripper, mats.accent, [3.25, 1.85, 0.12], [0, 0, 1.7]);
    gripperJaws = [-1, 1].map((sign) => {
      const jaw = new THREE.Group();
      jaw.name = sign < 0 ? "gripper-left-jaw" : "gripper-right-jaw";
      gripper.add(jaw);
      block(jaw, mats.joint, [0.8, 1.3, 0.6], [0, 0, 1.95]);
      block(jaw, mats.shell, [0.5, 0.65, 2.6], [0, 0, 3.4]);
      block(jaw, mats.dark, [0.08, 0.7, 0.9], [-sign * 0.29, 0, 4.2]);
      return jaw;
    });
    setGripper(gripperAction);
  }
  function setGripper(action) {
    if (action !== "open" && action !== "close") return;
    gripperAction = action;
    const gap = action === "open" ? 1.9 : 0.08;
    gripperJaws.forEach((jaw, i) => {
      jaw.position.x = (i ? 1 : -1) * (gap / 2 + 0.33);
      ghostGripper?.getObjectByName(jaw.name)?.position.copy(jaw.position);
    });
    if (gripper) gripper.userData.action = action;
  }
  function rebuild(c) {
    config = c;
    // Cosmetic diameters are separate from the kinematic geometry.
    proportions = K.visualSizes(c);
    const { reach, scale, radii } = proportions;
    const major = Math.max(...radii, ...proportions.linkRadii);
    ring.scale.setScalar((reach * 0.65) / 690);
    grid.scale.setScalar(scale);
    // Keep the floor edge beyond the fog even for small custom arms.
    ground.scale.setScalar(scale * 10);
    ground.position.z = -major * 0.1;
    // Keep grid lines above the floor's depth precision at distant views.
    grid.position.z = ground.position.z + 1.5 * scale;
    ring.position.z = ground.position.z + 2 * scale;
    const base = v(K.position(K.poseMatrix(c.base)));
    key.position
      .copy(base)
      .add(new THREE.Vector3(400, -500, 1200).multiplyScalar(scale));
    key.target.position.copy(base);
    rim.position
      .copy(base)
      .add(new THREE.Vector3(-600, 350, 650).multiplyScalar(scale));
    fill.position
      .copy(base)
      .add(new THREE.Vector3(500, 600, 300).multiplyScalar(scale));
    Object.assign(key.shadow.camera, {
      left: -1100 * scale,
      right: 1100 * scale,
      top: 1100 * scale,
      bottom: -1100 * scale,
      near: Math.max(0.01, scale),
      far: 4000 * scale,
    });
    key.shadow.camera.updateProjectionMatrix();
    key.shadow.normalBias = scale;
    scene.fog.near = reach * 8;
    scene.fog.far = reach * 30;
    controls.minDistance = reach * 0.06;
    controls.maxDistance = reach * 12;
    camera.near = Math.max(0.01, reach / 2000);
    camera.far = reach * 40;
    camera.updateProjectionMatrix();
    tip.scale.setScalar(6 * scale);
    for (const child of [...robot.children]) {
      robot.remove(child);
      if (child.isSprite) {
        child.material.map.dispose();
        child.material.dispose();
      }
      if (child.isAxesHelper) {
        child.geometry.dispose();
        child.material.dispose();
      }
    }
    parts = Array.from({ length: 6 }, () => ({
      joint: mesh(mats.shell, housingGeometry),
      cap: mesh(mats.joint, housingGeometry),
      trim: mesh(mats.dark),
      marker: mesh(mats.accent),
      link: mesh(mats.shell),
      offset: mesh(mats.shell),
      bend: mesh(mats.shell, sphere),
    }));
    parts.forEach((part, index) => {
      for (const key of ["joint", "cap", "trim", "marker"]) part[key].userData.jogJoint = index;
      part.joint.name = `joint-J${index + 1}`;
    });
    labels = parts.map((_, i) => label(`J${i + 1}`));
    labels.forEach((l) => {
      l.visible = labelsVisible;
      l.scale.set(32 * proportions.scale, 19 * proportions.scale, 1);
    });
    frameHelpers = Array.from({ length: 7 }, () => {
      const a = new THREE.AxesHelper(70 * proportions.scale);
      a.visible = framesVisible;
      robot.add(a);
      return a;
    });
    parts.base = mesh(mats.dark, housingGeometry);
    parts.foot = mesh(mats.shell, housingGeometry);
    parts.tool = mesh(mats.accent);
    parts.flange = mesh(mats.dark, housingGeometry);
    parts.base.userData.jogJoint = parts.foot.userData.jogJoint = 0;
    parts.tool.userData.jogJoint = parts.flange.userData.jogJoint = -1;
    buildGripper();
    gripper.traverse((part) => { if (part.isMesh) part.userData.jogJoint = -1; });
    buildGhost();
    update(lastQ);
  }
  const tcp = new THREE.AxesHelper(95);
  scene.add(tcp);
  const target = new THREE.AxesHelper(100);
  target.visible = false;
  scene.add(target);
  const tip = new THREE.Mesh(sphere, mats.accent);
  tip.scale.setScalar(6);
  scene.add(tip);
  const tcpJog = options.onTcpDragStart ? createRobotTcpGizmo({
    THREE, scene, camera, controls, element: renderer.domElement, label,
    onStart: options.onTcpDragStart, onMove: options.onTcpDrag, onEnd: options.onTcpDragEnd,
  }) : null;
  // A click selects a housing; dragging the workcell continues to orbit.
  const jointPicking = options.onJointPick ? (() => {
    const element = renderer.domElement, raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
    let press = null;
    function hit(event) {
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return undefined;
      pointer.set((event.clientX - rect.left) / rect.width * 2 - 1,
        -(event.clientY - rect.top) / rect.height * 2 + 1);
      camera.updateMatrixWorld(); robot.updateMatrixWorld(true);
      raycaster.setFromCamera(pointer, camera);
      // The nearest solid part occludes housings behind it. Ignore the ghost.
      return raycaster.intersectObject(robot, true).find(({ object }) => object.isMesh && object.visible)?.object.userData.jogJoint;
    }
    function down(event) {
      if (event.button !== 0 || event.isPrimary === false) { press = null; return; }
      press = { id: event.pointerId, x: event.clientX, y: event.clientY, joint: hit(event), moved: false };
    }
    function move(event) {
      if (press && event.pointerId === press.id && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 5)
        press.moved = true;
      if (!press && !tcpJog?.dragging && !["grab", "grabbing"].includes(element.style.cursor))
        element.style.cursor = Number.isInteger(hit(event)) ? "pointer" : "";
    }
    function up(event) {
      if (!press || event.pointerId !== press.id) return;
      const picked = press; press = null;
      if (!picked.moved && Math.hypot(event.clientX - picked.x, event.clientY - picked.y) <= 5 &&
          Number.isInteger(picked.joint) && hit(event) === picked.joint)
        options.onJointPick(picked.joint);
    }
    function cancel() { press = null; }
    const listeners = [["pointerdown", down], ["pointermove", move], ["pointerup", up],
      ["pointercancel", cancel], ["lostpointercapture", cancel]];
    listeners.forEach(([name, handler]) => element.addEventListener(name, handler, true));
    return { dispose() { listeners.forEach(([name, handler]) => element.removeEventListener(name, handler, true)); } };
  })() : null;
  const path = new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({
      color: 0xe5bf83,
      transparent: true,
      opacity: 0.85,
    }),
  );
  scene.add(path);
  const jointTarget = new THREE.Group();
  jointTarget.name = "target-arm-ghost";
  jointTarget.visible = false;
  scene.add(jointTarget);
  function buildGhost() {
    jointTarget.clear();
    jointTarget.visible = false;
    targetQ = null;
    ghostPoseQ = null;
    const copy = (source) => {
      // Clones share the same primitive buffers as the solid arm.
      const clone = source.clone();
      clone.traverse((part) => {
        if (!part.isMesh) return;
        part.material = mats.ghost;
        part.castShadow = false;
        part.receiveShadow = false;
      });
      jointTarget.add(clone);
      return clone;
    };
    ghostParts = parts.map((part) => Object.fromEntries(
      Object.entries(part).map(([key, value]) => [key, copy(value)]),
    ));
    for (const key of ["base", "foot", "tool", "flange"]) ghostParts[key] = copy(parts[key]);
    ghostGripper = copy(gripper);
  }
  function updateJointTarget(q) {
    targetQ = q ? [...q] : null;
    jointTarget.visible = !!targetQ && targetQ.some((angle, i) => Math.abs(angle - lastQ[i]) > 0.02);
    if (jointTarget.visible && (!ghostPoseQ || targetQ.some((angle, i) => angle !== ghostPoseQ[i]))) {
      positionArm(K.visualGeometry(config, targetQ), ghostParts, ghostGripper, true);
      ghostPoseQ = [...targetQ];
    }
  }
  // Dimension guides use DH axes, independent of illustrative housing sizes.
  const measurement = options.measurements ? new THREE.Group() : null;
  let measureLine, measureEnds;
  if (measurement) {
    measurement.name = "configuration-measurement";
    measurement.visible = false;
    measureLine = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xf7c877, depthTest: false }),
    );
    measureLine.renderOrder = 6;
    measurement.add(measureLine);
    const material = new THREE.MeshBasicMaterial({ color: 0xf7c877, depthTest: false });
    measureEnds = [0, 1].map(() => {
      const dot = new THREE.Mesh(sphere, material);
      dot.renderOrder = 7;
      measurement.add(dot);
      return dot;
    });
    scene.add(measurement);
  }
  function updateMeasurement(f) {
    if (!measurement) return;
    const index = ["d1", "a2", "a3", "d4", "d5", "d6"].indexOf(selectedMeasurement);
    measurement.visible = index >= 0 && f.parallelElbow;
    if (!measurement.visible) return;
    const joint = config.joints[index];
    const origin = v(f.origins[index]);
    const elbow = origin.clone().addScaledVector(v(f.axes[index]), joint.d);
    const start = selectedMeasurement[0] === "a" ? elbow : origin;
    const end = selectedMeasurement[0] === "a" ? v(K.position(f.frames[index + 1])) : elbow;
    const direction = end.clone().sub(start).normalize();
    const middle = start.clone().add(end).multiplyScalar(0.5);
    const center = new THREE.Box3().setFromPoints(f.centers.map(v)).getCenter(new THREE.Vector3());
    const outward = middle.clone().sub(center);
    outward.addScaledVector(direction, -outward.dot(direction));
    if (outward.lengthSq() < 0.001) outward.crossVectors(direction, new THREE.Vector3(0, 1, 0));
    if (outward.lengthSq() < 0.001) outward.crossVectors(direction, new THREE.Vector3(1, 0, 0));
    outward.normalize().multiplyScalar(Math.max(...proportions.radii, ...proportions.linkRadii) * 2.8);
    measureLine.geometry.dispose();
    measureLine.geometry = new THREE.BufferGeometry().setFromPoints([
      start, start.clone().add(outward), end.clone().add(outward), end,
    ]);
    measureEnds.forEach((dot, i) => {
      dot.position.copy(i ? end : start);
      dot.scale.setScalar(proportions.reach * 0.009);
    });
  }
  function setTransform(object, m, scale = 1) {
    object.matrixAutoUpdate = false;
    object.matrix.set(...m);
    object.matrix.scale(new THREE.Vector3(scale, scale, scale));
  }
  function positionArm(f, armParts, armGripper, ghost = false) {
    const { radii, linkRadii, offsetRadii } = proportions;
    armParts.forEach((part, i) => {
      const center = f.origins[i],
        axis = f.axes[i],
        end = K.position(f.frames[i + 1]),
        elbow = center.map((p, k) => p + axis[k] * config.joints[i].d),
        r = radii[i],
        housing = f.centers[i];
      if (f.parallelElbow) {
        // Connect the visible housings with simple tubes. The long links run
        // perpendicular to the parallel shoulder/elbow/wrist axes; a short
        // axial connector accounts for their different housing planes.
        const next = f.centers[i + 1] || K.position(f.frames[6]);
        let corner = next;
        if (i === 0) corner = K.position(f.frames[1]);
        else if (i === 1 || i === 2) {
          const offset = next.reduce(
            (sum, p, k) => sum + (p - housing[k]) * axis[k],
            0,
          );
          corner = next.map((p, k) => p - axis[k] * offset);
        }
        between(part.link, housing, corner, linkRadii[i]);
        between(part.offset, corner, next, offsetRadii[i]);
        part.bend.position.copy(v(corner));
        part.bend.scale.setScalar(linkRadii[i]);
      } else {
        between(part.offset, center, elbow, offsetRadii[i]);
        between(part.link, elbow, end, linkRadii[i]);
        part.bend.position.copy(v(elbow));
        part.bend.scale.setScalar(Math.max(linkRadii[i], offsetRadii[i]));
      }
      part.bend.visible = part.link.visible && part.offset.visible;
      part.cap.material = ghost ? mats.ghost : i === selectedJoint ? mats.accent : mats.joint;
      along(part.joint, housing, axis, r, r * 1.6);
      along(
        part.cap,
        housing.map((p, k) => p + axis[k] * r * 0.82),
        axis,
        r * 0.9,
        r * 0.12,
      );
      along(
        part.trim,
        housing.map((p, k) => p - axis[k] * r * 0.65),
        axis,
        r * 1.015,
        r * 0.07,
      );
      // This off-center cap marker follows the joint's local X direction,
      // making axial rotation visible even on a rotationally symmetric shell.
      const nextFrame = f.frames[i + 1];
      const localX = [nextFrame[0], nextFrame[4], nextFrame[8]];
      along(
        part.marker,
        housing.map(
          (p, k) => p + axis[k] * (r * 0.82 + r * 0.07) + localX[k] * r * 0.58,
        ),
        axis,
        r * 0.07,
        r * 0.05,
      );
    });
    const base = K.position(f.frames[0]),
      z = [f.frames[0][2], f.frames[0][6], f.frames[0][10]];
    // The pedestal spans the actual base-to-housing distance, independently
    // of cosmetic housing thickness. This cannot leave a gap on small arms.
    between(armParts.base, base, f.centers[0], proportions.baseRadius);
    along(armParts.foot, base, z, radii[0] * 1.4, radii[0] * 0.2);
    between(
      armParts.tool,
      K.position(f.frames[6]),
      K.position(f.tcp),
      proportions.toolRadius,
    );
    const flange = f.frames[6];
    along(
      armParts.flange,
      K.position(flange),
      [flange[2], flange[6], flange[10]],
      radii[5] * 0.95,
      radii[5] * 0.3,
    );
    // Illustrative attachment at the configured tool frame. Jaw movement
    // never changes the solver's TCP or the configured tool offset.
    // The gripper's longest dimension is 4.7 local units. Fit the entire
    // attachment, including open jaws, inside the flange's 1.9r diameter.
    setTransform(armGripper, f.tcp, (radii[5] * 1.9) / 5);
  }
  function update(q) {
    lastQ = [...q];
    const f = K.visualGeometry(config, q), { radii, scale } = proportions;
    positionArm(f, parts, gripper);
    labels.forEach((label, i) => {
      label.visible = labelsVisible || i === jogJoint;
      label.position.copy(v(f.centers[i]).add(new THREE.Vector3(0, 0, radii[i] + 22 * scale)));
    });
    frameHelpers.forEach((h, i) => setTransform(h, f.frames[i]));
    setTransform(tcp, f.tcp, scale);
    tip.position.copy(v(K.position(f.tcp)));
    if (jogJoint >= 0) {
      const state = K.jointJogState(config, q, jogJoint, jogFrame);
      tcpJog?.update(state.matrix, { axes: state.axes });
    } else tcpJog?.update(f.tcp);
    updateMeasurement(f);
    if (targetQ) updateJointTarget(targetQ);
  }
  function fit(view = "perspective") {
    tcpJog?.cancel();
    const f = K.visualGeometry(config, lastQ),
      box = new THREE.Box3();
    f.frames.forEach((m) => box.expandByPoint(v(K.position(m))));
    f.centers.forEach((center) => box.expandByPoint(v(center)));
    box.expandByPoint(v(K.position(f.tcp)));
    robot.updateMatrixWorld(true);
    box.union(new THREE.Box3().setFromObject(gripper));
    if (jointTarget.visible) {
      jointTarget.updateMatrixWorld(true);
      box.union(new THREE.Box3().setFromObject(jointTarget));
    }
    box.expandByScalar(Math.max(...proportions.radii, ...proportions.linkRadii) * 1.4);
    const center = box.getCenter(new THREE.Vector3()),
      size = Math.max(
        proportions.reach * 0.2,
        box.getSize(new THREE.Vector3()).length(),
      );
    center.z += size * 0.08;
    controls.target.copy(center);
    const distance = (size * (options.measurements ? 1.5 : 1.95)) / Math.min(1, camera.aspect);
    const direction =
      view === "top"
        ? new THREE.Vector3(0.001, 0, 1)
        : view === "front"
          ? new THREE.Vector3(0, -1, 0.1).normalize()
          : new THREE.Vector3(1.15, -1.6, 1.05).normalize();
    camera.position.copy(center).addScaledVector(direction, distance);
    controls.update();
  }
  function resize() {
    const w = container.clientWidth,
      h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();
  rebuild(config);
  fit();
  let frame;
  function render() {
    frame = requestAnimationFrame(render);
    if (!document.hidden) {
      if (!tcpJog?.dragging) controls.update();
      tcpJog?.refresh();
      if (options.measurements) {
        labels.forEach((label) => {
          const pixel = 2 * Math.tan(camera.fov * Math.PI / 360) * camera.position.distanceTo(label.position) / Math.max(1, container.clientHeight);
          label.scale.set(40 * pixel, 23 * pixel, 1);
        });
      }
      renderer.render(scene, camera);
    }
  }
  render();
  return {
    update,
    tcpJog(settings) {
      const nextJoint = settings.joint ?? jogJoint, nextFrame = settings.frame ?? jogFrame;
      if (nextJoint !== jogJoint || nextFrame !== jogFrame) {
        tcpJog?.cancel();
        if (nextJoint !== jogJoint) selectedJoint = nextJoint;
        jogJoint = nextJoint;
        jogFrame = nextFrame;
        update(lastQ);
      }
      tcpJog?.set(settings);
      tcp.visible = !settings.enabled;
    },
    cancelTcpDrag() { tcpJog?.cancel(); },
    gripper: setGripper,
    configure(c, q, { fit: shouldFit = true } = {}) {
      tcpJog?.cancel();
      lastQ = q;
      rebuild(c);
      if (shouldFit) fit();
    },
    measurement(key) {
      selectedMeasurement = key;
      update(lastQ);
    },
    fit,
    labels(on) {
      labelsVisible = on;
      labels.forEach((l, i) => (l.visible = on || i === jogJoint));
    },
    selectJoint(i) {
      selectedJoint = i;
      update(lastQ);
    },
    frames(on) {
      framesVisible = on;
      frameHelpers.forEach((h) => (h.visible = on));
    },
    pathVisible(on) {
      pathVisible = on;
      path.visible = on;
    },
    jointTarget: updateJointTarget,
    target(m) {
      target.visible = !!m;
      if (m) setTransform(target, m, proportions.scale);
    },
    path(samples) {
      path.geometry.dispose();
      path.geometry = new THREE.BufferGeometry().setFromPoints(
        samples.map((s) => v(K.position(K.forward(config, s.q).tcp))),
      );
      path.visible = pathVisible;
    },
    dispose() {
      jointPicking?.dispose();
      tcpJog?.dispose();
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      scene.traverse((o) => {
        o.geometry?.dispose();
        if (o.material) {
          for (const m of Array.isArray(o.material)
            ? o.material
            : [o.material]) {
            m.map?.dispose();
            m.dispose();
          }
        }
      });
      Object.values(mats).forEach((m) => m.dispose());
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
};
