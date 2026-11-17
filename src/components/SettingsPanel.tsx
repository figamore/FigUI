import { uiText as __uiText, uiPlural as __uiPlural, formatUi } from '../lib/i18n'
import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  RefreshCw,
  Search,
  Wifi,
  Globe,
  Settings,
  Sliders,
  Hash,
  RotateCcw,
  X,
  Cpu,
  Info,
  Monitor,
  Upload,
  Check,
  Radio,
  Trash2,
  Square,
  Target,
  FileCode2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  sendCommand,
  fetchFileContent,
  replaceFileContent,
  uploadFirmware,
  getDeviceInfoFast,
  WebUIBlockedError,
} from "../lib/http";
import { useMachineStore } from "../store";
import type { Theme } from "../store";
import { useGCodeSenderStore } from "../store/gcodeSender";
import { parseDecimalInput } from "../lib/numberInput";
import type { FluidNCSetting } from "../types";
import { yamlCommentStart } from "../lib/configValidation";
import { useConfirmTap } from "../hooks/useConfirmTap";
import {
  loadControllerConfigSettings,
  updateControllerConfigSetting,
} from "../lib/controllerConfig";
import { LimitsTab } from "./LimitsTab";
import { useViewportMetrics } from "../lib/viewport";

type Setting = FluidNCSetting;

const PREFIX_TO_CAT: Record<string, string> = {
  WiFi: "wifi",
  Network: "wifi",
  Sta: "wifi",
  AP: "wifi",
  Hostname: "wifi",
  HTTP: "services",
  Telnet: "services",
  MDNS: "services",
  Bluetooth: "services",
  Notification: "services",
  Message: "system",
  Config: "system",
  Report: "system",
  SD: "system",
  Firmware: "system",
  GCode: "system",
  Start: "system",
  Grbl: "machine",
};

const CAT_DEFS: Record<
  string,
  { label: string; icon: LucideIcon; order: number }
> = {
  workspace: { label: __uiText("components.SettingsPanel.workspace.1", "Workspace"), icon: Monitor, order: -1 },
  wifi: { label: __uiText("components.SettingsPanel.wifi_network.1", "WiFi & Network"), icon: Wifi, order: 0 },
  services: { label: __uiText("components.SettingsPanel.services.1", "Services"), icon: Globe, order: 1 },
  system: { label: __uiText("components.SettingsPanel.system.1", "System"), icon: Settings, order: 2 },
  machine: { label: __uiText("components.SettingsPanel.machine.1", "Machine"), icon: Sliders, order: 3 },
  config: { label: __uiText("components.SettingsPanel.machine_config.1", "Machine Config"), icon: Cpu, order: 4 },
  limits: { label: __uiText("components.SettingsPanel.limits.1", "Limits"), icon: Target, order: 5 },
  espnow: { label: "ESP-NOW", icon: Radio, order: 6 },
  other: { label: __uiText("components.SettingsPanel.other.1", "Other"), icon: Hash, order: 99 },
  firmware: { label: __uiText("components.SettingsPanel.firmware_update.1", "Firmware Update"), icon: Upload, order: 100 },
};

function catOf(s: Setting): string {
  if (s.F === "tree") return "config";
  return PREFIX_TO_CAT[s.P.split("/")[0]] ?? "other";
}

const TREE_PREFIX_TO_SUBCAT: Record<string, string> = {
  axes: "Axes",
  stepping: "Stepping",
  uart1: "UART",
  uart2: "UART",
  uart_channel1: "UART",
  uart_channel2: "UART",
  sdcard: "SD Card",
  coolant: "Coolant",
  probe: "Probe",
  macros: "Macros",
  start: "Startup",
  parking: "Parking",
  user_outputs: "Outputs",
};

const SUBCAT_ORDER = [
  "General",
  "Axes",
  "Stepping",
  "Startup",
  "Parking",
  "Probe",
  "Coolant",
  "Macros",
  "UART",
  "SD Card",
  "Outputs",
];

const SETTING_SECTION_NAMES: Record<string, string> = {
  "General": __uiText("components.SettingsPanel.section_name.1", "General"),
  "Axes": __uiText("components.SettingsPanel.section_name.2", "Axes"),
  "Stepping": __uiText("components.SettingsPanel.section_name.3", "Stepping"),
  "Startup": __uiText("components.SettingsPanel.section_name.4", "Startup"),
  "Parking": __uiText("components.SettingsPanel.section_name.5", "Parking"),
  "Probe": __uiText("components.SettingsPanel.section_name.6", "Probe"),
  "Coolant": __uiText("components.SettingsPanel.section_name.7", "Coolant"),
  "Macros": __uiText("components.SettingsPanel.section_name.8", "Macros"),
  "UART": __uiText("components.SettingsPanel.section_name.9", "UART"),
  "SD Card": __uiText("components.SettingsPanel.section_name.10", "SD Card"),
  "Outputs": __uiText("components.SettingsPanel.section_name.11", "Outputs"),
  "Homing": __uiText("components.SettingsPanel.section_name.12", "Homing"),
  "Motion": __uiText("components.SettingsPanel.section_name.13", "Motion"),
};

function settingSectionName(value: string): string {
  return Object.prototype.hasOwnProperty.call(SETTING_SECTION_NAMES, value) ? SETTING_SECTION_NAMES[value] : value;
}
function treeSubcat(path: string): string {
  const seg = path.split("/").filter(Boolean)[0] ?? "";
  return TREE_PREFIX_TO_SUBCAT[seg] ?? "General";
}

const KEY_LABELS: Record<string, string> = {
  PsMode: __uiText("components.SettingsPanel.setting_label.1", "Power Save Mode"),
  MinSecurity: __uiText("components.SettingsPanel.setting_label.2", "Minimum Security"),
  FastScan: __uiText("components.SettingsPanel.setting_label.3", "Fast Scan"),
  IPMode: __uiText("components.SettingsPanel.setting_label.4", "IP Mode"),
  steps_per_mm: __uiText("components.SettingsPanel.setting_label.5", "Steps / mm"),
  max_rate_mm_per_min: __uiText("components.SettingsPanel.setting_label.6", "Max Rate"),
  acceleration_mm_per_sec2: __uiText("components.SettingsPanel.setting_label.7", "Acceleration"),
  max_travel_mm: __uiText("components.SettingsPanel.setting_label.8", "Max Travel"),
  mpos_mm: __uiText("components.SettingsPanel.setting_label.9", "Machine Position"),
  feed_mm_per_min: __uiText("components.SettingsPanel.setting_label.10", "Feed Rate"),
  seek_mm_per_min: __uiText("components.SettingsPanel.setting_label.11", "Seek Rate"),
  rate_mm_per_min: __uiText("components.SettingsPanel.setting_label.12", "Rate"),
  pullout_rate_mm_per_min: __uiText("components.SettingsPanel.setting_label.13", "Pullout Rate"),
  pullout_distance_mm: __uiText("components.SettingsPanel.setting_label.14", "Pullout Distance"),
  target_mpos_mm: __uiText("components.SettingsPanel.setting_label.15", "Target Position"),
  pulloff_mm: __uiText("components.SettingsPanel.setting_label.16", "Pulloff Distance"),
  allow_single_axis: __uiText("components.SettingsPanel.setting_label.17", "Allow Single Axis"),
  positive_direction: __uiText("components.SettingsPanel.setting_label.18", "Positive Direction"),
  seek_scaler: __uiText("components.SettingsPanel.setting_label.19", "Seek Scaler"),
  feed_scaler: __uiText("components.SettingsPanel.setting_label.20", "Feed Scaler"),
  settle_ms: __uiText("components.SettingsPanel.setting_label.21", "Settle Time"),
  idle_ms: __uiText("components.SettingsPanel.setting_label.22", "Idle Time"),
  pulse_us: __uiText("components.SettingsPanel.setting_label.23", "Pulse Width"),
  dir_delay_us: __uiText("components.SettingsPanel.setting_label.24", "Direction Delay"),
  disable_delay_us: __uiText("components.SettingsPanel.setting_label.25", "Disable Delay"),
  frequency_hz: __uiText("components.SettingsPanel.setting_label.26", "Frequency"),
  passthrough_baud: __uiText("components.SettingsPanel.setting_label.27", "Passthrough Baud"),
  passthrough_mode: __uiText("components.SettingsPanel.setting_label.28", "Passthrough Mode"),
  report_interval_ms: __uiText("components.SettingsPanel.setting_label.29", "Report Interval"),
  uart_num: __uiText("components.SettingsPanel.setting_label.30", "UART Number"),
  message_level: __uiText("components.SettingsPanel.setting_label.31", "Message Level"),
  hard_limits: __uiText("components.SettingsPanel.setting_label.32", "Hard Limits"),
  soft_limits: __uiText("components.SettingsPanel.setting_label.33", "Soft Limits"),
  homing_runs: __uiText("components.SettingsPanel.setting_label.34", "Homing Runs"),
  check_mode_start: __uiText("components.SettingsPanel.late_coverage.1", "Check Mode on Start"),
  hard_stop: __uiText("components.SettingsPanel.setting_label.35", "Hard Stop on Probe"),
  probe_hard_limit: __uiText("components.SettingsPanel.late_coverage.2", "Probe as Hard Limit"),
  startup_line0: __uiText("components.SettingsPanel.setting_label.36", "Startup Line 1"),
  startup_line1: __uiText("components.SettingsPanel.setting_label.37", "Startup Line 2"),
  after_homing: __uiText("components.SettingsPanel.setting_label.38", "After Homing"),
  after_reset: __uiText("components.SettingsPanel.setting_label.39", "After Reset"),
  after_unlock: __uiText("components.SettingsPanel.setting_label.40", "After Unlock"),
  must_home: __uiText("components.SettingsPanel.late_coverage.3", "Require Homing on Start"),
  deactivate_parking: __uiText("components.SettingsPanel.setting_label.41", "Deactivate Parking"),
  check_limits: __uiText("components.SettingsPanel.late_coverage.4", "Check Limits on Start"),
  enable_parking_override_control: __uiText("components.SettingsPanel.setting_label.42", "Parking Override Control"),
  arc_tolerance_mm: __uiText("components.SettingsPanel.setting_label.43", "Arc Tolerance"),
  junction_deviation_mm: __uiText("components.SettingsPanel.setting_label.44", "Junction Deviation"),
  verbose_errors: __uiText("components.SettingsPanel.setting_label.45", "Verbose Errors"),
  report_inches: __uiText("components.SettingsPanel.setting_label.46", "Report in Inches"),
  use_line_numbers: __uiText("components.SettingsPanel.setting_label.47", "Use G-code Line Numbers"),
  planner_blocks: __uiText("components.SettingsPanel.setting_label.48", "Planner Buffer Size"),
  delay_ms: __uiText("components.SettingsPanel.setting_label.49", "Coolant Delay"),
};

