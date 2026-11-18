/* Standard DH kinematics. Millimetres, degrees; row-major homogeneous matrices. */
(() => {
  "use strict";
  const RAD = Math.PI / 180,
    DEG = 1 / RAD;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const norm = (v) => Math.hypot(...v);
  const sub = (a, b) => a.map((v, i) => v - b[i]);
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  function multiply(a, b) {
    return Array.from({ length: 16 }, (_, n) => {
      const r = Math.floor(n / 4),
        c = n % 4;
      return (
        a[r * 4] * b[c] +
        a[r * 4 + 1] * b[4 + c] +
        a[r * 4 + 2] * b[8 + c] +
        a[r * 4 + 3] * b[12 + c]
      );
    });
  }
  const position = (m) => [m[3], m[7], m[11]];
  function poseMatrix(p) {
    const [r, pitch, y] = [p.rx, p.ry, p.rz].map((v) => v * RAD);
    const [cr, sr, cp, sp, cy, sy] = [
      Math.cos(r),
      Math.sin(r),
      Math.cos(pitch),
      Math.sin(pitch),
      Math.cos(y),
      Math.sin(y),
    ];
    return [
      cy * cp,
      cy * sp * sr - sy * cr,
      cy * sp * cr + sy * sr,
      p.x,
      sy * cp,
      sy * sp * sr + cy * cr,
      sy * sp * cr - cy * sr,
      p.y,
      -sp,
      cp * sr,
      cp * cr,
      p.z,
      0,
      0,
      0,
      1,
    ];
  }
  function matrixPose(m) {
    const pitch = Math.asin(clamp(-m[8], -1, 1));
    const regular = Math.abs(Math.cos(pitch)) > 1e-7;
    return {
      x: m[3],
      y: m[7],
      z: m[11],
      rx: (regular ? Math.atan2(m[9], m[10]) : 0) * DEG,
      ry: pitch * DEG,
      rz: (regular ? Math.atan2(m[4], m[0]) : Math.atan2(-m[1], m[5])) * DEG,
    };
  }
  function quaternion(m) {
    const t = m[0] + m[5] + m[10];
    let x, y, z, w, s;
    if (t > 0) {
      s = Math.sqrt(t + 1) * 2;
      w = s / 4;
      x = (m[9] - m[6]) / s;
      y = (m[2] - m[8]) / s;
      z = (m[4] - m[1]) / s;
    } else if (m[0] > m[5] && m[0] > m[10]) {
      s = Math.sqrt(1 + m[0] - m[5] - m[10]) * 2;
      w = (m[9] - m[6]) / s;
      x = s / 4;
      y = (m[1] + m[4]) / s;
      z = (m[2] + m[8]) / s;
    } else if (m[5] > m[10]) {
      s = Math.sqrt(1 + m[5] - m[0] - m[10]) * 2;
      w = (m[2] - m[8]) / s;
      x = (m[1] + m[4]) / s;
      y = s / 4;
      z = (m[6] + m[9]) / s;
    } else {
      s = Math.sqrt(1 + m[10] - m[0] - m[5]) * 2;
      w = (m[4] - m[1]) / s;
      x = (m[2] + m[8]) / s;
      y = (m[6] + m[9]) / s;
      z = s / 4;
    }
    return [x, y, z, w];
  }
  function quatMatrix(q, p) {
    const [x, y, z, w] = q;
    return [
      1 - 2 * (y * y + z * z),
      2 * (x * y - z * w),
      2 * (x * z + y * w),
      p[0],
      2 * (x * y + z * w),
      1 - 2 * (x * x + z * z),
      2 * (y * z - x * w),
      p[1],
      2 * (x * z - y * w),
      2 * (y * z + x * w),
      1 - 2 * (x * x + y * y),
      p[2],
      0,
      0,
      0,
      1,
    ];
  }
  function interpolatePose(a, b, t) {
    const qa = quaternion(a);
    let qb = quaternion(b),
      dot = qa.reduce((s, x, i) => s + x * qb[i], 0);
    if (dot < 0) {
      qb = qb.map((x) => -x);
      dot = -dot;
    }
    let q;
    if (dot > 0.9995) {
      q = qa.map((v, i) => v + (qb[i] - v) * t);
      const l = norm(q);
      q = q.map((v) => v / l);
    } else {
      const angle = Math.acos(clamp(dot, -1, 1)),
        s = Math.sin(angle);
      q = qa.map(
        (v, i) =>
          (v * Math.sin((1 - t) * angle) + qb[i] * Math.sin(t * angle)) / s,
      );
    }
    return quatMatrix(
      q,
      position(a).map((v, i) => v + (position(b)[i] - v) * t),
    );
  }
  function rotationError(target, current) {
    const inv = identity();
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++) inv[r * 4 + c] = current[c * 4 + r];
    let q = quaternion(multiply(target, inv));
    if (q[3] < 0) q = q.map((v) => -v);
    const s = norm(q.slice(0, 3)),
      angle = 2 * Math.atan2(s, clamp(q[3], 0, 1));
    return s < 1e-10 ? [0, 0, 0] : q.slice(0, 3).map((v) => (v * angle) / s);
  }
  function forward(config, q) {
    let m = poseMatrix(config.base);
    const frames = [m],
      origins = [],
      axes = [];
    config.joints.forEach((j, i) => {
      origins.push(position(m));
      axes.push([m[2], m[6], m[10]]);
      const t = (q[i] + j.offset) * RAD,
        a = j.alpha * RAD,
        c = Math.cos(t),
        s = Math.sin(t),
        ca = Math.cos(a),
        sa = Math.sin(a);
      m = multiply(m, [
        c,
        -s * ca,
        s * sa,
        j.a * c,
        s,
        c * ca,
        -c * sa,
        j.a * s,
        0,
        sa,
        ca,
        j.d,
        0,
        0,
        0,
        1,
      ]);
      frames.push(m);
    });
    const tcp = multiply(m, poseMatrix(config.tool));
    return { frames, origins, axes, tcp, pose: matrixPose(tcp) };
  }
  function solveLinear(a, b) {
    const m = a.map((r, i) => [...r, b[i]]),
      n = b.length;
    for (let k = 0; k < n; k++) {
      let p = k;
      for (let i = k + 1; i < n; i++)
        if (Math.abs(m[i][k]) > Math.abs(m[p][k])) p = i;
      if (Math.abs(m[p][k]) < 1e-12) return null;
      [m[k], m[p]] = [m[p], m[k]];
      const d = m[k][k];
      for (let j = k; j <= n; j++) m[k][j] /= d;
      for (let i = 0; i < n; i++)
        if (i !== k) {
          const f = m[i][k];
          for (let j = k; j <= n; j++) m[i][j] -= f * m[k][j];
        }
    }
    return m.map((r) => r[n]);
  }
  function inverse(
    config,
    target,
    seed,
    { restarts = true, iterations = 180, positionTolerance = 0.15, orientationTolerance = 0.1 } = {},
  ) {
    const length = Math.max(
      100,
      config.joints.reduce((s, j) => s + Math.abs(j.a) + Math.abs(j.d), 0) / 4,
    );
    const seeds = [seed];
    if (restarts) {
      seeds.push(config.joints.map((j) => j.home));
      for (let n = 0; n < 5; n++)
        seeds.push(
          config.joints.map((j, i) =>
            clamp(
              seed[i] + Math.sin((n + 1) * (i + 2) * 2.4) * 100,
              j.min,
              j.max,
            ),
          ),
        );
    }
    let best = {
      ok: false,
      positionError: Infinity,
      orientationError: Infinity,
      score: Infinity,
      q: [...seed],
    };
    for (const initial of seeds) {
      let q = initial.map((v, i) =>
        clamp(v, config.joints[i].min, config.joints[i].max),
      );
      for (let k = 0; k < iterations; k++) {
        const f = forward(config, q),
          ep = sub(position(target), position(f.tcp)),
          er = rotationError(target, f.tcp);
        const e = [...ep, ...er.map((v) => v * length)],
          score = norm(e),
          pe = norm(ep),
          oe = norm(er) * DEG;
        if (score < best.score)
          best = {
            ok: pe < positionTolerance && oe < orientationTolerance,
            positionError: pe,
            orientationError: oe,
            score,
            q: [...q],
            iterations: k + 1,
          };
        if (pe < positionTolerance && oe < orientationTolerance)
          return { ok: true, positionError: pe, orientationError: oe, score, q: [...q], iterations: k + 1 };
        const columns = f.axes.map((axis, i) => [
          ...cross(axis, sub(position(f.tcp), f.origins[i])),
          ...axis.map((v) => v * length),
        ]);
        const J = Array.from({ length: 6 }, (_, r) => columns.map((c) => c[r]));
        let improved = false;
        for (const damping of [0.5, 3, 15, 60]) {
          const A = J.map((r, i) =>
            J.map(
              (s, j) =>
                r.reduce((v, x, k) => v + x * s[k], 0) +
                (i === j ? damping * damping : 0),
            ),
          );
          const v = solveLinear(A, e);
          if (!v) continue;
          let dq = columns.map(
              (c) => c.reduce((s, x, i) => s + x * v[i], 0) * DEG,
            ),
            largest = Math.max(...dq.map(Math.abs));
          if (largest > 12) dq = dq.map((v) => (v * 12) / largest);
          for (const factor of [1, 0.5, 0.2]) {
            const next = q.map((v, i) =>
              clamp(
                v + dq[i] * factor,
                config.joints[i].min,
                config.joints[i].max,
              ),
            );
            const nf = forward(config, next),
              ne = [
                ...sub(position(target), position(nf.tcp)),
                ...rotationError(target, nf.tcp).map((v) => v * length),
              ];
            if (norm(ne) < score - 1e-9) {
              q = next;
              improved = true;
              break;
            }
          }
          if (improved) break;
        }
        if (!improved) break;
      }
    }
    return best;
  }
  // Position-only IK permits the arm to change posture while its TCP is pinned.
  // Fixed joints are prescribed in degrees; the remaining joints compensate.
  function inversePosition(config, target, seed, fixed = {}, { joint = null } = {}) {
    if (!Array.isArray(target) || target.length !== 3 || !target.every(Number.isFinite))
      throw Error("A finite XYZ tool position is required.");
    let q = validateJoints(config, seed);
    if (joint !== null && (!Number.isInteger(joint) || joint < 0 || joint > 5))
      throw Error("Invalid joint drag target.");
    const locked = new Set(Object.keys(fixed).map(Number));
    for (const i of locked) {
      if (!Number.isInteger(i) || i < 0 || i > 5) throw Error("Invalid fixed joint.");
      q[i] = fixed[i];
    }
    q = validateJoints(config, q);
    const free = config.joints.map((_, i) => i).filter((i) => !locked.has(i) && (joint === null || i < joint));
    const evaluate = (angles) => joint === null ? forward(config, angles) : visualGeometry(config, angles);
    const point = (f) => joint === null ? position(f.tcp) : f.centers[joint];
    let best = { ok: false, positionError: Infinity, q: [...q] };
    for (let iteration = 0; iteration < 100; iteration++) {
      const f = evaluate(q),
        tcp = point(f),
        error = sub(target, tcp),
        distance = norm(error);
      if (distance < best.positionError)
        best = { ok: distance < 0.01, positionError: distance, q: [...q] };
      if (best.ok) return best;
      const columns = free.map((i) => cross(f.axes[i], sub(tcp, f.origins[i])).map((v) => v * RAD)),
        J = Array.from({ length: 3 }, (_, r) => columns.map((c) => c[r]));
      let improved = false;
      for (const damping of [0.01, 0.1, 1]) {
        const A = J.map((r, i) => J.map((s, j) =>
          r.reduce((sum, v, k) => sum + v * s[k], 0) + (i === j ? damping ** 2 : 0))),
          correction = solveLinear(A, error);
        if (!correction) continue;
        let step = columns.map((c) => c.reduce((sum, v, k) => sum + v * correction[k], 0));
        const largest = Math.max(0, ...step.map(Math.abs));
        if (largest > 2) step = step.map((v) => v * 2 / largest);
        for (const factor of [1, 0.5, 0.2]) {
          const next = [...q];
          free.forEach((i, k) => {
            next[i] = clamp(q[i] + step[k] * factor, config.joints[i].min, config.joints[i].max);
          });
          if (norm(sub(target, point(evaluate(next)))) < distance - 1e-9) {
            q = next;
            improved = true;
            break;
          }
        }
        if (improved) break;
      }
      if (!improved) break;
    }
    return best;
  }
  // Interactive position-only IK: accept local progress even when the exact
  // target is outside reach. Bound each update to stay on the nearby posture.
  function inversePush(config, target, seed, { joint = null } = {}) {
    validateJoints(config, seed);
    if (!Array.isArray(target) || target.length !== 3 || !target.every(Number.isFinite))
      throw Error("A finite XYZ tool position is required.");
    const local = { ...config, joints: config.joints.map((joint, i) => ({
      ...joint, min: Math.max(joint.min, seed[i] - 6), max: Math.min(joint.max, seed[i] + 6),
    })) };
    if (joint !== null && (!Number.isInteger(joint) || joint < 0 || joint > 5))
      throw Error("Invalid joint drag target.");
    const initial = joint === null ? position(forward(config, seed).tcp) : visualGeometry(config, seed).centers[joint];
    const initialError = norm(sub(target, initial));
    let best = inversePosition(local, target, seed, {}, { joint });
    // An exactly aligned elbow can have zero first-order movement toward the
    // target. Small, local seeds let the elbow bend without a remote IK restart.
    if (!best.ok && best.positionError >= initialError - 0.001) {
      const restartJoints = joint === null ? [2, 4, 1] : Array.from({ length: joint }, (_, i) => joint - i - 1);
      for (const index of restartJoints) {
        for (const sign of [-1, 1]) {
          const next = [...seed];
          next[index] = clamp(next[index] + sign, local.joints[index].min, local.joints[index].max);
          const result = inversePosition(local, target, next, {}, { joint });
          if (result.positionError < best.positionError) best = result;
        }
        if (best.ok) break;
      }
    }
    const reached = best.positionError < 0.05;
    const improved = best.positionError < initialError - 0.0001;
    return { ...best, ok: reached || improved, reached,
      q: reached || improved ? best.q : [...seed] };
  }
  const zeroPose = () => ({ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 });
  function forearmRollConfig() {
    // J2/J3 are parallel pitch axes. The elbow offset and twist align J4
    // with the forearm, perpendicular to J3. Forearm length is d4, not a3.
    const data = [
      [0, 180, 90, -180, 180, 0, 0, "Base rotation"],
      [320, 0, 0, -150, 150, 55, 0, "Shoulder"],
      [0, 0, 90, -155, 155, -55, 90, "Elbow"],
      [0, 260, -90, -180, 180, 0, 0, "Forearm roll"],
      [0, 0, 90, -120, 120, 30, 0, "Wrist bend"],
      [0, 75, 0, -360, 360, 0, 0, "Tool rotation"],
    ];
    return {
      name: "6R Forearm Roll · 580",
      base: zeroPose(),
      tool: { ...zeroPose(), z: 80 },
      joints: data.map(([a, d, alpha, min, max, home, offset, name], i) => ({
        name,
        a,
        d,
        alpha,
        min,
        max,
        home,
        offset,
        velocity: i < 3 ? 60 : 100,
        acceleration: i < 3 ? 120 : 200,
        axis: "XYZABC"[i],
        scale: 1,
        zero: 0,
      })),
    };
  }
  // Sample geometry in millimetres for arms with parallel elbow axes.
  // Both long links and wrist 2 stand upright; the flange faces outward
  // along the shoulder axis, matching the physical manual-reference pose.
  const UPRIGHT_HOME = [0, -90, 0, -90, 0, 0];
  function parallelElbowConfig(preset = "standard") {
    const presets = {
      standard: { name: "Standard arm", dimensions: [150, -600, -550, 160, 110, 90] },
      compact: { name: "Compact arm", dimensions: [140, -250, -210, 120, 80, 85] },
      medium: { name: "Medium arm", dimensions: [160, -420, -380, 140, 95, 100] },
      extended: { name: "Extended arm", dimensions: [180, -650, -610, 175, 120, 115] },
    };
    if (!Object.hasOwn(presets, preset)) throw Error(`Unknown arm preset: ${preset}`);
    const { name, dimensions } = presets[preset];
    const [d1, a2, a3, d4, d5, d6] = dimensions;
    const c = forearmRollConfig();
    c.name = `${name} · 6-axis`;
    c.tool = zeroPose();
    const home = UPRIGHT_HOME;
    const names = [
      "Base",
      "Shoulder",
      "Elbow",
      "Wrist 1",
      "Wrist 2",
      "Wrist 3",
    ];
    const data = [
      [0, d1, 90],
      [a2, 0, 0],
      [a3, 0, 0],
      [0, d4, 90],
      [0, d5, -90],
      [0, d6, 0],
    ];
    c.joints.forEach((j, i) => {
      [j.a, j.d, j.alpha] = data[i];
      Object.assign(j, {
        offset: 0,
        min: i === 2 ? -180 : -360,
        max: i === 2 ? 180 : 360,
        home: home[i],
        name: names[i],
        velocity: 10,
        acceleration: 20,
      });
    });
    return c;
  }
  const defaultConfig = () => parallelElbowConfig();
  function isParallelElbowLayout(c) {
    const near = (a, b) => Math.abs(a - b) < 1e-6;
    return (
      c.joints.length === 6 &&
      c.joints.every(
        (j, i) =>
          near(j.alpha, [90, 0, 0, 90, -90, 0][i]) &&
          near(j.offset, 0) &&
          (i === 1 || i === 2
            ? j.a < 0 && near(j.d, 0)
            : near(j.a, 0) && j.d > 0),
      )
    );
  }
  function uprightHome(c) {
    if (!isParallelElbowLayout(c))
      throw Error("Upright homing requires the parallel-elbow layout.");
    return validateJoints(c, UPRIGHT_HOME);
  }
  // DH origins lie on the rotation axes; housings may move along those axes.
  // Put the shoulder and first wrist housing in one plane, with the elbow over the base.
  function visualGeometry(c, q) {
    const f = forward(c, q),
      parallelElbow = isParallelElbowLayout(c);
    const centers = f.origins.map((origin, i) => {
      let offset = 0;
      if (parallelElbow)
        offset =
          i === 1 || i === 3
            ? c.joints[3].d
            : i === 2
              ? 0
              : i === 4
                ? c.joints[4].d
                : i === 5
                  ? c.joints[5].d * (5 / 6)
                  : c.joints[0].d * 0.55;
      return origin.map((v, k) => v + f.axes[i][k] * offset);
    });
    return { ...f, centers, parallelElbow };
  }
  // Use the visible housing center, which can be offset along the DH axis.
  // Only ancestors can translate a revolute joint's own rotation center.
  function jointJogState(config, q, index, frame = "world") {
    if (!Number.isInteger(index) || index < 0 || index > 5)
      throw Error("Invalid joint drag target.");
    const f = visualGeometry(config, q), matrix = [...f.frames[index]], center = f.centers[index];
    [3, 7, 11].forEach((offset, i) => { matrix[offset] = center[i]; });
    const axes = [false, false, false];
    const directions = [0, 1, 2].map((axis) => frame === "tool"
      ? [matrix[axis], matrix[axis + 4], matrix[axis + 8]]
      : [0, 1, 2].map((i) => i === axis ? 1 : 0));
    for (let joint = 0; joint < index; joint++) {
      // Sampling both signs also recognizes directions available by bending
      // away from an aligned pose, where the instantaneous Jacobian is zero.
      for (const sign of [-1, 1]) {
        const next = [...q];
        next[joint] = clamp(next[joint] + sign, config.joints[joint].min, config.joints[joint].max);
        const delta = sub(visualGeometry(config, next).centers[index], center);
        directions.forEach((direction, axis) => {
          if (Math.abs(delta.reduce((sum, value, i) => sum + value * direction[i], 0)) > 1e-5) axes[axis] = true;
        });
      }
    }
    return { matrix, axes, movable: axes.some(Boolean) };
  }
  const number = (v, name, min = -1e5, max = 1e5) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max)
      throw Error(`${name} must be a finite number between ${min} and ${max}.`);
    return v;
  };
  function visualSizes(c) {
    const reach = Math.max(1, c.joints.reduce((sum, j) => sum + Math.abs(j.a) + Math.abs(j.d), 0)),
      longLink = Math.max(...c.joints.map((j) => Math.abs(j.a))),
      offsets = c.joints.slice(3).map((j) => Math.abs(j.d)).filter((d) => d > 0),
      wrist = offsets.length ? Math.min(...offsets) : reach / 6,
      major = Math.max(longLink * 0.1, wrist * 0.3, reach * 0.015),
      automatic = [major, major, major * 0.82,
        Math.min(major * 0.75, wrist * 0.38),
        Math.min(major * 0.65, wrist * 0.34),
        Math.min(major * 0.6, wrist * 0.3)],
      radii = automatic.map((r, i) => c.appearance?.joints?.[i] != null ? c.appearance.joints[i] / 2 : r),
      linkRatio = isParallelElbowLayout(c) ? 0.65 : 0.72,
      linkRadii = radii.map((r, i) => c.appearance?.links?.[i] != null ? c.appearance.links[i] / 2 : r * linkRatio),
      offsetRadii = linkRadii.map((r, i) => c.appearance?.links?.[i] != null || linkRatio === 0.65 ? r : radii[i] * 0.7);
    return { reach, scale: reach / 1660, radii, linkRadii, offsetRadii,
      baseRadius: c.appearance?.links?.[0] != null ? linkRadii[0] : radii[0] * 0.88,
      toolRadius: c.appearance?.links?.[5] != null ? linkRadii[5] : radii[5] * 0.45 };
  }
  function validateConfig(c) {
    if (
      !c ||
      typeof c.name !== "string" ||
      !c.name.trim() ||
      c.name.length > 80
    )
      throw Error("Robot name must contain 1–80 characters.");
    if (!Array.isArray(c.joints) || c.joints.length !== 6)
      throw Error("Exactly six joints are required.");
    const axes = new Set();
    const joints = c.joints.map((j, i) => {
      if (
        !j ||
        !["X", "Y", "Z", "A", "B", "C"].includes(j.axis) ||
        axes.has(j.axis)
      )
        throw Error(`J${i + 1}: select a unique X/Y/Z/A/B/C axis.`);
      axes.add(j.axis);
      const out = { axis: j.axis };
      if (j.name !== undefined) {
        if (typeof j.name !== "string" || !j.name.trim() || j.name.length > 60)
          throw Error(`J${i + 1}: name must contain 1–60 characters.`);
        out.name = j.name.trim();
      }
      for (const k of [
        "a",
        "d",
        "alpha",
        "offset",
        "min",
        "max",
        "home",
        "zero",
      ])
        out[k] = number(j[k], `J${i + 1} ${k}`);
      out.velocity = number(j.velocity, `J${i + 1} velocity`, 0.01, 10000);
      out.acceleration = number(
        j.acceleration,
        `J${i + 1} acceleration`,
        0.01,
        1e6,
      );
      out.scale = number(j.scale, `J${i + 1} scale`);
      if (Math.abs(out.scale) < 1e-6)
        throw Error(`J${i + 1} scale cannot be zero.`);
      if (out.min >= out.max || out.home < out.min || out.home > out.max)
        throw Error(`J${i + 1}: min < max and home must be within limits.`);
      if (out.min < -3600 || out.max > 3600 || out.max - out.min > 7200)
        throw Error(`J${i + 1}: limits must be within ±3600°.`);
      return out;
    });
    const frame = (k) => {
      if (!c[k]) throw Error(`${k} frame is missing.`);
      return Object.fromEntries(
        ["x", "y", "z", "rx", "ry", "rz"].map((p) => [
          p,
          number(c[k][p], `${k} ${p}`),
        ]),
      );
    };
    if (joints.reduce((s, j) => s + Math.abs(j.a) + Math.abs(j.d), 0) < 1)
      throw Error("At least one link dimension must be nonzero.");
    let appearance;
    if (c.appearance !== undefined) {
      if (!c.appearance || typeof c.appearance !== "object" || Array.isArray(c.appearance))
        throw Error("Invalid robot appearance settings.");
      appearance = Object.fromEntries(["links", "joints"].map((key) => {
        const values = c.appearance[key] ?? Array(6).fill(null);
        if (!Array.isArray(values) || values.length !== 6)
          throw Error(`Appearance ${key} must contain six diameters.`);
        return [key, Array.from(values, (value, i) => value == null ? null : number(value, `J${i + 1} ${key} diameter`, 0.1, 10000))];
      }));
    }
    return {
      name: c.name.trim(),
      joints,
      base: frame("base"),
      tool: frame("tool"),
      ...(appearance ? { appearance } : {}),
    };
  }
  function validateJoints(config, q) {
    if (!Array.isArray(q) || q.length !== 6)
      throw Error("A pose must contain six joint angles.");
    return q.map((v, i) =>
      number(v, `J${i + 1}`, config.joints[i].min, config.joints[i].max),
    );
  }
  function validateEndEffector(value = {}) {
    const defaults = {
      open: "M67 E0 Q5",
      close: "M67 E0 Q10",
    };
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error("Invalid end effector settings.");
    return Object.fromEntries(Object.entries(defaults).map(([action, fallback]) => {
      const code = value[action] ?? fallback;
      if (typeof code !== "string" || code.length > 4000 || /[^\x20-\x7e\r\n\t]/.test(code))
        throw Error(`Invalid ${action} gripper commands.`);
      const lines = code.split(/\r\n?|\n/).map((line) => line.trim()).filter(Boolean);
      if (!lines.length || lines.length > 40 || lines.some((line) => line.length > 120))
        throw Error(`Use 1–40 lines of up to 120 characters for ${action} gripper commands.`);
      return [action, lines.join("\n")];
    }));
  }
  function endEffectorAction(value = "none") {
    if (!["none", "open", "close"].includes(value)) throw Error("Invalid gripper action.");
    return value;
  }
  function endEffectorCommand(action, settings) {
    endEffectorAction(action);
    if (action === "none") return "";
    return validateEndEffector(settings)[action];
  }
  function endEffectorDuration(code) {
    return Math.max(0.001, code.split("\n").reduce((seconds, line) => {
      const block = line.replace(/\([^)]*\)/g, "").split(";")[0];
      if (!/\bG0?4(?=\s|[A-Z]|$)/i.test(block)) return seconds;
      const dwell = block.match(/P\s*(\d+(?:\.\d*)?|\.\d+)/i);
      return seconds + (dwell ? number(Number(dwell[1]), "Gripper dwell", 0, 600) : 0);
    }, 0));
  }
  function withEndEffector(segment, action = "none", settings) {
    endEffectorAction(action);
    if (action === "none") return segment;
    const commands = endEffectorCommand(action, settings),
      duration = segment.duration + endEffectorDuration(commands);
    return {
      ...segment,
      duration,
      samples: [...segment.samples, {
        q: [...segment.samples.at(-1).q], t: duration,
        endEffector: action, commands,
      }],
    };
  }
  function validateProject(p) {
    if (!p || p.format !== "figui-robot-studio" || p.version !== 1)
      throw Error("Expected a Robot Studio version 1 JSON project.");
    const config = validateConfig(p.config),
      q = validateJoints(config, p.q);
    if (!Array.isArray(p.points) || p.points.length > 200)
      throw Error("A project may contain at most 200 waypoints.");
    const points = p.points.map((v, i) => {
      if (
        !v ||
        typeof v.name !== "string" ||
        v.name.length > 60 ||
        !["MoveJ", "MoveL"].includes(v.type)
      )
        throw Error(`Invalid waypoint ${i + 1}.`);
      return {
        name: v.name,
        type: v.type,
        q: validateJoints(config, v.q),
        duration: number(v.duration, "Duration", 0.1, 600),
        endEffector: endEffectorAction(v.endEffector),
      };
    });
    if (p.programMaximums !== undefined && typeof p.programMaximums !== "boolean")
      throw Error("Invalid program speed setting.");
    if (p.jogMaximums !== undefined && typeof p.jogMaximums !== "boolean")
      throw Error("Invalid jog speed setting.");
    if (p.programSource !== undefined && !["stream", "sd"].includes(p.programSource))
      throw Error("Invalid program source.");
    return { format: p.format, version: 1, config, q, points, endEffector: validateEndEffector(p.endEffector), programMaximums: p.programMaximums ?? true, jogMaximums: p.jogMaximums ?? true, programSource: p.programSource ?? "stream" };
  }
  const smooth = (t) => t * t * t * (10 + t * (-15 + 6 * t));
  function planControllerJoint(config, from, to, { duration, speed, acceleration }) {
    const delta = sub(to, from), moving = delta.map((value, i) => value === 0 ? -1 : i).filter((i) => i >= 0);
    const rate = Math.min(1 / duration, ...moving.map((i) => config.joints[i].velocity * speed / Math.abs(delta[i])));
    const accel = Math.min(...moving.map((i) => config.joints[i].acceleration * acceleration / Math.abs(delta[i])));
    const peak = Math.min(rate, Math.sqrt(accel)), ramp = peak / accel;
    const cruise = Math.max(0, 1 / peak - ramp), total = 2 * ramp + cruise;
    const count = Math.min(1200, Math.max(4, Math.ceil(total / 0.05), Math.ceil(Math.max(...delta.map(Math.abs)) / 1.5)));
    const times = [...Array.from({ length: count + 1 }, (_, i) => total * i / count), ramp, total - ramp]
      .sort((a, b) => a - b).filter((value, i, all) => i === 0 || value - all[i - 1] > 1e-9);
    times[times.length - 1] = total;
    const samples = times.map((t, i) => {
      const progress = t <= ramp ? 0.5 * accel * t * t
        : t < total - ramp ? 0.5 * peak * ramp + peak * (t - ramp)
        : 1 - 0.5 * accel * (total - t) ** 2;
      return { q: i === 0 ? [...from] : i === times.length - 1 ? [...to]
        : from.map((value, j) => value + delta[j] * clamp(progress, 0, 1)), t };
    });
    // Samples are for visualization/progress. Export sends one constant-feed
    // joint move, allowing FluidNC to apply the same ramps used for jogging.
    const distance = norm(delta.map((value, i) => value * config.joints[i].scale));
    return { type: "MoveJ", samples, duration: total, controllerFeed: distance * rate * 60 };
  }
  function planSegment(
    config,
    from,
    to,
    { type = "MoveJ", duration = 3, speed = 1, acceleration = 1, controllerRamp = false } = {},
  ) {
    validateJoints(config, from);
    validateJoints(config, to);
    number(duration, "Duration", 0.1, 600);
    number(speed, "Speed", 0.01, 1);
    number(acceleration, "Acceleration", 0.01, 1);
    if (!["MoveJ", "MoveL"].includes(type)) throw Error("Unknown move type.");
    if (from.every((value, j) => value === to[j])) {
      const holdDuration = duration * 1.01;
      return { type, duration: holdDuration, samples: [
        { q: [...from], t: 0 }, { q: [...to], t: holdDuration, hold: true },
      ] };
    }
    if (type === "MoveJ" && controllerRamp)
      return planControllerJoint(config, from, to, { duration, speed, acceleration });
    const start = forward(config, from).tcp,
      end = forward(config, to).tcp;
    const n = Math.min(
      1200,
      Math.max(
        40,
        type === "MoveL" ? Math.ceil(norm(sub(position(end), position(start))) / 3) : 0,
        Math.ceil(Math.max(...sub(to, from).map(Math.abs)) / 1.5),
      ),
    );
    const samples = [{ q: [...from], t: 0 }],
      diff = sub(to, from);
    let seed = from;
    for (let i = 1; i <= n; i++) {
      const s = smooth(i / n);
      let q;
      if (type === "MoveJ") q = from.map((v, j) => v + diff[j] * s);
      else {
        const result = inverse(config, interpolatePose(start, end, s), seed, {
          restarts: false,
          iterations: 100,
        });
        if (!result.ok)
          throw Error(
            `MoveL cannot be solved at ${Math.round((i / n) * 100)}% (${result.positionError.toFixed(2)} mm residual). Try an intermediate point or MoveJ.`,
          );
        q = result.q;
        if (Math.max(...sub(q, seed).map(Math.abs)) > 12)
          throw Error(
            "MoveL encountered a joint discontinuity near a singularity.",
          );
      }
      samples.push({ q, t: i / n });
      seed = q;
    }
    let timed = timeJointPath(config, samples.map((s) => s.q), { duration, speed, acceleration });
    if (type === "MoveJ") {
      // Tiny moves must not require hundreds of network round trips/second.
      // Keep angular resolution for larger curves and enough samples to shape
      // acceleration, then recheck limits on the actual reduced path.
      const count = Math.min(n, Math.max(4,
        Math.ceil(Math.max(...diff.map(Math.abs)) / 1.5),
        Math.ceil(timed.duration / 0.05)));
      if (count < n) {
        const path = Array.from({ length: count + 1 }, (_, i) =>
          i === count ? [...to] : from.map((v, j) => v + diff[j] * smooth(i / count)));
        timed = timeJointPath(config, path, { duration, speed, acceleration });
      }
    }
    return { ...timed, type };
  }
  function timeJointPath(config, path, { duration = 3, speed = 1, acceleration = 1 } = {}) {
    number(duration, "Duration", 0.1, 600);
    number(speed, "Speed", 0.01, 1);
    number(acceleration, "Acceleration", 0.01, 1);
    if (!Array.isArray(path) || path.length < 2) throw Error("A joint path needs at least two poses.");
    const samples = path.map((q, i) => ({ q: validateJoints(config, q), t: i / (path.length - 1) })),
      n = samples.length - 1;
    // Retiming enforces sampled joint speed/acceleration, including rest at both ends.
    let required = duration;
    config.joints.forEach((j, k) => {
      let previous = 0;
      for (let i = 1; i < samples.length; i++) {
        const velocity = (samples[i].q[k] - samples[i - 1].q[k]) * n;
        required = Math.max(
          required,
          Math.abs(velocity) / (j.velocity * speed),
          Math.sqrt(
            (Math.abs(velocity - previous) * n) / (j.acceleration * acceleration),
          ),
        );
        previous = velocity;
      }
      required = Math.max(
        required,
        Math.sqrt((Math.abs(previous) * n) / (j.acceleration * acceleration)),
      );
    });
    required *= 1.01;
    samples.forEach((s) => (s.t *= required));
    return { samples, duration: required };
  }
  function planProgram(config, start, points, speed = 1, endEffector, { controllerRamp = false } = {}) {
    if (!points.length) throw Error("Teach at least one waypoint first.");
    let q = start,
      time = 0;
    const samples = [{ q: [...start], t: 0 }],
      segments = [];
    for (const [i, p] of points.entries()) {
      let segment;
      try {
        segment = withEndEffector(planSegment(config, q, p.q, { ...p, speed, controllerRamp }), p.endEffector, endEffector);
      } catch (e) {
        throw Error(`Point ${i + 1}: ${e.message}`);
      }
      samples.push(
        ...segment.samples.slice(1).map((s) => ({ ...s, t: s.t + time })),
      );
      time += segment.duration;
      segments.push({ ...segment, name: p.name });
      q = segment.samples.at(-1).q;
    }
    return blendProgram(config, { samples, segments, duration: time }, speed);
  }
  // A quintic Bezier with shared endpoint velocity and zero endpoint
  // acceleration joins MoveJ waypoints without restarting the speed profile.
  // Monotone control points keep every joint inside its taught endpoint range.
  function bezier(values, u) {
    const work = [...values];
    for (let n = work.length - 1; n > 0; n--)
      for (let i = 0; i < n; i++) work[i] += (work[i + 1] - work[i]) * u;
    return work[0];
  }
  function derivativeBound(values, depth = 3) {
    // Subdivision tightens the convex-hull bound without missing extrema
    // between samples. This is a bound over the whole continuous curve.
    if (!depth) return Math.max(...values.map(Math.abs));
    const work = [...values], left = [work[0]], right = [work.at(-1)];
    for (let n = work.length - 1; n > 0; n--) {
      for (let i = 0; i < n; i++) work[i] = (work[i] + work[i + 1]) / 2;
      left.push(work[0]); right.unshift(work[n - 1]);
    }
    return Math.max(derivativeBound(left, depth - 1), derivativeBound(right, depth - 1));
  }
  function blendProgram(config, plan, speed = 1) {
    number(speed, "Speed", 0.01, 1);
    const segments = [...plan.segments];
    const blendable = (s) => s.type === "MoveJ" && !s.controllerFeed && s.duration > 0 &&
      !s.samples.some((sample) => sample.commands) &&
      norm(sub(s.samples.at(-1).q, s.samples[0].q)) >= 1e-6;
    for (let first = 0; first < segments.length;) {
      if (!blendable(segments[first])) { first++; continue; }
      let end = first + 1;
      while (end < segments.length && blendable(segments[end])) end++;
      if (end - first < 2) { first = end; continue; }
      const run = segments.slice(first, end);
      const velocities = Array.from({ length: run.length + 1 }, () => Array(6).fill(0));
      for (let i = 1; i < run.length; i++) {
        const before = run[i - 1], after = run[i];
        velocities[i] = before.samples.at(-1).q.map((q, j) => {
          const a = (q - before.samples[0].q[j]) / before.duration;
          const b = (after.samples.at(-1).q[j] - q) / after.duration;
          return a * b > 0 ? Math.sign(a) * Math.min(Math.abs(a), Math.abs(b)) : 0;
        });
      }
      let stretch = 1;
      const curves = run.map((segment, i) => config.joints.map((joint, j) => {
        const a = segment.samples[0].q[j], b = segment.samples.at(-1).q[j];
        const enter = velocities[i][j] * segment.duration / 5;
        const leave = velocities[i + 1][j] * segment.duration / 5;
        const control = [a, a + enter, a + 2 * enter, b - 2 * leave, b - leave, b];
        const velocity = control.slice(1).map((v, k) => 5 * (v - control[k]) / segment.duration);
        const acceleration = velocity.slice(1).map((v, k) => 4 * (v - velocity[k]) / segment.duration);
        stretch = Math.max(stretch,
          derivativeBound(velocity) / (joint.velocity * speed),
          Math.sqrt(derivativeBound(acceleration) / joint.acceleration));
        return control;
      }));
      // Scale the whole run together to preserve shared velocities at joins.
      if (stretch > 1) stretch *= 1.01;
      run.forEach((segment, i) => {
        segments[first + i] = { ...segment, duration: segment.duration * stretch,
          samples: segment.samples.map((sample, k) => ({ ...sample,
            q: k === 0 || k === segment.samples.length - 1 ? [...sample.q]
              : curves[i].map((control) => bezier(control, sample.t / segment.duration)),
            t: sample.t * stretch,
          })),
        };
      });
      first = end;
    }
    const samples = [{ ...plan.samples[0], q: [...plan.samples[0].q] }];
    let duration = 0;
    for (const segment of segments) {
      samples.push(...segment.samples.slice(1).map((sample) => ({ ...sample, t: sample.t + duration })));
      duration += segment.duration;
    }
    return { ...plan, samples, segments, duration };
  }
  function axisWords(config, q) {
    return config.joints
      .map((j, i) => `${j.axis}${(q[i] * j.scale + j.zero).toFixed(5)}`)
      .join(" ");
  }
  function exportGcode(config, plan) {
    const compact = (value, places = 5) => String(Number(value.toFixed(places)));
    const coordinates = (q) => config.joints.map((j, i) => compact(q[i] * j.scale + j.zero));
    let samples = plan.samples;
    if (plan.segments?.some((segment) => segment.controllerFeed)) {
      samples = [{ ...plan.samples[0] }];
      let time = 0;
      for (const segment of plan.segments) {
        if (segment.controllerFeed) {
          const motion = segment.samples.filter((sample) => !sample.commands).at(-1);
          samples.push({ ...motion, t: time + motion.t, controllerFeed: segment.controllerFeed });
          samples.push(...segment.samples.filter((sample) => sample.commands).map((sample) => ({ ...sample, t: time + sample.t })));
        } else samples.push(...segment.samples.slice(1).map((sample) => ({ ...sample, t: time + sample.t })));
        time += segment.duration;
      }
    }
    let previous = coordinates(samples[0].q), fullPosition = true, dwell = 0, pendingTime = 0, motionMode = null;
    const lines = [
      "; Robot Studio - joint-space FluidNC program",
      "; Requires Cartesian firmware kinematics and calibrated machine coordinates.",
      `; START REQUIRED: ${axisWords(config, plan.samples[0].q)}`,
      "; Verify start position before running. No automatic move to start.",
      "G21 G90 G94",
    ];
    const flushDwell = () => {
      if (dwell > 0) { lines.push(`G4 P${compact(dwell)}`); motionMode = null; }
      dwell = 0;
    };
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1],
        b = samples[i],
        dt = b.t - a.t;
      if (b.commands) {
        dwell += pendingTime;
        pendingTime = 0;
        flushDwell();
        lines.push("G4 P0", `; ${b.endEffector === "open" ? "Open" : "Close"} gripper`, ...b.commands.split("\n"), "G21 G90 G94");
        // User commands may change axes or modal state. Reassert every axis.
        previous = null;
        motionMode = null;
        continue;
      }
      const next = coordinates(b.q);
      if (b.hold) {
        dwell += dt + pendingTime;
        pendingTime = 0;
        continue;
      }
      // Keep sub-resolution travel time with the next representable motion,
      // rather than inserting a planner-draining dwell into a moving path.
      if (previous && next.every((value, j) => previous[j] === value)) { pendingTime += dt; continue; }
      const words = next.map((value, j) => !fullPosition && previous?.[j] === value ? "" : `${config.joints[j].axis}${value}`).filter(Boolean);
      // A real stationary interval is a deliberate hold; preserve it.
      flushDwell();
      const nextMode = b.controllerFeed ? "G94" : "G93";
      // Cartesian/sampled paths retain their planned stop at a mode boundary.
      // Consecutive controller-ramped joint moves stay in the planner together.
      if (motionMode && motionMode !== nextMode) lines.push("G4 P0");
      let feed = b.controllerFeed || 60 / (dt + pendingTime);
      if (b.controllerFeed && pendingTime > 0) {
        const origin = previous || coordinates(a.q);
        const distance = norm(next.map((value, j) => Number(value) - Number(origin[j])));
        feed = Math.min(feed, 60 * distance / (dt + pendingTime));
      }
      lines.push(`${nextMode} G53 G1 ${words.join(" ")} F${compact(feed, 6)}`);
      motionMode = nextMode;
      pendingTime = 0;
      previous = next;
      fullPosition = false;
    }
    dwell += pendingTime;
    flushDwell();
    lines.push("G94", "M2");
    return lines.join("\n") + "\n";
  }
  function machineJoints(config, status) {
    if (!status?.mpos) throw Error("Machine positions are unavailable.");
    return validateJoints(
      config,
      config.joints.map((j) => {
        const v = status.mpos[j.axis.toLowerCase()];
        number(v, `${j.axis} machine position`);
        return (v - j.zero) / j.scale;
      }),
    );
  }
  function referenceConfig(config, status) {
    if (status?.state !== "Idle")
      throw Error("Machine must be Idle to record a manual reference.");
    if (!status.mpos) throw Error("All six machine positions are required.");
    const next = validateConfig(config);
    next.joints.forEach((j) => {
      const position = number(
        status.mpos[j.axis.toLowerCase()],
        `${j.axis} machine position`,
      );
      j.zero = position - j.home * j.scale;
    });
    return validateConfig(next);
  }
  function jogCommand(config, from, to, speed) {
    validateJoints(config, from);
    validateJoints(config, to);
    number(speed, "Speed", 0.01, 1);
    // This is one constant-feed jog. FluidNC accelerates and brakes it using
    // its axis acceleration settings; baking an acceleration time into F
    // would slow the requested feed before the firmware applies that ramp.
    const seconds = Math.max(
      1e-6,
      ...config.joints.map((j, i) =>
        Math.abs(to[i] - from[i]) / (j.velocity * speed),
      ),
    );
    const distance = norm(
      config.joints.map((j, i) => (to[i] - from[i]) * j.scale),
    );
    if (distance < 1e-5)
      throw Error("The machine is already at this joint pose.");
    return `$J=G53 G90 G21 ${axisWords(config, to)} F${((distance / seconds) * 60).toFixed(4)}`;
  }
  globalThis.RobotCore = {
    RAD,
    DEG,
    clamp,
    norm,
    sub,
    identity,
    multiply,
    position,
    poseMatrix,
    matrixPose,
    rotationError,
    interpolatePose,
    forward,
    inverse,
    inversePosition,
    inversePush,
    defaultConfig,
    forearmRollConfig,
    parallelElbowConfig,
    isParallelElbowLayout,
    uprightHome,
    visualGeometry,
    jointJogState,
    visualSizes,
    validateConfig,
    validateJoints,
    validateProject,
    validateEndEffector,
    endEffectorCommand,
    withEndEffector,
    planSegment,
    timeJointPath,
    planProgram,
    blendProgram,
    exportGcode,
    machineJoints,
    referenceConfig,
    jogCommand,
  };
})();
