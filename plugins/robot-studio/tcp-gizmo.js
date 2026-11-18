/* Screen-sized TCP translation handles. All coordinates are in world mm. */
globalThis.createRobotTcpGizmo = function ({ THREE, scene, camera, controls, element, label, onStart, onMove, onEnd }) {
  const group = new THREE.Group();
  group.name = "tcp-jog-handles";
  group.visible = false;
  scene.add(group);
  const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
  const shaftGeometry = new THREE.CylinderGeometry(0.025, 0.025, 0.72, 12);
  const headGeometry = new THREE.ConeGeometry(0.075, 0.22, 16);
  const pickGeometry = new THREE.CylinderGeometry(0.11, 0.11, 1.05, 8);
  const pickMaterial = new THREE.MeshBasicMaterial({ visible: false });
  const axes = ["X", "Y", "Z"].map((name, index) => {
    const axis = new THREE.Group();
    axis.name = `tcp-jog-${name.toLowerCase()}`;
    const direction = new THREE.Vector3().setComponent(index, 1);
    axis.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
    const color = [0xf16c6c, 0x70d68b, 0x74adff][index];
    const material = new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false });
    const shaft = new THREE.Mesh(shaftGeometry, material);
    shaft.position.y = 0.46;
    const head = new THREE.Mesh(headGeometry, material);
    head.position.y = 0.93;
    shaft.renderOrder = head.renderOrder = 10;
    const pick = new THREE.Mesh(pickGeometry, pickMaterial);
    pick.position.y = 0.58;
    pick.userData.axis = index;
    axis.add(shaft, head, pick);
    const badge = label(name, axis);
    badge.position.y = 1.23;
    badge.scale.set(0.26, 0.16, 1);
    badge.renderOrder = 11;
    group.add(axis);
    return { axis, direction, material, pick };
  });
  let enabled = false, frame = "tool", tcp = null, drag = null, disposed = false,
    availableAxes = [true, true, true];
  function refresh() {
    if (!enabled || !tcp) return;
    group.position.set(tcp[3], tcp[7], tcp[11]);
    group.quaternion.identity();
    if (frame === "tool") {
      if (drag) group.quaternion.copy(drag.orientation);
      else {
        const rotation = new THREE.Matrix4().set(...tcp);
        group.quaternion.setFromRotationMatrix(rotation);
      }
    }
    // Keep a handle about 100 px long at every arm size and zoom level.
    const depth = Math.abs(group.position.clone().sub(camera.position).dot(camera.getWorldDirection(new THREE.Vector3())));
    const size = 2 * Math.tan(camera.fov * Math.PI / 360) * depth * 100 / Math.max(1, element.getBoundingClientRect().height);
    group.scale.setScalar(Math.max(0.001, size));
    const view = camera.position.clone().sub(group.position).normalize();
    axes.forEach(({ axis, direction }, index) => {
      // An end-on axis has no stable screen-space drag direction. Orbit to expose it.
      axis.visible = availableAxes[index] && Math.abs(direction.clone().applyQuaternion(group.quaternion).dot(view)) < 0.985;
    });
    group.updateMatrixWorld(true);
  }
  function setRay(event) {
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    pointer.set((event.clientX - rect.left) / rect.width * 2 - 1,
      -(event.clientY - rect.top) / rect.height * 2 + 1);
    camera.updateMatrixWorld();
    raycaster.setFromCamera(pointer, camera);
    return true;
  }
  function hit(event) {
    refresh();
    if (!setRay(event)) return null;
    return raycaster.intersectObjects(axes.filter(({ axis }) => axis.visible).map(({ pick }) => pick), false)[0];
  }
  function consume(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  function finish() {
    if (!drag) return;
    const previous = drag;
    drag = null;
    controls.enabled = previous.controlsEnabled;
    axes.forEach(({ material }) => material.color.copy(material.userData.baseColor));
    element.style.cursor = enabled ? "grab" : "";
    if (element.hasPointerCapture(previous.pointerId)) element.releasePointerCapture(previous.pointerId);
    refresh();
    onEnd?.();
  }
  function down(event) {
    if (!enabled || !group.visible) return;
    if (drag) { consume(event); return; }
    if (event.button !== 0 || event.isPrimary === false) return;
    const intersection = hit(event);
    if (!intersection) return;
    consume(event);
    const index = intersection.object.userData.axis;
    const direction = axes[index].direction.clone().applyQuaternion(group.quaternion).normalize();
    const origin = group.position.clone();
    const normal = camera.position.clone().sub(origin);
    normal.addScaledVector(direction, -normal.dot(direction)).normalize();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin);
    const start = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    if (!start || onStart?.(index, event) === false) return;
    drag = { pointerId: event.pointerId, index, direction, plane, start,
      orientation: group.quaternion.clone(), controlsEnabled: controls.enabled };
    controls.enabled = false;
    axes[index].material.color.set(0xffdc83);
    element.style.cursor = "grabbing";
    element.setPointerCapture(event.pointerId);
  }
  function move(event) {
    if (!enabled || !group.visible) return;
    if (!drag) {
      element.style.cursor = hit(event) ? "grab" : "";
      return;
    }
    consume(event);
    if (event.pointerId !== drag.pointerId || !setRay(event)) return;
    const point = raycaster.ray.intersectPlane(drag.plane, new THREE.Vector3());
    if (!point) return;
    const distance = point.sub(drag.start).dot(drag.direction);
    if (Number.isFinite(distance)) onMove?.({ axis: drag.index, distance,
      direction: drag.direction.toArray(), shiftKey: event.shiftKey });
  }
  function up(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    consume(event);
    finish();
  }
  function visibility() { if (document.hidden) finish(); }
  function key(event) { if (event.key === "Escape") finish(); }
  axes.forEach(({ material }) => { material.userData.baseColor = material.color.clone(); });
  // Capture before OrbitControls can start an orbit on the same pointer.
  const listeners = [[element, "pointerdown", down, true], [element, "pointermove", move, true],
    [element, "pointerup", up, true], [element, "pointercancel", up, true],
    [element, "lostpointercapture", up, true], [window, "blur", finish, false],
    [document, "visibilitychange", visibility, false], [window, "keydown", key, false]];
  listeners.forEach(([target, name, handler, capture]) => target.addEventListener(name, handler, capture));
  return {
    get dragging() { return !!drag; },
    update(matrix, { axes: nextAxes = [true, true, true] } = {}) {
      tcp = [...matrix];
      // Keep the chosen axes stable for the duration of an active gesture.
      if (!drag) availableAxes = [...nextAxes];
      refresh();
    },
    refresh,
    set({ enabled: nextEnabled, frame: nextFrame = frame }) {
      if (!nextEnabled || nextFrame !== frame) finish();
      enabled = !!nextEnabled;
      frame = nextFrame;
      group.visible = enabled;
      if (!enabled) element.style.cursor = "";
      refresh();
    },
    cancel: finish,
    dispose() {
      if (disposed) return;
      disposed = true;
      finish();
      listeners.forEach(([target, name, handler, capture]) => target.removeEventListener(name, handler, capture));
      scene.remove(group);
      shaftGeometry.dispose(); headGeometry.dispose(); pickGeometry.dispose(); pickMaterial.dispose();
      axes.forEach(({ material }) => material.dispose());
      group.traverse((part) => {
        if (part.isSprite) { part.material.map.dispose(); part.material.dispose(); }
      });
    },
  };
};
