/* Single-pass execution through the host streamer or a verified SD file.
   Position reports track progress; SD markers distinguish completion from Idle. */
(() => {
  "use strict";
  const K = RobotCore,
    SD_PATH = "/robot-studio.nc",
    closePose = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 0.25);
  function sdFile(gcode) {
    // The tag identifies messages, never file equality: reuse compares the
    // complete stored contents, including geometry, timing and gripper code.
    let hash = 2166136261;
    for (let i = 0; i < gcode.length; i++) hash = Math.imul(hash ^ gcode.charCodeAt(i), 16777619);
    const tag = `ROBOT_STUDIO_${(hash >>> 0).toString(16).toUpperCase()}`;
    return { tag, content: `(MSG,${tag}_START)\n${gcode.replace(/M2\n$/, `G4 P0\n(MSG,${tag}_DONE)\nM2\n`)}` };
  }
  function progress(plan, actual, cursor = 0) {
    // Search forward locally, preferring the earliest equally close sample.
    // This avoids jumping to a later visit to the same pose in a cyclic path.
    let best = cursor,
      distance = Infinity;
    for (let i = cursor; i < Math.min(plan.samples.length, cursor + 161); i++) {
      const d = plan.samples[i].q.reduce((sum, v, j) => sum + (v - actual[j]) ** 2, 0);
      if (d < distance - 1e-8) { best = i; distance = d; }
    }
    const time = plan.samples[best].t;
    let boundary = 0,
      move = plan.segments.length - 1;
    for (let i = 0; i < plan.segments.length; i++) {
      boundary += plan.segments[i].duration;
      if (time < boundary - 1e-6) { move = i; break; }
    }
    return { cursor: best, move, percent: Math.min(99, 100 * time / plan.duration) };
  }
  function create({ call, getState, onUpdate = () => {}, now = () => performance.now() }) {
    let generation = 0,
      startPending = false,
      streamJobId = null,
      streamPhase = null,
      completedAt = 0,
      source = "stream",
      sdTag = "",
      sdStartSent = false,
      sdStartedAt = 0,
      sdConfirmed = false,
      sdFinishedAt = null,
      sdIdleSince = null,
      model = null,
      state = { active: false, phase: "idle", plan: null, percent: 0, move: 0, cursor: 0, error: "" };
    const publish = (patch) => { state = { ...state, ...patch }; onUpdate(state); };
    const ownedJob = () => streamJobId == null ? {} : { jobId: streamJobId };
    const abortMotion = () => source === "sd"
      ? sdStartSent && void call("sendRealtime", { byte: 0x18 }).catch(() => {})
      : void call("stopProgramStream", ownedJob()).catch(() => {});
    function fresh() {
      const s = getState();
      if (!s.at || now() - s.at >= 2000) throw Error("Fresh machine telemetry is required.");
      if (!s.referenced) throw Error("Record the manual home reference first.");
      return s;
    }
    function idlePose() {
      const s = fresh();
      if (s.status.state !== "Idle" || s.status.sdFilename)
        throw Error("The controller must be Idle with no other program open.");
      return K.machineJoints(model, s.status);
    }
    function fail(error, reset = false, abort = false) {
      generation++;
      publish({ active: false, phase: "error", error: String(error), reset });
      if (abort) abortMotion();
    }
    async function prepareSd(gcode, stamp) {
      const file = sdFile(gcode);
      sdTag = file.tag;
      let stored;
      try { stored = await call("readFile", { path: SD_PATH, fs: "sd", fresh: true }); }
      catch (error) { if (!/\bHTTP 404\b/.test(error.message)) throw error; }
      if (stamp !== generation) return;
      if (stored === file.content) return true;
      idlePose();
      publish({ phase: "saving" });
      await call("writeFile", { path: SD_PATH, fs: "sd", content: file.content });
      if (stamp !== generation) return;
      const verified = await call("readFile", { path: SD_PATH, fs: "sd", fresh: true });
      if (stamp !== generation) return;
      if (verified !== file.content) throw Error("The SD file did not match after saving. The program was not started.");
      return false;
    }
    function tickSd(s, actual) {
      const status = s.status;
      if (status.sdFilename) {
        const path = `/${status.sdFilename.replace(/^\/?sd\//i, "").replace(/^\//, "")}`;
        if (path !== SD_PATH) {
          fail("Another SD program is active. Robot Studio no longer owns execution.");
          return;
        }
        sdConfirmed = true;
      }
      if (sdFinishedAt !== null && s.at > sdFinishedAt && status.state === "Idle" && !status.sdFilename) {
        if (!closePose(actual, state.plan.samples.at(-1).q)) {
          fail("The SD program ended before reaching its final waypoint.");
          return;
        }
        publish({ active: false, phase: "completed", percent: 100, move: state.plan.segments.length - 1 });
        return;
      }
      if (!sdConfirmed && now() - sdStartedAt > 10000) {
        fail("The controller did not confirm the SD program start. It will not be retried automatically.", true, true);
        return;
      }
      if (sdConfirmed && sdFinishedAt === null && status.state === "Idle" && !status.sdFilename) {
        sdIdleSince ??= now();
        if (now() - sdIdleSince > 3000) {
          fail("The SD program stopped without its completion marker. Check the controller before running again.");
          return;
        }
      } else sdIdleSince = null;
      const phase = ["Hold", "Door"].includes(status.state) ? "paused"
        : sdConfirmed && status.state === "Run" ? "running" : state.phase;
      publish({ ...progress(state.plan, actual, state.cursor), phase });
    }
    function tick() {
      if (!state.active || startPending || (source === "stream" ? streamJobId == null : !sdStartSent)) return;
      const s = getState();
      // The host sender handles disconnects and acknowledgement failures. A
      // backgrounded iframe may briefly receive old telemetry when it wakes.
      if (!s.at || now() - s.at >= 2000) return;
      try {
        if (!s.referenced) throw Error("The robot reference changed during the program.");
        const status = s.status;
        if (!["Idle", "Run", "Hold", "Door"].includes(status.state))
          throw Error(`Program stopped: controller is ${status.state}.`);
        const actual = K.machineJoints(model, status);
        if (source === "sd") { tickSd(s, actual); return; }
        if (streamPhase === "completed") {
          // Require a position report newer than the sender's completion event.
          if (s.at <= completedAt || status.state !== "Idle" || status.sdFilename) return;
          if (!closePose(actual, state.plan.samples.at(-1).q)) {
            fail("Program ended before reaching its final waypoint.");
            return;
          }
          publish({ active: false, phase: "completed", percent: 100, move: state.plan.segments.length - 1 });
          return;
        }
        const phase = ["Hold", "Door"].includes(status.state) ? "paused"
          : state.phase === "starting" && status.state === "Run" ? "running" : state.phase;
        publish({ ...progress(state.plan, actual, state.cursor), phase });
      } catch (error) {
        fail(error.message, true, true);
      }
    }
    function stream(snapshot) {
      if (!state.active || streamJobId == null || snapshot?.jobId !== streamJobId) return;
      if (snapshot.phase === "idle") return;
      const firstCompletion = streamPhase !== "completed";
      streamPhase = snapshot.phase;
      if (snapshot.phase === "error") {
        fail(snapshot.error || "The G-code stream failed.", !!snapshot.reset);
      } else if (snapshot.phase === "aborted") {
        publish({ active: false, phase: "stopped", reset: true });
      } else if (snapshot.phase === "completed") {
        if (firstCompletion) {
          completedAt = now();
          void call("sendRealtime", { byte: 0x3f }).catch(() => {});
        }
      } else if (snapshot.phase === "paused") {
        publish({ phase: "paused" });
      } else if (["streaming", "draining"].includes(snapshot.phase)) {
        publish({ phase: snapshot.phase === "streaming" && snapshot.acceptedLine == null ? "starting" : "running" });
      }
    }
    return {
      get active() { return state.active; },
      get busy() { return state.active || startPending; },
      get state() { return state; },
      clear() {
        if (state.active || startPending || state.phase === "idle") return;
        publish({ phase: "idle", plan: null, percent: 0, move: 0, cursor: 0, error: "", reset: false });
      },
      async run(config, plan, { source: requestedSource = "stream", saveOnly = false } = {}) {
        if (state.active || startPending) throw Error("A program is already active.");
        model = K.validateConfig(config);
        if (!plan?.samples?.length || !plan.segments?.length) throw Error("Plan a program first.");
        if (!closePose(idlePose(), plan.samples[0].q))
          throw Error("The physical robot does not match the planned start pose. Plan from its reported position.");
        if (!["stream", "sd"].includes(requestedSource)) throw Error("Unknown program source.");
        if (saveOnly && requestedSource !== "sd") throw Error("Save-only requires SD storage.");
        source = requestedSource;
        sdStartSent = false;
        sdConfirmed = false;
        sdFinishedAt = sdIdleSince = null;
        const stamp = ++generation;
        streamJobId = null;
        streamPhase = null;
        startPending = true;
        publish({ active: true, startPending: true, source, phase: source === "sd" ? "checking" : "starting", plan, percent: 0, cursor: 0, move: 0, error: "", reset: false });
        try {
          const gcode = K.exportGcode(model, plan);
          const startPosition = model.joints.map((joint, i) => ({
              axis: joint.axis,
              position: plan.samples[0].q[i] * joint.scale + joint.zero,
              tolerance: Math.abs(joint.scale) * 0.25,
            }));
          if (source === "sd") {
            const reused = await prepareSd(gcode, stamp);
            if (stamp !== generation || !state.active) return;
            if (saveOnly) {
              publish({ active: false, phase: "saved", sdReused: reused });
              return;
            }
            if (!closePose(idlePose(), plan.samples[0].q))
              throw Error("The machine moved while preparing the SD file. Plan again from its current position.");
            publish({ phase: "starting", sdReused: reused });
            sdStartedAt = now();
            sdStartSent = true;
            let result;
            try { result = await call("startProgramFile", { path: SD_PATH, startPosition }); }
            catch (error) {
              // A host rejection proves it did not dispatch. Only a lost reply
              // is ambiguous; do not reset another job that made the host busy.
              if (stamp === generation && !/timed out/i.test(error.message)) sdStartSent = false;
              throw error;
            }
            if (stamp !== generation || !state.active) { abortMotion(); return; }
            if (!result?.started) throw Error("The host did not confirm the SD start request.");
            void call("sendRealtime", { byte: 0x3f }).catch(() => {});
            return;
          }
          const snapshot = await call("startProgramStream", {
            gcode, startPosition,
          });
          if (stamp !== generation || !state.active) {
            if (snapshot?.jobId != null)
              await call("stopProgramStream", { jobId: snapshot.jobId });
            return;
          }
          if (snapshot?.jobId == null) throw Error("The host did not confirm the stream start.");
          streamJobId = snapshot.jobId;
          stream(snapshot);
        } catch (error) {
          if (error.message === "Unknown method: startProgramFile") sdStartSent = false;
          const reason = /^Unknown method: startProgram(?:Stream|File)$/.test(error.message)
            ? "Update FluidUI and Robot Studio together to enable this execution mode."
            : error.message;
          if (stamp === generation) {
            fail(reason, source === "sd" && sdStartSent);
            // Also cancel an accepted start whose response was lost; never retry.
            abortMotion();
          }
          throw Error(reason);
        } finally {
          startPending = false;
          publish({ startPending: false });
        }
      },
      tick,
      stream,
      line(line) {
        if (source !== "sd" || !state.active || !sdStartSent) return;
        if (/^(?:error\b|ALARM:|\[MSG:ERR)/i.test(line)) { fail(line, true, true); return; }
        if (!line.startsWith("[MSG:")) return;
        if (line.includes(`${sdTag}_START`)) sdConfirmed = true;
        if (line.includes(`${sdTag}_DONE`)) {
          sdConfirmed = true;
          sdFinishedAt = now();
          void call("sendRealtime", { byte: 0x3f }).catch(() => {});
        }
      },
      connectionChanged() {
        if (source === "sd" && (state.active || startPending)) {
          // A late reply must not reset a newly connected controller.
          sdStartSent = false;
          fail("Controller connection changed. Check the SD job on the controller before running again.", true);
        }
      },
      controlTaken() {
        if (source !== "sd" || (!state.active && !startPending)) return;
        if (sdStartSent) void call("sendRealtime", { byte: 0x21 }).catch(() => {});
        sdStartSent = false;
        fail("Another client took control. Check the controller's SD job before continuing.");
      },
      async pause() {
        if (!state.active || state.phase === "paused") return;
        if (source === "sd") {
          if (!sdStartSent) return;
          const stamp = generation;
          await call("sendRealtime", { byte: 0x21 });
          if (stamp === generation && state.active) publish({ phase: "pausing" });
          return;
        }
        if (streamJobId == null) return;
        stream(await call("pauseProgramStream", ownedJob()));
      },
      async resume() {
        if (!state.active || state.phase !== "paused") return;
        if (fresh().status.state === "Door") throw Error("Close the safety door before resuming.");
        if (source === "sd") {
          const stamp = generation;
          await call("sendRealtime", { byte: 0x7e });
          if (stamp === generation && state.active) publish({ phase: "resuming" });
          return;
        }
        if (streamJobId == null) return;
        stream(await call("resumeProgramStream", ownedJob()));
      },
      stop() {
        if (!state.active && !startPending) return;
        generation++;
        publish({ active: false, phase: "stopped", reset: source === "sd" ? sdStartSent : streamJobId != null });
        abortMotion();
      },
    };
  }
  globalThis.RobotProgramControl = { create, progress, sdFile, SD_PATH };
})();
