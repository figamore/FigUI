/* Wrist singularity crossing. Cartesian axis chooses the world
   direction of the wrist's rotation; it is not a choice of joint number.
   Joint-space timing avoids an IK branch flip at the singular configuration. */
(() => {
  "use strict";
  const K = RobotCore, RAD = Math.PI / 180, DEG = 180 / Math.PI;
  function nearestEquivalent(angle, joint, reference) {
    const first = Math.ceil((joint.min - angle) / 360),
      last = Math.floor((joint.max - angle) / 360);
    if (first > last) return null;
    const turn = Math.max(first, Math.min(last, Math.round((reference - angle) / 360)));
    return angle + turn * 360;
  }
  async function plan(config, start, { axis = "x", angle = 35, speed = 1, duration = 12, cancelled = () => false } = {}) {
    K.validateConfig(config);
    start = K.validateJoints(config, start);
    if (!K.isParallelElbowLayout(config)) throw Error("Wrist singularity demo requires the parallel-elbow layout.");
    if (!["x", "y", "z"].includes(axis)) throw Error("Choose a red X, green Y or blue Z crossing axis.");
    if (!Number.isFinite(angle) || angle < 5 || angle > 80) throw Error("Crossing sweep must be between 5° and 80°.");
    const checkCancelled = () => { if (cancelled()) throw Error("Singularity planning cancelled."); };
    checkCancelled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    checkCancelled();
    // Convert the selected world direction into base coordinates. For this layout,
    // the J5 axis is [cos(q1) sin(S), sin(q1) sin(S), -cos(S)], S=q2+q3+q4.
    const base = K.poseMatrix(config.base), row = { x: 0, y: 4, z: 8 }[axis],
      direction = [base[row], base[row + 1], base[row + 2]],
      tilt = Math.acos(Math.max(-1, Math.min(1, -direction[2]))) * DEG,
      azimuth = Math.hypot(direction[0], direction[1]) < 1e-8 ? start[0] : Math.atan2(direction[1], direction[0]) * DEG,
      wrist = config.joints[4], centers = [];
    for (let k = Math.ceil((wrist.min + angle) / 180); k <= Math.floor((wrist.max - angle) / 180); k++)
      centers.push(k * 180);
    centers.sort((a, b) => Math.abs(a - start[4]) - Math.abs(b - start[4]));
    if (!centers.length) throw Error("Wrist limits leave no room to cross alignment. Reduce the sweep.");
    let center = null;
    for (const sign of [1, -1]) {
      const candidate = [...start];
      // Bend a straight elbow to keep this specifically a wrist crossing.
      if (Math.abs(Math.sin(candidate[2] * RAD)) < 0.25)
        candidate[2] = candidate[2] < 0 ? -60 : 60;
      candidate[0] = nearestEquivalent(azimuth + (sign < 0 ? 180 : 0), config.joints[0], start[0]);
      candidate[3] = nearestEquivalent(sign * tilt - candidate[1] - candidate[2], config.joints[3], start[3]);
      candidate[4] = centers[0];
      if (candidate[0] === null || candidate[3] === null) continue;
      try { K.validateJoints(config, candidate); center = candidate; break; } catch {}
    }
    if (!center) throw Error("This crossing axis needs a working pose outside the joint limits. Choose another axis or starting pose.");
    const from = [...center], to = [...center];
    from[4] -= angle;
    to[4] += angle;
    K.validateJoints(config, from); K.validateJoints(config, to);
    const n = 240, path = [];
    for (let i = 0; i <= n; i++) {
      const u = i / n, s = u ** 3 * (10 + u * (-15 + 6 * u)), q = [...center];
      q[4] = from[4] + 2 * angle * s;
      path.push(q);
    }
    const timed = K.timeJointPath(config, [...path, ...path.slice(0, -1).reverse()], { speed, duration }),
      samples = [{ q: [...start], t: 0 }], segments = [];
    let time = 0;
    const append = (segment) => {
      samples.push(...segment.samples.slice(1).map((s) => ({ q: s.q, t: s.t + time })));
      time += segment.duration;
      segments.push(segment);
    };
    append({ ...K.planSegment(config, start, from, { speed, duration: 0.1 }), name: "Set crossing pose" });
    for (let i = 0; i < 2; i++) {
      const at = timed.samples[i * n].t;
      append({ type: "Wrist crossing", name: i ? "Cross back through alignment" : "Cross through alignment",
        duration: timed.samples[(i + 1) * n].t - at,
        samples: timed.samples.slice(i * n, (i + 1) * n + 1).map((s) => ({ q: s.q, t: s.t - at })),
      });
    }
    append({ ...K.planSegment(config, from, start, { speed, duration: 0.1 }), name: "Restore starting pose" });
    checkCancelled();
    const tcp = K.forward(config, center).pose;
    return { samples, segments, duration: time, demo: {
      kind: "singularity", title: "Singularity crossing", axis, angle, center,
      anchorPose: { x: tcp.x, y: tcp.y, z: tcp.z, rx: 0, ry: 0, rz: 0 },
      summary: `Singularity crossing · ${axis.toUpperCase()} rotation · ±${angle}°`,
      detail: "Wrist 2 crosses alignment continuously · tool follows an arc",
    } };
  }
  globalThis.RobotSingularityDemo = { plan };
})();
