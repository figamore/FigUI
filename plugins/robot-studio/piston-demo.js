/* Two straight Cartesian strokes with fixed tool orientation, followed by a
   return to the exact starting joints. No machine commands are sent here. */
(() => {
  "use strict";
  const K = RobotCore;
  async function plan(config, start, { axis = "x", stroke = 30, speed = 1, duration = 12, cancelled = () => false } = {}) {
    K.validateConfig(config);
    start = K.validateJoints(config, start);
    if (!["x", "y", "z"].includes(axis)) throw Error("Choose a piston stroke axis.");
    if (!Number.isFinite(stroke) || stroke < 1 || stroke > 1000)
      throw Error("Piston stroke must be between 1 and 1000 mm.");
    const checkCancelled = () => {
      if (cancelled()) throw Error("Piston planning cancelled.");
    };
    checkCancelled();
    const ready = [...start];
    // A straight elbow is at the reach boundary: sideways motion with fixed
    // orientation is impossible there. An explicit setup bend makes room.
    // The shoulder, elbow and wrist-1 axes are parallel; keeping their sum constant
    // preserves tool orientation throughout this joint-space setup move.
    if (K.isParallelElbowLayout(config) && Math.abs(start[2]) < 20) {
      const bend = start[2] < 0 ? -40 : 40;
      ready[1] -= bend / 2;
      ready[2] += bend;
      ready[3] -= bend / 2;
      try { K.validateJoints(config, ready); }
      catch { throw Error("Piston setup exceeds joint limits. Start from a bent arm pose."); }
    }
    const origin = K.forward(config, ready).tcp,
      offset = { x: 3, y: 7, z: 11 }[axis],
      travel = axis === "z" ? -stroke : stroke,
      n = Math.max(120, Math.ceil(stroke * 2)),
      outward = [[...ready]];
    let seed = ready, maxError = 0, maxOrientationError = 0;
    for (let i = 1; i <= n; i++) {
      if (i % 12 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        checkCancelled();
      }
      const u = i / n, s = u ** 3 * (10 + u * (-15 + 6 * u)),
        target = [...origin];
      target[offset] += travel * s;
      const result = K.inverse(config, target, seed, {
        restarts: false, iterations: 120, positionTolerance: 0.005, orientationTolerance: 0.01,
      });
      if (!result.ok || Math.max(...K.sub(result.q, seed).map(Math.abs)) > 2)
        throw Error("Piston stroke cannot be reached smoothly from this pose. Try a shorter stroke or a more bent arm.");
      // Check the actual joint-linear interpolation sent to FluidNC, including
      // orientation and distance from the requested Cartesian line segment.
      for (const t of [0.25, 0.5, 0.75, 1]) {
        const q = seed.map((v, j) => v + (result.q[j] - v) * t), f = K.forward(config, q).tcp,
          onLine = [...origin];
        const fraction = Math.max(0, Math.min(1, (f[offset] - origin[offset]) / travel));
        onLine[offset] += travel * fraction;
        maxError = Math.max(maxError, K.norm(K.sub(K.position(f), K.position(onLine))));
        maxOrientationError = Math.max(maxOrientationError, K.norm(K.rotationError(origin, f)) * 180 / Math.PI);
      }
      if (maxError > 0.05 || maxOrientationError > 0.05)
        throw Error("Piston stroke exceeds the straight-line tolerance. Try a shorter stroke or another pose.");
      outward.push(result.q);
      seed = result.q;
    }
    checkCancelled();
    const back = [...outward].reverse(),
      wave = [...outward, ...back.slice(1), ...outward.slice(1), ...back.slice(1)],
      timed = K.timeJointPath(config, wave, { speed, duration }),
      segments = [], samples = [{ q: [...start], t: 0 }];
    let time = 0;
    const append = (segment) => {
      samples.push(...segment.samples.slice(1).map((s) => ({ q: s.q, t: time + s.t })));
      time += segment.duration;
      segments.push(segment);
    };
    const setup = K.norm(K.sub(ready, start)) > 1e-6;
    if (setup) append({ ...K.planSegment(config, start, ready, { speed, duration: 0.1 }), name: "Piston · Set working pose" });
    for (let i = 0; i < 4; i++) {
      const at = timed.samples[i * n].t;
      append({
        name: `Piston · ${i % 2 ? "Return" : "Stroke"} ${Math.floor(i / 2) + 1}`,
        type: "MoveL",
        duration: timed.samples[(i + 1) * n].t - at,
        samples: timed.samples.slice(i * n, (i + 1) * n + 1).map((s) => ({ q: s.q, t: s.t - at })),
      });
    }
    if (setup) append({ ...K.planSegment(config, ready, start, { speed, duration: 0.1 }), name: "Piston · Restore starting pose" });
    checkCancelled();
    return { samples, segments, duration: time, demo: {
      kind: "piston", title: "Piston", axis, stroke, setup, origin, travel,
      maxError, maxOrientationError,
      summary: `Piston · ${stroke} mm ${axis.toUpperCase()} stroke · two cycles`,
      detail: "Straight tool-tip stroke · orientation stays fixed",
    } };
  }
  globalThis.RobotPistonDemo = { plan };
})();
