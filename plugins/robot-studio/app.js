(() => {
  "use strict";
  const K = RobotCore,
    $ = (id) => document.getElementById(id),
    embedded = window.parent !== window;
  const poseKeys = ["x", "y", "z", "rx", "ry", "rz"],
    jointNames = [
      "Base",
      "Shoulder",
      "Elbow",
      "Wrist 1",
      "Wrist 2",
      "Tool flange",
    ];
  let config = K.defaultConfig(),
    endEffector = K.validateEndEffector(),
    gripperState = "open",
    lastManualGripperAction = "open",
    endEffectorBusy = false,
    programMaximums = true,
    programSource = "stream",
    machinePlanCache = null,
    jogMaximums = true,
    q = config.joints.map((j) => j.home),
    points = [],
    viewer = null,
    plan = null,
    displayedPlan = null,
    playback = null;
  let status = null,
    statusAt = 0,
    positionRequestAt = -Infinity,
    revision = 0,
    holding = false,
    jogGeneration = 0,
    frames = false,
    showPath = true,
    referenced = false,
    referenceReason = "",
    homeViewer = null,
    configViewer = null,
    configPreviewFrame = null,
    configPreviewGeneration = 0,
    configPreviewModel = null,
    configPreviewKey = "d1",
    configPreviewView = "perspective",
    reportedQ = null,
    directJog = null,
    liveAfterReference = false,
    runAfterReference = false,
    demoAfterReference = false,
    programPreparing = false,
    programRequestGeneration = 0,
    programPhase = "idle",
    preparingLabel = "Planning from reported position…",
    displayedDemoPlan = null,
    controllerSettings = {},
    controllerLimitsLoading = false,
    controllerLimitsRequest = null,
    controllerLimitsError = "",
    restoringSettings = false;
  let controllerSession = null, restoringReference = false,
    recoveryPending = false, recoveryGeneration = null, recoveryRevision = null,
    startupRestorePending = embedded, startupRestoreRevision = 0;
  let jointRose = null, wristRose = null, cartesianRose = null,
    cartesianGroup = 0, roseHold = true, configuredRoseHold = null,
    livePreferred = embedded, liveFault = false, liveEnding = null;
  let tcpJogEnabled = false, tcpDrag = null, tcpDragUpdating = false;
  let tcpPushEnabled = false, tcpPushShift = false;
  let tcpJogJoint = -1;
  let jogFrame = "tool";
  let projectVersion = 0,
    savedVersion = 0,
    hasSavedProject = false,
    savingProject = false,
    saveFailed = false;
  const browserProjectKey = "figui.robot-studio.workspace.v1";
  let browserSaveWarning = false, browserSavePending = false;
  const pointUndo = [], pointRedo = [];
  function renderSaveState() {
    const dirty = projectVersion !== savedVersion;
    $("project-save-state").textContent = savingProject ? "Saving…" : saveFailed ? "Save failed" : dirty ? "Unsaved changes" : hasSavedProject ? "All changes saved" : "New project";
    $("project-save-state").classList.toggle("dirty", dirty || saveFailed);
    $("save-project").disabled = savingProject || restoringSettings;
    $("save-project").textContent = savingProject ? "Saving…" : "Save project";
    $("save-project").setAttribute("aria-busy", String(savingProject));
  }
  function projectChanged() {
    projectVersion++;
    renderSaveState();
    void rememberReference().catch(() => {});
    rememberBrowserProject();
  }
  function rememberBrowserProject() {
    if (browserSavePending) return;
    browserSavePending = true;
    // Waypoint edits mark the project dirty before mutating the list. Save
    // once the current edit finishes, coalescing its synchronous changes.
    queueMicrotask(() => {
      browserSavePending = false;
      writeBrowserProject();
    });
  }
  function writeBrowserProject() {
    const data = {
      project: project(), projectVersion, savedVersion, hasSavedProject,
    };
    try {
      const text = JSON.stringify(data);
      const saved = embedded
        ? call("setLocalState", { data: JSON.parse(text) })
        : localStorage.setItem(browserProjectKey, text);
      Promise.resolve(saved).catch(browserSaveFailed);
    } catch (error) { browserSaveFailed(error); }
  }
  function browserSaveFailed() {
    if (browserSaveWarning) return;
    browserSaveWarning = true;
    message("Automatic browser saving is unavailable. Use Save project or Export JSON to keep your setup.", true);
  }
  async function readBrowserProject() {
    try {
      const raw = embedded
        ? await call("getLocalState")
        : JSON.parse(localStorage.getItem(browserProjectKey) || "null");
      if (!raw?.project) return null;
      return { ...raw, project: K.validateProject(raw.project) };
    } catch { return null; } // Missing, corrupt or unavailable storage falls back to the saved project.
  }
  function rememberPoints() {
    pointUndo.push(structuredClone(points));
    if (pointUndo.length > 30) pointUndo.shift();
    pointRedo.length = 0;
    projectChanged();
  }
  function restorePoints(from, to) {
    if (programPreparing || program.busy || !from.length) return;
    stopPreview();
    to.push(structuredClone(points));
    points = from.pop();
    projectChanged();
    invalidate();
    renderPoints();
    message(`${from === pointUndo ? "Undid" : "Redid"} waypoint edit · ${points.length} waypoints.`);
  }
  function confirmReplacement(title, description, label) {
    const dialog = $("replace-dialog");
    $("replace-title").textContent = title;
    $("replace-description").textContent = description;
    $("replace-confirm").textContent = label;
    dialog.returnValue = "cancel";
    return new Promise((resolve) => {
      dialog.addEventListener("close", () => resolve(dialog.returnValue === "replace"), { once: true });
      dialog.showModal();
    });
  }
  function referenceKey(model = config) {
    // Calibration maps machine coordinates to joint angles. Editing the TCP,
    // link lengths, travel limits or speeds does not change that mapping.
    return JSON.stringify(model.joints.map(
      ({ offset, home, axis, scale }) => ({ offset, home, axis, scale }),
    ));
  }
  async function rememberReference() {
    if (!embedded || !controllerSession || !referenced) return;
    await call("setSessionState", {
      generation: controllerSession.generation,
      data: {
        key: referenceKey(), zeros: config.joints.map((j) => j.zero),
        project: project(), projectVersion, savedVersion, hasSavedProject,
      },
    });
  }
  function clearReference(reason = "Robot calibration or loaded project changed.", { recoverable = false } = {}) {
    if (referenced || !referenceReason) referenceReason = reason;
    referenced = false;
    reportedQ = null;
    $("enable-machine").checked = false;
    if (controllerSession) controllerSession = { ...controllerSession, data: null,
      recovery: recoverable ? controllerSession.recovery : null };
    if (embedded && controllerSession && !recoverable)
      void call("setSessionState", { generation: controllerSession.generation, data: null }).catch(() => {});
  }
  function recoveryConfig(session = controllerSession) {
    const saved = session?.recovery;
    if (saved?.key !== referenceKey() || !Array.isArray(saved.zeros) || saved.zeros.length !== 6 || !saved.zeros.every(Number.isFinite)) return null;
    try {
      return K.validateConfig({ ...config, joints: config.joints.map((j, i) => ({ ...j, zero: saved.zeros[i] })) });
    } catch { return null; }
  }
  function renderRecovery() {
    if (!$("recover-dialog").open) return;
    let angles = null;
    try {
      const model = recoveryConfig();
      if (model && referenceAvailable()) angles = K.machineJoints(model, status);
    } catch {}
    const unchanged = recoveryGeneration === controllerSession?.generation && recoveryRevision === revision;
    $("recover-angles").textContent = angles
      ? angles.map((value, i) => `J${i + 1}: ${value.toFixed(2)}°`).join(" · ")
      : "Waiting for valid, stationary machine coordinates.";
    $("confirm-recovery").disabled = recoveryPending || !unchanged || !angles || !$("recovery-confirmed").checked;
    document.querySelectorAll('[data-close="recover-dialog"]').forEach((button) => { button.disabled = recoveryPending; });
    if (!unchanged) $("recover-error").textContent = "The controller session or robot setup changed. Close this dialog and check the reference again.";
  }
  async function openReferenceRecovery() {
    if (program.busy || programPreparing || endEffectorBusy || restoringSettings)
      throw Error("Wait for the current operation before recovering the reference.");
    const session = await call("getSessionState");
    if (controllerSession && session.generation < controllerSession.generation) return;
    controllerSession = session;
    if (!recoveryConfig()) throw Error("No compatible reference is available to recover. Set the manual reference.");
    live.stop();
    stopPreview();
    cancelJog();
    recoveryGeneration = session.generation;
    recoveryRevision = revision;
    $("recovery-confirmed").checked = false;
    $("recover-error").textContent = "";
    $("recover-dialog").showModal();
    requestFreshPosition();
    renderRecovery();
  }
  async function recoverReference() {
    if (recoveryPending || !$("recovery-confirmed").checked) return;
    recoveryPending = true;
    renderRecovery();
    try {
      const session = await call("getSessionState");
      if (session.generation !== recoveryGeneration || revision !== recoveryRevision ||
          (controllerSession && controllerSession.generation !== session.generation))
        throw Error("The controller session or robot setup changed. Check the reference again.");
      if (program.busy || programPreparing || endEffectorBusy || live.active || live.busy || holding || !referenceAvailable())
        throw Error("Fresh Idle coordinates with no active motion are required.");
      const next = recoveryConfig(session);
      if (!next) throw Error("The recovery reference is no longer available.");
      K.machineJoints(next, status); // Validate all axes and joint limits before accepting.
      await call("setSessionState", { generation: session.generation, data: {
        ...session.recovery, project: { ...project(), config: next },
        projectVersion, savedVersion, hasSavedProject,
      } });
      // Neither a delayed reply nor a disconnected frame may restore permission.
      if (controllerSession?.generation !== session.generation || revision !== recoveryRevision || !referenceAvailable())
        throw Error("Feedback changed during recovery. Check the reference again.");
      const offsetsChanged = config.joints.some((joint, i) => joint.zero !== next.joints[i].zero);
      config = next;
      controllerSession = { ...session, data: session.recovery, recovery: null };
      referenced = true;
      referenceReason = "";
      livePreferred = false;
      liveFault = false;
      $("enable-machine").checked = false;
      $("follow-machine").checked = true;
      reportedQ = K.machineJoints(config, status);
      setPose(reportedQ, { edit: false });
      currentTarget();
      invalidate();
      if (offsetsChanged) projectChanged();
      else rememberBrowserProject();
      $("recover-dialog").close();
      updateMachine();
      message("Previous reference recovered from machine coordinates. No motion sent; choose Live joints when ready.");
    } catch (error) { $("recover-error").textContent = error.message; }
    finally { recoveryPending = false; renderRecovery(); }
  }
  async function restoreReference() {
    if (!embedded || restoringReference || referenced) return;
    restoringReference = true;
    const stamp = revision;
    try {
      const session = await call("getSessionState");
      if (!session || (controllerSession && session.generation < controllerSession.generation)) return;
      controllerSession = session;
      if (stamp !== revision || referenced || live.active || program.busy) return;
      const saved = session.data;
      if (saved?.key !== referenceKey() || !Array.isArray(saved.zeros) || saved.zeros.length !== 6 || !saved.zeros.every(Number.isFinite)) return;
      const next = K.validateConfig({ ...config, joints: config.joints.map((j, i) => ({ ...j, zero: saved.zeros[i] })) });
      if (!statusAt || performance.now() - statusAt >= 2000 || status?.state !== "Idle") return;
      reportedQ = K.machineJoints(next, status);
      config = next;
      referenced = true;
      referenceReason = "";
      if (livePreferred) {
        $("follow-machine").checked = true;
        setPose(reportedQ, { edit: false });
        currentTarget();
      }
      updateMachine();
    } catch { /* Older FigUI builds keep references within the open plugin. */ }
    finally { restoringReference = false; }
  }
  function retrySessionRestore() {
    if (!embedded || restoringSettings || !statusAt || performance.now() - statusAt >= 2000 || status?.state !== "Idle") return;
    if (startupRestorePending) {
      startupRestorePending = false;
      if (revision === startupRestoreRevision)
        void restoreProject({ fromSession: true }).catch((error) => message(error.message, true));
      return;
    }
    if (!referenced && controllerSession?.data?.key === referenceKey() && !program.busy && !programPreparing)
      void restoreReference();
  }
  const motionConfig = () => jogMaximums
    ? RobotMotionSettings.applyMaximums(config, controllerSettings)
    : RobotMotionSettings.cappedConfig(config, controllerSettings);
  const programMotionConfig = () => programMaximums
    ? RobotMotionSettings.applyMaximums(config, controllerSettings)
    : RobotMotionSettings.cappedConfig(config, controllerSettings);
  const pending = new Map();
  const requestSession = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let requestId = 0;
  function call(method, params = {}) {
    if (!embedded)
      return Promise.reject(
        Error("Open this plugin in FigUI to access the controller."),
      );
    return new Promise((resolve, reject) => {
      const id = `robot-${requestSession}-${++requestId}`,
        timeout = setTimeout(() => {
          pending.delete(id);
          reject(Error(`${method} timed out.`));
        }, ["getSettings", "saveSettings", "readFile", "writeFile"].includes(method) ? 120000 : 6000);
      pending.set(id, { resolve, reject, timeout });
      parent.postMessage({ type: "fluid-request", id, method, params }, "*");
    });
  }
  const jogTransport = RobotJogTransport.create({
    call,
    canSend: () =>
      live.active &&
      referenced &&
      $("enable-machine").checked &&
      !document.hidden &&
      statusAt &&
      performance.now() - statusAt < 2000 &&
      ["Idle", "Jog"].includes(status?.state),
  });
  const live = RobotLiveControl.create({
    getConfig: motionConfig,
    getState: () => ({
      enabled: referenced && $("enable-machine").checked && !document.hidden,
      q: K.machineJoints(config, status),
      state: status?.state,
      at: statusAt,
      speed: Number($("speed").value) / 100,
    }),
    send: jogTransport.send,
    cancel: jogTransport.cancel,
    onStop: (reason) => {
      const ending = jogTransport.end().catch(() => {});
      liveEnding = ending;
      void ending.then(() => {
        if (liveEnding === ending) liveEnding = null;
      });
      directJog = null;
      jointRose?.cancel();
      wristRose?.cancel();
      $("joint-mode").value = "virtual";
      $("follow-machine").disabled = false;
      if (reportedQ) setPose(reportedQ, { edit: false });
      if (reason) {
        liveFault = !/telemetry is stale|machine is Unknown\b/i.test(reason);
        $("enable-machine").checked = false;
        message(reason, true);
      }
      refreshMode();
    },
  });
  const program = RobotProgramControl.create({
    call,
    getState: () => ({ referenced, status, at: statusAt }),
    onUpdate: renderProgramExecution,
  });
  window.addEventListener("message", (e) => {
    if (e.source !== parent) return;
    const m = e.data;
    if (m?.type === "fluid-event" && m.event === "session") {
      if (controllerSession && m.data?.generation <= controllerSession.generation) return;
      controllerSession = m.data;
      clearReference(m.data.reason === "connection"
        ? "Connection interrupted. Recover the previous reference if FluidNC retained its coordinates."
        : "Controller session changed: reset, homing, alarm or controller switch.",
        { recoverable: m.data.reason === "connection" });
      program.connectionChanged();
      live.stop();
      cancelJog();
    }
    if (m?.type === "fluid-event" && m.event === "control-taken") {
      program.controlTaken();
      liveFault = true;
      live.stop();
      cancelJog();
      $("enable-machine").checked = false;
      updateMachine();
      message("Another client took control. Reference retained; choose Live joints when the controller is Idle to resume.");
    }
    if (m?.type === "fluid-response") {
      const p = pending.get(m.id);
      if (p) {
        clearTimeout(p.timeout);
        pending.delete(m.id);
        m.error ? p.reject(Error(m.error)) : p.resolve(m.result);
      }
    }
    if (m?.type === "fluid-event" && m.event === "status") {
      status = m.data;
      statusAt = performance.now();
      if (["Unknown", "Alarm", "Home"].includes(status?.state)) {
        // Missing position feedback is not a coordinate reset. The session
        // bridge and explicit firmware events handle actual reference loss.
        if (status.state !== "Unknown")
          clearReference(`Controller entered ${status.state}.`);
        live.stop();
        cancelJog();
      }
      program.tick();
      if (
        $("enable-machine").checked &&
        !["Idle", "Jog"].includes(status?.state)
      ) {
        $("enable-machine").checked = false;
        live.stop();
        cancelJog();
        message(
          `Machine control disabled: ${status?.state || "unknown state"}.`,
          true,
        );
      }
      updateMachine();
    }
    if (m?.type === "fluid-event" && m.event === "line" && /^(?:Grbl\b|FluidNC\b|ALARM:)/i.test(String(m.data))) {
      clearReference(`Controller restart or alarm: ${String(m.data)}`);
      live.stop();
      cancelJog();
    }
    if (m?.type === "fluid-event" && m.event === "line")
      program.line(String(m.data));
    if (m?.type === "fluid-event" && m.event === "program-stream")
      program.stream(m.data);
    if (
      m?.type === "fluid-event" &&
      m.event === "line" &&
      /^(error:|ALARM:)/i.test(String(m.data))
    ) {
      if (holding || live.active || $("enable-machine").checked) {
        liveFault = true;
        live.stop();
        cancelJog();
        $("enable-machine").checked = false;
        message(`Controller: ${m.data}`, true);
      }
    }
  });
  function message(text, error = false) {
    $("message").textContent = text;
    $("message").classList.toggle("error", error);
  }
  function action(fn) {
    return async (e) => {
      try {
        await fn(e);
      } catch (error) {
        message(error.message, true);
      }
    };
  }
  function project() {
    return {
      format: "figui-robot-studio",
      version: 1,
      config,
      endEffector,
      programMaximums,
      programSource,
      jogMaximums,
      q: [...q],
      points,
    };
  }
  function invalidate() {
    revision++;
    plan = null;
    displayedPlan = null;
    if (!programPreparing) program.clear();
    viewer?.path([]);
    $("plan-label").textContent = "Trajectory needs planning";
    $("plan-duration").textContent = "—";
    refreshProgramControls();
    void rememberReference().catch(() => {});
  }
  function stopPreview() {
    $("end-effector-preview").textContent = "";
    if (playback) {
      cancelAnimationFrame(playback.frame);
      gripperState = playback.gripper;
      playback = null;
      viewer?.gripper(gripperState);
      $("preview-program").textContent = "Preview";
      $("viewer-state").innerHTML =
        '<span class="status-dot"></span> Simulation';
      $("playback-time").textContent = "";
    }
  }
  function setPose(next, { edit = true, liveEdit = false } = {}) {
    if (edit && (program.active || programPreparing))
      throw Error("Stop the program before changing its pose.");
    const validated = K.validateJoints(config, next);
    if (edit && tcpDrag && !tcpDragUpdating) viewer?.cancelTcpDrag();
    if (edit) {
      if (!liveEdit) live.stop();
      if (!liveEdit) $("follow-machine").checked = false;
      stopPreview();
      if (holding) cancelJog();
      invalidate();
    }
    q = validated;
    if (edit) projectChanged();
    q.forEach((v, i) => {
      const range = $(`joint-range-${i}`),
        input = $(`joint-input-${i}`);
      if (range) range.value = v;
      if (input && document.activeElement !== input) input.value = v.toFixed(2);
    });
    refreshVisualization();
  }
  function displayedJoints() {
    const machine = ($("follow-machine").checked || program.active) && referenced && reportedQ;
    return [...(machine ? reportedQ : q)];
  }
  function refreshVisualization() {
    const machine = ($("follow-machine").checked || program.active) && referenced && reportedQ;
    const shown = displayedJoints();
    const f = K.forward(config, shown);
    poseKeys.forEach((k) => ($(`tcp-${k}`).textContent = f.pose[k].toFixed(1)));
    const fresh = statusAt && performance.now() - statusAt < 2000;
    const feed = fresh && Number.isFinite(status?.feed) && status.feed >= 0 ? status.feed : null;
    $("controller-feed").textContent = feed === null ? "—" : feed.toFixed(1);
    $("controller-feed").parentElement.classList.toggle("moving", feed !== null && feed > 0);
    $("controller-override").textContent = `Controller override · ${fresh && Number.isFinite(status?.feedOverride) ? `${status.feedOverride}%` : "—"}`;
    viewer?.update(shown);
    viewer?.gripper(playback?.gripper || gripperState);
    const activeSegment = playback
      ? playback.plan.segments[playback.move]
      : program.active ? program.state.plan?.segments[program.state.move] : null;
    const destination = activeSegment?.samples.at(-1)?.q || q;
    viewer?.jointTarget((machine || playback) && !directJog ? destination : null);
    $("arm-legend").textContent = machine ? "Reported machine" : "Virtual arm";
    if (!playback)
      $("viewer-state").textContent = machine
        ? performance.now() - statusAt < 2000
          ? "● Machine position"
          : "Last machine position"
        : "● Simulation";
    config.joints.forEach((_, i) => {
      const reading = $(`joint-actual-${i}`);
      if (reading)
        reading.textContent =
          referenced && reportedQ && performance.now() - statusAt < 2000
            ? `${reportedQ[i].toFixed(2)}° reported`
            : "— reported";
    });
    [jointRose, wristRose].forEach((rose, group) => {
      rose?.readings([0, 1, 2].map((i) => live.active ? (fresh ? reportedQ?.[group * 3 + i] : null) : q[group * 3 + i]));
    });
    const targetPose = K.forward(config, q).pose;
    cartesianRose?.readings(poseKeys.slice(cartesianGroup, cartesianGroup + 3).map((key) => targetPose[key]));
    refreshTcpJog();
  }
  function refreshMode() {
    $("joint-mode").value = livePreferred ? "live" : "virtual";
    $("control-mode-badge").textContent = program.active
      ? "Program active"
      : live.active
      ? "Live joints"
      : livePreferred
      ? "Live paused"
      : $("enable-machine").checked
        ? "Machine ready"
        : "Virtual";
    $("joint-mode-hint").textContent = !live.active && livePreferred
      ? liveFault ? "Live paused after a fault · Select Live joints to retry." : "Waiting for reference and fresh Idle feedback."
      : "";
    $("joint-mode-hint").hidden = !$("joint-mode-hint").textContent;
    $("control-mode-badge").classList.toggle("is-live", live.active || program.active);
    $("mode-live").classList.toggle("active", livePreferred);
    $("mode-live").setAttribute("aria-pressed", String(livePreferred));
    $("mode-target").classList.toggle("active", !livePreferred);
    $("mode-target").setAttribute("aria-pressed", String(!livePreferred));
    document
      .querySelectorAll(".joint-jog")
      .forEach((b) => (b.disabled = !live.active));
    $("joint-panel").classList.toggle("live-mode", live.active);
    refreshJogPads();
  }
  function editJoint(i, angle) {
    if (directJog) throw Error("Release the held jog before entering another target.");
    if (livePreferred && !live.active) throw Error("Live controls are waiting for a reference and fresh Idle feedback. Choose Target pose to edit virtually.");
    if (live.active) {
      directJog = null;
      const next = [...K.machineJoints(config, status)];
      next[i] = angle;
      K.validateJoints(config, next);
      live.setTarget(i, angle);
      setPose(next, { liveEdit: true });
      void live.tick();
    } else {
      const next = [...q];
      next[i] = angle;
      setPose(next);
    }
  }
  async function enableLiveControls() {
    if (endEffectorBusy) throw Error("Wait for the gripper command to finish.");
    if (program.active || programPreparing)
      throw Error("Stop the program before enabling live joints.");
    if (live.active) return;
    if (!embedded)
      throw Error("Open Robot Studio through FluidUI to move the machine.");
    livePreferred = true;
    liveFault = false;
    if (!referenced) {
      $("joint-mode").value = "virtual";
      await openManualHome({ liveAfter: true });
      return;
    }
    try {
      if (holding)
        throw Error("Release Hold to jog before enabling live control.");
      freshMachine();
      $("enable-machine").checked = true;
      stopPreview();
      const actual = live.start();
      $("joint-mode").value = "live";
      $("follow-machine").checked = true;
      $("follow-machine").disabled = true;
      reportedQ = actual;
      setPose(actual, { edit: false });
      currentTarget();
      invalidate();
      message(roseHold ? "Live joints · Hold ready." : "Live joints · Step ready.");
    } catch (e) {
      $("joint-mode").value = "virtual";
      $("enable-machine").checked = false;
      throw e;
    } finally {
      refreshMode();
      updateMachine();
    }
  }
  function resumePreferredLiveControls() {
    if (!livePreferred || liveFault || live.active || live.busy || liveEnding || holding || endEffectorBusy ||
        !referenced || restoringSettings || planning || playback || programPreparing || program.busy ||
        document.hidden || !document.hasFocus() || document.querySelector("dialog[open]") ||
        document.querySelector(".control-panel").hidden || $("joint-panel").hidden ||
        !statusAt || performance.now() - statusAt >= 2000 || status?.state !== "Idle" || status.sdFilename)
      return;
    // Starting only adopts reported positions; every old destination was cleared
    // on suspension. The next gesture is the only thing that requests movement.
    void enableLiveControls().catch((error) => {
      liveFault = true;
      message(error.message, true);
    });
  }
  function startDirectJog(i, direction, e) {
    if (endEffectorBusy) return false;
    if (!live.active) throw Error("Choose Live joints first.");
    if (e.type === "pointerdown" && (e.button !== 0 || !e.isPrimary)) return false;
    if (e.type === "keydown" && (![" ", "Enter"].includes(e.key) || e.repeat))
      return false;
    if (directJog) return false;
    e.preventDefault();
    live.setTarget(
      i,
      direction < 0 ? config.joints[i].min : config.joints[i].max,
      { jog: true },
    );
    directJog = { joint: i, button: e.currentTarget, pointerId: e.pointerId, key: e.key };
    viewer?.selectJoint(i);
    if (e.pointerId !== undefined)
      e.currentTarget.setPointerCapture(e.pointerId);
    void live.tick();
    refreshVisualization();
    return true;
  }
  function releaseDirectJog(e) {
    if (
      !directJog ||
      (e?.currentTarget && e.currentTarget !== directJog.button)
    )
      return;
    if (e?.type === "keyup" && e.key !== directJog.key) return;
    if (e?.type.startsWith("pointer") && e.pointerId !== directJog.pointerId) return;
    directJog = null;
    live.release();
    if (reportedQ) setPose(reportedQ, { edit: false });
    message("Joint jog released.");
    updateMachine();
  }
  function configureJointRose() {
    configuredRoseHold = roseHold && livePreferred;
    [jointRose, wristRose].forEach((rose, group) => {
      const offset = group * 3;
      rose?.configure({
        axes: config.joints.slice(offset, offset + 3).map((joint, i) => ({
          label: `J${offset + i + 1}`, name: joint.name || jointNames[offset + i],
        })),
        hold: configuredRoseHold,
      });
    });
    refreshJogPads();
    refreshVisualization();
  }
  function configureCartesianRose() {
    cartesianRose.configure({
      axes: poseKeys.slice(cartesianGroup, cartesianGroup + 3).map((key, i) => ({
        label: key.toUpperCase(), name: cartesianGroup ? ["Roll", "Pitch", "Yaw"][i] : ["X position", "Y position", "Z position"][i],
      })),
      unit: cartesianGroup ? "°" : "mm",
    });
    refreshJogPads();
    refreshVisualization();
  }
  function refreshJogPads() {
    refreshTcpJog();
    if (!jointRose) return;
    const locked = programPreparing || program.busy || endEffectorBusy;
    if (configuredRoseHold !== (roseHold && livePreferred)) {
      configureJointRose();
    }
    const disabled = locked || (livePreferred && !live.active) || (!roseHold && live.active && live.busy);
    jointRose.setDisabled(disabled);
    wristRose?.setDisabled(disabled);
    cartesianRose?.setDisabled(locked);
    $("rose-hold-mode").disabled = locked || !live.active;
    $("rose-step-mode").disabled = locked;
    for (const [id, active] of [["rose-step-mode", !configuredRoseHold], ["rose-hold-mode", configuredRoseHold]]) {
      $(id).classList.toggle("active", active);
      $(id).setAttribute("aria-pressed", String(active));
    }
    document.querySelectorAll("[data-cart-group]").forEach((button) => { button.disabled = locked; });
  }
  function stepJoint(axis, sign, amount) {
    if (programPreparing || program.busy) throw Error("Stop the program before jogging.");
    if (directJog || (live.active && live.busy)) throw Error("Wait for the current jog to finish before stepping again.");
    const i = axis,
      actual = live.active ? freshMachine() : q;
    editJoint(i, actual[i] + sign * amount);
    currentTarget();
    refreshMode();
    message(`J${i + 1} ${sign > 0 ? "+" : "−"}${amount}° · ${live.active ? "Machine step requested" : "Virtual target updated"}.`);
  }
  function stepCartesian(axis, sign, amount) {
    if (programPreparing || program.busy) throw Error("Stop the program before changing the tool target.");
    // The viewer may be following reported joints while q still holds an
    // older virtual target. Capture the displayed pose for both FK and IK.
    const start = displayedJoints(),
      i = cartesianGroup + axis, key = poseKeys[i],
      current = K.forward(config, start).tcp,
      delta = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 };
    delta[key] = sign * amount;
    let target;
    if (jogFrame === "tool") target = K.multiply(current, K.poseMatrix(delta));
    else if (i < 3) {
      target = [...current];
      target[i * 4 + 3] += delta[key];
    } else {
      target = K.multiply(K.poseMatrix(delta), current);
      [3, 7, 11].forEach((k) => (target[k] = current[k]));
    }
    // The default IK tolerance is larger than the innermost 0.1 mm ring.
    // Small steps must converge rather than accepting the unchanged seed pose.
    solveTarget(target, { positionTolerance: 0.05, orientationTolerance: 0.05, restarts: false }, start);
    currentTarget();
  }
  function selectJogTarget(index) {
    if (!Number.isInteger(index) || index < -1 || index > 5) return;
    if (programPreparing || program.busy || endEffectorBusy || restoringSettings ||
        playback || holding || directJog || live.busy || document.querySelector("dialog[open]")) {
      message("Finish the current operation before selecting a drag target.", true);
      $("jog-target").value = String(tcpJogJoint);
      return;
    }
    viewer?.cancelTcpDrag();
    tcpJogJoint = index;
    if ($("jog-target").value !== String(index)) $("jog-target").value = String(index);
    tcpJogEnabled = true;
    livePreferred = false;
    selectWorkspace("move");
    $("cartesian-tab").click();
    refreshMode();
    refreshTcpJog();
    const state = index >= 0 ? K.jointJogState(config, displayedJoints(), index) : null;
    message(state && !state.movable
      ? `J${index + 1} has a fixed position. Use its joint controls to rotate it, or select another housing.`
      : index >= 0
        ? `J${index + 1} selected · Drag its arrows. Upstream joints position this housing; hold Shift for Push.`
        : "Tool TCP selected · Drag its arrows to edit the virtual target.");
  }
  function setJogFrame(frame) {
    if (!["world", "tool"].includes(frame) || frame === jogFrame) return;
    viewer?.cancelTcpDrag();
    jogFrame = frame;
    if ($("jog-frame").value !== frame) $("jog-frame").value = frame;
    refreshTcpJog();
  }
  function refreshTcpJog() {
    const locked = programPreparing || program.busy || endEffectorBusy || restoringSettings ||
      !!playback || holding || !!directJog || live.busy;
    $("toggle-tcp-jog").disabled = !viewer || locked;
    $("toggle-tcp-jog").classList.toggle("active", tcpJogEnabled);
    $("toggle-tcp-jog").setAttribute("aria-pressed", String(tcpJogEnabled));
    const push = tcpPushEnabled || tcpPushShift;
    $("toggle-tcp-push").disabled = !viewer || locked;
    $("toggle-tcp-push").classList.toggle("active", push);
    $("toggle-tcp-push").setAttribute("aria-pressed", String(push));
    const targetSelect = $("jog-target"), frameSelect = $("jog-frame");
    if (targetSelect.disabled !== (!viewer || locked)) targetSelect.disabled = !viewer || locked;
    if (frameSelect.disabled !== locked) frameSelect.disabled = locked;
    const localOption = frameSelect.querySelector('[value="tool"]');
    const localLabel = tcpJogJoint >= 0 ? "Joint frame" : "Tool frame";
    // Replacing even identical option text can rebuild a native open menu.
    // Telemetry refreshes must leave the dropdown's contents alone.
    if (localOption.textContent !== localLabel) localOption.textContent = localLabel;
    const visible = tcpJogEnabled && !locked && !live.active && !$("cartesian-panel").hidden &&
      !document.querySelector(".control-panel").hidden && !document.querySelector("dialog[open]");
    viewer?.tcpJog({ enabled: visible, frame: jogFrame, joint: tcpJogJoint });
    $("viewer-frame-controls").hidden = !visible;
    document.querySelectorAll("[data-jog-frame]").forEach((button) => {
      const active = button.dataset.jogFrame === jogFrame;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
      const label = button.dataset.jogFrame === "tool" ? localLabel : "World frame";
      if (button.textContent !== label) button.textContent = label;
    });
    const selected = tcpJogJoint >= 0 ? `J${tcpJogJoint + 1}` : "TCP";
    $("viewer-drag-hint").textContent = visible
      ? push ? `${selected} · Push · Drag toward a reachable target`
        : `${selected} · Drag X / Y / Z · Shift to push · Click a joint to select`
      : "Drag to orbit · Click a joint to select · Scroll to zoom";
  }
  function setTcpPushShift(active, { retry = true } = {}) {
    if (tcpPushShift === active) return;
    tcpPushShift = active;
    refreshTcpJog();
    if (retry && tcpDrag?.last) dragTcp(tcpDrag.last);
  }
  function startTcpDrag(_axis, event = {}) {
    if (!tcpJogEnabled || programPreparing || program.busy || endEffectorBusy || restoringSettings ||
        playback || holding || directJog || live.active || live.busy || document.querySelector("dialog[open]")) return false;
    const start = displayedJoints();
    const joint = tcpJogJoint;
    const state = joint >= 0 ? K.jointJogState(config, start, joint, jogFrame) : null;
    if (state && !state.movable) return false;
    const tcp = state ? state.matrix : K.forward(config, start).tcp;
    tcpPushShift = !!event.shiftKey;
    tcpDrag = { start: tcp, orientation: tcp, seed: start, failed: false, joint,
      push: tcpPushEnabled || tcpPushShift, last: null };
    refreshTcpJog();
    message(joint >= 0
      ? `Drag J${joint + 1} · Upstream joints move; downstream joint angles are kept. Hold Shift for Push.`
      : tcpDrag.push
        ? "Push · Tool orientation and other axes may adjust. Virtual target only."
        : "Drag along an axis · Hold Shift to push past a constrained target. Virtual target only.");
    return true;
  }
  function dragTcp({ axis, distance, direction, shiftKey }) {
    if (!tcpDrag) return;
    if (typeof shiftKey === "boolean") setTcpPushShift(shiftKey, { retry: false });
    if (!tcpDrag) return;
    tcpDrag.last = { axis, distance, direction };
    const push = tcpPushEnabled || tcpPushShift;
    const previousPush = tcpDrag.push, wasFailed = tcpDrag.failed;
    // Resume strict dragging from the adjusted orientation, rather than
    // snapping back to the orientation from before Push was held.
    if (tcpDrag.joint < 0 && tcpDrag.push && !push) tcpDrag.orientation = K.forward(config, tcpDrag.seed).tcp;
    tcpDrag.push = push;
    const target = [...tcpDrag.orientation];
    direction.forEach((component, i) => { target[i * 4 + 3] = tcpDrag.start[i * 4 + 3] + component * distance; });
    const joint = tcpDrag.joint, selected = joint >= 0 ? `J${joint + 1}` : "TCP";
    const result = push
      ? K.inversePush(config, K.position(target), tcpDrag.seed, { joint: joint >= 0 ? joint : null })
      : joint >= 0
        ? K.inversePosition(config, K.position(target), tcpDrag.seed, {}, { joint })
        : K.inverse(config, target, tcpDrag.seed, {
          positionTolerance: 0.05, orientationTolerance: 0.05, restarts: false, iterations: 100,
        });
    if (!result.ok) {
      if (!tcpDrag.failed) message(push
        ? "Push limit · No closer local pose found. Last reachable pose kept; try another direction."
        : `${selected} axis target is constrained. Hold Shift or enable Push to follow its reachable motion. Last valid pose kept.`, !push);
      tcpDrag.failed = true;
      $("ik-result").textContent = push
        ? "Push limit · Last reachable pose kept"
        : "Axis target constrained · Hold Shift to push · Last valid pose kept";
      return;
    }
    tcpDrag.seed = result.q;
    tcpDrag.failed = false;
    // Never dispatch a live joint target from a Cartesian drag.
    tcpDragUpdating = true;
    try { setPose(result.q); }
    finally { tcpDragUpdating = false; }
    currentTarget();
    if (wasFailed || previousPush !== push) message(push
      ? `${selected} · Push · Following a nearby reachable target.`
      : joint >= 0 ? `${selected} · Following the requested axis.` : "Axis drag · Keeping the adjusted tool orientation fixed.");
    $("ik-result").textContent = push
      ? `${selected} Push ${["X", "Y", "Z"][axis]} · ${result.positionError.toFixed(2)} mm from requested target`
      : `${selected} ${["X", "Y", "Z"][axis]} drag · ${distance.toFixed(1)} mm · Virtual target`;
  }
  function endTcpDrag() {
    const completed = tcpDrag;
    tcpDrag = null;
    if (completed && !completed.failed) message(completed.joint >= 0
      ? `J${completed.joint + 1} target updated · Use Hold to jog or add a waypoint.`
      : "Tool target updated · Use Hold to jog or add a waypoint.");
  }
  function previewCartesianWorkingPose() {
    if (programPreparing || program.busy || endEffectorBusy)
      throw Error("Wait for the current operation to finish.");
    if (!K.isParallelElbowLayout(config))
      throw Error("Use Joints to bend the elbow and wrist away from alignment for this joint layout.");
    const start = displayedJoints(),
      aligned = (angle) => Math.abs(Math.sin(angle * Math.PI / 180)) < Math.sin(20 * Math.PI / 180),
      elbows = aligned(start[2]) ? [40, -40] : [0],
      wrists = aligned(start[4]) ? [30, -30] : [0];
    if (elbows[0] === 0 && wrists[0] === 0) {
      message("The elbow and wrist are already bent. Cartesian steps still depend on reach and joint limits.");
      return;
    }
    for (const elbow of elbows) {
      for (const wrist of wrists) {
        const next = [...start];
        next[1] -= elbow / 2;
        next[2] += elbow;
        next[3] -= elbow / 2;
        next[4] += wrist;
        try { K.validateJoints(config, next); }
        catch { continue; }
        setPose(next);
        currentTarget();
        $("ik-result").textContent = "Working pose preview · Elbow and wrist bent · Tool orientation changed";
        message("Working pose previewed. Use Hold to jog to position the physical arm, then retry Cartesian jogging. Manual reference retained.");
        return;
      }
    }
    throw Error("A working pose would exceed the configured joint limits. Bend the elbow and wrist manually in Joints.");
  }
  function bindJogPads() {
    const onError = (error) => message(error.message, true);
    const createJointRose = (id, offset) => RobotJogPad.create($(id), {
      onStep: (axis, sign, amount) => stepJoint(offset + axis, sign, amount),
      onHold: (axis, sign, event) => startDirectJog(offset + axis, sign, event),
      onRelease: releaseDirectJog,
      onStop: stop,
      onSelect: (axis) => viewer?.selectJoint(offset + axis),
      onError,
    });
    jointRose = createJointRose("joint-rose", 0);
    wristRose = createJointRose("wrist-rose", 3);
    cartesianRose = RobotJogPad.create($("cartesian-rose"), {
      onStep: stepCartesian, onStop: stop, onRelease: () => {}, onError,
    });
    const release = () => {
      jointRose.cancel();
      wristRose.cancel();
      releaseDirectJog();
      // Also discard a finite step before changing the meaning of a direction.
      if (live.active) live.release();
    };
    for (const [id, hold] of [["rose-step-mode", false], ["rose-hold-mode", true]]) {
      $(id).onclick = () => {
        release();
        roseHold = hold;
        configureJointRose();
      };
    }
    document.querySelectorAll("[data-cart-group]").forEach((button) => {
      button.onclick = () => {
        cartesianGroup = Number(button.dataset.cartGroup);
        document.querySelectorAll("[data-cart-group]").forEach((b) => {
          b.classList.toggle("active", b === button);
          b.setAttribute("aria-pressed", String(b === button));
        });
        configureCartesianRose();
      };
    });
    configureJointRose();
    configureCartesianRose();
  }
  function inputNumber(value, attrs = {}) {
    const el = document.createElement("input");
    el.type = "number";
    el.step = "any";
    el.value = value;
    Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
    return el;
  }
  function poseFields(container, prefix, pose) {
    container.replaceChildren();
    poseKeys.forEach((k) => {
      const label = document.createElement("label");
      label.textContent = `${k.toUpperCase()} · ${k.length === 1 ? "mm" : "°"}`;
      const input = inputNumber(pose[k], {
        id: `${prefix}-${k}`,
        required: "",
      });
      label.append(input);
      container.append(label);
    });
  }
  function readPose(prefix) {
    return Object.fromEntries(
      poseKeys.map((k) => [k, readNumber($(`${prefix}-${k}`))]),
    );
  }
  function readNumber(input) {
    const invalid = !input.value.trim() || !Number.isFinite(input.valueAsNumber);
    if (invalid || !input.checkValidity()) {
      input.setAttribute("aria-invalid", "true");
      input.focus();
      const label = input.getAttribute("aria-label") || input.labels?.[0]?.textContent.trim() || "Value";
      throw Error(`${label}: ${invalid ? "enter a valid number." : input.validationMessage}`);
    }
    input.removeAttribute("aria-invalid");
    return input.valueAsNumber;
  }
  function renderJoints() {
    $("jog-target").querySelectorAll("option").forEach((option, index) => {
      if (index > 0) option.textContent = `J${index} · ${config.joints[index - 1].name || jointNames[index - 1]}`;
    });
    const hasWorkingPose = K.isParallelElbowLayout(config);
    $("cartesian-working-pose").hidden = !hasWorkingPose;
    $("cartesian-working-hint").hidden = !hasWorkingPose;
    $("joint-controls").replaceChildren();
    config.joints.forEach((j, i) => {
      const row = document.createElement("div");
      row.className = "joint-control";
      row.innerHTML = `<div class="joint-line"><span class="joint-badge">J${i + 1}</span><label class="joint-name" for="joint-input-${i}"></label><input type="number" id="joint-input-${i}" min="${j.min}" max="${j.max}" step="any"><small>°</small></div><div class="joint-jog-row"><button class="joint-jog" data-direction="-1" aria-label="Jog joint ${i + 1} negative" title="Hold to jog negative" disabled>−</button><input id="joint-range-${i}" type="range" min="${j.min}" max="${j.max}" step="0.1" aria-label="Joint ${i + 1} angle"><button class="joint-jog" data-direction="1" aria-label="Jog joint ${i + 1} positive" title="Hold to jog positive" disabled>+</button></div><div class="range-labels"><span>${j.min}°</span><span id="joint-actual-${i}" class="joint-actual">— reported</span><span>${j.max}°</span></div>`;
      row.querySelector(".joint-name").textContent = j.name || jointNames[i];
      $("joint-controls").append(row);
      const select = () => {
        document
          .querySelectorAll(".joint-control")
          .forEach((r) => r.classList.toggle("selected", r === row));
        viewer?.selectJoint(i);
      };
      row.addEventListener("focusin", select);
      row.addEventListener("pointerdown", select);
      row.querySelectorAll(".joint-jog").forEach((button) => {
        for (const event of ["pointerdown", "keydown"])
          button.addEventListener(
            event,
            action((e) =>
              startDirectJog(i, Number(button.dataset.direction), e),
            ),
          );
        for (const event of [
          "pointerup",
          "pointercancel",
          "lostpointercapture",
          "blur",
        ])
          button.addEventListener(event, releaseDirectJog);
        button.addEventListener("keyup", (e) => {
          if ([" ", "Enter"].includes(e.key)) releaseDirectJog(e);
        });
      });
      $(`joint-range-${i}`).addEventListener(
        "input",
        action((e) => {
          editJoint(i, readNumber(e.target));
        }),
      );
      $(`joint-input-${i}`).addEventListener(
        "change",
        action((e) => {
          try {
            editJoint(i, readNumber(e.target));
          } catch (err) {
            e.target.value = q[i].toFixed(2);
            throw err;
          }
        }),
      );
    });
    $("robot-name").textContent = config.name;
    const toolOffset = K.norm([config.tool.x, config.tool.y, config.tool.z]);
    // Offer a visible straight tool for projects that still use the bare flange.
    // Existing nonzero tool transforms retain their configured extension.
    $("demo-tool-length").value = toolOffset < 1e-6 ? 30 : config.tool.z;
    $("demo-tool-hint").textContent = toolOffset < 1e-6
      ? "The current model has no tool extension. Starting either demo applies the extension above."
      : `Current tool tip: ${config.tool.x.toFixed(1)}, ${config.tool.y.toFixed(1)}, ${config.tool.z.toFixed(1)} mm from the flange, in flange coordinates.`;
    $("model-summary").replaceChildren();
    for (const [label, value] of [
      [
        "Kinematics",
        K.isParallelElbowLayout(config)
          ? "Parallel elbow · 6 revolute"
          : "Custom · 6 revolute",
      ],
      [
        "Link dimensions",
        `${config.joints.reduce((s, j) => s + Math.abs(j.a) + Math.abs(j.d), 0).toFixed(0)} mm`,
      ],
      [
        "Tool offset",
        `${K.norm([config.tool.x, config.tool.y, config.tool.z]).toFixed(1)} mm`,
      ],
      ["Controller axes", config.joints.map((j) => j.axis).join(" · ")],
    ]) {
      const div = document.createElement("div"),
        a = document.createElement("span"),
        b = document.createElement("strong");
      a.textContent = label;
      b.textContent = value;
      div.append(a, b);
      $("model-summary").append(div);
    }
    if (jointRose) configureJointRose();
  }
  function currentTarget() {
    const p = K.forward(config, displayedJoints()).pose;
    poseKeys.forEach((k) => ($(`target-${k}`).value = p[k].toFixed(3)));
    viewer?.target(null);
  }
  function solveTarget(target, options = {}, seed = displayedJoints()) {
    stopPreview();
    const result = K.inverse(config, target, seed, options);
    viewer?.target(target);
    const residual = `${result.positionError.toFixed(3)} mm · ${result.orientationError.toFixed(3)}°`;
    if (!result.ok) {
      const aligned = K.isParallelElbowLayout(config) && [seed[2], seed[4]].some(
        (angle) => Math.abs(Math.sin(angle * Math.PI / 180)) < 0.1,
      );
      const guidance = aligned
        ? "The starting elbow or wrist is aligned. Preview a working pose, use Hold to jog, then retry."
        : "Try another direction or starting pose.";
      $("ik-result").textContent = `Target not reached · ${residual} · Previous pose kept`;
      throw Error(
        `Target not reached within solver tolerance (${residual}). ${guidance} Previous pose and manual reference are unchanged.`,
      );
    }
    setPose(result.q);
    $("ik-result").textContent = `IK solved · ${residual}`;
    message("IK solved · Virtual arm updated.");
  }
  function renderEndEffectorSettings() {
    $("end-effector-open").value = endEffector.open;
    $("end-effector-close").value = endEffector.close;
  }
  function renderEndEffector() {
    const busy = endEffectorBusy || programPreparing || program.busy;
    const available = embedded && statusAt && performance.now() - statusAt < 2000 &&
      ["Idle", "Jog"].includes(status?.state) && !status.sdFilename;
    for (const actionName of ["open", "close"]) {
      const button = $(`gripper-${actionName}`);
      button.disabled = busy || !available;
      button.title = !embedded ? "Open in FluidUI to operate the gripper" : "Send the configured gripper commands";
      $(`end-effector-${actionName}`).disabled = busy;
    }
    const toggle = $("gripper-toggle"),
      closed = lastManualGripperAction === "close";
    toggle.disabled = busy || !available;
    toggle.setAttribute("aria-pressed", String(closed));
    toggle.classList.toggle("active", closed);
    toggle.title = `${closed ? "Open" : "Close"} gripper · ${!embedded ? "Open in FluidUI to operate the gripper" : "Send the configured gripper command"}`;
    toggle.querySelectorAll("[data-gripper-state]").forEach((icon) => {
      icon.toggleAttribute("hidden", icon.dataset.gripperState !== lastManualGripperAction);
    });
    $("save-end-effector").disabled = busy;
    $("end-effector-controls").setAttribute("aria-busy", String(endEffectorBusy));
  }
  async function runEndEffector(actionName) {
    if (endEffectorBusy || programPreparing || program.busy) throw Error("Wait for the current operation to finish.");
    if (!embedded) throw Error("Open in FluidUI to operate the gripper.");
    if (!statusAt || performance.now() - statusAt >= 2000 || !["Idle", "Jog"].includes(status?.state) || status.sdFilename)
      throw Error("Waiting for the controller to be ready.");
    const command = K.endEffectorCommand(actionName, endEffector),
      wasMoving = status.state === "Jog" || live.busy || holding;
    endEffectorBusy = true;
    live.stop();
    $("enable-machine").checked = false;
    stopPreview();
    cancelJog();
    refreshProgramControls();
    renderEndEffector();
    try {
      await jogTransport.end();
      if (wasMoving) {
        const after = performance.now();
        await call("sendRealtime", { byte: 0x3f });
        while (statusAt <= after || status?.state !== "Idle") {
          if (performance.now() - after > 5000 || !["Idle", "Jog"].includes(status?.state))
            throw Error("Wait for the controller to finish jogging.");
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      if (status?.state !== "Idle" || status.sdFilename) throw Error("Wait for the controller program to finish.");
      await call("sendCommand", { command });
      lastManualGripperAction = actionName;
      gripperState = actionName;
      viewer?.gripper(gripperState);
      $("end-effector-state").textContent = `Last command: ${actionName}`;
      message(`Gripper ${actionName} commands sent.`);
    } finally {
      endEffectorBusy = false;
      refreshProgramControls();
      updateMachine();
    }
  }
  function renderPoints(focusIndex, focusAction) {
    const scrollTop = document.querySelector(".program-body").scrollTop;
    $("point-count").textContent = String(points.length).padStart(2, "0");
    $("nav-point-count").textContent = points.length;
    $("waypoints").replaceChildren();
    if (!points.length) {
      $("waypoints").innerHTML =
        '<div class="empty-state"><strong>Teach your first waypoint</strong><p>Position the virtual arm in Move, then add its pose here. Add another pose to create a sequence.</p><button id="empty-edit-pose">Position the arm</button></div>';
      $("empty-edit-pose").onclick = () => selectWorkspace("move");
      refreshProgramControls();
      return;
    }
    points.forEach((point, i) => {
      const card = document.createElement("div");
      card.className = "waypoint";
      card.dataset.point = i;
      card.innerHTML = `<div class="waypoint-head"><span class="waypoint-index">${String(i + 1).padStart(2, "0")}</span><input class="name" maxlength="60" aria-label="Waypoint ${i + 1} name"><button class="delete" aria-label="Delete waypoint ${i + 1}">Delete</button></div><div class="waypoint-meta"><select aria-label="Waypoint ${i + 1} motion"><option value="MoveJ">Joint move</option><option value="MoveL">Linear move</option></select><input type="number" min="0.1" max="600" step="any" aria-label="Waypoint ${i + 1} duration"><span>s minimum</span></div><div class="waypoint-actions"><button data-point-action="recall">Recall pose</button><button data-point-action="update" title="Replace with the displayed target or stationary machine pose">Update</button><button data-point-action="up" aria-label="Move waypoint ${i + 1} up">↑</button><button data-point-action="down" aria-label="Move waypoint ${i + 1} down">↓</button></div>`;
      card.querySelector(".name").value = point.name;
      card.querySelector("select").value = point.type;
      card.querySelector("input[type=number]").value = point.duration;
      const effectorLabel = document.createElement("label");
      effectorLabel.className = "waypoint-effector";
      effectorLabel.textContent = "After arrival";
      const effectorSelect = document.createElement("select");
      effectorSelect.setAttribute("aria-label", `Waypoint ${i + 1} gripper action`);
      effectorSelect.innerHTML = '<option value="none">No gripper action</option><option value="open">Open gripper</option><option value="close">Close gripper</option>';
      effectorSelect.value = point.endEffector || "none";
      effectorSelect.onchange = () => {
        stopPreview();
        rememberPoints();
        point.endEffector = effectorSelect.value;
        invalidate();
      };
      card.querySelector(".name").addEventListener("change", (e) => {
        rememberPoints();
        point.name = e.target.value.trim() || `Waypoint ${i + 1}`;
        e.target.value = point.name;
        invalidate();
      });
      card.querySelector("select").addEventListener("change", (e) => {
        stopPreview();
        rememberPoints();
        point.type = e.target.value;
        invalidate();
      });
      card.querySelector("input[type=number]").addEventListener(
        "change",
        action((e) => {
          try {
            const duration = readNumber(e.target);
            rememberPoints();
            point.duration = duration;
            stopPreview();
            invalidate();
          } catch (err) {
            e.target.value = point.duration;
            throw err;
          }
        }),
      );
      card.querySelector(".waypoint-meta").after(effectorLabel);
      effectorLabel.append(effectorSelect);
      card.querySelector(".delete").onclick = () => {
        stopPreview();
        rememberPoints();
        points.splice(i, 1);
        invalidate();
        renderPoints(Math.min(i, points.length - 1), ".delete");
        if (!points.length) $("undo-points").focus({ preventScroll: true });
        message(`Deleted ${point.name}. Use Undo to restore it.`);
      };
      card.querySelector("[data-point-action=recall]").onclick = action(() => {
        setPose(point.q);
        currentTarget();
        selectWorkspace("move");
        message(`Recalled ${point.name} · Virtual pose only.`);
      });
      const jog = document.createElement("button");
      jog.type = "button";
      jog.dataset.pointAction = "jog";
      jog.textContent = "Jog to pose";
      jog.setAttribute("aria-label", `Jog to waypoint ${i + 1}`);
      jog.onclick = action(() => jogToWaypoint(i));
      card.querySelector(".waypoint-actions").prepend(jog);
      card.querySelector("[data-point-action=update]").onclick = action(() => {
        stopPreview();
        const captured = capturePose();
        rememberPoints();
        point.q = captured;
        invalidate();
        message(`Updated ${point.name}.`);
      });
      for (const [key, delta] of [
        ["up", -1],
        ["down", 1],
      ]) {
        const b = card.querySelector(`[data-point-action=${key}]`);
        b.disabled = i + delta < 0 || i + delta >= points.length;
        b.onclick = () => {
          stopPreview();
          rememberPoints();
          [points[i], points[i + delta]] = [points[i + delta], points[i]];
          invalidate();
          renderPoints(i + delta, `[data-point-action=${key}]`);
        };
      }
      $("waypoints").append(card);
    });
    refreshProgramControls();
    document.querySelector(".program-body").scrollTop = scrollTop;
    if (focusIndex >= 0) {
      const card = $("waypoints").children[focusIndex];
      if (!$("program-workspace").hidden) card?.scrollIntoView({ block: "nearest" });
      if (!focusAction) return;
      const requested = card?.querySelector(focusAction);
      const target = requested && !requested.disabled ? requested : card?.querySelector(".name");
      target?.focus({ preventScroll: true });
    }
  }
  function capturePose() {
    if (program.busy || programPreparing) throw Error("Stop the program before teaching a waypoint.");
    if ($("follow-machine").checked) {
      if (!referenced) throw Error("Set the manual reference before capturing machine position.");
      return [...freshMachine()];
    }
    return [...q];
  }
  function refreshProgramControls() {
    const locked = programPreparing || program.busy || endEffectorBusy;
    const jogReady = embedded && referenced && statusAt && performance.now() - statusAt < 2000 &&
      ["Idle", "Jog"].includes(status?.state) && !status.sdFilename;
    $("undo-points").disabled = locked || !pointUndo.length;
    $("redo-points").disabled = locked || !pointRedo.length;
    $("clear-points").disabled = locked || !points.length;
    $("program-maximum-speed").disabled = locked;
    $("program-speed").disabled = $("program-acceleration").disabled = locked || programMaximums;
    for (const id of ["teach-point", "teach-point-move"]) {
      $(id).disabled = locked || points.length >= 200;
      $(id).title = locked ? "Stop the program before adding waypoints" : points.length >= 200 ? "Maximum 200 waypoints" : "Capture the displayed pose";
    }
    $("save-gcode").disabled = locked || !embedded || !points.length;
    $("program-source").disabled = locked;
    $("save-sd-program").disabled = locked || planning || !embedded || !referenced || !points.length;
    $("plan-program").disabled = locked || planning || !points.length;
    $("plan-program").textContent = planning ? "Planning…" : "Plan path";
    $("plan-program").setAttribute("aria-busy", String(planning));
    $("preview-program").disabled = $("export-gcode").disabled = locked || planning || (!points.length && !displayedPlan?.demo);
    document.querySelectorAll("#waypoints .waypoint").forEach((card, i) => {
      card.querySelectorAll("input, select, button").forEach((el) => { el.disabled = locked; });
      card.querySelector('[data-point-action="up"]').disabled = locked || i === 0;
      card.querySelector('[data-point-action="down"]').disabled = locked || i === points.length - 1;
      const jog = card.querySelector('[data-point-action="jog"]');
      jog.disabled = locked || !jogReady;
      jog.title = !embedded ? "Open in FluidUI to move the physical arm"
        : !referenced ? "Set the manual reference first"
        : !jogReady ? "Waiting for fresh Idle machine feedback"
        : "Move to this pose using the program speed. Joint move only; no gripper action.";
    });
  }
  let planning = false;
  function showPlan(p) {
    displayedPlan = p;
    viewer?.path(p.samples);
    viewer?.target(p.demo?.anchorPose ? K.poseMatrix(p.demo.anchorPose) : null);
    $("plan-label").textContent = p.demo
      ? p.demo.summary
      : `${p.segments.length} moves · ${p.segments.some((segment) => segment.controllerFeed) ? "Controller ramps" : "Joint limits checked"}`;
    $("plan-duration").textContent = `${p.segments.some((segment) => segment.controllerFeed) ? "≈ " : ""}${p.duration.toFixed(1)} s`;
    refreshProgramControls();
  }
  async function ensurePlan({ start: requestedStart = null, force = false } = {}) {
    if (plan && (!force || (requestedStart && requestedStart.every((angle, i) => Math.abs(angle - plan.samples[0].q[i]) < 1e-6)))) {
      showPlan(plan);
      return plan;
    }
    if (planning) throw Error("A trajectory is already being planned.");
    // Yield by elapsed work, rather than adding a browser timer to every
    // waypoint. Long IK plans remain interruptible; short joint plans are immediate.
    const stamp = revision,
      model = programMotionConfig(),
      start = [...(requestedStart || points[0]?.q || q)],
      waypoints = structuredClone(points),
      effectorSettings = structuredClone(endEffector),
      controllerRamp = programMaximums,
      speed = readNumber($("program-speed-override")) / 100;
    planning = true;
    stopPreview();
    refreshProgramControls();
    message("Solving trajectory and checking joint limits…");
    try {
      if (!waypoints.length) throw Error("Teach at least one waypoint first.");
      let time = 0,
        from = start,
        lastYield = performance.now();
      const samples = [{ q: start, t: 0 }],
        segments = [];
      for (const [i, p] of waypoints.entries()) {
        if (performance.now() - lastYield >= 12) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          lastYield = performance.now();
        }
        if (stamp !== revision)
          throw Error("Planning canceled because the project changed.");
        let segment;
        try {
          segment = K.withEndEffector(K.planSegment(model, from, p.q, { ...p, speed, controllerRamp }), p.endEffector, effectorSettings);
        } catch (e) {
          throw Error(`Point ${i + 1}: ${e.message}`);
        }
        samples.push(
          ...segment.samples.slice(1).map((s) => ({ ...s, t: s.t + time })),
        );
        time += segment.duration;
        segments.push({ ...segment, name: p.name });
        from = segment.samples.at(-1).q;
      }
      if (stamp !== revision)
        throw Error("Planning canceled because the project changed.");
      const result = K.blendProgram(model, { samples, segments, duration: time }, speed);
      // A physical entry move must not replace the preview's first-waypoint start.
      if (!requestedStart) plan = result;
      showPlan(result);
      message(
        `Trajectory ready · ${controllerRamp ? "≈ " : ""}${result.duration.toFixed(1)} s · No collision checking.`,
      );
      return result;
    } finally {
      planning = false;
      refreshProgramControls();
    }
  }
  function renderProgramMotion() {
    const model = programMotionConfig();
    $("program-speed").value = Math.min(...model.joints.map((j) => j.velocity));
    $("program-acceleration").value = Math.min(...model.joints.map((j) => j.acceleration));
    $("jog-speed-limit").value = Math.min(...motionConfig().joints.map((j) => j.velocity));
    $("jog-maximum-speed").checked = jogMaximums;
    $("program-maximum-speed").checked = programMaximums;
    $("program-motion-label").textContent = programMaximums ? "Speed · Controller maximums" : "Speed · Custom limits";
    $("program-speed").disabled = $("program-acceleration").disabled = programMaximums || programPreparing || program.busy || endEffectorBusy;
    renderControllerLimits();
  }
  function renderControllerLimits() {
    const limits = RobotMotionSettings.jointLimits(config, controllerSettings);
    const summary = limits.map((j, i) => `J${i + 1} (${j.axis}) ${j.velocity.toFixed(1)}°/s${j.rateFallback ? " fallback" : ""}`).join(" · ");
    const accelerationSummary = limits.map((j, i) => `J${i + 1} (${j.axis}) ${(j.acceleration ?? config.joints[i].acceleration).toFixed(1)}°/s²${j.acceleration === null ? " configured fallback" : ""}`).join(" · ");
    for (const id of ["jog-controller-limits", "program-controller-limits"]) {
      $(id).textContent = controllerLimitsLoading ? "Reading controller limits…" : `Max rates: ${summary}. Acceleration: ${accelerationSummary}.`;
      $(id).title = [controllerLimitsError, ...limits.map((j, i) => `J${i + 1} (${j.axis}): ${j.velocity.toFixed(2)} °/s${j.rateFallback ? " (1200 units/min fallback)" : ""}, ${j.acceleration === null ? `${config.joints[i].acceleration.toFixed(2)} °/s² (configured)` : `${j.acceleration.toFixed(2)} °/s²`}`)].filter(Boolean).join("\n");
    }
    const locked = programPreparing || program.busy || holding || live.active || live.busy || endEffectorBusy;
    for (const id of ["jog-controller-max", "program-controller-max"])
      $(id).disabled = !embedded || controllerLimitsLoading || locked;
    $("jog-speed-limit").disabled = locked || jogMaximums;
    $("jog-maximum-speed").disabled = locked;
  }
  async function readControllerLimits({ invalidatePlan = true } = {}) {
    if (!embedded) return;
    if (controllerLimitsRequest) return controllerLimitsRequest;
    controllerLimitsRequest = loadControllerLimits({ invalidatePlan });
    try { await controllerLimitsRequest; }
    finally { controllerLimitsRequest = null; }
  }
  async function loadControllerLimits({ invalidatePlan }) {
    controllerLimitsLoading = true;
    controllerLimitsError = "";
    renderControllerLimits();
    try {
      const settings = await call("getMachineSettings");
      controllerSettings = settings || {};
      // Older FluidUI builds expose only XYZ through this API. Read the runtime
      // settings tree while Idle; no SD/config-file request during motion.
      const incomplete = RobotMotionSettings.jointLimits(config, controllerSettings).some((j) => j.rateFallback || j.acceleration === null);
      if (incomplete && status?.state === "Idle" && performance.now() - statusAt < 2000 && !program.busy && !live.active && !holding) {
        const raw = await call("sendQuery", { command: "[ESP400]" });
        controllerSettings = { ...controllerSettings, ...RobotMotionSettings.fromSettingsResponse(raw) };
      }
    } catch (error) {
      controllerLimitsError = `Could not read controller limits: ${error.message}`;
    } finally {
      controllerLimitsLoading = false;
      if (invalidatePlan && programMaximums && !program.busy && !programPreparing && (plan || planning)) invalidate();
      renderProgramMotion();
    }
  }
  async function useControllerMaximums(workspace) {
    if (programPreparing || program.busy || holding || live.active || live.busy)
      throw Error("Stop motion before changing joint limits.");
    if (!embedded || !statusAt || performance.now() - statusAt >= 2000 || status?.state !== "Idle")
      throw Error("Wait for fresh Idle telemetry before reading controller maximums.");
    const stamp = revision;
    await readControllerLimits({ invalidatePlan: false });
    if (stamp !== revision || programPreparing || program.busy || holding || live.active || live.busy || status?.state !== "Idle")
      throw Error("Controller limit update cancelled because the project or motion changed.");
    if (!statusAt || performance.now() - statusAt >= 2000)
      throw Error("Controller limit update cancelled because telemetry is stale.");
    config = RobotMotionSettings.applyMaximums(config, controllerSettings);
    stopPreview();
    if (workspace === "jog") {
      jogMaximums = true;
      $("speed").value = 100;
      $("speed-value").textContent = "100%";
    } else {
      programMaximums = true;
      $("program-speed-override").value = 100;
      $("program-speed-value").textContent = "100%";
      $("demo-duration").value = 0.1;
    }
    projectChanged();
    invalidate();
    renderProgramMotion();
    await call("sendRealtime", { byte: 0x90 });
    const limits = RobotMotionSettings.jointLimits(config, controllerSettings);
    message(`Axis maximums applied${limits.some((j) => j.rateFallback) ? " · Missing rates use 1200 units/min" : ""}${limits.some((j) => j.acceleration === null) ? " · Unavailable acceleration keeps configured limits" : ""} · Save project to keep them.`);
  }
  function renderProgramExecution(s) {
    const locked = programPreparing || s.active || s.startPending;
    if (s.phase !== programPhase && s.reset && referenced) clearReference("Program stopped with an invalid machine reference.");
    const labels = {
      idle: "Ready · one pass",
      checking: "Checking saved SD program…",
      saving: "Saving and verifying SD program…",
      saved: s.sdReused ? "SD program unchanged · ready to run" : "Program saved to /robot-studio.nc",
      starting: s.source === "sd" ? "Starting SD program…" : "Starting stream…",
      running: "Running · one pass",
      pausing: "Pausing…",
      paused: "Paused",
      resuming: "Resuming…",
      completed: s.plan?.home ? "Home pose reached" : s.plan?.waypoint ? `Reached ${s.plan.waypoint.name}` : s.plan?.demo ? `${s.plan.demo.title} complete · one pass` : "Completed · one pass",
      stopped: s.reset ? "Stopped · set manual reference again" : s.startPending ? "Cancelling program preparation…" : "Start cancelled",
      error: s.error,
    };
    $("program-state").textContent = programPreparing && !s.active ? preparingLabel : labels[s.phase];
    $("program-progress").value = s.percent;
    $("program-progress-label").textContent = `${Math.round(s.percent)}% · position estimate`;
    $("program-current-move").textContent = s.plan?.home ? "Return to configured home pose"
      : s.plan?.waypoint ? `Move to ${s.plan.waypoint.name}`
      : s.plan
      ? `${s.plan.demo ? "Stage" : "Waypoint"} ${s.move + 1} / ${s.plan.segments.length} · ${s.plan.segments[s.move]?.name || "Move"}`
      : "The arm follows reported joint positions during execution.";
    $("save-gcode").textContent = locked ? "Program active" : programSource === "sd" ? "Run from SD" : "Run on machine";
    $("save-gcode").disabled = locked || !embedded;
    $("save-gcode").hidden = locked;
    $("singularity-demo").disabled = locked;
    $("singularity-demo").hidden = locked;
    $("piston-demo").disabled = locked;
    $("piston-demo").hidden = locked;
    $("demo-tool-hint").hidden = locked;
    $("program-execution-feedback").hidden = s.phase === "idle" && !programPreparing;
    $("program-execution-actions").hidden = !locked;
    $("program-feed-actions").hidden = !s.active;
    for (const id of ["program-slower", "program-full-speed"])
      $(id).disabled = !s.active || !["running", "paused"].includes(s.phase);
    document.querySelector(".program-panel").classList.toggle("executing", locked);
    $("program-pause").textContent = s.phase === "paused" ? "Resume" : "Pause";
    $("program-pause").disabled = !s.active || !["running", "paused"].includes(s.phase);
    $("program-stop").disabled = !(s.active || programPreparing);
    for (const id of ["plan-program", "preview-program", "export-gcode", "teach-point", "configure", "import-project", "setup-home", "quick-reference", "manual-home", "mode-live", "home-pose", "move-type", "move-duration", "move-end-effector"])
      $(id).disabled = locked;
    document.querySelectorAll("[data-shortcut]").forEach((button) => {
      button.disabled = $(button.dataset.shortcut).disabled;
    });
    document.querySelectorAll(".program-panel input, .program-panel select, .waypoint button")
      .forEach((el) => { el.disabled = locked; });
    refreshProgramControls();
    renderEndEffector();
    document.querySelectorAll("#joint-controls input, #cartesian-panel input, #cartesian-panel select, #cartesian-panel button")
      .forEach((el) => { if (el.disabled !== locked) el.disabled = locked; });
    $("sync-machine").disabled = locked;
    document.querySelectorAll(".waypoint").forEach((card) => {
      card.classList.toggle("executing", s.active && !s.plan?.demo && !s.plan?.home && Number(card.dataset.point) === (s.plan?.waypoint?.index ?? s.move));
    });
    const demoActive = !!s.plan?.demo && s.active;
    $("waypoints").hidden = demoActive;
    $("demo-moves").hidden = !demoActive;
    if (demoActive) {
      if (displayedDemoPlan !== s.plan) {
        displayedDemoPlan = s.plan;
        $("demo-moves").replaceChildren();
        s.plan.segments.forEach((segment, i) => {
          const card = document.createElement("div"),
            name = document.createElement("strong"),
            detail = document.createElement("p");
          card.className = "waypoint";
          name.textContent = `${i + 1} · ${segment.name}`;
          detail.className = "hint";
          detail.textContent = segment.type === "MoveJ"
            ? "Positioning the arm"
            : s.plan.demo.detail;
          card.append(name, detail);
          $("demo-moves").append(card);
        });
      }
      Array.from($("demo-moves").children).forEach((card, i) => card.classList.toggle("executing", i === s.move));
    }
    $("stop").innerHTML = s.active || programPreparing
      ? "Stop program <kbd>Esc</kbd>"
      : "Stop <kbd>Esc</kbd>";
    if (s.phase !== programPhase) {
      programPhase = s.phase;
      message(labels[s.phase], s.phase === "error");
      if (s.phase === "completed" && referenced) {
        try { setPose(K.machineJoints(config, status), { edit: false }); } catch {}
      }
    }
    refreshVisualization();
    refreshMode();
    renderControllerLimits();
  }
  async function runMachineProgram({ saveOnly = false } = {}) {
    if (programPreparing || program.busy) throw Error("A program is already active.");
    if (!embedded) throw Error("Open Robot Studio in FluidUI to run the robot.");
    if (!points.length) throw Error("Teach at least one waypoint first.");
    if (!referenced) {
      if (saveOnly) throw Error("Set the manual reference before saving machine G-code.");
      await openManualHome({ runAfter: true });
      return;
    }
    const source = saveOnly ? "sd" : programSource;
    return runPhysicalProgram(async (start) => {
      const key = JSON.stringify([programMaximums, programMotionConfig(), points, endEffector, $("program-speed-override").value]);
      if (machinePlanCache?.key === key &&
          start.every((v, i) => Math.abs(v - machinePlanCache.plan.samples[0].q[i]) <= 0.25)) {
        showPlan(machinePlanCache.plan);
        return machinePlanCache.plan;
      }
      const result = await ensurePlan({ start, force: true });
      machinePlanCache = { key, plan: result };
      return result;
    }, saveOnly ? "Preparing SD program…" : "Planning from reported position…", { source, saveOnly });
  }
  async function buildDemo(kind, start, stamp) {
    const planner = kind === "piston" ? RobotPistonDemo : RobotSingularityDemo;
    const p = await planner.plan(programMotionConfig(), start, {
      speed: readNumber($("program-speed-override")) / 100,
      duration: readNumber($("demo-duration")),
      ...(kind === "piston"
        ? { axis: $("piston-axis").value, stroke: readNumber($("piston-stroke")) }
        : { axis: $("singularity-axis").value, angle: readNumber($("singularity-angle")) }),
      cancelled: () => stamp !== programRequestGeneration,
    });
    if (stamp !== programRequestGeneration) throw Error("Demo planning cancelled.");
    showPlan(p);
    return p;
  }
  async function runDemo(kind) {
    if (programPreparing || program.busy) throw Error("A program is already active.");
    const label = kind === "piston" ? "Planning piston demo…" : "Planning singularity crossing…",
      build = (start, stamp) => buildDemo(kind, start, stamp);
    const toolZ = readNumber($("demo-tool-length"));
    if (toolZ !== config.tool.z) {
      if (holding || live.active || live.busy)
        throw Error("Stop jogging before changing the demo tool extension.");
      if (embedded) freshMachine();
      const next = K.validateConfig({ ...config, tool: { ...config.tool, z: toolZ } });
      // The viewer, TCP readouts, planner and saved project must all use the
      // same tool. Keep taught joint poses when changing only the tool offset.
      applyProject({ config: next, q: [...q], points }, { preserveReference: true });
    }
    if (embedded) {
      if (!referenced) {
        await openManualHome({ demoAfter: kind });
        return;
      }
      return runPhysicalProgram(build, label);
    }
    const stamp = ++programRequestGeneration;
    preparingLabel = label;
    programPreparing = true;
    stopPreview();
    renderProgramExecution(program.state);
    try {
      const p = await build([...q], stamp);
      if (stamp !== programRequestGeneration) return;
      programPreparing = false;
      renderProgramExecution(program.state);
      await preview(p);
    } finally {
      if (stamp === programRequestGeneration) {
        programPreparing = false;
        renderProgramExecution(program.state);
      }
    }
  }
  async function jogToWaypoint(index) {
    if (programPreparing || program.busy || endEffectorBusy || holding)
      throw Error("Wait for the current operation to finish.");
    if (!embedded) throw Error("Open Robot Studio in FluidUI to move the physical arm.");
    if (!referenced) throw Error("Set the manual reference before jogging to a waypoint.");
    const point = points[index];
    if (!point) throw Error("This waypoint is no longer available.");
    const target = K.validateJoints(config, point.q), name = point.name;
    if (status?.state === "Idle" && freshMachine().every((angle, i) => Math.abs(angle - target[i]) <= 0.02)) {
      message(`Robot is already at ${name}.`);
      return;
    }
    return runPhysicalProgram((start) => {
      const segment = K.planSegment(programMotionConfig(), start, target, {
        type: "MoveJ", duration: 0.1, speed: readNumber($("program-speed-override")) / 100, controllerRamp: programMaximums,
      });
      return {
        waypoint: { index, name },
        samples: segment.samples,
        segments: [{ ...segment, name }],
        duration: segment.duration,
      };
    }, `Planning move to ${name}…`);
  }
  async function goHome() {
    if (programPreparing || program.busy || endEffectorBusy) throw Error("Wait for the current operation to finish.");
    if (!referenced) throw Error("Set the manual reference before returning home.");
    const home = K.validateJoints(config, config.joints.map((joint) => joint.home));
    if (status?.state === "Idle" && freshMachine().every((angle, i) => Math.abs(angle - home[i]) <= 0.02)) {
      message("Robot is already at its configured home pose.");
      return;
    }
    return runPhysicalProgram((start) => {
      const segment = K.planSegment(programMotionConfig(), start, home, {
        type: "MoveJ", duration: 0.1, speed: readNumber($("program-speed-override")) / 100, controllerRamp: programMaximums,
      });
      return {
        home: true,
        samples: segment.samples,
        segments: [{ ...segment, name: "Home pose" }],
        duration: segment.duration,
      };
    }, "Planning return home…");
  }
  async function runPhysicalProgram(build, label = "Planning from reported position…", options = {}) {
    if (endEffectorBusy) throw Error("Wait for the gripper command to finish.");
    const waitForNewIdle = live.active || live.busy || holding,
      after = waitForNewIdle ? performance.now() : 0,
      stamp = ++programRequestGeneration;
    programPreparing = true;
    preparingLabel = waitForNewIdle ? "Finishing jog control…" : label;
    renderProgramExecution(program.state);
    live.stop();
    stopPreview();
    cancelJog();
    try {
      await jogTransport.end();
      if (stamp !== programRequestGeneration) return;
      if (waitForNewIdle || !statusAt || performance.now() - statusAt >= 2000 || status?.state !== "Idle") {
        preparingLabel = "Waiting for fresh Idle position…";
        renderProgramExecution(program.state);
        await call("sendRealtime", { byte: 0x3f });
      }
      const startedAt = performance.now();
      while (status?.state !== "Idle" || !statusAt || performance.now() - statusAt >= 2000 || statusAt <= after) {
        if (stamp !== programRequestGeneration) return;
        if (!referenced || performance.now() - startedAt > 5000 || !["Idle", "Jog"].includes(status?.state))
          throw Error("Wait for fresh Idle telemetry before running a program.");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (stamp !== programRequestGeneration) return;
      // Use the startup/explicit-refresh snapshot. Runtime settings queries
      // must not block a Run request behind a potentially slow ESP400 read.
      if (preparingLabel !== label) {
        preparingLabel = label;
        renderProgramExecution(program.state);
      }
      const start = freshMachine(),
        p = await build(start, stamp);
      if (stamp !== programRequestGeneration) return;
      $("follow-machine").checked = true;
      $("enable-machine").checked = false;
      await program.run(config, p, options);
    } finally {
      if (stamp === programRequestGeneration) {
        programPreparing = false;
        renderProgramExecution(program.state);
      }
    }
  }
  async function preview(providedPlan = null) {
    if (program.active || programPreparing)
      throw Error("Stop the physical program before previewing.");
    live.stop();
    $("follow-machine").checked = false;
    if (playback) {
      if (playback.paused) {
        playback.start = performance.now() - playback.elapsed * 1000;
        playback.paused = false;
        playback.frame = requestAnimationFrame(playback.tick);
        $("preview-program").textContent = "Pause";
        $("viewer-state").textContent = "● Playing preview";
      } else {
        cancelAnimationFrame(playback.frame);
        playback.elapsed = (performance.now() - playback.start) / 1000;
        playback.paused = true;
        $("preview-program").textContent = "Resume";
        $("viewer-state").textContent = "Ⅱ Preview paused";
        message("Preview paused at current virtual pose.");
      }
      return;
    }
    if (holding) cancelJog();
    const p = providedPlan || await ensurePlan();
    setPose(p.samples[0].q, { edit: false });
    playback = { start: performance.now(), frame: 0, index: 1, gripper: gripperState, gripperCursor: 0,
      plan: p, move: 0, moveEnd: p.segments[0].duration };
    $("preview-program").textContent = "Pause";
    $("viewer-state").textContent = "● Playing preview";
    function tick(now) {
      if (!playback) return;
      const t = (now - playback.start) / 1000;
      while (playback.move < p.segments.length - 1 && t >= playback.moveEnd) {
        playback.move++;
        playback.moveEnd += p.segments[playback.move].duration;
      }
      while (
        playback.index < p.samples.length - 1 &&
        p.samples[playback.index].t < t
      )
        playback.index++;
      const b = p.samples[playback.index],
        a = p.samples[playback.index - 1],
        f = K.clamp((t - a.t) / (b.t - a.t), 0, 1);
      while (playback.gripperCursor < p.samples.length) {
        const index = playback.gripperCursor, sample = p.samples[index];
        // Gripper samples end an action's dwell. Show the action as soon as
        // the preceding motion arrives, then hold it throughout that dwell.
        const actionAt = sample.endEffector && index > 0 ? p.samples[index - 1].t : sample.t;
        if (actionAt > t) break;
        playback.gripperCursor++;
        const action = sample.endEffector;
        if (action) {
          playback.gripper = action;
          $("end-effector-preview").textContent = `Preview: ${action === "open" ? "Open" : "Close"} gripper`;
        }
      }
      setPose(
        a.q.map((v, i) => v + (b.q[i] - v) * f),
        { edit: false },
      );
      $("playback-time").textContent =
        `${Math.min(t, p.duration).toFixed(1)} / ${p.duration.toFixed(1)} s`;
      if (t >= p.duration) {
        stopPreview();
        message("Preview complete · Machine has not moved.");
        return;
      }
      playback.frame = requestAnimationFrame(tick);
    }
    playback.tick = tick;
    playback.frame = requestAnimationFrame(tick);
    updateMachine();
  }
  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type })),
      a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  function applyProject(p, { restoring = false, preserveReference = false } = {}) {
    if (program.busy || programPreparing || endEffectorBusy)
      throw Error("Stop the program before loading a project.");
    live.stop();
    reportedQ = null;
    $("follow-machine").checked = false;
    stopPreview();
    cancelJog();
    $("enable-machine").checked = false;
    const keepReference = preserveReference && referenced && referenceKey(p.config) === referenceKey() &&
      p.config.joints.every((joint, i) => joint.zero === config.joints[i].zero);
    if (restoring) referenced = false;
    else if (!keepReference) clearReference();
    config = p.config;
    programMaximums = p.programMaximums ?? programMaximums;
    programSource = p.programSource ?? "stream";
    $("program-source").value = programSource;
    jogMaximums = p.jogMaximums ?? jogMaximums;
    endEffector = K.validateEndEffector(p.endEffector ?? endEffector);
    renderEndEffectorSettings();
    q = p.q;
    points = p.points;
    pointUndo.length = pointRedo.length = 0;
    renderProgramMotion();
    renderJoints();
    renderPoints();
    viewer?.configure(config, q);
    setPose(q);
    currentTarget();
    updateMachine();
  }
  async function saveProject() {
    if (savingProject || restoringSettings) return;
    const p = K.validateProject(project()), stamp = projectVersion;
    savingProject = true;
    saveFailed = false;
    renderSaveState();
    try {
      if (embedded) {
        await call("saveSettings", { data: p });
      } else {
        localStorage.setItem("figui.robot-studio.v1", JSON.stringify(p));
      }
      savedVersion = stamp;
      hasSavedProject = true;
      rememberBrowserProject();
      message(`Project saved ${embedded ? "to the FigUI controller" : "in this browser"}.${stamp !== projectVersion ? " Newer edits still need saving." : ""}`);
    } catch (error) {
      saveFailed = true;
      throw Error(`Project could not be saved. ${embedded ? error.message : "Browser storage is unavailable."} Export a backup or try Save project again.`);
    } finally {
      savingProject = false;
      renderSaveState();
      void rememberReference().catch(() => {});
    }
  }
  async function restoreProject({ ask = false, fromSession = false } = {}) {
    if (restoringSettings) return;
    if (programPreparing || program.busy || live.active || live.busy || holding || endEffectorBusy)
      throw Error("Stop motion before restoring a saved project.");
    if (embedded && (!statusAt || performance.now() - statusAt >= 2000 || status?.state !== "Idle"))
      throw Error("Wait until the controller is Idle before restoring settings.");
    if (ask && projectVersion !== savedVersion && !await confirmReplacement(
      "Restore saved project?", "Unsaved changes will be replaced by the saved project. Export a backup first if you need to keep them.", "Restore project",
    )) return;
    const stamp = revision;
    restoringSettings = true;
    renderSaveState();
    $("retry-settings").hidden = true;
    message("Loading saved project…");
    try {
      let saved, cached = null;
      if (embedded) {
        const session = await call("getSessionState").catch(() => null);
        if (session && (!controllerSession || session.generation >= controllerSession.generation)) {
          controllerSession = session;
          cached = fromSession ? (session.data?.project ? session.data : session.recovery?.project ? session.recovery : null) : null;
        }
        // Reopening a panel on the same connection restores the in-memory
        // workspace, including an unsaved robot model and its calibration.
        if (!cached && fromSession) cached = await readBrowserProject();
        saved = cached ? cached.project : await call("getSettings");
      }
      else {
        if (!ask) cached = await readBrowserProject();
        const raw = cached ? null : localStorage.getItem("figui.robot-studio.v1");
        saved = cached ? cached.project : raw ? JSON.parse(raw) : null;
      }
      // A delayed SD response must never replace edits or an active motion.
      if (stamp !== revision || programPreparing || program.busy || live.active || live.busy || holding || endEffectorBusy) {
        $("retry-settings").hidden = false;
        message("Saved project was not restored because the workspace changed. Your edits are kept.");
        return;
      }
      if (embedded && (!statusAt || performance.now() - statusAt >= 2000 || status?.state !== "Idle")) {
        if (fromSession && cached) {
          startupRestorePending = true;
          startupRestoreRevision = revision;
        }
        $("retry-settings").hidden = false;
        message("Saved project loading deferred · Retry when the controller is Idle.");
        return;
      }
      if (saved?.format) {
        applyProject(K.validateProject(saved), { restoring: true });
        savedVersion = projectVersion;
        hasSavedProject = true;
        if (cached) {
          projectVersion = Number.isSafeInteger(cached.projectVersion) ? cached.projectVersion : projectVersion;
          savedVersion = Number.isSafeInteger(cached.savedVersion) ? cached.savedVersion : 0;
          hasSavedProject = cached.hasSavedProject === true;
        }
        rememberBrowserProject();
        message(cached ? "Last robot workspace restored." : K.isParallelElbowLayout(config)
          ? "Saved project restored."
          : "Saved project restored · This project uses custom joint geometry.");
      } else message("Ready · No saved project found.");
      await restoreReference();
    } catch (error) {
      if (stamp === revision) {
        $("retry-settings").hidden = false;
        message(`Saved project could not be loaded: ${error.message} Retry when the controller is Idle.`, true);
      }
    } finally {
      restoringSettings = false;
      renderSaveState();
    }
  }
  function editConfig(c = config) {
    disposeConfigPreview();
    $("config-name").value = c.name;
    $("dh-rows").replaceChildren();
    $("mapping-rows").replaceChildren();
    $("limits-rows").replaceChildren();
    $("config-error").textContent = "";
    c.joints.forEach((j, i) => {
      const row = document.createElement("tr"),
        label = document.createElement("td");
      label.textContent = `J${i + 1}`;
      row.dataset.jointName = j.name || "";
      label.title = j.name || jointNames[i];
      row.append(label);
      const limitRow = document.createElement("tr"),
        limitLabel = document.createElement("td");
      limitLabel.textContent = `J${i + 1} · ${j.name || jointNames[i]}`;
      limitRow.append(limitLabel);
      $("limits-rows").append(limitRow);
      for (const key of [
        "a",
        "d",
        "alpha",
        "offset",
        "min",
        "max",
        "home",
        "velocity",
        "acceleration",
      ]) {
        const cell = document.createElement("td");
        cell.append(
          inputNumber(j[key], {
            id: `dh-${i}-${key}`,
            "aria-label": `Joint ${i + 1} ${key}`,
            required: "",
          }),
        );
        (["a", "d", "alpha", "offset"].includes(key) ? row : limitRow).append(
          cell,
        );
      }
      $("dh-rows").append(row);
      const mapping = document.createElement("tr");
      mapping.innerHTML = `<td>J${i + 1}</td><td><select id="map-${i}-axis" aria-label="Joint ${i + 1} axis">${[..."XYZABC"].map((a) => `<option>${a}</option>`).join("")}</select></td>`;
      for (const key of ["scale", "zero"]) {
        const cell = document.createElement("td");
        cell.append(
          inputNumber(j[key], {
            id: `map-${i}-${key}`,
            "aria-label": `Joint ${i + 1} ${key}`,
            required: "",
          }),
        );
        mapping.append(cell);
      }
      $("mapping-rows").append(mapping);
      $(`map-${i}-axis`).value = j.axis;
    });
    renderDimensions(c);
    renderAppearance(c);
    poseFields($("base-fields"), "base", c.base);
    poseFields($("tool-fields"), "tool", c.tool);
    if (!$("config-dialog").open) $("config-dialog").showModal();
    void openConfigPreview(c);
  }
  const dimensions = [
    ["d1", 0, "d", "Base height", 1],
    ["a2", 1, "a", "Upper arm", -1],
    ["a3", 2, "a", "Forearm", -1],
    ["d4", 3, "d", "Shoulder offset", 1],
    ["d5", 4, "d", "Wrist offset", 1],
    ["d6", 5, "d", "Flange offset", 1],
  ];
  const dimensionDescriptions = {
    d1: "Base plane → shoulder axis (J2).",
    a2: "Shoulder axis (J2) → elbow axis (J3).",
    a3: "Elbow axis (J3) → wrist 1 axis (J4).",
    d4: "Shoulder-to-wrist plane offset, along the parallel joint axes.",
    d5: "Wrist 1 axis (J4) → wrist 3 axis (J6), along the wrist 2 axis.",
    d6: "Wrist 2 axis (J5) → mounting flange, along the final rotation axis.",
  };
  function selectConfigDimension(key) {
    configPreviewKey = key;
    document.querySelectorAll(".dimension-fields label").forEach((label) =>
      label.classList.toggle("selected", label.id === `dimension-label-${key}`),
    );
    const dimension = dimensions.find(([id]) => id === key);
    if (dimension && configPreviewModel && K.isParallelElbowLayout(configPreviewModel)) {
      const [, i, dh, name] = dimension;
      const value = Math.abs(configPreviewModel.joints[i][dh]).toLocaleString(undefined, { maximumFractionDigits: 3 });
      $("config-measurement").textContent = `${name} · ${key} · ${value} mm`;
      $("dimension-help").textContent = dimensionDescriptions[key];
      configViewer?.measurement(key);
    } else {
      $("config-measurement").textContent = "Custom DH geometry · edit the advanced geometry below.";
      $("dimension-help").textContent = "Use Advanced DH geometry for this joint arrangement.";
      configViewer?.measurement(null);
    }
  }
  function syncConfigDimensions(c) {
    const parallelElbow = K.isParallelElbowLayout(c);
    $("dimension-fields").hidden = !parallelElbow;
    $("config-dimensions-title").textContent = parallelElbow ? "Dimensions · mm" : "Custom geometry";
    $("config-layout-hint").hidden = !parallelElbow;
    dimensions.forEach(([key]) => { $(`dimension-${key}`).disabled = !parallelElbow; });
  }
  function renderDimensions(c) {
    $("dimension-fields").replaceChildren();
    dimensions.forEach(([key, i, dh, name, sign]) => {
      const label = document.createElement("label");
      label.id = `dimension-label-${key}`;
      label.textContent = `${name} · ${key}`;
      const input = inputNumber(Math.abs(c.joints[i][dh]), {
        id: `dimension-${key}`, min: "0.1", max: "10000", step: "any", required: "",
      });
      label.append(input);
      $("dimension-fields").append(label);
      input.onfocus = () => selectConfigDimension(key);
      input.oninput = () => {
        // An unfinished number must not become zero in the underlying geometry.
        $(`dh-${i}-${dh}`).value = Number.isFinite(input.valueAsNumber)
          ? input.valueAsNumber * sign : "";
        selectConfigDimension(key);
        queueConfigPreview();
      };
      $(`dh-${i}-${dh}`).onfocus = () => selectConfigDimension(key);
      $(`dh-${i}-${dh}`).oninput = (e) => {
        input.value = Number.isFinite(e.target.valueAsNumber) ? Math.abs(e.target.valueAsNumber) : "";
      };
    });
    syncConfigDimensions(c);
  }
  function renderAppearance(c) {
    $("appearance-rows").replaceChildren();
    const names = ["Base", "Upper arm", "Forearm", "Wrist 1", "Wrist 2", "Flange / tool"];
    names.forEach((name, i) => {
      const row = document.createElement("tr"), heading = document.createElement("th");
      heading.scope = "row";
      heading.textContent = `J${i + 1} · ${name}`;
      row.append(heading);
      for (const key of ["links", "joints"]) {
        const cell = document.createElement("td");
        const input = inputNumber(c.appearance?.[key]?.[i] ?? "", {
          id: `appearance-${key}-${i}`, min: "0.1", max: "10000", step: "any",
          "aria-label": `J${i + 1} ${name} ${key === "links" ? "link" : "joint"} diameter in millimetres`,
          "aria-describedby": "appearance-help",
        });
        input.oninput = queueConfigPreview;
        cell.append(input);
        row.append(cell);
      }
      $("appearance-rows").append(row);
    });
    syncAppearancePlaceholders(c);
  }
  function syncAppearancePlaceholders(c) {
    const sizes = K.visualSizes(c);
    for (const [key, radii] of [["links", sizes.linkRadii], ["joints", sizes.radii]]) {
      radii.forEach((radius, i) => {
        $(`appearance-${key}-${i}`).placeholder = `Auto: ${Number((radius * 2).toFixed(1))}`;
      });
    }
  }
  function disposeConfigPreview() {
    configPreviewGeneration++;
    if (configPreviewFrame !== null) cancelAnimationFrame(configPreviewFrame);
    configPreviewFrame = null;
    configViewer?.dispose();
    configViewer = null;
    configPreviewModel = null;
  }
  async function openConfigPreview(c) {
    const generation = configPreviewGeneration;
    configPreviewModel = c;
    configPreviewView = "perspective";
    configPreviewKey = "d1";
    $("config-viewer-loading").hidden = false;
    $("config-viewer-loading").textContent = "Loading 3D preview…";
    $("config-preview-status").textContent = "Preview shows your home pose. Changes take effect when you apply.";
    $("config-preview-status").classList.remove("error");
    document.querySelectorAll("[data-config-view]").forEach((button) =>
      button.setAttribute("aria-pressed", String(button.dataset.configView === configPreviewView)),
    );
    selectConfigDimension(configPreviewKey);
    try {
      const preview = await createRobotViewer($("config-viewer"), c, c.joints.map((j) => j.home), { measurements: true });
      if (generation !== configPreviewGeneration || !$("config-dialog").open) {
        preview.dispose();
        return;
      }
      configViewer = preview;
      preview.labels(true);
      preview.measurement(K.isParallelElbowLayout(c) ? configPreviewKey : null);
      $("config-viewer-loading").hidden = true;
    } catch {
      if (generation !== configPreviewGeneration) return;
      $("config-viewer-loading").textContent = "3D preview unavailable. Enable WebGL and reopen configuration. You can still edit and apply dimensions.";
    }
  }
  function queueConfigPreview() {
    if (configPreviewFrame !== null) cancelAnimationFrame(configPreviewFrame);
    configPreviewFrame = requestAnimationFrame(() => {
      configPreviewFrame = null;
      if (!$("config-dialog").open) return;
      try {
        const next = readConfigForm(true);
        // Keep the user's orbit and zoom while typing so length changes remain visible.
        configViewer?.configure(next, next.joints.map((j) => j.home), { fit: false });
        configPreviewModel = next;
        syncConfigDimensions(next);
        syncAppearancePlaceholders(next);
        selectConfigDimension(configPreviewKey);
        $("config-preview-status").classList.remove("error");
        $("config-preview-status").textContent = "Preview shows your home pose. Changes take effect when you apply.";
      } catch (error) {
        $("config-preview-status").classList.add("error");
        $("config-preview-status").textContent = `Showing last valid preview. ${error.message}`;
      }
    });
  }
  async function openManualHome({ liveAfter = false, runAfter = false, demoAfter = false } = {}) {
    if (program.active || programPreparing)
      throw Error("Stop the program before changing its reference.");
    liveAfterReference = liveAfter;
    runAfterReference = runAfter;
    demoAfterReference = demoAfter;
    live.stop();
    stopPreview();
    cancelJog();
    $("enable-machine").checked = false;
    $("record-home").disabled = !referenceAvailable();
    $("record-home").textContent = demoAfter
      ? `Confirm pose & run ${demoAfter === "piston" ? "piston" : "singularity crossing"} demo`
      : runAfter
      ? "Confirm pose & run program"
      : liveAfter
      ? "Confirm pose & enable live controls"
      : "Confirm pose & record reference";
    $("home-error").textContent = embedded
      ? ""
      : "Open this plugin in FluidUI to record the physical reference.";
    renderHomeAngles();
    $("home-dialog").showModal();
    try {
      homeViewer = await createRobotViewer(
        $("home-viewer"),
        config,
        config.joints.map((j) => j.home),
      );
      homeViewer.labels(true);
      if (!$("home-dialog").open) {
        homeViewer.dispose();
        homeViewer = null;
      }
    } catch (e) {
      $("home-error").textContent =
        `Reference viewer: ${e.message}. Use the six joint angles shown.`;
    }
  }
  function renderHomeAngles() {
    $("home-upright-option").hidden = !K.isParallelElbowLayout(config);
    $("home-angles").replaceChildren();
    config.joints.forEach((j, i) => {
      const div = document.createElement("div"),
        span = document.createElement("span"),
        strong = document.createElement("strong");
      span.textContent = `J${i + 1} · ${j.name || jointNames[i]}`;
      strong.textContent = `${j.home}°`;
      div.append(span, strong);
      $("home-angles").append(div);
    });
  }
  function useUprightHome() {
    try {
      const home = K.uprightHome(config);
      config = {
        ...config,
        joints: config.joints.map((j, i) => ({ ...j, home: home[i] })),
      };
      projectChanged();
      clearReference();
      reportedQ = null;
      $("enable-machine").checked = false;
      $("follow-machine").checked = false;
      invalidate();
      renderHomeAngles();
      homeViewer?.configure(config, home);
      refreshVisualization();
      updateMachine();
      $("home-error").textContent = "";
      message(
        "Upright homing pose selected · Align the physical arm and confirm, then Save project.",
      );
    } catch (e) {
      $("home-error").textContent = e.message;
    }
  }
  function referenceAvailable() {
    return (
      embedded &&
      statusAt &&
      performance.now() - statusAt < 2000 &&
      status?.state === "Idle" &&
      !status.sdFilename &&
      status?.mpos &&
      config.joints.every((j) =>
        Number.isFinite(status.mpos[j.axis.toLowerCase()]),
      )
    );
  }
  function recordHome() {
    try {
      if (!referenceAvailable())
        throw Error("Fresh Idle telemetry is required to record a reference.");
      const next = K.referenceConfig(config, status);
      config = next;
      referenced = true;
      referenceReason = "";
      liveFault = false;
      void rememberReference().catch((e) => message(`Reference recorded for this window. ${e.message}`, true));
      reportedQ = K.machineJoints(config, status);
      setPose(config.joints.map((j) => j.home));
      currentTarget();
      const enterLive = liveAfterReference;
      const runProgram = runAfterReference;
      const demoKind = demoAfterReference;
      liveAfterReference = false;
      runAfterReference = false;
      demoAfterReference = false;
      $("home-dialog").close();
      updateMachine();
      if (demoKind) {
        void runDemo(demoKind).catch((e) => message(e.message, true));
        return;
      }
      if (runProgram) {
        void runMachineProgram().catch((e) => message(e.message, true));
        return;
      }
      if (enterLive) {
        void enableLiveControls().catch((e) => message(e.message, true));
        return;
      }
      message(
        "Manual home reference recorded · Save project to keep the joint zero offsets.",
      );
    } catch (e) {
      $("home-error").textContent = e.message;
    }
  }
  function readConfigForm(preview = false) {
    const read = preview ? (input) => {
      if (!input.value.trim() || !Number.isFinite(input.valueAsNumber) || !input.validity.valid)
        throw Error("Finish entering a valid value to update the preview.");
      return input.valueAsNumber;
    } : readNumber;
    const readFrame = (prefix) => Object.fromEntries(poseKeys.map((key) => [key, read($(`${prefix}-${key}`))]));
    const appearance = Object.fromEntries(["links", "joints"].map((key) => [key,
      Array.from({ length: 6 }, (_, i) => {
        const input = $(`appearance-${key}-${i}`);
        if (input.validity.badInput || input.value.trim()) return read(input);
        return null;
      }),
    ]));
    if (preview && K.isParallelElbowLayout(configPreviewModel)) {
      dimensions.forEach(([key]) => { read($(`dimension-${key}`)); });
    }
    const joints = Array.from({ length: 6 }, (_, i) => {
      const j = { axis: $(`map-${i}-axis`).value };
      const name = $("dh-rows").children[i].dataset.jointName;
      if (name) j.name = name;
      for (const key of [
        "a",
        "d",
        "alpha",
        "offset",
        "min",
        "max",
        "home",
        "velocity",
        "acceleration",
      ])
        j[key] = read($(`dh-${i}-${key}`));
      for (const key of ["scale", "zero"])
        j[key] = read($(`map-${i}-${key}`));
      return j;
    });
    return K.validateConfig({
      name: $("config-name").value,
      joints,
      base: readFrame("base"),
      tool: readFrame("tool"),
      appearance,
    });
  }
  async function submitConfig(e) {
    e.preventDefault();
    try {
      const next = readConfigForm();
      const physicalDefinition = ({ appearance, ...model }) => JSON.stringify(model);
      if (physicalDefinition(next) === physicalDefinition(K.validateConfig(config))) {
        if (program.busy || programPreparing || endEffectorBusy)
          throw Error("Stop the program before applying appearance changes.");
        config = next;
        revision++;
        viewer?.configure(config, q, { fit: false });
        projectChanged();
        $("config-dialog").close();
        message("Robot appearance applied · Save project to keep it.");
        return;
      }
      const geometry = (model) => JSON.stringify({
        base: model.base, tool: model.tool,
        joints: model.joints.map(({ a, d, alpha, offset }) => ({ a, d, alpha, offset })),
      });
      let keepPoints = geometry(config) === geometry(next);
      if (keepPoints) {
        try { points.forEach((point) => K.validateJoints(next, point.q)); }
        catch { keepPoints = false; }
      }
      let nextPose = next.joints.map((j) => j.home);
      if (keepPoints) {
        try { nextPose = K.validateJoints(next, q); } catch { /* Use the new home if the target is outside the limits. */ }
      }
      if (points.length && !keepPoints && !await confirmReplacement(
        "Apply a new robot definition?",
        `The geometry or travel limits are incompatible with the current program. This clears ${points.length} taught waypoint${points.length === 1 ? "" : "s"}. Joint calibration changes also clear the manual reference. Export the project first to keep a copy.`,
        "Apply and clear waypoints",
      )) return;
      applyProject({
        config: next,
        q: nextPose,
        points: keepPoints ? points : [],
      }, { preserveReference: true });
      $("config-dialog").close();
      message(`Robot configuration applied${keepPoints && points.length ? " · Waypoints retained" : ""} · Save project to keep it.`);
    } catch (err) {
      $("config-error").textContent = err.message;
    }
  }
  function freshMachine() {
    if (!embedded)
      throw Error("Open Robot Studio in FigUI to access a machine.");
    if (performance.now() - statusAt > 2000 || !statusAt)
      throw Error("Waiting for fresh machine telemetry.");
    if (status?.state !== "Idle")
      throw Error(
        `Machine must be Idle (currently ${status?.state || "offline"}).`,
      );
    if (status.sdFilename) throw Error("Wait for the open controller program to finish.");
    return K.machineJoints(config, status);
  }
  function requestFreshPosition() {
    const now = performance.now();
    if (!embedded || document.hidden || now - positionRequestAt < 1000) return;
    positionRequestAt = now;
    // Request real telemetry; getStatus alone can return the host's cached
    // position and must not be used to make an old report look fresh.
    void call("sendRealtime", { byte: 0x3f }).catch(() => {});
  }
  function updateMachine() {
    const fresh = statusAt && performance.now() - statusAt < 2000 && status?.state !== "Unknown";
    if (!fresh || status?.state === "Unknown") requestFreshPosition();
    $("machine-state").textContent = fresh
      ? (status?.state || "UNKNOWN").toUpperCase()
      : "OFFLINE";
    if (fresh && referenced) {
      try {
        reportedQ = K.machineJoints(config, status);
      } catch (e) {
        reportedQ = null;
        live.stop(`Live control stopped: ${e.message}`);
        $("enable-machine").checked = false;
      }
    }
    if (directJog && reportedQ) setPose(reportedQ, { edit: false });
    let valid = false;
    try {
      freshMachine();
      valid = true;
    } catch {}
    $("machine-move").disabled =
      !holding &&
      (!valid ||
        !referenced ||
        !$("enable-machine").checked ||
        !!playback || program.busy || programPreparing || endEffectorBusy ||
        live.active ||
        live.busy);
    if (!fresh) {
      live.stop("Live control stopped: machine telemetry is stale.");
    }
    $("reference-state").textContent = referenced
      ? fresh ? "Reference set · valid for this controller connection." : "Reference retained · waiting for fresh telemetry."
      : recoveryConfig() ? "Reference paused · Recover reference if FluidNC retained its coordinates, or set a new reference."
      : `Manual reference required before physical motion.${referenceReason ? ` ${referenceReason}` : ""}`;
    $("record-home").disabled = !referenceAvailable();
    renderReadiness(fresh, valid);
    renderRecovery();
    if (!fresh && $("enable-machine").checked) {
      $("enable-machine").checked = false;
      if (holding) cancelJog();
    }
    program.tick();
    refreshMode();
    refreshVisualization();
    renderControllerLimits();
    renderEndEffector();
    refreshProgramControls();
  }
  function renderReadiness(fresh, valid) {
    const busy = programPreparing || program.busy || endEffectorBusy;
    let title, detail;
    if (!embedded) {
      title = "Simulation workspace";
      detail = "Teach and preview here. Open in FluidUI for machine control.";
    } else if (!fresh) {
      title = referenced ? "Waiting for position · reference retained" : "Controller unavailable";
      detail = referenced
        ? "Requesting fresh position feedback. Jogging resumes from the reported position."
        : "Waiting for fresh position feedback. Motion is unavailable.";
    } else if (busy) {
      title = endEffectorBusy ? "Operating gripper" : "Program in progress";
      detail = endEffectorBusy ? "The gripper command is running." : "Use Pause or Stop in Program to control this run.";
    } else if (live.active) {
      title = "Live machine control";
      detail = "Joint controls move the physical arm. Release a jog to stop.";
    } else if (status?.state !== "Idle") {
      title = `Controller · ${status?.state || "Unknown"}`;
      detail = "The controller must be Idle before enabling motion.";
    } else if (!referenced) {
      title = "Controller idle · reference needed";
      detail = referenceReason || "Set the physical home reference before moving the machine.";
    } else if (!valid) {
      title = "Machine feedback needs attention";
      detail = "Check axis positions, joint limits, and any open controller job.";
    } else {
      title = "Controller idle · reference set";
      detail = liveFault
        ? "Live controls paused; reference retained. Choose Live joints to retry."
        : livePreferred ? "Live joints resumes when you return to the joint controls." : "Choose Live joints to jog, or preview a waypoint program.";
    }
    $("machine-move").title = !embedded || !fresh || busy || live.active || !referenced || !valid
      ? `${title} · ${detail}`
      : !$("enable-machine").checked
        ? "Enable calibrated axis mapping under Physical machine connection."
        : "Hold to jog the physical arm to the virtual pose. Release to cancel.";
    $("recover-reference").hidden = !embedded || referenced || !recoveryConfig();
    $("recover-reference").disabled = busy || restoringSettings || !referenceAvailable();
    $("mode-live").disabled = busy || !embedded || !fresh || (!live.active && status?.state !== "Idle");
    $("mode-live").title = !embedded ? "Open in FluidUI to control a machine" : !fresh ? "Waiting for fresh controller feedback" : "Enable physical joint control";
    $("go-home").disabled = busy || !embedded || !referenced || !fresh || !["Idle", "Jog"].includes(status?.state) || !!status?.sdFilename;
    $("go-home").textContent = program.active && program.state.plan?.home ? "Going home…" : "Go home";
    $("go-home").title = !referenced ? "Set the manual reference first" : "Move the robot to its configured home pose";
    document.querySelectorAll('[data-shortcut="go-home"]').forEach((button) => {
      button.disabled = $("go-home").disabled;
      button.title = $("go-home").title;
      button.setAttribute("aria-label", $("go-home").textContent);
    });
    $("sync-machine").disabled = busy || !referenced || !valid;
    $("sync-machine").title = !referenced ? "Set the manual reference first" : !valid ? "Requires fresh Idle machine positions" : "Copy reported joint angles to the virtual pose";
    $("run-readiness").textContent = busy ? "" : !points.length
      ? "Add a waypoint to create a program."
      : !embedded ? "Preview available. Open in FluidUI to run on a machine."
      : !fresh ? "Waiting for controller feedback before running."
      : !["Idle", "Jog"].includes(status?.state) ? "Wait for the controller to be Idle before starting a program."
      : !referenced ? "Run will first ask you to set the physical home reference."
      : "Runs once from the current machine pose through all waypoints.";
    $("save-gcode").disabled = busy || !points.length || !embedded || !fresh || !["Idle", "Jog"].includes(status?.state);
  }
  async function startJog(e) {
    if (endEffectorBusy) throw Error("Wait for the gripper command to finish.");
    if (program.busy || programPreparing) throw Error("Stop the program before jogging.");
    if (e.type === "pointerdown" && e.button !== 0) return;
    if (holding) return;
    if (live.active || live.busy)
      throw Error("Turn off live joint control before using Hold to jog.");
    e.preventDefault();
    if (!$("enable-machine").checked)
      throw Error("Enable the calibrated axis mapping first.");
    if (!referenced)
      throw Error("Record the manual home reference before physical motion.");
    const actual = freshMachine();
    stopPreview();
    const command = K.jogCommand(
      motionConfig(),
      actual,
      q,
      Number($("speed").value) / 100,
    );
    holding = true;
    $("follow-machine").checked = true;
    updateMachine();
    const generation = ++jogGeneration;
    $("machine-move").classList.add("moving");
    if (e.pointerId !== undefined)
      $("machine-move").setPointerCapture(e.pointerId);
    message("Machine joint jog active · Keep holding. Release to cancel.");
    try {
      await call("sendCommand", { command });
      if (!holding || generation !== jogGeneration)
        await call("sendRealtime", { byte: 0x85 });
    } catch (err) {
      cancelJog();
      $("enable-machine").checked = false;
      throw err;
    }
  }
  function cancelJog() {
    const wasHolding = holding;
    holding = false;
    jogGeneration++;
    $("machine-move").classList.remove("moving");
    if (wasHolding)
      call("sendRealtime", { byte: 0x85 }).catch((err) =>
        message(`Jog cancel failed: ${err.message}`, true),
      );
    updateMachine();
  }
  function stop() {
    viewer?.cancelTcpDrag();
    programRequestGeneration++;
    programPreparing = false;
    const hadProgram = program.active;
    program.stop();
    live.stop();
    stopPreview();
    if (planning) revision++;
    cancelJog();
    renderProgramExecution(program.state);
    if (!hadProgram) message("Preview stopped · Jog cancel requested if active.");
  }
  function selectWorkspace(workspace) {
    viewer?.cancelTcpDrag();
    const isProgram = workspace === "program";
    live.stop();
    cancelJog();
    document.querySelector(".control-panel").hidden = isProgram;
    document.querySelector(".program-panel").hidden = !isProgram;
    document.querySelector(".workspace").classList.toggle("program-view", isProgram);
    document.querySelectorAll("[data-workspace]").forEach((button) => {
      const active = button.dataset.workspace === workspace;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    refreshTcpJog();
  }
  function bindInfoHelp() {
    let active = null, closeTimer;
    function close() {
      clearTimeout(closeTimer);
      if (!active) return;
      const { popup, button } = active;
      active = null;
      if (typeof popup.hidePopover === "function" && popup.matches(":popover-open")) popup.hidePopover();
      popup.hidden = true;
      button.setAttribute("aria-expanded", "false");
    }
    function position() {
      if (!active) return;
      const { button, popup } = active, rect = button.getBoundingClientRect();
      if (!button.getClientRects().length || button.closest("dialog:not([open])")) { close(); return; }
      const width = popup.offsetWidth, height = popup.offsetHeight;
      popup.style.left = `${Math.max(8, Math.min(rect.right - width, innerWidth - width - 8))}px`;
      const below = rect.bottom + 8;
      popup.style.top = `${Math.max(8, below + height <= innerHeight - 8 ? below : rect.top - height - 8)}px`;
    }
    function show(help, pinned = false) {
      clearTimeout(closeTimer);
      if (active?.button === help.button) { active.pinned ||= pinned; return; }
      close();
      active = { ...help, pinned };
      help.popup.hidden = false;
      if (typeof help.popup.showPopover === "function") help.popup.showPopover();
      help.button.setAttribute("aria-expanded", "true");
      position();
    }
    function leave(help) {
      clearTimeout(closeTimer);
      closeTimer = setTimeout(() => {
        if (active?.button === help.button && !active.pinned &&
            document.activeElement !== help.button && !help.popup.matches(":hover")) close();
      }, 150);
    }
    document.querySelectorAll("[data-info]").forEach((source, index) => {
      const previous = source.previousElementSibling;
      const wrapper = document.createElement("span"), button = document.createElement("button"), popup = document.createElement("div");
      wrapper.className = "info-help";
      button.type = "button";
      button.className = "info-button";
      button.setAttribute("aria-label", `About ${source.dataset.info}`);
      button.setAttribute("aria-expanded", "false");
      popup.id = `info-tooltip-${index}`;
      popup.className = "info-tooltip";
      popup.setAttribute("role", "tooltip");
      if (typeof popup.showPopover === "function") popup.setAttribute("popover", "manual");
      popup.hidden = true;
      button.setAttribute("aria-controls", popup.id);
      button.setAttribute("aria-describedby", popup.id);
      button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7" r=".7"/></svg>';
      source.before(wrapper);
      wrapper.append(button, popup);
      popup.append(source);
      if (previous?.matches(".section-intro, .button-row, .rose-toolbar, .config-preview-heading, h3")) previous.append(wrapper);
      else if (previous?.matches("button, label")) {
        const row = document.createElement("div");
        row.className = "info-anchor";
        previous.before(row);
        row.append(previous, wrapper);
      }
      const help = { button, popup };
      const sync = () => {
        wrapper.hidden = source.hidden || !source.textContent.trim();
        if (active?.button === button) { if (wrapper.hidden) close(); else position(); }
      };
      new MutationObserver(sync).observe(source, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["hidden"] });
      sync();
      wrapper.addEventListener("pointerenter", (event) => { if (event.pointerType !== "touch") show(help); });
      wrapper.addEventListener("pointerleave", () => leave(help));
      popup.addEventListener("pointerenter", () => clearTimeout(closeTimer));
      popup.addEventListener("pointerleave", () => leave(help));
      button.addEventListener("focus", () => show(help));
      button.addEventListener("blur", () => leave(help));
      button.addEventListener("click", (event) => {
        event.preventDefault(); event.stopPropagation();
        if (active?.button === button && active.pinned) close(); else show(help, true);
      });
    });
    document.addEventListener("pointerdown", (event) => {
      if (active && !active.button.contains(event.target) && !active.popup.contains(event.target)) close();
    }, true);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && active) { close(); event.preventDefault(); }
    }, true);
    document.addEventListener("scroll", (event) => {
      if (active && !active.popup.contains(event.target)) close();
    }, true);
    document.addEventListener("toggle", (event) => {
      if (active && event.target.tagName === "DETAILS") close();
    }, true);
    document.addEventListener("close", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
  }
  function bind() {
    bindInfoHelp();
    const statusSize = new ResizeObserver(([entry]) => {
      document.documentElement.style.setProperty("--statusbar-height", `${entry.target.getBoundingClientRect().height}px`);
    });
    statusSize.observe(document.querySelector(".statusbar"));
    document.querySelectorAll("[data-tab]").forEach(
      (b) =>
        (b.onclick = () => {
          viewer?.cancelTcpDrag();
          const enteringCartesian = b.dataset.tab === "cartesian" && $("cartesian-panel").hidden;
          if (b.dataset.tab !== "joint") { live.stop(); cancelJog(); }
          $("end-effector-controls").hidden = b.dataset.tab === "setup";
          document.querySelectorAll("[data-tab]").forEach((t) => {
            const active = b === t;
            t.classList.toggle("active", active);
            t.setAttribute("aria-selected", String(active));
            t.tabIndex = active ? 0 : -1;
            $(`${t.dataset.tab}-panel`).hidden = !active;
          });
          if (enteringCartesian) currentTarget();
          refreshTcpJog();
        }),
    );
    $("toggle-tcp-jog").onclick = action(() => {
      tcpJogEnabled = !tcpJogEnabled;
      if (tcpJogEnabled) {
        tcpJogJoint = -1;
        if ($("jog-target").value !== "-1") $("jog-target").value = "-1";
        livePreferred = false;
        selectWorkspace("move");
        $("cartesian-tab").click();
        refreshMode();
        message("Jog TCP · Drag an axis arrow to edit the virtual target. Physical motion uses Hold to jog.");
      }
      refreshTcpJog();
    });
    $("toggle-tcp-push").onclick = () => {
      tcpPushEnabled = !tcpPushEnabled;
      refreshTcpJog();
      if (tcpDrag?.last) dragTcp(tcpDrag.last);
      else message(tcpPushEnabled
        ? "Push enabled · Tool rotation and off-axis movement may adjust the virtual target."
        : "Push disabled · Axis dragging keeps tool orientation fixed. Hold Shift for temporary Push.");
    };
    $("jog-frame").onchange = () => setJogFrame($("jog-frame").value);
    document.querySelectorAll("[data-jog-frame]").forEach((button) => {
      button.onclick = () => setJogFrame(button.dataset.jogFrame);
    });
    $("jog-target").onchange = () => selectJogTarget(Number($("jog-target").value));
    document.querySelector('[role="tablist"]').addEventListener("keydown", (e) => {
      const tabs = [...document.querySelectorAll("[data-tab]")];
      const index = tabs.indexOf(document.activeElement);
      if (index < 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
      e.preventDefault();
      const next = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (index + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next].click();
      tabs[next].focus();
    });
    $("undo-points").onclick = () => restorePoints(pointUndo, pointRedo);
    $("redo-points").onclick = () => restorePoints(pointRedo, pointUndo);
    $("clear-points").onclick = () => {
      if (program.busy || programPreparing || endEffectorBusy || !points.length) return;
      stopPreview();
      rememberPoints();
      points = [];
      invalidate();
      renderPoints();
      message("Waypoints cleared. Use Undo to restore them.");
    };
    $("recover-reference").onclick = action(openReferenceRecovery);
    $("recovery-confirmed").onchange = renderRecovery;
    $("confirm-recovery").onclick = recoverReference;
    $("recover-dialog").addEventListener("cancel", (event) => {
      if (recoveryPending) event.preventDefault();
    });
    $("go-home").onclick = action(goHome);
    $("home-pose").onclick = () => {
      setPose(config.joints.map((j) => j.home));
      currentTarget();
      message("Virtual arm moved to configured home pose.");
    };
    $("sync-machine").onclick = action(() => {
      if (!referenced) throw Error("Set the manual reference before using machine position.");
      setPose(freshMachine());
      currentTarget();
      message("Virtual pose synchronized from machine coordinates.");
    });
    $("target-current").onclick = currentTarget;
    $("cartesian-working-pose").onclick = action(previewCartesianWorkingPose);
    $("solve-ik").onclick = action(() =>
      solveTarget(K.poseMatrix(readPose("target"))),
    );
    bindJogPads();
    for (const actionName of ["open", "close"])
      $(`gripper-${actionName}`).onclick = action(() => runEndEffector(actionName));
    $("gripper-toggle").onclick = action(() =>
      runEndEffector(lastManualGripperAction === "close" ? "open" : "close"),
    );
    $("save-end-effector").onclick = action(() => {
      if (programPreparing || program.busy || endEffectorBusy) throw Error("Wait for the current operation to finish.");
      endEffector = K.validateEndEffector({ open: $("end-effector-open").value, close: $("end-effector-close").value });
      renderEndEffectorSettings();
      stopPreview();
      projectChanged();
      invalidate();
      message("Gripper commands applied · Save project to keep them.");
    });
    $("teach-point").onclick = action(() => {
      const captured = capturePose();
      if (points.length >= 200)
        throw Error("A project supports at most 200 waypoints.");
      stopPreview();
      const duration = readNumber($("move-duration"));
      rememberPoints();
      points.push({
        name: `Waypoint ${String(points.length + 1).padStart(2, "0")}`,
        type: $("move-type").value,
        duration,
        q: captured,
        endEffector: $("move-end-effector").value,
      });
      invalidate();
      renderPoints(points.length - 1);
      message(`Waypoint ${points.length} added from ${$("follow-machine").checked ? "reported machine position" : "target pose"}.`);
    });
    $("teach-point-move").onclick = () => $("teach-point").click();
    $("edit-program-pose").onclick = () => selectWorkspace("move");
    $("speed").oninput = () => {
      stopPreview();
      cancelJog();
      $("speed-value").textContent = `${$("speed").value}%`;
      invalidate();
      if (live.active) void live.tick();
    };
    $("plan-program").onclick = action(() => ensurePlan());
    $("preview-program").onclick = action(() => preview(displayedPlan?.demo ? displayedPlan : null));
    $("stop").onclick = stop;
    $("save-project").onclick = action(saveProject);
    $("retry-settings").onclick = action(() => restoreProject({ ask: true }));
    $("export-project").onclick = action(() => {
      const p = K.validateProject(project());
      download(
        "robot-studio.json",
        JSON.stringify(p, null, 2),
        "application/json",
      );
      message("Project JSON exported.");
    });
    $("import-project").onclick = () => $("project-file").click();
    $("project-file").onchange = action(async (e) => {
      const file = e.target.files[0];
      e.target.value = "";
      if (!file) return;
      if (file.size > 2e6)
        throw Error("Project exceeds the 2 MB import limit.");
      const stamp = revision;
      const p = K.validateProject(JSON.parse(await file.text()));
      if (stamp !== revision) throw Error("The workspace changed while opening the file. Open it again when ready.");
      if ((points.length || projectVersion !== savedVersion) && !await confirmReplacement(
        "Open a different project?", `Opening ${p.config.name} replaces the current robot, pose, and waypoints. Export a backup first if you need to keep them.`, "Open project",
      )) return;
      applyProject(p);
      message(`Imported ${config.name} · ${points.length} waypoints.`);
    });
    $("export-gcode").onclick = action(async () => {
      const p = displayedPlan?.demo ? displayedPlan : await ensurePlan();
      download("robot-program.nc", K.exportGcode(config, p), "text/plain");
      message(
        "G-code exported · Set the machine to the START REQUIRED pose before running.",
      );
    });
    $("save-gcode").onclick = action(runMachineProgram);
    $("save-sd-program").onclick = action(() => runMachineProgram({ saveOnly: true }));
    $("program-source").onchange = () => {
      programSource = $("program-source").value;
      projectChanged();
      renderProgramExecution(program.state);
    };
    $("singularity-demo").onclick = action(() => runDemo("singularity"));
    $("piston-demo").onclick = action(() => runDemo("piston"));
    $("program-pause").onclick = action(async () => {
      if (program.state.phase === "paused") await program.resume();
      else await program.pause();
    });
    $("program-stop").onclick = stop;
    for (const [id, byte] of [["program-slower", 0x92], ["program-full-speed", 0x90]])
      $(id).onclick = action(async () => {
        if (!program.active || !["running", "paused"].includes(program.state.phase))
          throw Error("Wait for the program to start before adjusting controller speed.");
        await call("sendRealtime", { byte });
        await call("sendRealtime", { byte: 0x3f });
      });
    $("jog-controller-max").onclick = action(() => useControllerMaximums("jog"));
    $("program-controller-max").onclick = action(async () => {
      if (programPreparing || program.busy || endEffectorBusy) return;
      await readControllerLimits();
    });
    $("jog-maximum-speed").onchange = action(() => {
      if (programPreparing || program.busy || holding || live.active || live.busy || endEffectorBusy) {
        $("jog-maximum-speed").checked = jogMaximums;
        throw Error("Stop motion before changing jog limits.");
      }
      jogMaximums = $("jog-maximum-speed").checked;
      projectChanged();
      renderProgramMotion();
      message(jogMaximums ? "Jogging uses controller maximum speeds and firmware acceleration." : "Jogging uses custom speed caps and firmware acceleration.");
    });
    $("program-maximum-speed").onchange = () => {
      programMaximums = $("program-maximum-speed").checked;
      projectChanged();
      stopPreview();
      invalidate();
      renderProgramMotion();
    };
    for (const [id, key] of [["program-speed", "velocity"], ["jog-speed-limit", "velocity"], ["program-acceleration", "acceleration"]]) {
      $(id).onchange = action(() => {
        try {
          if (programPreparing || program.busy || holding || live.active || live.busy)
            throw Error("Stop motion before changing joint limits.");
          const value = readNumber($(id));
          config = K.validateConfig({ ...config, joints: config.joints.map((j) => ({ ...j, [key]: value })) });
          projectChanged();
          stopPreview();
          invalidate();
          renderProgramMotion();
          message("Joint motion limits updated · Save project to keep them. FluidNC motor limits still apply.");
        } catch (error) {
          renderProgramMotion();
          throw error;
        }
      });
    }
    $("program-speed-override").oninput = () => {
      stopPreview();
      invalidate();
      $("program-speed-value").textContent = `${$("program-speed-override").value}%`;
    };
    for (const id of ["demo-duration", "demo-tool-length", "piston-axis", "piston-stroke", "singularity-axis", "singularity-angle"])
      $(id).onchange = () => {
        stopPreview();
        invalidate();
      };
    $("configure").onclick = () => {
      live.stop();
      stopPreview();
      cancelJog();
      editConfig();
    };
    document.querySelectorAll("[data-shortcut]").forEach((button) => {
      button.onclick = () => $(button.dataset.shortcut).click();
    });
    $("default-config").onclick = () =>
      editConfig(
        $("robot-preset").value === "legacy"
          ? K.forearmRollConfig()
          : K.parallelElbowConfig($("robot-preset").value),
      );
    $("j6-direct-drive").onclick = () => {
      const scale = $("map-5-scale");
      scale.value = Number(scale.value) < 0 ? "-1" : "1";
      scale.dispatchEvent(new Event("input", { bubbles: true }));
    };
    $("config-form").onsubmit = submitConfig;
    $("config-form").addEventListener("input", queueConfigPreview);
    $("appearance-reset").onclick = () => {
      document.querySelectorAll("#appearance-rows input").forEach((input) => { input.value = ""; });
      queueConfigPreview();
    };
    $("config-dialog").addEventListener("close", disposeConfigPreview);
    document.querySelectorAll("[data-config-view]").forEach((button) => {
      button.onclick = () => {
        configPreviewView = button.dataset.configView;
        document.querySelectorAll("[data-config-view]").forEach((other) =>
          other.setAttribute("aria-pressed", String(other === button)),
        );
        configViewer?.fit(configPreviewView);
      };
    });
    $("config-view-fit").onclick = () => configViewer?.fit(configPreviewView);
    $("help").onclick = () => $("help-dialog").showModal();
    document
      .querySelectorAll("[data-close]")
      .forEach((b) => (b.onclick = () => $(b.dataset.close).close()));
    document.querySelectorAll("[data-workspace]").forEach(
      (b) =>
        (b.onclick = () => {
          selectWorkspace(b.dataset.workspace);
        }),
    );
    $("toggle-labels").onclick = (e) => {
      const on = e.currentTarget.getAttribute("aria-pressed") !== "true";
      viewer?.labels(on);
      e.currentTarget.setAttribute("aria-pressed", String(on));
      e.currentTarget.classList.toggle("active", on);
    };
    $("view-fit").onclick = () => viewer?.fit();
    document.querySelectorAll("[data-view]").forEach(
      (b) =>
        (b.onclick = () => {
          viewer?.fit(b.dataset.view);
          document
            .querySelectorAll("[data-view]")
            .forEach((button) =>
              button.classList.toggle("active", button === b),
            );
        }),
    );
    $("toggle-frames").onclick = (e) => {
      frames = !frames;
      viewer?.frames(frames);
      e.target.setAttribute("aria-pressed", String(frames));
      e.target.classList.toggle("active", frames);
    };
    $("toggle-path").onclick = (e) => {
      showPath = !showPath;
      viewer?.pathVisible(showPath);
      e.target.setAttribute("aria-pressed", String(showPath));
      e.target.classList.toggle("active", showPath);
    };
    $("mode-live").onclick = action(enableLiveControls);
    $("mode-target").onclick = () => {
      livePreferred = false;
      live.stop();
      $("follow-machine").checked = false;
      $("joint-mode").value = "virtual";
      refreshMode();
      updateMachine();
      message("Target pose · Set angles, then Hold to jog when ready.");
    };
    $("quick-reference").onclick = action(() => openManualHome());
    $("quick-stop").onclick = stop;
    $("joint-mode").onchange = action(async () => {
      if ($("joint-mode").value === "live") await enableLiveControls();
      else $("mode-target").click();
    });
    $("follow-machine").onchange = action(() => {
      if ($("follow-machine").checked) {
        try {
          if (!referenced)
            throw Error(
              "Record the manual home reference to show machine positions.",
            );
          reportedQ = K.machineJoints(config, status);
          if (performance.now() - statusAt >= 2000)
            throw Error("Waiting for fresh machine telemetry.");
          stopPreview();
        } catch (e) {
          $("follow-machine").checked = false;
          throw e;
        }
      }
      refreshVisualization();
    });
    $("manual-home").onclick = action(openManualHome);
    $("setup-home").onclick = action(openManualHome);
    $("home-upright").onclick = useUprightHome;
    $("record-home").onclick = recordHome;
    $("home-dialog").addEventListener("close", () => {
      liveAfterReference = false;
      runAfterReference = false;
      demoAfterReference = false;
      homeViewer?.dispose();
      homeViewer = null;
    });
    $("enable-machine").onchange = action(() => {
      if ($("enable-machine").checked) {
        try {
          if (!referenced) throw Error("Set the manual home reference first.");
          freshMachine();
          message(
            "Mapping enabled · Hold to jog performs a physical joint move.",
          );
        } catch (e) {
          $("enable-machine").checked = false;
          throw e;
        }
      } else {
        livePreferred = false;
        live.stop();
        cancelJog();
      }
      updateMachine();
    });
    $("machine-move").addEventListener("pointerdown", action(startJog));
    for (const event of ["pointerup", "pointercancel", "lostpointercapture"])
      $("machine-move").addEventListener(event, cancelJog);
    $("machine-move").addEventListener(
      "keydown",
      action((e) => {
        if ([" ", "Enter"].includes(e.key) && !e.repeat)
          startJog(e).catch((err) => message(err.message, true));
      }),
    );
    $("machine-move").addEventListener("keyup", (e) => {
      if ([" ", "Enter"].includes(e.key)) cancelJog();
    });
    $("machine-move").addEventListener("blur", cancelJog);
    window.addEventListener("blur", () => {
      setTcpPushShift(false, { retry: false });
      void rememberReference().catch(() => {});
      live.stop();
      cancelJog();
    });
    const refreshFeedback = () => {
      if (embedded && !document.hidden) {
        void call("sendRealtime", { byte: 0x3f }).catch(() => {});
        if (program.active)
          void call("getProgramStreamState").then((snapshot) => program.stream(snapshot)).catch(() => {});
      }
    };
    window.addEventListener("focus", refreshFeedback);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        setTcpPushShift(false, { retry: false });
        void rememberReference().catch(() => {});
        live.stop();
        cancelJog();
        stopPreview();
      } else refreshFeedback();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Shift" && !e.repeat && (tcpDrag || !e.target.closest?.("input, select, textarea, [contenteditable]")))
        setTcpPushShift(true);
      if (e.key === "Escape") stop();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && !document.querySelector("dialog[open]")) {
        e.preventDefault();
        void saveProject().catch((error) => message(error.message, true));
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" &&
          !document.querySelector("dialog[open]") && !document.querySelector(".program-panel").hidden &&
          !e.target.closest?.("input, select, textarea, [contenteditable]")) {
        e.preventDefault();
        restorePoints(e.shiftKey ? pointRedo : pointUndo, e.shiftKey ? pointUndo : pointRedo);
      }
    });
    document.addEventListener("keyup", (e) => {
      if (e.key === "Shift") setTcpPushShift(!!e.shiftKey);
    });
    document.addEventListener("input", (e) => e.target.removeAttribute("aria-invalid"));
    window.addEventListener("pagehide", () => {
      statusSize.disconnect();
      program.stop();
      live.stop();
      cancelJog();
      viewer?.dispose();
      homeViewer?.dispose();
      disposeConfigPreview();
      if (embedded) {
        call("unsubscribe", { event: "status" }).catch(() => {});
        call("unsubscribe", { event: "line" }).catch(() => {});
      }
    });
  }
  async function init() {
    renderEndEffectorSettings();
    $("tcp-readouts").innerHTML = poseKeys
      .map(
        (k) =>
          `<div class="tcp-value"><span>${k.toUpperCase()}</span><strong id="tcp-${k}">0.0</strong></div>`,
      )
      .join("");
    poseFields($("target-fields"), "target", K.forward(config, q).pose);
    renderJoints();
    renderPoints();
    renderProgramMotion();
    renderProgramExecution(program.state);
    setPose(q, { edit: false });
    bind();
    renderSaveState();
    const restoreRevision = revision;
    startupRestoreRevision = restoreRevision;
    if (!embedded) void restoreProject();
    if (embedded) {
      // Session state is memory-only; acquire its generation independently of
      // slow SD settings reads so an early manual reference can be retained.
      void call("getSessionState").then((session) => {
        if (!session || (controllerSession && session.generation < controllerSession.generation)) return;
        controllerSession = session;
        if (referenced) return rememberReference();
      }).catch(() => {});
      call("subscribe", { event: "status" }).catch((e) =>
        message(e.message, true),
      );
      call("subscribe", { event: "line" }).catch(() => {});
      call("getStatus")
        .then((s) => {
          status = s;
          statusAt = performance.now();
          updateMachine();
          if (restoreRevision !== revision) {
            $("retry-settings").hidden = false;
          } else if (s?.state === "Idle") retrySessionRestore();
          else {
            $("retry-settings").hidden = false;
            message("Saved project loading deferred · Retry when the controller is Idle.");
          }
          void readControllerLimits();
        })
        .catch(() => {
          $("retry-settings").hidden = false;
          message("Waiting for the controller · Retry loading the saved project when connected.", true);
        });
    }
    setInterval(() => {
      updateMachine();
      retrySessionRestore();
      resumePreferredLiveControls();
    }, 500);
    setInterval(() => {
      void live.tick();
    }, 50);
    try {
      viewer = await createRobotViewer($("viewer"), config, q, {
        onTcpDragStart: startTcpDrag, onTcpDrag: dragTcp, onTcpDragEnd: endTcpDrag,
        onJointPick: selectJogTarget,
      });
      viewer.configure(config, q);
      if (plan) viewer.path(plan.samples);
      viewer.frames(frames);
      viewer.pathVisible(showPath);
      refreshVisualization();
      $("viewer-loading").remove();
    } catch (e) {
      $("viewer-loading").textContent =
        "3D viewer unavailable. Enable WebGL in your browser and reopen the plugin. Joint controls and planning remain available.";
      message(`Viewer failed: ${e.message}`, true);
    }
  }
  init().catch((e) => message(e.message, true));
})();
