/* Continuous absolute joint goals. Serialized WebSocket sends, at most two
   collinear endpoints in the planner, and explicit cancel before retarget. */
(() => {
  "use strict";
  const K = RobotCore,
    EPS = 0.02;
  function goal(config, actual, joint, angle, speed) {
    K.validateJoints(config, actual);
    if (!Number.isInteger(joint) || joint < 0 || joint > 5)
      throw Error("Select a joint.");
    const q = [...actual];
    q[joint] = angle;
    K.validateJoints(config, q);
    if (!Number.isFinite(speed) || speed < 0.01 || speed > 1)
      throw Error("Invalid live speed.");
    if (Math.abs(angle - actual[joint]) <= EPS) return null;
    const j = config.joints[joint],
      feed = j.velocity * speed * Math.abs(j.scale) * 60;
    // Single-axis jog: changing one joint cannot command a stale pose on another.
    return {
      joint,
      angle,
      q,
      speed,
      direction: Math.sign(angle - actual[joint]),
      command: `$J=G53 G90 G21 ${j.axis}${(angle * j.scale + j.zero).toFixed(5)} F${feed.toFixed(4)}`,
    };
  }
  function create({
    getConfig,
    getState,
    send,
    cancel,
    onStop = () => {},
    now = () => performance.now(),
  }) {
    let active = false,
      pending = false,
      cancelling = 0,
      queue = [],
      target = null,
      generation = 0,
      drain = null,
      lastSend = -Infinity;
    function state() {
      const s = getState();
      if (!s.enabled)
        throw Error(
          "Enable calibrated axis mapping and record the manual reference first.",
        );
      if (!s.at || now() - s.at >= 2000)
        throw Error("Live control stopped: machine telemetry is stale.");
      if (!["Idle", "Jog"].includes(s.state))
        throw Error(
          `Live control stopped: machine is ${s.state || "offline"}.`,
        );
      K.validateJoints(getConfig(), s.q);
      return s;
    }
    async function cancelMotion() {
      cancelling++;
      try {
        await cancel();
      } catch (e) {
        active = false;
        target = null;
        queue = [];
        drain = null;
        generation++;
        onStop(`Jog cancel failed: ${e.message}`);
      } finally {
        cancelling--;
      }
    }
    function cancelForRetarget() {
      if (drain) return;
      const marker = { after: now(), started: now() };
      drain = marker;
      queue = [];
      generation++;
      void cancelMotion().then(() => {
        if (drain === marker) marker.after = now();
      });
    }
    function stop(reason = "") {
      const wasActive = active,
        hadMotion = pending || queue.length > 0;
      active = false;
      target = null;
      queue = [];
      drain = null;
      generation++;
      if (hadMotion) void cancelMotion();
      if (wasActive) onStop(reason);
    }
    function incompatible(s, tail) {
      return (
        target &&
        (target.joint !== tail.joint ||
          tail.speed !== s.speed ||
          tail.direction * (target.angle - tail.angle) < -EPS)
      );
    }
    return {
      get active() {
        return active;
      },
      get busy() {
        return pending || queue.length > 0 || cancelling > 0 || !!drain;
      },
      start() {
        if (active) return [...state().q];
        if (pending || cancelling)
          throw Error(
            "Wait for the previous live command to finish cancelling.",
          );
        const s = state();
        if (s.state !== "Idle")
          throw Error("Machine must be Idle to start live control.");
        target = null;
        queue = [];
        drain = null;
        active = true;
        generation++;
        lastSend = -Infinity;
        return [...s.q];
      },
      setTarget(joint, angle, { jog = false } = {}) {
        if (!active) throw Error("Live joint control is disabled.");
        const s = state();
        goal(getConfig(), s.q, joint, angle, s.speed);
        target = { joint, angle, jog }; // Latest input replaces every unsent destination.
        if (queue.length && incompatible(s, queue.at(-1))) cancelForRetarget();
      },
      release() {
        target = null;
        if (queue.length || pending) cancelForRetarget();
      },
      stop,
      async tick() {
        if (!active) return;
        try {
          const s = state();
          if (drain) {
            if (now() - drain.started > 5000)
              throw Error(
                "Live control stopped: jog cancellation did not finish.",
              );
            if (
              pending ||
              cancelling ||
              s.state !== "Idle" ||
              s.at <= drain.after
            )
              return;
            drain = null;
            lastSend = -Infinity;
          }
          if (pending || cancelling) return;
          // Passing a queued endpoint keeps the next collinear move running.
          while (
            queue.length > 1 &&
            s.at > queue[0].sentAt &&
            queue[0].direction * (s.q[queue[0].joint] - queue[0].angle) >= -EPS
          )
            queue.shift();
          if (queue.length) {
            const first = queue[0];
            if (
              s.at > first.sentAt &&
              s.state === "Idle" &&
              Math.abs(s.q[first.joint] - first.angle) <= EPS &&
              queue.length === 1
            ) {
              queue = [];
              if (
                target?.joint === first.joint &&
                Math.abs(target.angle - first.angle) <= EPS
              )
                target = null;
            } else {
              if (Math.abs(s.q[first.joint] - first.lastPosition) > 0.005) {
                first.lastPosition = s.q[first.joint];
                first.progressAt = now();
              }
              if (now() - first.progressAt > 5000)
                throw Error(
                  "Live control stopped: the joint is not making progress.",
                );
            }
          }
          if (queue.length && incompatible(s, queue.at(-1))) {
            cancelForRetarget();
            return;
          }
          if (!queue.length && s.state !== "Idle")
            throw Error("Live control stopped: another jog is active.");
          if (!target || queue.length >= 2 || now() - lastSend < 120) return;
          const tail = queue.at(-1);
          if (tail && Math.abs(target.angle - tail.angle) <= EPS) return;
          const from = tail ? tail.q : s.q;
          // Hold buttons feed finite collinear jogs ahead of the moving arm.
          // Two seconds per endpoint bridges the status/command round trip while
          // keeping a bounded amount of motion in the planner.
          const j = getConfig().joints[target.joint];
          const destination = target.jog
            ? from[target.joint] +
              K.clamp(
                target.angle - from[target.joint],
                -j.velocity * s.speed * 2,
                j.velocity * s.speed * 2,
              )
            : target.angle;
          const next = goal(
            getConfig(),
            from,
            target.joint,
            destination,
            s.speed,
          );
          if (!next) {
            target = null;
            return;
          }
          const stamp = generation;
          lastSend = now();
          pending = true;
          queue.push({
            ...next,
            sentAt: now(),
            progressAt: now(),
            lastPosition: s.q[next.joint],
          });
          try {
            const response = await send(next.command);
            if (
              typeof response === "string" &&
              /^(error:|ALARM:)/im.test(response)
            )
              throw Error(response.trim());
            if (stamp !== generation || !active) {
              await cancelMotion();
              if (drain) drain.after = now();
            }
          } catch (error) {
            // Release/retarget can cancel a native bridge request while it is
            // still waiting to send. Its late rejection belongs to the old
            // destination, not the current live session. Keep waiting for Idle.
            if (
              (stamp !== generation || !active) &&
              /^(?:Error:\s*)?Jog cancel(?:led|ed)$/i.test(error.message)
            ) return;
            throw error;
          } finally {
            pending = false;
          }
        } catch (e) {
          stop(e.message);
        }
      },
    };
  }
  globalThis.RobotLiveControl = { goal, create };
})();