const GROUP_LABELS: Record<string, string> = {
  WiFi: __uiText("components.SettingsPanel.setting_label.50", "General"),
  Sta: __uiText("components.SettingsPanel.setting_label.51", "Station (STA)"),
  AP: __uiText("components.SettingsPanel.setting_label.52", "Access Point (AP)"),
  Network: __uiText("components.SettingsPanel.setting_label.53", "Network Connection"),
  HTTP: __uiText("components.SettingsPanel.setting_label.54", "HTTP Server"),
  Telnet: __uiText("components.SettingsPanel.setting_label.55", "Telnet Server"),
  MDNS: __uiText("components.SettingsPanel.setting_label.56", "mDNS"),
  Bluetooth: __uiText("components.SettingsPanel.setting_label.57", "Bluetooth"),
  Notification: __uiText("components.SettingsPanel.setting_label.58", "Notifications"),
  Hostname: __uiText("components.SettingsPanel.setting_label.59", "Hostname"),
  uart1: __uiText("components.SettingsPanel.setting_label.60", "UART 1"),
  uart2: __uiText("components.SettingsPanel.setting_label.61", "UART 2"),
  uart_channel1: __uiText("components.SettingsPanel.setting_label.62", "UART Channel 1"),
  uart_channel2: __uiText("components.SettingsPanel.setting_label.63", "UART Channel 2"),
  sdcard: __uiText("components.SettingsPanel.setting_label.64", "SD Card"),
  user_outputs: __uiText("components.SettingsPanel.setting_label.65", "User Outputs"),
};

