/* Rose pendant shared by joint jogging and virtual Cartesian positioning.
   Transport and kinematics stay with the caller; this owns input gestures only. */
(() => {
  "use strict";
  const NS = "http://www.w3.org/2000/svg";
  const radii = [32, 58, 84, 110];
  const steps = [0.1, 1, 5];
  function arc(inner, outer, direction) {
    const a = ((direction - 0.5) * Math.PI) / 2,
      b = ((direction + 0.5) * Math.PI) / 2,
      point = (r, t) => `${r * Math.sin(t)},${-r * Math.cos(t)}`;
    return `M${point(inner, a)} L${point(outer, a)} A${outer},${outer} 0 0 1 ${point(outer, b)} L${point(inner, b)} A${inner},${inner} 0 0 0 ${point(inner, a)} Z`;
  }
  function svgNode(tag, attrs = {}, text = "") {
    const el = document.createElementNS(NS, tag);
    Object.entries(attrs).forEach(([key, value]) =>
      el.setAttribute(key, value),
    );
    el.textContent = text;
    return el;
  }
  function create(
    container,
    { onStep, onHold, onRelease, onStop, onSelect = () => {}, onError },
  ) {
    let axes = [],
      unit = "°",
      hold = false,
      disabled = false,
      gesture = null;
    const controls = [];
    const caption = document.createElement("p");
    caption.className = "rose-caption";
    caption.setAttribute("aria-live", "polite");
    function describe(text) {
      if (caption.textContent !== text) caption.textContent = text;
      caption.hidden = !text;
    }
    function restingCaption() {
      describe("");
    }
    function cancel() {
      if (!gesture) return;
      const previous = gesture;
      gesture = null;
      previous.el.classList.remove("pressed");
      onRelease();
      if (
        previous.pointerId !== undefined &&
        previous.el.hasPointerCapture(previous.pointerId)
      )
        previous.el.releasePointerCapture(previous.pointerId);
      restingCaption();
    }
    function bindControl(el, axis, sign, step) {
      const label = axes[axis].label,
        direction = sign > 0 ? "+" : "−";
      const description = `${label} ${direction} ${hold ? "hold to jog" : `${step} ${unit}`}`;
      el.dataset.roseAxis = String(axis);
      el.dataset.roseSign = String(sign);
      el.dataset.roseStep = hold ? "hold" : String(step);
      el.classList.add("rose-control", `rose-axis-${axis}`);
      el.setAttribute("role", "button");
      el.setAttribute("aria-label", description);
      const title = svgNode("title", {}, description);
      if (el.namespaceURI === NS) el.append(title);
      else el.title = description;
      controls.push(el);
      el.addEventListener("pointerenter", () => {
        describe(description);
        onSelect(axis);
      });
      el.addEventListener("pointerleave", () => {
        if (!gesture) restingCaption();
      });
      el.addEventListener("focus", () => {
        describe(description);
        onSelect(axis);
      });
      function stepOnce() {
        if (disabled || gesture) return;
        try {
          onStep(axis, sign, step);
          describe(description);
        } catch (error) {
          onError(error);
        }
      }
      function begin(e) {
        if (disabled || gesture) return;
        if (e.type === "pointerdown" && (e.button !== 0 || !e.isPrimary))
          return;
        if (
          e.type === "keydown" &&
          (![" ", "Enter"].includes(e.key) || e.repeat)
        )
          return;
        e.preventDefault();
        try {
          if (onHold(axis, sign, e) === false) return;
          gesture = { el, pointerId: e.pointerId, key: e.key };
          el.classList.add("pressed");
          describe(description);
        } catch (error) {
          onError(error);
        }
      }
      function end(e) {
        if (!gesture || gesture.el !== el) return;
        if (e.type === "keyup" && e.key !== gesture.key) return;
        if (e.pointerId !== undefined && e.pointerId !== gesture.pointerId)
          return;
        cancel();
      }
      if (hold) {
        el.addEventListener("pointerdown", begin);
        el.addEventListener("keydown", begin);
        for (const event of [
          "pointerup",
          "pointercancel",
          "lostpointercapture",
          "keyup",
          "blur",
        ])
          el.addEventListener(event, end);
      } else {
        el.addEventListener("click", stepOnce);
        // One keypress is one step; suppress native button key-repeat too.
        el.addEventListener("keydown", (e) => {
          if (![" ", "Enter"].includes(e.key)) return;
          e.preventDefault();
          if (!e.repeat) stepOnce();
        });
      }
    }
    function setDisabled(value) {
      disabled = value;
      if (disabled) cancel();
      controls.forEach((el) => {
        el.setAttribute("aria-disabled", String(disabled));
        el.setAttribute("tabindex", disabled ? "-1" : "0");
        if (el.namespaceURI !== NS) el.disabled = disabled;
      });
    }
    function configure(options) {
      cancel();
      ({ axes, unit = "°", hold = false } = options);
      controls.length = 0;
      container.replaceChildren();
      const layout = document.createElement("div");
      layout.className = "rose-layout";
      const disc = document.createElement("div");
      disc.className = "rose-disc";
      const svg = svgNode("svg", {
        viewBox: "-130 -130 260 260",
        "aria-label": `${axes[0].label} and ${axes[1].label} jog rose`,
      });
      svg.append(svgNode("circle", { r: 112, class: "rose-outline" }));
      const directions = [
        { axis: 1, sign: 1 },
        { axis: 0, sign: 1 },
        { axis: 1, sign: -1 },
        { axis: 0, sign: -1 },
      ];
      directions.forEach(({ axis, sign }, direction) => {
        (hold ? [0] : steps).forEach((step, ring) => {
          const inner = hold ? radii[0] : radii[ring],
            outer = hold ? radii.at(-1) : radii[ring + 1];
          const path = svgNode("path", {
            d: arc(inner, outer, direction),
            "data-ring": ring,
          });
          bindControl(path, axis, sign, step);
          svg.append(path);
          const angle = (direction * Math.PI) / 2,
            r = (inner + outer) / 2;
          svg.append(
            svgNode(
              "text",
              {
                x: r * Math.sin(angle),
                y: -r * Math.cos(angle),
                class: "rose-step-label",
                "text-anchor": "middle",
                "dominant-baseline": "central",
              },
              hold ? (sign > 0 ? "+" : "−") : String(step),
            ),
          );
        });
        const angle = (direction * Math.PI) / 2;
        svg.append(
          svgNode(
            "text",
            {
              x: 122 * Math.sin(angle),
              y: -122 * Math.cos(angle),
              class: `rose-direction rose-axis-${axis}`,
              "text-anchor": "middle",
              "dominant-baseline": "central",
            },
            `${axes[axis].label}${sign > 0 ? "+" : "−"}`,
          ),
        );
      });
      const stop = document.createElement("button");
      stop.className = "rose-stop";
      stop.setAttribute("aria-label", "Stop motion");
      stop.innerHTML = '<span aria-hidden="true">■</span><span>Stop</span>';
      stop.onclick = () => {
        cancel();
        onStop();
      };
      disc.append(svg, stop);
      const rail = document.createElement("div");
      rail.className = "rose-rail rose-axis-2";
      for (const sign of [1, -1]) {
        const label = document.createElement("span");
        label.className = "rose-rail-label";
        label.textContent = `${axes[2].label}${sign > 0 ? "+" : "−"}`;
        rail.append(label);
        const group = document.createElement("div");
        group.className = "rose-rail-group";
        (hold ? [0] : sign > 0 ? [...steps].reverse() : steps).forEach(
          (step) => {
            const button = document.createElement("button");
            button.textContent = hold ? (sign > 0 ? "+" : "−") : String(step);
            button.dataset.ring = String(steps.indexOf(step));
            bindControl(button, 2, sign, step);
            group.append(button);
          },
        );
        rail.append(group);
      }
      layout.append(disc, rail);
      const readings = document.createElement("div");
      readings.className = "rose-readings";
      axes.forEach((axis, i) => {
        const reading = document.createElement("div"),
          label = document.createElement("span"),
          value = document.createElement("strong");
        label.textContent = `${axis.label} · ${axis.name}`;
        value.dataset.roseReading = i;
        value.textContent = "—";
        reading.append(label, value);
        readings.append(reading);
      });
      container.append(layout, caption, readings);
      restingCaption();
      setDisabled(disabled);
    }
    container.addEventListener("contextmenu", (e) => e.preventDefault());
    return {
      configure,
      setDisabled,
      cancel,
      readings(values) {
        container.querySelectorAll("[data-rose-reading]").forEach((el, i) => {
          const text = Number.isFinite(values[i])
            ? `${values[i].toFixed(2)} ${unit}`
            : "—";
          if (el.textContent !== text) el.textContent = text;
        });
      },
    };
  }
  globalThis.RobotJogPad = { create };
})();
