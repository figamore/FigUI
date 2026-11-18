/* FluidNC stores axis rates in units/min and acceleration in units/s².
   Robot joint limits are degrees/s and degrees/s², with arbitrary axis mapping. */
(() => {
  "use strict";
  const FALLBACK_RATE = 1200;
  function fromSettingsResponse(raw) {
    const json = typeof raw === "string" ? JSON.parse(raw) : raw;
    const entries = Array.isArray(json) ? json : json?.EEPROM || [
      ...(json?.data?.nvs || []), ...(json?.data?.tree || []),
    ];
    const result = {};
    for (const entry of entries) {
      const match = String(entry.P || "").match(/^\/?axes\/([xyzabc])\/(max_rate_mm_per_min|acceleration_mm_per_sec2)$/i);
      const value = Number(entry.V);
      if (match && Number.isFinite(value) && value > 0)
        result[`${match[2].toLowerCase() === "max_rate_mm_per_min" ? "maxRate" : "accel"}${match[1].toUpperCase()}`] = value;
    }
    return result;
  }
  function jointLimits(config, settings) {
    return config.joints.map((j) => {
      const scale = Math.abs(j.scale), rate = settings?.[`maxRate${j.axis}`], acceleration = settings?.[`accel${j.axis}`];
      const rateFallback = !Number.isFinite(rate) || rate <= 0;
      return {
        axis: j.axis,
        rateFallback,
        velocity: (rateFallback ? FALLBACK_RATE : rate) / (60 * scale),
        acceleration: Number.isFinite(acceleration) && acceleration > 0 ? acceleration / scale : null,
      };
    });
  }
  function applyMaximums(config, settings) {
    const limits = jointLimits(config, settings);
    return RobotCore.validateConfig({ ...config, joints: config.joints.map((j, i) => ({ ...j, velocity: limits[i].velocity, acceleration: limits[i].acceleration ?? j.acceleration })) });
  }
  function cappedConfig(config, settings) {
    const limits = jointLimits(config, settings);
    return { ...config, joints: config.joints.map((j, i) => ({ ...j,
      velocity: Math.min(j.velocity, limits[i].velocity ?? Infinity),
      acceleration: Math.min(j.acceleration, limits[i].acceleration ?? Infinity),
    })) };
  }
  globalThis.RobotMotionSettings = { FALLBACK_RATE, fromSettingsResponse, jointLimits, applyMaximums, cappedConfig };
})();