function humanizeKey(key: string): string {
  if (KEY_LABELS[key]) return KEY_LABELS[key];
  return key
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function groupLabel(seg: string): string {
  return GROUP_LABELS[seg] ?? humanizeKey(seg);
}

function searchBreadcrumb(s: Setting): string {
  const cat = CAT_DEFS[catOf(s)]?.label ?? catOf(s);
  if (s.F === "tree") {
    const sub = treeSubcat(s.P);
    const parts = s.P.split("/").filter(Boolean);
    // For axes, include the axis letter in the breadcrumb (parts[1] must be a single letter)
    if (sub === "Axes" && parts.length >= 3) {
      const axis = parts[1];
      const section = parts.length >= 4 ? parts[2] : null;
      const sectionLabel: Record<string, string> = {
        homing: "Homing",
        motor0: "Motor 0",
        motor1: "Motor 1",
      };
      return [cat, settingSectionName(sub), `${axis} Axis`, section ? settingSectionName(sectionLabel[section] ?? section) : null]
        .filter(Boolean)
        .join(" › ");
    }
    return `${cat} › ${settingSectionName(sub)}`;
  }
  return cat;
}

function displayLabel(s: Setting): string {
  const parts = s.P.split("/").filter(Boolean);
  const service = parts[0];
  const last = parts[parts.length - 1] ?? s.P;

  // A Services page combines settings from several independent protocols. The
  // firmware uses generic leaf names such as "Enable" and "Port", but showing
  // those names on their own makes it too easy to change the wrong service.
  if (catOf(s) === "services") {
    const serviceLabel = groupLabel(service);
    if (last === "Enable") return formatUi(__uiText("components.SettingsPanel.service.enable.1", "Enable {service}"), { service: serviceLabel });
    if (last === "Port") return formatUi(__uiText("components.SettingsPanel.service.port.1", "{service} Port"), { service: serviceLabel });
    if (last === "Name") return formatUi(__uiText("components.SettingsPanel.service.name.1", "{service} Name"), { service: serviceLabel });
    if (/^T\d+$/i.test(last) || last === "TS")
      return formatUi(__uiText("components.SettingsPanel.service.setting.1", "{service} Setting {name}"), { service: serviceLabel, name: last });
  }

  if (service === "Network") {
    if (last === "Enable") return __uiText("components.SettingsPanel.network.enable.1", "Enable Network Connection");
    if (last === "Type") return __uiText("components.SettingsPanel.network.type.1", "Connection Type");
  }

  return humanizeKey(last);
}

function inferUnit(path: string): string {
  const k = path.toLowerCase();
  if (k.includes("steps_per_mm") || k.includes("resolution")) return "steps/mm";
  if (
    k.includes("_mm_per_min") ||
    k.includes("maxrate") ||
    (k.includes("rate") && !k.includes("port") && !k.includes("baud"))
  )
    return "mm/min";
  if (k.includes("_mm_per_sec2") || k.includes("accel")) return "mm/s²";
  if (
    k.includes("_us") ||
    k.includes("pulse") ||
    k.includes("dir_delay") ||
    k.includes("disable_delay")
  )
    return "µs";
  if (
    k.includes("_ms") ||
    k.includes("delay") ||
    k.includes("settle") ||
    k.includes("idle")
  )
    return "ms";
  if (
    k.includes("_mm") ||
    k.includes("maxtravel") ||
    k.includes("travel") ||
    k.includes("pulloff") ||
    k.includes("mpos") ||
    k.includes("tolerance") ||
    k.includes("deviation")
  )
    return "mm";
  if (k.includes("maxspindlespeed") || k.includes("spindlespeed")) return "rpm";
  if (k.includes("_hz") || k.includes("frequency") || k.includes("freq"))
    return "Hz";
  if (k.includes("baud")) return "baud";
  return "";
}

type ListItem =
  | { type: "header"; label: string; level: "section" | "subsection" }
  | { type: "setting"; setting: Setting };

function buildGroupedItems(settings: Setting[], subKey: string): ListItem[] {
  if (subKey === "Axes") {
    const general: Setting[] = [];
    const axisMap = new Map<string, Map<string, Setting[]>>();

    for (const s of settings) {
      const parts = s.P.split("/").filter(Boolean); // ['axes', ...]
      if (parts.length <= 2) {
        general.push(s);
        continue;
      }
      const axis = parts[1];
      const section = parts.length >= 4 ? parts[2] : "motion";
      if (!axisMap.has(axis)) axisMap.set(axis, new Map());
      const secMap = axisMap.get(axis)!;
      if (!secMap.has(section)) secMap.set(section, []);
      secMap.get(section)!.push(s);
    }

    const items: ListItem[] = [];
    if (general.length > 0) {
      items.push({ type: "header", label: __uiText("components.SettingsPanel.label_extra.1", "General"), level: "section" });
      for (const s of general) items.push({ type: "setting", setting: s });
    }

    const SECTION_ORDER = [
      "motion",
      "homing",
      "motor0",
      "motor1",
      "motor2",
      "motor3",
    ];
    const SECTION_LABELS: Record<string, string> = {
      motion: "Motion",
      homing: "Homing",
      motor0: "Motor 0",
      motor1: "Motor 1",
      motor2: "Motor 2",
      motor3: "Motor 3",
    };

    for (const [axis, sections] of [...axisMap].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      items.push({ type: "header", label: `${axis} Axis`, level: "section" });
      const ordered = [...sections.entries()].sort(([a], [b]) => {
        const ai = SECTION_ORDER.indexOf(a),
          bi = SECTION_ORDER.indexOf(b);
        if (ai === -1 && bi === -1) return a.localeCompare(b);
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      });
      for (const [sec, subs] of ordered) {
        items.push({
          type: "header",
          label: SECTION_LABELS[sec] ? settingSectionName(SECTION_LABELS[sec]) : humanizeKey(sec),
          level: "subsection",
        });
        for (const s of subs) items.push({ type: "setting", setting: s });
      }
    }
    return items;
  }

  // All other sub-tabs: group by top-level path segment
  const groups = new Map<string, Setting[]>();
  for (const s of settings) {
    const seg = s.P.split("/").filter(Boolean)[0] ?? "general";
    if (!groups.has(seg)) groups.set(seg, []);
    groups.get(seg)!.push(s);
  }

  if (groups.size <= 1)
    return settings.map((s) => ({ type: "setting", setting: s }));

  const items: ListItem[] = [];
  for (const [seg, subs] of groups) {
    items.push({ type: "header", label: groupLabel(seg), level: "section" });
    for (const s of subs) items.push({ type: "setting", setting: s });
  }
  return items;
}

type SaveState = "idle" | "saving" | "saved" | "error";

function SaveBtn({
  state,
  changed,
  onClick,
}: {
  state: SaveState;
  changed: boolean;
  onClick: () => void;
}) {
  const base =
    "shrink-0 h-7 min-w-[44px] px-2 rounded text-sm font-medium transition-all border";
  if (state === "saving")
    return (
      <button
        className={`${base} border-border text-text-dim cursor-not-allowed`}
        disabled
      >
        …
      </button>
    );
  if (state === "saved")
    return (
      <button className={`${base} border-ok/40 bg-ok/10 text-ok`} disabled>
        ✓
      </button>
    );
  if (state === "error")
    return (
      <button
        className={`${base} border-danger/40 bg-danger/10 text-danger`}
        disabled
      >
        !
      </button>
    );
  if (!changed)
    return (
      <button
        className={`${base} border-border text-text-dim opacity-0 pointer-events-none`}
        disabled
      >
        {__uiText("components.SettingsPanel.save.1", "Save")}
      </button>
    );
  return (
    <button
      className={`${base} border-accent/50 bg-accent/10 text-accent hover:bg-accent/20`}
      onClick={onClick}
    >
      {__uiText("components.SettingsPanel.save.2", "Save")}
    </button>
  );
}

interface SettingRowProps {
  setting: Setting;
  showPath: boolean;
  onSave: (p: string, t: string, v: string) => Promise<void>;
}

// FluidNC reports enum items as type B too, with one option per member, and
// those take a member value or name rather than true/false.
export function isBooleanTreeSetting(setting: Setting): boolean {
  if (setting.F !== "tree" || setting.T !== "B") return false;
  const options = (setting.O ?? []).map((o) => Object.entries(o)[0] ?? []);
  return options.length === 2
    && options.some(([label, value]) => /^false$/i.test(String(label)) && value === 0)
    && options.some(([label, value]) => /^true$/i.test(String(label)) && value === 1);
}

function normalizeSettingValueForSave(setting: Setting, value: string): string {
  if (!isBooleanTreeSetting(setting)) return value;
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1" ? "true" : "false";
}

function booleanSettingValueIsOn(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return Number(value) !== 0;
}

function settingLimit(limit: string | undefined): number | null {
  if (limit === undefined || limit.trim() === "") return null;
  const n = Number(limit);
  return Number.isFinite(n) ? n : null;
}

/** Explains why a typed number cannot be sent to ESP401, or returns null. */
export function numericSettingError(setting: Setting, value: string): string | null {
  const n = parseDecimalInput(value);
  if (n === null) return __uiText("components.SettingsPanel.numeric.not_number.1", "Not a number");
  if (setting.T === "I" && !Number.isInteger(n)) return __uiText("components.SettingsPanel.numeric.integer.1", "Must be a whole number");
  const min = settingLimit(setting.M);
  const reportedMax = settingLimit(setting.S);
  // FluidNC reports a uint32 default maximum as -1: that maximum is unknown,
  // but the minimum (usually 0) still holds.
  const max = min !== null && reportedMax !== null && reportedMax < min ? null : reportedMax;
  if ((min !== null && n < min) || (max !== null && n > max)) {
    return min !== null && max !== null
      ? formatUi(__uiText("components.SettingsPanel.numeric.between.1", "Must be between {min} and {max}"), { min, max })
      : min !== null
        ? formatUi(__uiText("components.SettingsPanel.numeric.minimum.1", "Must be at least {min}"), { min })
        : formatUi(__uiText("components.SettingsPanel.numeric.maximum.1", "Must be at most {max}"), { max });
  }
  return null;
}

function saveErrorText(e: unknown): string {
  if (!(e instanceof Error)) return __uiText("components.SettingsPanel.numeric.save_failed.1", "Save failed");
  // FluidNC answers 503 to web commands while the machine is moving.
  if (e instanceof WebUIBlockedError || e.message === "HTTP 503") return __uiText("components.SettingsPanel.numeric.busy.1", "Controller busy: try again when not moving");
  return formatUi(__uiText("components.SettingsPanel.numeric.save_details.1", "Save failed: {message}"), { message: e.message });
}

function SettingRow({ setting, showPath, onSave }: SettingRowProps) {
  const [value, setValue] = useState(setting.V);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    setValue(setting.V);
  }, [setting.V]);

  const changed = value !== setting.V;
  const unit = inferUnit(setting.P);
  const label = displayLabel(setting);
  const opts = setting.O ?? [];
  const isNumeric = setting.T === "I" || setting.T === "F" || setting.T === "R";
  const isPassword = /(?:^|\/)password$/i.test(setting.P);
  const maskedPassword = isPassword && /^\*{4,}$/.test(value.trim());

  const optVals = opts.map((o) => Object.values(o)[0]).sort((a, b) => a - b);
  const isToggle =
    setting.T === "B" &&
    opts.length === 2 &&
    optVals[0] === 0 &&
    optVals[1] === 1;

  async function save() {
    if (!changed || saveState === "saving") return;
    // FluidNC treats an empty V= as a query: nothing would be set, but the
    // empty value would be shown as saved and written to the config file.
    const invalid =
      value.trim() === ""
        ? __uiText("components.SettingsPanel.numeric.value_required.1", "Enter a value")
        : isNumeric && !isPassword
          ? numericSettingError(setting, value)
          : null;
    setSaveError(invalid ?? "");
    if (invalid) return;
    setSaveState("saving");
    try {
      // A decimal comma must reach the controller as a point: "80,5" steps/mm
      // was sent as 805.
      if (isNumeric && parseDecimalInput(value) === null) throw new Error("not a number");
      const sent = isNumeric ? value.trim().replace(",", ".") : value;
      await onSave(setting.P, setting.T, normalizeSettingValueForSave(setting, sent));
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 2500);
    } catch (e) {
      setSaveError(saveErrorText(e));
      setSaveState("error");
      setTimeout(() => setSaveState("idle"), 3000);
    }
  }

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === "Enter" && changed) save();
  }

  if (isToggle) {
    const isOn = booleanSettingValueIsOn(value);
    const onEntry = opts.find((o) => Object.values(o)[0] === 1);
    const offEntry = opts.find((o) => Object.values(o)[0] === 0);
    const onVal = String(Object.values(onEntry ?? {})[0] ?? 1);
    const offVal = String(Object.values(offEntry ?? {})[0] ?? 0);

    function toggle() {
      const next = normalizeSettingValueForSave(setting, isOn ? offVal : onVal);
      setValue(next);
      onSave(setting.P, setting.T, next)
        .then(() => {
          setSaveState("saved");
          setTimeout(() => setSaveState("idle"), 1500);
        })
        .catch((e) => {
          setValue(setting.V);
          setSaveError(saveErrorText(e));
          setSaveState("error");
          setTimeout(() => setSaveState("idle"), 2000);
        });
    }

    return (
      <div
        className="flex items-center gap-3 px-4 py-2.5 border-b border-border last:border-0
                      hover:bg-elevated/40 transition-colors"
      >
        <div className="flex-1 min-w-0">
          <div className="text-base text-text-primary leading-tight">
            {label}
          </div>
          {showPath && (
            <div className="text-sm text-text-dim mt-0.5">
              {searchBreadcrumb(setting)}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {saveState === "saved" && (
            <span className="text-sm text-ok">{__uiText("components.SettingsPanel.saved.1", "saved")}</span>
          )}
          {saveState === "error" && (
            <span className="text-sm text-danger">{saveError || __uiText("components.SettingsPanel.extra_coverage.1", "error")}</span>
          )}
          <button
            dir="ltr"
            role="switch"
            aria-checked={isOn}
            aria-label={label}
            onClick={toggle}
            className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full
                        border transition-colors duration-200 ${
                          isOn
                            ? "bg-ok border-ok/60"
                            : "bg-elevated border-border-strong"
                        }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm
                             transition-transform duration-200 ${
                               isOn ? "translate-x-[18px]" : "translate-x-[2px]"
                             }`}
            />
          </button>
        </div>
      </div>
    );
  }

  if (setting.T === "B" && opts.length > 0) {
    const selectValue = isBooleanTreeSetting(setting)
      ? normalizeSettingValueForSave(setting, value)
      : value;

    return (
      <div
        className={`flex items-center gap-3 px-4 py-2.5 border-b border-border last:border-0
                       hover:bg-elevated/40 transition-colors ${changed ? "border-l-2 border-l-warn" : ""}`}
      >
        <div className="flex-1 min-w-0">
          <div className="text-base text-text-primary">{label}</div>
          {showPath && (
            <div className="text-sm text-text-dim mt-0.5">
              {searchBreadcrumb(setting)}
            </div>
          )}
          {saveError && (
            <div className="text-sm text-danger mt-0.5">{saveError}</div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <select
            value={selectValue}
            onChange={(e) => {
              setValue(e.target.value);
              setSaveError("");
            }}
            className="input-field py-1 text-sm w-36"
          >
            {opts.map((opt) => {
              const [optLabel, optVal] = Object.entries(opt)[0];
              const optionValue = normalizeSettingValueForSave(
                setting,
                String(optVal),
              );
              return (
                <option key={String(optVal)} value={optionValue}>
                  {optLabel}
                </option>
              );
            })}
          </select>
          <SaveBtn state={saveState} changed={changed} onClick={save} />
        </div>
      </div>
    );
  }

  return (
    <div
      className={`px-4 py-2.5 border-b border-border last:border-0
                     hover:bg-elevated/40 transition-colors ${changed ? "border-l-2 border-l-warn" : ""}`}
    >
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="min-w-0">
          <span className="text-base text-text-primary leading-tight">
            {label}
          </span>
          {showPath && (
            <div className="text-sm text-text-dim">
              {searchBreadcrumb(setting)}
            </div>
          )}
        </div>
        {unit && <span className="text-sm text-text-dim shrink-0">{unit}</span>}
      </div>
      <div className="flex items-center gap-2">
        <input
          type={isPassword ? "password" : "text"}
          // The iOS decimal keypad has no minus key.
          inputMode={isNumeric && Number(setting.M) >= 0 ? "decimal" : undefined}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setSaveError("");
          }}
          onFocus={(e) => {
            if (maskedPassword) e.currentTarget.select();
          }}
          onKeyDown={handleKey}
          className="input-field flex-1 py-1 text-sm font-mono"
          spellCheck={false}
        />
        <SaveBtn state={saveState} changed={changed} onClick={save} />
      </div>
      {saveError && (
        <div className="mt-1 text-sm text-danger">{saveError}</div>
      )}
    </div>
  );
}

function SectionHeader({
  label,
  level,
}: {
  label: string;
  level: "section" | "subsection";
}) {
  if (level === "subsection") {
    return (
      <div className="px-4 pt-3 pb-1 text-sm font-semibold uppercase tracking-widest text-text-dim">
        {label}
      </div>
    );
  }
  return (
    <div
      className="px-4 pt-4 pb-1.5 text-sm font-bold uppercase tracking-wider text-accent/80
                    border-t border-border first:border-t-0 first:pt-3 bg-elevated/20"
    >
      {label}
    </div>
  );
}

/** Returns null when the key is not written in the file. */
export function updateYamlInPlace(
  yaml: string,
  path: string,
  newValue: string,
): string | null {
  const parts = path
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean)
    .map((p) => p.toLowerCase());
  const lines = yaml.split("\n");

  let matchDepth = 0;
  const indentAtDepth: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const indent = line.length - line.trimStart().length;

    // Pop path stack when we exit a section
    while (
      indentAtDepth.length > 0 &&
      indent <= indentAtDepth[indentAtDepth.length - 1]
    ) {
      indentAtDepth.pop();
      matchDepth--;
    }

    if (!trimmed.includes(":")) continue;

    const colonIdx = trimmed.indexOf(":");
    const key = trimmed.slice(0, colonIdx).trim().toLowerCase();

    if (key === parts[matchDepth]) {
      if (matchDepth === parts.length - 1) {
        const lineIndent = line.slice(0, line.length - line.trimStart().length);
        const originalKey = trimmed.slice(0, colonIdx).trim();
        // Preserve a trailing inline comment (e.g. "# tuned 2024-01-15") by
        // the validator's rule: never inside quotes, never in a macro line.
        const afterColon = trimmed.slice(colonIdx + 1);
        const commentAt = yamlCommentStart(originalKey, afterColon);
        const inlineComment = commentAt >= 0 ? `  ${afterColon.slice(commentAt)}` : "";
        lines[i] = `${lineIndent}${originalKey}: ${newValue}${inlineComment}`;
        return lines.join("\n");
      }
      indentAtDepth.push(indent);
      matchDepth++;
    }
  }

  return null;
}

interface PendingConfigChange {
  value: string;
}

interface ConfigFile {
  fs: "local" | "sd";
  dir: string;
  name: string;
}

/** The file the controller loads its config from ($Config/Filename, default config.yaml). */
export function activeConfigFile(settings: Setting[]): ConfigFile {
  const raw =
    settings
      .find((s) => s.P.replace(/^\/+/, "") === "Config/Filename")
      ?.V.trim() || "config.yaml";
  let path = raw.replace(/\\/g, "/").replace(/^\/+/, "");
  let fs: ConfigFile["fs"] = "local";
  if (/^sd\//i.test(path)) {
    fs = "sd";
    path = path.slice(3);
  } else {
    path = path.replace(/^localfs\//i, "");
  }
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  if (!name) return { fs: "local", dir: "/", name: "config.yaml" };
  return { fs, dir: `/${path.slice(0, slash + 1)}`, name };
}

/** Writes the changes into the config file; returns the setting paths it does not contain. */
async function updateConfigYamlBatch(
  changes: Record<string, PendingConfigChange>,
  file: ConfigFile,
): Promise<string[]> {
  const entries = Object.entries(changes);
  if (entries.length === 0) return [];

  try {
    const configContent = await fetchFileContent(
      `${file.dir}${file.name}`,
      file.fs,
    );
    const missing: string[] = [];
    const updatedContent = entries.reduce((yaml, [settingPath, change]) => {
      const updated = updateYamlInPlace(yaml, settingPath, change.value);
      if (updated === null) missing.push(settingPath);
      return updated ?? yaml;
    }, configContent);
    if (missing.length < entries.length) {
      await replaceFileContent(file.dir, file.name, updatedContent, file.fs);
    }
    return missing;
  } catch (error) {
    console.warn(formatUi(__uiText("components.SettingsPanel.template_coverage.1", "Failed to update {v0}:"), { v0: file.name }), error);
    throw error;
  }
}

type FirmwarePhase =
  | "idle"
  | "downloading"
  | "uploading"
  | "restarting"
  | "error";

type GithubRelease = {
  id: number;
  name: string;
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
};
type Chip = "esp32" | "esp32s3";
type Radio = "wifi" | "bt" | "noradio";

const CHIPS: { id: Chip; label: string }[] = [
  { id: "esp32", label: "ESP32" },
  { id: "esp32s3", label: "ESP32-S3" },
];
const RADIOS: { id: Radio; label: string }[] = [
  { id: "wifi", label: "WiFi" },
  { id: "bt", label: "Bluetooth" },
  { id: "noradio", label: __uiText("components.SettingsPanel.no_radio.1", "No Radio") },
];

function parseVer(s: string): [number, number, number] {
  const m = s.match(/v?(\d+)\.(\d+)\.(\d+)(-\S+)?/);
  return m ? [+m[1], +m[2], +m[3]] : [0, 0, 0];
}

function cmpVer(a: string, b: string): number {
  const av = parseVer(a),
    bv = parseVer(b);
  for (let i = 0; i < 3; i++) if (av[i] !== bv[i]) return av[i] - bv[i];
  return 0;
}

const FLUIDNC_RESOURCES =
  "https://raw.githubusercontent.com/bdring/fluidnc-releases/main/releases";

type FirmwareImage = { offset: string; path: string };
type FirmwareChoice = {
  "choice-name"?: string;
  images?: string[];
  choices?: FirmwareChoice[];
};
type ReleaseManifest = {
  images: Record<string, FirmwareImage>;
  installable: FirmwareChoice;
};

async function fetchFirmwareBin(
  releaseName: string,
  chip: Chip,
  radio: Radio,
  onProgress: (pct: number) => void,
): Promise<File> {
  const manifestRes = await fetch(
    `${FLUIDNC_RESOURCES}/${releaseName}/manifest.json`,
  );
  if (!manifestRes.ok)
    throw new Error(
      formatUi(__uiText("components.SettingsPanel.template_coverage.2", "Manifest not found for {v0} (HTTP {v1})"), { v0: releaseName, v1: manifestRes.status }),
    );
  const manifest: ReleaseManifest = await manifestRes.json();

  const imageKey = `${chip}-${radio}-firmware`;
  const image = manifest.images[imageKey];
  if (!image)
    throw new Error(`No firmware found for ${chip} / ${radio} in this release`);

  const url = `${FLUIDNC_RESOURCES}/${releaseName}/${image.path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(formatUi(__uiText("components.SettingsPanel.template_coverage.3", "Download failed (HTTP {v0})"), { v0: res.status }));

  const total = Number(res.headers.get("content-length") ?? 0);
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total) onProgress(Math.round((received / total) * 100));
  }
  const out = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return new File([out], image.path.split("/").pop() ?? "firmware.bin", {
    type: "application/octet-stream",
  });
}

function ProgressBar({
  value,
  color = "accent",
}: {
  value: number;
  color?: "accent" | "ok";
}) {
  return (
    <div className="h-2 rounded-full bg-elevated overflow-hidden">
      <div
        className={`h-full rounded-full transition-all duration-200 ${color === "ok" ? "bg-ok duration-1000" : "bg-accent"}`}
        style={{ width: `${value}%` }}
      />
    </div>
  );
}

// FluidNC accepts a firmware upload while it moves and reboots once the image
// is written, which would end a running job.
const FLASH_AFTER_JOB = __uiText("components.SettingsPanel.late_coverage.5", "A job is running. Flash the firmware after it has finished.");

function isJobActive(state: string, sdFilename: string | undefined, senderPhase: string) {
  return state === "Run" || state === "Hold" || !!sdFilename ||
    senderPhase === "streaming" || senderPhase === "paused" || senderPhase === "draining";
}

function FirmwareTab() {
  const espInfo = useMachineStore((s) => s.espInfo);
  const jobRunning = isJobActive(
    useMachineStore((s) => s.status.state),
    useMachineStore((s) => s.status.sdFilename),
    useGCodeSenderStore((s) => s.phase),
  );

  const [phase, setPhase] = useState<FirmwarePhase>("idle");
  const [progress, setProgress] = useState(0);
  const [statusMsg, setStatusMsg] = useState("");
  const [countdown, setCountdown] = useState(0);
  const [errorMsg, setErrorMsg] = useState("");

  const [releases, setReleases] = useState<GithubRelease[]>([]);
  const [showPrerelease, setShowPrerelease] = useState(false);
  const [selectedTag, setSelectedTag] = useState("");
  const [chip, setChip] = useState<Chip>("esp32");
  const [radio, setRadio] = useState<Radio>("wifi");
  const [releasesLoading, setReleasesLoading] = useState(false);
  const [releasesError, setReleasesError] = useState("");
  const releaseRequestRef = useRef<AbortController | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const busy =
    phase === "downloading" || phase === "uploading" || phase === "restarting";

  const currentVer = espInfo?.version ?? "";
  const visibleReleases = releases.filter(
    (r) =>
      (showPrerelease || !r.prerelease) &&
      (currentVer ? cmpVer(r.tag_name, currentVer) !== 0 : true),
  );

  async function loadReleases() {
    releaseRequestRef.current?.abort();
    const controller = new AbortController();
    releaseRequestRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 10_000);

    setReleasesLoading(true);
    setReleasesError("");
    try {
      const response = await fetch(
        "https://api.github.com/repos/bdring/FluidNC/releases?per_page=30",
        {
          signal: controller.signal,
        },
      );
      if (!response.ok)
        throw new Error(formatUi(__uiText("components.SettingsPanel.template_coverage.4", "GitHub API error ({v0})"), { v0: response.status }));

      const data: GithubRelease[] = await response.json();
      const filtered = data
        .filter((r) => !r.draft && cmpVer(r.tag_name, "v4.0.3") >= 0)
        .sort((a, b) => b.id - a.id);
      setReleases(filtered);
      const stable = filtered.find((r) => !r.prerelease);
      setSelectedTag(stable?.tag_name ?? "");
    } catch (e) {
      if (releaseRequestRef.current !== controller) return;
      const offline = typeof navigator !== "undefined" && !navigator.onLine;
      const timedOut = e instanceof DOMException && e.name === "AbortError";
      setReleasesError(
        offline
          ? __uiText("components.SettingsPanel.late_coverage.6", "No internet connection. Online updates are unavailable.")
          : timedOut
            ? __uiText("components.SettingsPanel.late_coverage.7", "Could not fetch updates. Check your internet connection and try again.")
            : e instanceof Error
              ? formatUi(__uiText("components.SettingsPanel.template_coverage.5", "Could not check GitHub: {v0}"), { v0: e.message })
              : __uiText("components.SettingsPanel.late_coverage.8", "Could not check GitHub for updates."),
      );
    } finally {
      window.clearTimeout(timeout);
      if (releaseRequestRef.current === controller) {
        releaseRequestRef.current = null;
        setReleasesLoading(false);
      }
    }
  }

  useEffect(() => {
    loadReleases();
    return () => releaseRequestRef.current?.abort();
  }, []);

  function beginRestart() {
    setPhase("restarting");
    let remaining = 40;
    setCountdown(remaining);
    const poll = setInterval(async () => {
      try {
        await getDeviceInfoFast();
        clearInterval(poll);
        clearInterval(tick);
        location.reload();
      } catch {
        /* not up yet */
      }
    }, 2000);
    const tick = setInterval(() => {
      remaining--;
      setCountdown(remaining);
      if (remaining <= 0) {
        clearInterval(poll);
        clearInterval(tick);
        location.reload();
      }
    }, 1000);
  }

  async function flashFile(file: File) {
    // A job may have started while the release was downloading.
    const { state, sdFilename } = useMachineStore.getState().status;
    if (isJobActive(state, sdFilename, useGCodeSenderStore.getState().phase)) {
      setPhase("error");
      setErrorMsg(FLASH_AFTER_JOB);
      return;
    }
    setPhase("uploading");
    setProgress(0);
    setStatusMsg(formatUi(__uiText("components.SettingsPanel.firmware_upload.1", "Uploading {name}…"), { name: file.name }));
    try {
      await uploadFirmware(file, (pct) => setProgress(pct));
      beginRestart();
    } catch (e) {
      setPhase("error");
      setErrorMsg(e instanceof Error ? e.message : __uiText("components.SettingsPanel.alert_coverage.1", "Upload failed"));
    }
  }

  async function downloadAndFlash() {
    if (!selectedTag || jobRunning) return;
    if (
      !confirm(
        formatUi(__uiText("components.SettingsPanel.alert_coverage.2", "Download and flash FluidNC {v0} ({v1} / {v2})?\n\nThe device will restart after flashing."), { v0: selectedTag, v1: chip, v2: radio }),
      )
    )
      return;

    setPhase("downloading");
    setProgress(0);
    setStatusMsg(__uiText("components.SettingsPanel.firmware_download.1", "Downloading firmware…"));
    setErrorMsg("");
    try {
      const binFile = await fetchFirmwareBin(selectedTag, chip, radio, (pct) =>
        setProgress(pct),
      );
      await flashFile(binFile);
    } catch (e) {
      setPhase("error");
      setErrorMsg(e instanceof Error ? e.message : __uiText("components.SettingsPanel.alert_coverage.3", "Update failed"));
    }
  }

  function pickFile(f: File | null | undefined) {
    if (!f) return;
    setFile(f);
    setErrorMsg("");
  }

  const latestStable = releases.find((r) => !r.prerelease);
  const hasNewerStable = latestStable
    ? cmpVer(latestStable.tag_name, currentVer) > 0
    : false;

  return (
    <div className="flex flex-col divide-y divide-border max-w-lg">
      {jobRunning && !busy && (
        <div className="px-5 py-3 text-sm text-warn">{FLASH_AFTER_JOB}</div>
      )}
      {/* ── Online Update ── */}
      <div className="flex flex-col gap-4 p-5">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-text-dim">
            {__uiText("components.SettingsPanel.online_update.1", "Online Update")}
          </h3>
          {currentVer && (
            <span className="text-sm text-text-dim font-mono">
              {currentVer}
            </span>
          )}
        </div>

        {releasesError && (
          <div className="flex flex-col gap-2">
            <div className="p-3 rounded bg-elevated border border-border text-text-muted text-sm">
              {releasesError}
            </div>
            <button
              onClick={loadReleases}
              disabled={releasesLoading}
              className="flex items-center gap-1.5 text-sm text-text-muted hover:text-text-primary
                         transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <RefreshCw size={12} />
              {__uiText("components.SettingsPanel.retry.1", "Retry")}
            </button>
          </div>
        )}

        {releasesLoading && (
          <div className="flex items-center gap-2 text-sm text-text-muted">
            <RefreshCw size={13} className="animate-spin" />
            {__uiText("components.SettingsPanel.fetching_releases.1", "Fetching releases…")}
          </div>
        )}

        {!releasesError &&
          !releasesLoading &&
          visibleReleases.length === 0 &&
          releases.length > 0 && (
            <div className="flex items-center gap-2 p-2.5 rounded bg-ok/10 border border-ok/30 text-ok text-sm">
              <Check size={13} className="shrink-0" />
              {__uiText("components.SettingsPanel.coverage.1", "You're on the latest version (")}{currentVer}).
            </div>
          )}

        {!releasesError && !releasesLoading && visibleReleases.length > 0 && (
          <>
            {hasNewerStable && latestStable && (
              <div className="flex items-center gap-2 p-2.5 rounded bg-ok/10 border border-ok/30 text-ok text-sm">
                <Upload size={13} className="shrink-0" />
                {__uiText("components.SettingsPanel.update_available.1", "Update available:")} {latestStable.tag_name}
              </div>
            )}

            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-3">
                <div className="flex-1 flex flex-col gap-1">
                  <label className="text-xs text-text-dim uppercase tracking-wider">
                    {__uiText("components.SettingsPanel.version.1", "Version")}
                  </label>
                  <select
                    value={selectedTag}
                    onChange={(e) => setSelectedTag(e.target.value)}
                    disabled={busy}
                    className="input-field py-1.5 text-sm"
                  >
                    {visibleReleases.map((r) => (
                      <option key={r.id} value={r.tag_name}>
                        {r.tag_name}
                        {r.prerelease
                          ? __uiText("components.SettingsPanel.pre_release.1", " (pre-release)")
                          : r.tag_name === latestStable?.tag_name
                            ? __uiText("components.SettingsPanel.latest.1", " (latest)")
                            : ""}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex-1 flex flex-col gap-1">
                  <label className="text-xs text-text-dim uppercase tracking-wider">
                    Chip
                  </label>
                  <select
                    value={chip}
                    onChange={(e) => setChip(e.target.value as Chip)}
                    disabled={busy}
                    className="input-field py-1.5 text-sm"
                  >
                    {CHIPS.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex-1 flex flex-col gap-1">
                  <label className="text-xs text-text-dim uppercase tracking-wider">
                    Radio
                  </label>
                  <select
                    value={radio}
                    onChange={(e) => setRadio(e.target.value as Radio)}
                    disabled={busy}
                    className="input-field py-1.5 text-sm"
                  >
                    {RADIOS.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <label className="flex items-center gap-2 text-sm text-text-muted cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={showPrerelease}
                  onChange={(e) => setShowPrerelease(e.target.checked)}
                  className="accent-[var(--accent)]"
                />
                {__uiText("components.SettingsPanel.show_pre_releases.1", "Show pre-releases")}
              </label>
            </div>

            {!busy && (
              <button
                onClick={downloadAndFlash}
                disabled={!selectedTag || jobRunning}
                className="flex items-center justify-center gap-2 px-4 py-2.5 rounded text-sm font-medium
                           bg-accent text-white hover:bg-accent/90 transition-colors
                           disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Upload size={14} />
                {__uiText("components.SettingsPanel.coverage.2", "Download & Flash")}
              </button>
            )}
          </>
        )}

        {(phase === "downloading" || phase === "uploading") && (
          <div className="flex flex-col gap-2">
            <div className="flex justify-between text-sm text-text-muted">
              <span>
                {phase === "uploading" && progress === 100
                  ? __uiText("components.SettingsPanel.writing_to_flash.1", "Writing to flash…")
                  : statusMsg}
              </span>
              <span>{progress}%</span>
            </div>
            <ProgressBar value={progress} />
          </div>
        )}
      </div>

      {/* ── Restart progress (shared) ── */}
      {phase === "restarting" && (
        <div className="flex flex-col gap-2 p-5">
          <div className="flex justify-between text-sm text-text-muted">
            <span>{__uiText("components.SettingsPanel.restarting_device.1", "Restarting device…")}</span>
            <span>{countdown}s</span>
          </div>
          <ProgressBar value={(1 - countdown / 40) * 100} color="ok" />
          <p className="text-sm text-text-dim">
            {__uiText("components.SettingsPanel.page_will_reload_automatically_when.1", "Page will reload automatically when ready.")}
          </p>
        </div>
      )}

      {phase === "error" && (
        <div className="p-5">
          <div className="p-3 rounded bg-danger/10 border border-danger/30 text-danger text-sm">
            {errorMsg}
          </div>
        </div>
      )}

      {/* ── Manual Flash ── */}
      <div className="flex flex-col gap-4 p-5">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-text-dim">
          {__uiText("components.SettingsPanel.manual_flash.1", "Manual Flash")}
        </h3>

        <label
          className={`flex flex-col items-center justify-center gap-2 p-6 rounded-lg border-2 border-dashed
                      transition-colors ${
                        busy
                          ? "border-border opacity-50 cursor-not-allowed"
                          : dragOver
                            ? "border-accent bg-accent/10 cursor-pointer"
                            : "border-border hover:border-accent/50 hover:bg-elevated/40 cursor-pointer"
                      }`}
          onDragOver={(e) => {
            if (busy) return;
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (!busy) pickFile(e.dataTransfer.files[0]);
          }}
        >
          <input
            type="file"
            accept=".bin"
            disabled={busy}
            className="sr-only"
            onChange={(e) => pickFile(e.target.files?.[0])}
          />
          <Upload size={28} className="text-text-dim" />
          {file ? (
            <span className="text-sm text-text-primary font-mono">
              {file.name}
            </span>
          ) : (
            <span className="text-sm text-text-muted">
              {__uiText("components.SettingsPanel.drop_bin_file_or_click_to_browse.1", "Drop .bin file or click to browse")}
            </span>
          )}
          {file && (
            <span className="text-xs text-text-dim">
              {file.size < 1048576
                ? `${(file.size / 1024).toFixed(1)} KB`
                : `${(file.size / 1048576).toFixed(2)} MB`}
            </span>
          )}
        </label>

        <button
          disabled={!file || busy || jobRunning}
          onClick={() => {
            if (!file || jobRunning) return;
            if (
              !confirm(
                formatUi(__uiText("components.SettingsPanel.alert_coverage.4", "Flash firmware from \"{v0}\"? The device will restart."), { v0: file.name }),
              )
            )
              return;
            flashFile(file);
          }}
          className="flex items-center justify-center gap-2 px-4 py-2.5 rounded text-sm font-medium
                     bg-accent text-white hover:bg-accent/90 transition-colors
                     disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Upload size={14} />
          {__uiText("components.SettingsPanel.flash_firmware.1", "Flash Firmware")}
        </button>
      </div>
    </div>
  );
}

interface SettingsPanelProps {
  onClose?: () => void;
  onRequestCloseReady?: (requestClose: (() => void) | null) => void;
}

interface ESPNowPendant {
  index: number;
  mac: string;
}

function parseESPNowPendants(raw: string): ESPNowPendant[] {
  const pendants: ESPNowPendant[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/\b(\d+):\s*([0-9a-f]{2}(?::[0-9a-f]{2}){5})\b/i);
    if (match) {
      pendants.push({ index: Number(match[1]), mac: match[2].toLowerCase() });
    }
  }
  return pendants;
}

function ESPNowPendantsTab() {
  const [pendants, setPendants] = useState<ESPNowPendant[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [pairingUntil, setPairingUntil] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [pairingBaseline, setPairingBaseline] = useState<string[]>([]);
  const [pairingFeedback, setPairingFeedback] = useState("");

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      setPendants(parseESPNowPendants(await sendCommand("$ESPNow/List")));
    } catch (e) {
      setError(
        e instanceof Error ? e.message : __uiText("components.SettingsPanel.late_coverage.9", "Failed to list ESP-NOW pendants"),
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    if (!pairingUntil) {
      setSecondsLeft(0);
      return;
    }
    const update = () => {
      const remaining = Math.max(
        0,
        Math.ceil((pairingUntil - Date.now()) / 1000),
      );
      setSecondsLeft(remaining);
      if (remaining === 0) {
        setPairingUntil(0);
        setPairingFeedback(__uiText("components.SettingsPanel.late_coverage.10", "Pairing window expired"));
      }
    };
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [pairingUntil]);

  useEffect(() => {
    if (!pairingUntil) return;

    let stopped = false;
    const baseline = new Set(pairingBaseline);
    const poll = async () => {
      try {
        const current = parseESPNowPendants(await sendCommand("$ESPNow/List"));
        if (stopped) return;
        setPendants(current);
        const added = current.find((pendant) => !baseline.has(pendant.mac));
        if (added) {
          setPairingUntil(0);
          setPairingFeedback(`Paired successfully: ${added.mac}`);
        }
      } catch {
        // A transient request failure should not cancel the controller's window.
      }
    };

    const timer = window.setInterval(poll, 1000);
    poll();
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [pairingUntil, pairingBaseline]);

  async function run(action: string, command: string, after?: () => void) {
    setBusy(action);
    setError("");
    try {
      await sendCommand(command);
      after?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : __uiText("components.SettingsPanel.espnow_failed.1", "ESP-NOW command failed"));
    } finally {
      setBusy("");
    }
  }

  async function startPairing() {
    setBusy("pair");
    setError("");
    setPairingFeedback("");
    try {
      const current = parseESPNowPendants(await sendCommand("$ESPNow/List"));
      setPendants(current);
      setPairingBaseline(current.map((pendant) => pendant.mac));
      await sendCommand("$ESPNow/Pair");
      setPairingUntil(Date.now() + 60_000);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : __uiText("components.SettingsPanel.late_coverage.11", "Failed to start ESP-NOW pairing"),
      );
    } finally {
      setBusy("");
    }
  }

  function cancelPairing() {
    run("cancel", "$ESPNow/Cancel", () => {
      setPairingUntil(0);
      setPairingFeedback(__uiText("components.SettingsPanel.pair_cancelled.1", "Pairing cancelled"));
    });
  }

  function removePendant(pendant: ESPNowPendant) {
    if (!confirm(formatUi(__uiText("components.SettingsPanel.unpair_one.1", "Unpair ESP-NOW pendant {mac}?"), { mac: pendant.mac }))) return;
    run(`remove-${pendant.index}`, `$ESPNow/Unpair=${pendant.index}`, refresh);
  }

  function clearPendants() {
    if (!confirm(__uiText("components.SettingsPanel.notice.1", "Unpair all ESP-NOW pendants?"))) return;
    run("clear", "$ESPNow/Unpair=0", refresh);
  }

  const disabled = busy !== "";

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 px-5 py-3.5 border-b border-border">
        {secondsLeft > 0 ? (
          <>
            <div className="flex items-center gap-2 mr-auto text-sm text-text-primary">
              <span className="w-2 h-2 rounded-full bg-ok animate-pulse" />
              {__uiText("components.SettingsPanel.pairing_active.1", "Pairing active")}
              <span className="font-mono text-text-muted">{secondsLeft}s</span>
            </div>
            <button
              onClick={cancelPairing}
              disabled={disabled}
              className="flex items-center gap-1.5 px-3 py-2 rounded text-sm font-medium
                         border border-border text-text-muted hover:text-text-primary
                         hover:bg-elevated transition-colors disabled:opacity-40"
            >
              <Square size={13} />
              {__uiText("components.SettingsPanel.cancel_pairing.1", "Cancel Pairing")}
            </button>
          </>
        ) : (
          <>
            <div className="mr-auto text-sm text-text-muted">
              {__uiText("components.SettingsPanel.open_a_60_second_pairing_window_for.1", "Open a 60-second pairing window for nearby ESP-NOW pendants & peripherals.")}
            </div>
            <button
              onClick={startPairing}
              disabled={disabled}
              className="flex items-center gap-1.5 px-3 py-2 rounded text-sm font-medium
                         bg-accent text-white hover:bg-accent/90
                         transition-colors disabled:opacity-40"
            >
              <Radio size={14} />
              {__uiText("components.SettingsPanel.pair_pendant.1", "Pair Pendant")}
            </button>
          </>
        )}
      </div>

      {pairingFeedback && (
        <div
          className={`mx-4 mt-4 p-3 rounded border text-sm ${
            pairingFeedback.startsWith("Paired successfully")
              ? "bg-ok/10 border-ok/30 text-ok"
              : "bg-elevated border-border text-text-muted"
          }`}
        >
          {pairingFeedback.startsWith("Paired successfully: ") ? formatUi(__uiText("components.SettingsPanel.pair_success.1", "Paired successfully: {mac}"), { mac: pairingFeedback.slice("Paired successfully: ".length) }) : pairingFeedback}
        </div>
      )}

      {error && (
        <div className="m-4 p-3 rounded bg-danger/10 border border-danger/30 text-danger text-sm">
          {error}
        </div>
      )}

      <div className="flex items-center justify-between px-5 py-3 border-b border-border">
        <div>
          <div className="text-sm font-medium text-text-primary">
            {__uiText("components.SettingsPanel.paired_pendants.1", "Paired pendants")}
          </div>
          <div className="text-xs text-text-dim">
            {loading ? __uiText("components.SettingsPanel.loading.1", "Loading...") : formatUi(__uiText("components.SettingsPanel.tail_coverage.1", "{v0} paired"), { v0: pendants.length })}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={refresh}
            disabled={loading || disabled}
            className="p-2 rounded text-text-muted hover:text-text-primary hover:bg-elevated
                       transition-colors disabled:opacity-40"
            title={__uiText("components.SettingsPanel.refresh_paired_pendants.1", "Refresh paired pendants")}
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </button>
          {pendants.length > 0 && (
            <button
              onClick={clearPendants}
              disabled={disabled}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-sm
                         text-text-muted hover:text-danger hover:bg-danger/10
                         transition-colors disabled:opacity-40"
            >
              <Trash2 size={13} />
              {__uiText("components.SettingsPanel.unpair_all.1", "Unpair All")}
            </button>
          )}
        </div>
      </div>

      {!loading && pendants.length === 0 && !error && (
        <div className="flex flex-col items-center justify-center h-32 gap-2 text-text-dim text-sm">
          <Radio size={22} />
          {__uiText("components.SettingsPanel.no_esp_now_pendants_paired.1", "No ESP-NOW pendants paired")}
        </div>
      )}

      {pendants.map((pendant) => (
        <div
          key={pendant.mac}
          className="flex items-center gap-3 px-5 py-3.5 border-b border-border"
        >
          <Radio size={16} className="text-accent shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-text-primary">
              {__uiText("components.SettingsPanel.pendant.1", "Pendant")} {pendant.index}
            </div>
            <div className="font-mono text-xs text-text-muted">
              {pendant.mac}
            </div>
          </div>
          <button
            onClick={() => removePendant(pendant)}
            disabled={disabled}
            className="p-2 rounded text-text-muted hover:text-danger hover:bg-danger/10
                       transition-colors disabled:opacity-40"
            title={formatUi(__uiText("components.SettingsPanel.dynamic.1", "Unpair {v0}"), { v0: pendant.mac })}
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function SettingsPanel({
  onClose,
  onRequestCloseReady,
}: SettingsPanelProps) {
  const isMobile = useViewportMetrics().innerWidth < 768;
  const espInfo = useMachineStore((s) => s.espInfo);
  const units = useMachineStore((s) => s.units);
  const setUnits = useMachineStore((s) => s.setUnits);
  const layoutMode = useMachineStore((s) => s.layoutMode);
  const setLayoutMode = useMachineStore((s) => s.setLayoutMode);
  const theme = useMachineStore((s) => s.theme);
  const setTheme = useMachineStore((s) => s.setTheme);
  const cachedSettings = useMachineStore((s) => s.controllerConfigSettings);
  const cachedSettingsLoading = useMachineStore(
    (s) => s.controllerConfigLoading,
  );

  const [settings, setSettings] = useState<Setting[]>(
    () => useMachineStore.getState().controllerConfigSettings ?? [],
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [category, setCategory] = useState("workspace");
  const [subKey, setSubKey] = useState("");
  const [configSublistExpanded, setConfigSublistExpanded] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const restartTap = useConfirmTap();
  const machineState = useMachineStore((s) => s.status.state);
  const senderPhase = useGCodeSenderStore((s) => s.phase);
  // FluidNC refuses web commands while moving; in Hold the restart goes
  // through and the job is lost, so say so on the confirm tap.
  const machineMoving =
    machineState === "Run" || machineState === "Jog" || machineState === "Home";
  const jobActive =
    machineState === "Run" ||
    machineState === "Hold" ||
    senderPhase === "streaming" ||
    senderPhase === "paused" ||
    senderPhase === "draining";
  const disarmRestart = restartTap.disarm;
  useEffect(() => {
    if (machineMoving) disarmRestart();
  }, [machineMoving, disarmRestart]);
  const [pendingConfigChanges, setPendingConfigChanges] = useState<
    Record<string, PendingConfigChange>
  >({});
  const [savingConfigFile, setSavingConfigFile] = useState(false);

  async function openConfigStudio() {
    if (window.innerWidth < 768) return;
    const closed = await requestClose();
    if (!closed) return;
    setTimeout(
      () =>
        window.dispatchEvent(
          new CustomEvent("config:show-studio"),
        ),
      0,
    );
  }

  async function load(force = false) {
    if (!force && cachedSettings) {
      setSettings(cachedSettings);
      setError("");
      return;
    }

    setLoading(true);
    setError("");
    try {
      setSettings(await loadControllerConfigSettings(force));
    } catch (e) {
      setError(e instanceof Error ? e.message : __uiText("components.SettingsPanel.late_coverage.12", "Failed to load settings"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (settings.length === 0) load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (cachedSettings) {
      setSettings(cachedSettings);
      setError("");
    }
  }, [cachedSettings]);

  useEffect(() => {
    if (category === "machine" || category === "config") {
      const keys = buildSubKeys(settings, category);
      if (keys.length && !subKey) setSubKey(keys[0]);
    } else {
      setSubKey("");
    }
  }, [category, settings]);

  async function saveSetting(p: string, t: string, v: string) {
    // Always update runtime configuration first
    // FluidNC's V= parser stops at an unescaped space and treats backslash as an escape
    const escaped = v.replace(/\\/g, "\\\\").replace(/ /g, "\\ ");
    const reply = await sendCommand(`[ESP401]P=${p} T=${t} V=${escaped}`);
    // FluidNC answers HTTP 200 and puts a refusal in the text ("error:N").
    const rejected = reply.match(/^\s*error\s*:.*$/im);
    if (rejected) throw new Error(formatUi(__uiText("components.SettingsPanel.template_coverage.6", "controller refused it ({v0})"), { v0: rejected[0].trim() }));

    const setting = settings.find((s) => s.P === p);
    const updatedSettings = updateControllerConfigSetting(
      useMachineStore.getState().controllerConfigSettings ?? settings,
      p,
      v,
    );
    setSettings(updatedSettings);
    useMachineStore.getState().setControllerConfigSettings(updatedSettings);

    if (setting?.F === "tree") {
      setPendingConfigChanges((current) => ({
        ...current,
        [p]: { value: v },
      }));
    }
  }

  const requestClose = useCallback(async (): Promise<boolean> => {
    if (savingConfigFile) return false;

    const pendingCount = Object.keys(pendingConfigChanges).length;
    if (pendingCount === 0) {
      onClose?.();
      return true;
    }

    const configFile = activeConfigFile(settings);
    const shouldSave = confirm(
      formatUi(__uiPlural("components.SettingsPanel.save_config_prompt", pendingCount, { one: "Machine config changed. Save this change to {filename}?\n\n", other: "Machine config changed. Save these changes to {filename}?\n\n" }), { filename: configFile.name }) +
        formatUi(__uiText("components.SettingsPanel.alert_coverage.5", "OK saves the config file. Cancel closes without updating {v0}."), { v0: configFile.name }),
    );

    if (shouldSave) {
      setSavingConfigFile(true);
      try {
        const missing = await updateConfigYamlBatch(
          pendingConfigChanges,
          configFile,
        );
        setPendingConfigChanges({});
        if (missing.length) {
          alert(
            formatUi(__uiText("components.SettingsPanel.alert_coverage.6", "Not in {v0}, so not saved (back to default after a restart):\n\n{v1}\n\nAdd to the file in Config Studio to keep."), { v0: configFile.name, v1: missing.join("\n") }),
          );
        }
      } catch (error) {
        alert(
          formatUi(__uiText("components.SettingsPanel.alert_coverage.7", "Runtime settings were sent, but {v0} could not be updated.\n\n{v1}"), { v0: configFile.name, v1: error instanceof Error ? error.message : String(error) }),
        );
        return false;
      } finally {
        setSavingConfigFile(false);
      }
    } else {
      setPendingConfigChanges({});
    }

    onClose?.();
    return true;
  }, [onClose, pendingConfigChanges, savingConfigFile, settings]);

  useEffect(() => {
    onRequestCloseReady?.(() => {
      requestClose();
    });
    return () => onRequestCloseReady?.(null);
  }, [onRequestCloseReady, requestClose]);

  async function restart() {
    if (machineMoving) return;
    const closed = await requestClose();
    if (!closed) return;
    setRestarting(true);
    useMachineStore.getState().setRestarting(true);
    // Expected: the controller tears down TCP mid-response, so fetch rejects.
    try {
      await sendCommand("[ESP444]RESTART");
    } catch {
      /* ignore — restart kills the connection */
    } finally {
      setRestarting(false);
    }
  }

  const categories = useMemo(() => buildCategories(settings), [settings]);

  const subKeys = useMemo(
    () =>
      category === "machine" || category === "config"
        ? buildSubKeys(settings, category)
        : [],
    [settings, category],
  );

  const visibleSettings = useMemo(() => {
    if (filter.trim()) {
      const tokens = filter.toLowerCase().trim().split(/\s+/).filter(Boolean);
      return settings.filter((s) => {
        const parts = s.P.split("/").filter(Boolean);
        // Split into discrete words so "x" matches axis "x" but not "axes"
        const rawWords = [
          ...parts.flatMap((p) =>
            p
              .replace(/([a-z])(\d)/gi, "$1 $2")
              .replace(/(\d)([a-z])/gi, "$1 $2")
              .split(/[\s_]+/),
          ),
          ...displayLabel(s).toLowerCase().split(/\s+/),
          ...treeSubcat(s.P).toLowerCase().split(/\s+/),
          ...(CAT_DEFS[catOf(s)]?.label ?? "").toLowerCase().split(/\s+/),
        ];
        const words = rawWords.map((w) => w.toLowerCase()).filter(Boolean);
        return tokens.every((t) => words.some((w) => w.startsWith(t)));
      });
    }
    if (!category) return [];
    let list = settings.filter((s) => catOf(s) === category);
    if (category === "machine" && subKey) {
      if (subKey === "General") {
        list = list.filter((s) => s.P.split("/").length < 3);
      } else {
        list = list.filter((s) => s.P.split("/")[1] === subKey);
      }
    }
    if (category === "config" && subKey) {
      list = list.filter((s) => treeSubcat(s.P) === subKey);
    }
    if (category === "wifi") {
      const groupOrder: Record<string, number> = { Hostname: 0, WiFi: 1, Sta: 2, AP: 3 };
      const fieldOrder: Record<string, number> = { SSID: 0, Password: 1 };
      list = [...list].sort((a, b) => {
        const ap = a.P.split("/").filter(Boolean);
        const bp = b.P.split("/").filter(Boolean);
        const groupDiff =
          (groupOrder[ap[0]] ?? 99) - (groupOrder[bp[0]] ?? 99);
        if (groupDiff) return groupDiff;
        const fieldDiff =
          (fieldOrder[ap[ap.length - 1]] ?? 99) -
          (fieldOrder[bp[bp.length - 1]] ?? 99);
        return fieldDiff || displayLabel(a).localeCompare(displayLabel(b));
      });
    }
    return list;
  }, [settings, filter, category, subKey]);

  const groupedItems = useMemo((): ListItem[] => {
    if (filter.trim()) {
      return visibleSettings.map((s) => ({ type: "setting", setting: s }));
    }
    if (category === "config" || category === "wifi" || category === "services")
      return buildGroupedItems(visibleSettings, subKey);
    return visibleSettings.map((s) => ({ type: "setting", setting: s }));
  }, [visibleSettings, category, subKey, filter]);

  const isSearching = filter.trim().length > 0;
  const activeCat = CAT_DEFS[category];

  function selectCategory(id: string) {
    if (id === "config" && category === "config" && !filter.trim()) {
      setConfigSublistExpanded((expanded) => !expanded);
      return;
    }

    setCategory(id);
    setSubKey("");
    setFilter("");
    setConfigSublistExpanded(id === "config");
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-5 py-3.5 border-b border-border shrink-0">
        <Settings size={18} className="text-accent shrink-0" />
        <h2 className="text-base font-semibold text-text-primary flex-1">
          {__uiText("components.SettingsPanel.settings.1", "Settings")}
        </h2>
        <div className="flex items-center gap-2">
          <button
            className="p-1.5 rounded hover:bg-elevated text-text-muted hover:text-text-primary
                       transition-colors disabled:opacity-40"
            onClick={() => load(true)}
            disabled={loading || cachedSettingsLoading || category === "limits"}
            title={
              category === "limits"
                ? __uiText("components.SettingsPanel.unavailable_while_monitoring_limits.1", "Unavailable while monitoring limits")
                : __uiText("components.SettingsPanel.reload_settings.1", "Reload settings")
            }
          >
            <RefreshCw
              size={14}
              className={loading || cachedSettingsLoading ? "animate-spin" : ""}
            />
          </button>
          <button
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded text-sm font-medium
                       hover:text-danger hover:bg-danger/10 border
                       hover:border-danger/30 transition-colors disabled:opacity-40 ${
                         restartTap.armed && !machineMoving
                           ? "text-danger bg-danger/10 border-danger/30"
                           : "text-text-muted border-transparent"
                       }`}
            onClick={() => restartTap.tap(restart)}
            disabled={restarting || machineMoving}
            title={
              machineMoving
                ? __uiText("components.SettingsPanel.unavailable_while_the_machine_is_mo.1", "Unavailable while the machine is moving")
                : __uiText("components.SettingsPanel.restart_device.1", "Restart device")
            }
          >
            <RotateCcw size={12} />
            {restarting
              ? __uiText("components.SettingsPanel.restarting.1", "Restarting…")
              : restartTap.armed && !machineMoving
                ? jobActive
                  ? __uiText("components.SettingsPanel.tap_again_aborts_job.1", "Tap again: aborts job")
                  : __uiText("components.SettingsPanel.tap_again_to_restart.1", "Tap again to restart")
                : __uiText("components.SettingsPanel.restart.1", "Restart")}
          </button>
          {onClose && (
            <button
              className="p-1.5 rounded-md text-text-muted hover:text-text-primary
                         hover:bg-elevated transition-colors ml-1"
              onClick={() => requestClose()}
              disabled={savingConfigFile}
              title={__uiText("components.SettingsPanel.close_esc.1", "Close (Esc)")}
            >
              <X size={18} />
            </button>
          )}
        </div>
      </div>

      {espInfo && (
        <div
          className="flex items-center gap-4 px-5 py-2 border-b border-border
                        bg-elevated/40 text-sm"
        >
          <span>
            <span className="text-text-dim">Firmware </span>
            <span className="text-text-primary font-mono">
              {espInfo.version || "—"}
            </span>
          </span>
          <span>
            <span className="text-text-dim">{__uiText("components.SettingsPanel.coverage.3", "Host")} </span>
            <span className="text-text-primary font-mono">
              {espInfo.hostname || "—"}
            </span>
          </span>
          <span>
            <span className="text-text-dim">{__uiText("components.SettingsPanel.axes.1", "Axes")} </span>
            <span className="text-text-primary font-mono">{espInfo.axes}</span>
          </span>
        </div>
      )}

      <div className="sm:hidden px-4 py-2 border-b border-border shrink-0">
        <div className="relative">
          <Search
            size={12}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-text-dim pointer-events-none"
          />
          <input
            className="input-field pr-3 py-1.5 text-sm"
            style={{ paddingLeft: 32 }}
            placeholder={__uiText("components.SettingsPanel.search_settings.1", "Search settings…")}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      </div>

      <div className="flex flex-col sm:flex-row flex-1 min-h-0 overflow-hidden">
        <div
          className="sm:w-48 shrink-0 sm:border-r border-b sm:border-b-0 border-border
                        bg-[var(--bg)] flex flex-row sm:flex-col
                        overflow-x-auto sm:overflow-x-hidden sm:overflow-y-auto"
        >
          <div className="hidden sm:block p-3 shrink-0">
            <div className="relative">
              <Search
                size={12}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-text-dim pointer-events-none"
              />
              <input
                className="input-field pr-3 py-1.5 text-sm"
                style={{ paddingLeft: 32 }}
                placeholder={__uiText("components.SettingsPanel.search.1", "Search…")}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
          </div>

          <nav
            className="flex flex-row sm:flex-col flex-1 sm:flex-none
                          px-2 py-1.5 sm:pb-3 sm:py-0 sm:space-y-0.5
                          gap-1 sm:gap-0"
            style={{ scrollbarWidth: "none" }}
          >
            {categories.map((cat) => {
              const Icon = cat.icon;
              const active = !isSearching && category === cat.id;
              const showConfigSublist =
                cat.id === "config" &&
                active &&
                configSublistExpanded &&
                subKeys.length > 1;

              return (
                <div key={cat.id} className="shrink-0 sm:w-full">
                  <button
                    onClick={() => selectCategory(cat.id)}
                    aria-expanded={
                      cat.id === "config" ? showConfigSublist : undefined
                    }
                    className={`flex items-center gap-1.5 sm:gap-2.5 sm:w-full
                                px-2.5 sm:px-3 py-1.5 sm:py-2 rounded
                                text-sm sm:text-base whitespace-nowrap sm:whitespace-normal sm:break-words sm:[overflow-wrap:anywhere]
                                transition-all text-left ${
                                  active
                                    ? "bg-accent/[0.12] text-accent font-medium"
                                    : "text-text-muted hover:text-text-primary hover:bg-elevated"
                                }`}
                  >
                    <Icon size={14} className="shrink-0" />
                    <span className="min-w-0">{cat.label}</span>
                  </button>

                  {showConfigSublist && (
                    <div
                      className="hidden sm:flex sm:flex-col gap-1 mt-1 sm:ml-3 sm:pl-2 sm:border-l sm:border-border"
                      role="group"
                      aria-label={__uiText("components.SettingsPanel.machine_config_sections.1", "Machine Config sections")}
                    >
                      {subKeys.map((k) => (
                        <button
                          key={k}
                          onClick={() => setSubKey(k)}
                          aria-current={subKey === k ? "page" : undefined}
                          className={`px-2.5 py-1 text-sm text-left break-words [overflow-wrap:anywhere] rounded transition-colors ${
                            subKey === k
                              ? "bg-accent/[0.12] text-accent font-medium"
                              : "text-text-muted hover:text-text-primary hover:bg-elevated"
                          }`}
                        >
                          {settingSectionName(k)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </nav>
        </div>

        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {!isSearching && activeCat && (
            <div className="shrink-0">
              <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-border">
                <h3 className="min-w-0 text-base font-semibold text-text-primary flex items-center gap-2">
                  <activeCat.icon size={14} className="text-accent shrink-0" />
                  <span className="truncate">
                    {activeCat.label}
                    {category === "config" && subKey && ` › ${settingSectionName(subKey)}`}
                  </span>
                </h3>
                {category === "config" && (
                  <button
                    className="btn btn-primary shrink-0 px-3 py-1.5 text-sm"
                    onClick={openConfigStudio}
                    disabled={isMobile}
                    title={isMobile ? __uiText("components.SettingsPanel.config_studio_is_available_on_table.1", "Config Studio is available on tablets and desktops") : undefined}
                  >
                    <FileCode2 size={14} />
                    <span className="sm:hidden">Config Studio</span>
                    <span className="hidden sm:inline">{__uiText("components.SettingsPanel.open_config_studio.1", "Open Config Studio")}</span>
                  </button>
                )}
              </div>

              {category === "config" && subKeys.length > 1 && (
                <div className="sm:hidden flex items-center gap-3 px-4 py-2 border-b border-border">
                  <label
                    htmlFor="machine-config-section"
                    className="shrink-0 text-sm font-medium text-text-muted"
                  >
                    {__uiText("components.SettingsPanel.section.1", "Section")}
                  </label>
                  <select
                    id="machine-config-section"
                    value={subKey}
                    onChange={(e) => setSubKey(e.target.value)}
                    className="input-field flex-1 py-1.5 text-sm"
                  >
                    {subKeys.map((k) => (
                      <option key={k} value={k}>
                        {settingSectionName(k)}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {category === "machine" && subKeys.length > 1 && (
                  <div
                    className="flex border-b border-border overflow-x-auto px-2"
                    style={{ scrollbarWidth: "none" }}
                  >
                    {subKeys.map((k) => (
                      <button
                        key={k}
                        onClick={() => setSubKey(k)}
                        className={`py-2 px-3 text-sm font-semibold uppercase tracking-wider whitespace-nowrap
                                  transition-colors border-b-2 -mb-px ${
                                    subKey === k
                                      ? "border-accent text-accent"
                                      : "border-transparent text-text-muted hover:text-text-primary"
                                  }`}
                      >
                        {settingSectionName(k)}
                      </button>
                    ))}
                  </div>
                )}

              {category === "config" && (
                <div
                  className="px-4 py-2 border-b border-border"
                >
                  <div
                    className="flex items-start gap-2 rounded border border-border bg-elevated/30
                               px-3 py-2 text-sm leading-relaxed text-text-muted"
                  >
                    <Info size={13} className="text-accent shrink-0 mt-1" />
                    <span>
                      {__uiText("components.SettingsPanel.these_settings_come_from.1", "These settings come from")}{" "}
                      <span className="font-mono font-medium text-text-primary">
                        config.yaml
                      </span>
                      {__uiText("components.SettingsPanel.most_changes_made_here_take_effect_.1", ". Most changes made here take effect immediately.")}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}

          {isSearching && visibleSettings.length > 0 && (
            <div className="px-5 py-2.5 text-sm text-text-dim border-b border-border shrink-0">
              {__uiPlural("components.SettingsPanel.result.1", visibleSettings.length, { one: "{count} result", other: "{count} results" })}
            </div>
          )}

          <div className="flex-1 overflow-y-auto min-h-0">
            {!isSearching && category === "firmware" && <FirmwareTab />}
            {!isSearching && category === "espnow" && <ESPNowPendantsTab />}
            {!isSearching && category === "limits" && (
              <LimitsTab settings={settings} />
            )}

            {!isSearching && category === "workspace" && (
              <div className="divide-y divide-border">
                {[
                  {
                    label: __uiText("components.SettingsPanel.units.1", "Units"),
                    control: (["mm", "in"] as const).map((unit) => (
                      <button
                        key={unit}
                        onClick={() => setUnits(unit)}
                        className={`px-3 py-1.5 text-sm rounded-sm transition-colors ${
                          units === unit
                            ? "bg-surface border border-border text-text-primary shadow-sm"
                            : "text-text-muted hover:text-text-primary"
                        }`}
                      >
                        {unit}
                      </button>
                    )),
                  },
                  {
                    label: __uiText("components.SettingsPanel.layout.1", "Layout"),
                    control: (["auto", "tablet", "desktop"] as const).map(
                      (mode) => (
                        <button
                          key={mode}
                          onClick={() => setLayoutMode(mode)}
                          className={`px-3 py-1.5 text-sm rounded-sm transition-colors capitalize ${
                            layoutMode === mode
                              ? "bg-surface border border-border text-text-primary shadow-sm"
                              : "text-text-muted hover:text-text-primary"
                          }`}
                        >
                          {mode}
                        </button>
                      ),
                    ),
                  },
                  {
                    label: __uiText("components.SettingsPanel.theme.1", "Theme"),
                    control: [
                      { id: "light" as Theme, label: __uiText("components.SettingsPanel.light.1", "Light") },
                      { id: "dark" as Theme, label: __uiText("components.SettingsPanel.dark.1", "Dark") },
                      { id: "anthracite-dark" as Theme, label: __uiText("components.SettingsPanel.label_extra.2", "Anthracite") },
                      { id: "midnight-dark" as Theme, label: __uiText("components.SettingsPanel.midnight.1", "Midnight") },
                    ].map(({ id, label }) => (
                      <button
                        key={id}
                        onClick={() => setTheme(id)}
                        className={`px-3 py-1.5 text-sm rounded-sm transition-colors ${
                          theme === id
                            ? "bg-surface border border-border text-text-primary shadow-sm"
                            : "text-text-muted hover:text-text-primary"
                        }`}
                      >
                        {label}
                      </button>
                    )),
                  },
                ].map(({ label, control }) => (
                  <div
                    key={label}
                    className="flex items-center justify-between px-5 py-3.5"
                  >
                    <span className="text-base text-text-primary">{label}</span>
                    <div className="flex items-center gap-0.5 bg-elevated rounded-sm border border-border p-0.5">
                      {control}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {(isSearching ||
              (category !== "workspace" &&
                category !== "firmware" &&
                category !== "espnow" &&
                category !== "limits")) &&
              error && (
                <div className="m-4 p-3 rounded bg-danger/10 border border-danger/30 text-danger text-sm leading-relaxed whitespace-pre-wrap font-mono">
                  {error}
                </div>
              )}

            {(isSearching ||
              (category !== "workspace" &&
                category !== "firmware" &&
                category !== "espnow" &&
                category !== "limits")) &&
              loading &&
              !error && (
                <div className="flex items-center justify-center h-32 gap-2 text-text-muted text-sm">
                  <RefreshCw size={14} className="animate-spin" />
                  {__uiText("components.SettingsPanel.loading_settings.1", "Loading settings…")}
                </div>
              )}

            {(isSearching ||
              (category !== "workspace" &&
                category !== "firmware" &&
                category !== "espnow" &&
                category !== "limits")) &&
              !loading &&
              !error &&
              visibleSettings.length === 0 && (
                <div className="flex flex-col items-center justify-center h-32 gap-2 text-text-dim text-sm">
                  {isSearching ? (
                    <>
                      {__uiText("components.SettingsPanel.no_settings_match.1", "No settings match")}{" "}
                      <span className="font-mono">"{filter}"</span>
                    </>
                  ) : (
                    __uiText("components.SettingsPanel.select_a_category.1", "Select a category")
                  )}
                </div>
              )}

            {(isSearching ||
              (category !== "workspace" &&
                category !== "firmware" &&
                category !== "espnow" &&
                category !== "limits")) &&
              groupedItems.map((item, i) =>
                item.type === "header" ? (
                  <SectionHeader
                    key={`h-${i}`}
                    label={item.label}
                    level={item.level}
                  />
                ) : (
                  <SettingRow
                    key={item.setting.P}
                    setting={item.setting}
                    showPath={isSearching}
                    onSave={saveSetting}
                  />
                ),
              )}
          </div>
        </div>
      </div>
    </div>
  );
}

function buildCategories(settings: Setting[]) {
  const seen = new Set<string>();
  for (const s of settings) seen.add(catOf(s));
  const deviceCats = [...seen]
    .map((id) => ({
      id,
      ...(CAT_DEFS[id] ?? { label: id, icon: Hash, order: 99 }),
    }))
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  return [
    { id: "workspace", ...CAT_DEFS.workspace },
    ...deviceCats,
    { id: "limits", ...CAT_DEFS.limits },
    { id: "espnow", ...CAT_DEFS.espnow },
    { id: "firmware", ...CAT_DEFS.firmware },
  ];
}

function buildSubKeys(settings: Setting[], category: string): string[] {
  if (category === "machine") {
    const seen = new Set<string>();
    for (const s of settings) {
      if (catOf(s) !== "machine") continue;
      const parts = s.P.split("/");
      seen.add(parts.length >= 3 ? parts[1] : "General");
    }
    const keys = [...seen].sort();
    const gi = keys.indexOf("General");
    if (gi > 0) {
      keys.splice(gi, 1);
      keys.unshift("General");
    }
    return keys;
  }

  if (category === "config") {
    const seen = new Set<string>();
    for (const s of settings) {
      if (catOf(s) !== "config") continue;
      seen.add(treeSubcat(s.P));
    }
    return [...seen].sort((a, b) => {
      const ai = SUBCAT_ORDER.indexOf(a),
        bi = SUBCAT_ORDER.indexOf(b);
      if (ai === -1 && bi === -1) return a.localeCompare(b);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  }

  return [];
}
