import { useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  CircuitBoard,
  Cpu,
  Crosshair,
  Gauge,
  Grid3X3,
  Minus,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Undo2,
  Redo2,
  Zap,
} from "lucide-react";
import {
  loadFluidConfig,
  MOTOR_DRIVER_PREFIX,
  type ConfigItem,
  type FluidConfig,
} from "../lib/fluidSchema";

type NodeKind =
  | "machine"
  | "stepping"
  | "axes"
  | "axis"
  | "motor"
  | "driver"
  | "kinematics"
  | "spindle"
  | "bus"
  | "storage"
  | "control"
  | "probe"
  | "coolant"
  | "macro"
  | "io"
  | "start"
  | "parking"
  | "display"
  | "atc";
type NodeData = {
  id: string;
  kind: NodeKind;
  title: string;
  subtitle: string;
  x: number;
  y: number;
  color: string;
  fields: Record<string, string>;
  parentId?: string;
  /** Stable source key, independent of graph ordering. */
  yamlKey?: string;
  /** Stable nested factory/type key (for example kinematics.CoreXY). */
  yamlTypeKey?: string;
};
type FieldDef = {
  key: string;
  label: string;
  type?: "number" | "boolean" | "select" | "pin" | "text";
  options?: string[];
  unit?: string;
  min?: number;
  max?: number;
  description?: string;
};

const PALETTE: {
  group: string;
  items: { kind: NodeKind; title: string; sub: string }[];
}[] = [
  {
    group: "Motion",
    items: [
      { kind: "axis", title: "Axis", sub: "X, Y, Z, A, B or C" },
      { kind: "motor", title: "Motor", sub: "StepStick, TMC, servo" },
      {
        kind: "kinematics",
        title: "Kinematics",
        sub: "Cartesian, CoreXY, Delta",
      },
    ],
  },
  {
    group: "Tooling",
    items: [
      {
        kind: "spindle",
        title: "Spindle / Laser",
        sub: "PWM, VFD, relay, plasma",
      },
      { kind: "probe", title: "Probe", sub: "Touch probe input" },
      { kind: "atc", title: "Tool changer", sub: "Manual ATC workflow" },
      { kind: "coolant", title: "Coolant", sub: "Flood and mist outputs" },
    ],
  },
  {
    group: "Hardware",
    items: [
      { kind: "bus", title: "Hardware bus", sub: "UART, SPI, I²C, I²S" },
      { kind: "storage", title: "SD card", sub: "SPI storage interface" },
      { kind: "io", title: "User I/O", sub: "Digital and analog I/O" },
      { kind: "display", title: "OLED display", sub: "I²C status display" },
    ],
  },
  {
    group: "Machine",
    items: [
      {
        kind: "control",
        title: "Control inputs",
        sub: "Reset, hold, start, E-stop",
      },
      {
        kind: "start",
        title: "Startup",
        sub: "Boot and reset behavior",
      },
      { kind: "parking", title: "Parking", sub: "Safety-door motion" },
      { kind: "macro", title: "Macros", sub: "Startup and event commands" },
    ],
  },
];

const FIELDS: Record<NodeKind, FieldDef[]> = {
  machine: [
    { key: "name", label: "Machine name" },
    { key: "board", label: "Board" },
    { key: "meta", label: "Description" },
  ],
  stepping: [
    {
      key: "engine",
      label: "Engine",
      type: "select",
      options: ["RMT", "TIMED", "I2S_STATIC", "I2S_STREAM"],
    },
    { key: "idle_ms", label: "Idle delay", type: "number", unit: "ms" },
    { key: "pulse_us", label: "Pulse width", type: "number", unit: "µs" },
    {
      key: "dir_delay_us",
      label: "Direction delay",
      type: "number",
      unit: "µs",
    },
    {
      key: "disable_delay_us",
      label: "Disable delay",
      type: "number",
      unit: "µs",
    },
  ],
  axes: [
    {
      key: "shared_stepper_disable_pin",
      label: "Shared stepper disable",
      type: "pin",
    },
  ],
  axis: [
    {
      key: "axis",
      label: "Axis",
      type: "select",
      options: ["x", "y", "z", "a", "b", "c"],
    },
    { key: "steps_per_mm", label: "Steps per mm", type: "number" },
    {
      key: "max_rate_mm_per_min",
      label: "Maximum rate",
      type: "number",
      unit: "mm/min",
    },
    {
      key: "acceleration_mm_per_sec2",
      label: "Acceleration",
      type: "number",
      unit: "mm/s²",
    },
    {
      key: "max_travel_mm",
      label: "Maximum travel",
      type: "number",
      unit: "mm",
    },
    { key: "soft_limits", label: "Soft limits", type: "boolean" },
    { key: "homing_cycle", label: "Homing cycle", type: "number" },
    { key: "homing_positive", label: "Positive homing", type: "boolean" },
    {
      key: "homing_mpos_mm",
      label: "Home position",
      type: "number",
      unit: "mm",
    },
  ],
  motor: [
    { key: "limit_neg_pin", label: "Negative limit", type: "pin" },
    { key: "limit_pos_pin", label: "Positive limit", type: "pin" },
    { key: "limit_all_pin", label: "Combined limit", type: "pin" },
    { key: "hard_limits", label: "Hard limits", type: "boolean" },
    { key: "pulloff_mm", label: "Pull-off", type: "number", unit: "mm" },
  ],
  driver: [
    {
      key: "type",
      label: "Driver type",
      type: "select",
      options: [
        "stepstick",
        "standard_stepper",
        "tmc_2130",
        "tmc_2208",
        "tmc_2209",
        "tmc_5160",
        "tmc_5160Pro",
        "tmc_2160Pro",
        "tmc_2160",
        "rc_servo",
        "solenoid",
        "dynamixel2",
        "null_motor",
      ],
    },
    { key: "cs_pin", label: "Chip select pin", type: "pin" },
    { key: "step_pin", label: "Step pin", type: "pin" },
    { key: "direction_pin", label: "Direction pin", type: "pin" },
    { key: "disable_pin", label: "Disable pin", type: "pin" },
    { key: "ms1_pin", label: "Microstep 1 pin", type: "pin" },
    { key: "ms2_pin", label: "Microstep 2 pin", type: "pin" },
    { key: "ms3_pin", label: "Microstep 3 pin", type: "pin" },
    { key: "reset_pin", label: "Reset pin", type: "pin" },
    { key: "spi_index", label: "SPI index", type: "number" },
    { key: "uart_num", label: "UART bus", type: "number" },
    { key: "addr", label: "Driver address", type: "number" },
    {
      key: "r_sense_ohms",
      label: "Sense resistance",
      type: "number",
      unit: "Ω",
    },
    { key: "run_amps", label: "Run current", type: "number", unit: "A" },
    { key: "hold_amps", label: "Hold current", type: "number", unit: "A" },
    {
      key: "homing_amps",
      label: "Homing current",
      type: "number",
      unit: "A",
    },
    { key: "microsteps", label: "Microsteps", type: "number" },
    { key: "stallguard", label: "StallGuard", type: "number" },
    { key: "stallguard_debug", label: "StallGuard debug", type: "boolean" },
    { key: "toff_disable", label: "Disable TOFF", type: "number" },
    { key: "toff_stealthchop", label: "StealthChop TOFF", type: "number" },
    { key: "toff_coolstep", label: "CoolStep TOFF", type: "number" },
    {
      key: "run_mode",
      label: "Run mode",
      type: "select",
      options: ["StealthChop", "CoolStep", "StallGuard"],
    },
    {
      key: "homing_mode",
      label: "Homing mode",
      type: "select",
      options: ["StealthChop", "CoolStep", "StallGuard"],
    },
    { key: "use_enable", label: "Use enable", type: "boolean" },
    { key: "diag0_error", label: "DIAG0 error", type: "boolean" },
    { key: "diag0_otpw", label: "DIAG0 overtemperature", type: "boolean" },
    {
      key: "diag0_int_pushpull",
      label: "DIAG0 push-pull",
      type: "boolean",
    },
    { key: "tpfd", label: "Passive fast decay time", type: "number" },
    { key: "CHOPCONF", label: "CHOPCONF register", type: "number" },
    { key: "COOLCONF", label: "COOLCONF register", type: "number" },
    { key: "THIGH", label: "THIGH register", type: "number" },
    { key: "TCOOLTHRS", label: "TCOOLTHRS register", type: "number" },
    { key: "GCONF", label: "GCONF register", type: "number" },
    { key: "PWMCONF", label: "PWMCONF register", type: "number" },
    { key: "IHOLD_IRUN", label: "IHOLD_IRUN register", type: "number" },
    { key: "output_pin", label: "Output pin", type: "pin" },
    { key: "pwm_hz", label: "PWM frequency", type: "number", unit: "Hz" },
    {
      key: "min_pulse_us",
      label: "Minimum pulse",
      type: "number",
      unit: "µs",
    },
    {
      key: "max_pulse_us",
      label: "Maximum pulse",
      type: "number",
      unit: "µs",
    },
    { key: "timer_ms", label: "Timer period", type: "number", unit: "ms" },
    { key: "off_percent", label: "Off power", type: "number", unit: "%" },
    { key: "pull_percent", label: "Pull power", type: "number", unit: "%" },
    { key: "hold_percent", label: "Hold power", type: "number", unit: "%" },
    { key: "pull_ms", label: "Pull duration", type: "number", unit: "ms" },
    {
      key: "direction_invert",
      label: "Invert direction",
      type: "boolean",
    },
    { key: "id", label: "Servo ID", type: "number" },
    { key: "count_min", label: "Minimum count", type: "number" },
    { key: "count_max", label: "Maximum count", type: "number" },
  ],
  kinematics: [
    {
      key: "type",
      label: "Type",
      type: "select",
      options: [
        "Cartesian",
        "CoreXY",
        "midtbot",
        "parallel_delta",
        "WallPlotter",
      ],
    },
    {
      key: "kinematic_segment_len_mm",
      label: "Segment length",
      type: "number",
      unit: "mm",
    },
  ],
  spindle: [
    {
      key: "type",
      label: "Spindle type",
      type: "select",
      options: [
        "PWM",
        "10V",
        "DAC",
        "HBridge",
        "Laser",
        "Relay",
        "OnOff",
        "BESC",
        "PlasmaSpindle",
        "NoSpindle",
        "ModbusVFD",
        "Huanyang",
        "H2A",
        "YL620",
        "DeltaMS300",
        "FolinnBD600",
        "H100",
        "MollomG70",
        "NowForever",
        "SiemensV20",
        "DanfossVLT2800",
      ],
    },
    { key: "tool_num", label: "Tool number", type: "number" },
    { key: "output_pin", label: "Output pin", type: "pin" },
    { key: "enable_pin", label: "Enable pin", type: "pin" },
    { key: "direction_pin", label: "Direction pin", type: "pin" },
    { key: "pwm_hz", label: "PWM frequency", type: "number", unit: "Hz" },
    { key: "speed_map", label: "Speed map" },
    { key: "spinup_ms", label: "Spin-up delay", type: "number", unit: "ms" },
    {
      key: "spindown_ms",
      label: "Spin-down delay",
      type: "number",
      unit: "ms",
    },
    { key: "uart_num", label: "UART bus", type: "number" },
    { key: "modbus_id", label: "Modbus ID", type: "number" },
  ],
  bus: [
    {
      key: "type",
      label: "Bus type",
      type: "select",
      options: [
        "uart1",
        "uart2",
        "uart_channel1",
        "uart_channel2",
        "i2c0",
        "i2c1",
        "spi",
        "i2so",
      ],
    },
    { key: "txd_pin", label: "TX pin", type: "pin" },
    { key: "rxd_pin", label: "RX pin", type: "pin" },
    { key: "rts_pin", label: "RTS pin", type: "pin" },
    { key: "cts_pin", label: "CTS pin", type: "pin" },
    { key: "sda_pin", label: "SDA pin", type: "pin" },
    { key: "scl_pin", label: "SCL pin", type: "pin" },
    { key: "sck_pin", label: "Clock pin", type: "pin" },
    { key: "mosi_pin", label: "MOSI pin", type: "pin" },
    { key: "miso_pin", label: "MISO pin", type: "pin" },
    { key: "baud", label: "Baud rate", type: "number" },
    { key: "mode", label: "UART mode" },
    { key: "passthrough_baud", label: "Passthrough baud", type: "number" },
    { key: "passthrough_mode", label: "Passthrough mode" },
    { key: "uart_num", label: "UART bus", type: "number" },
    {
      key: "report_interval_ms",
      label: "Report interval",
      type: "number",
      unit: "ms",
    },
    {
      key: "message_level",
      label: "Message level",
      type: "select",
      options: ["None", "Error", "Warn", "Info", "Debug", "Verbose"],
    },
    { key: "frequency", label: "Frequency", type: "number", unit: "Hz" },
  ],
  storage: [
    { key: "cs_pin", label: "Chip select", type: "pin" },
    { key: "card_detect_pin", label: "Card detect", type: "pin" },
    { key: "frequency_hz", label: "Frequency", type: "number", unit: "Hz" },
  ],
  control: [
    { key: "reset_pin", label: "Reset", type: "pin" },
    { key: "feed_hold_pin", label: "Feed hold", type: "pin" },
    { key: "cycle_start_pin", label: "Cycle start", type: "pin" },
    { key: "safety_door_pin", label: "Safety door", type: "pin" },
    { key: "estop_pin", label: "Emergency stop", type: "pin" },
    { key: "fault_pin", label: "Fault", type: "pin" },
  ],
  probe: [
    { key: "pin", label: "Probe pin", type: "pin" },
    { key: "toolsetter_pin", label: "Tool setter pin", type: "pin" },
    { key: "check_mode_start", label: "Allow check mode", type: "boolean" },
    { key: "hard_stop", label: "Stop immediately", type: "boolean" },
    {
      key: "probe_hard_limit",
      label: "Probe hard limit",
      type: "boolean",
    },
  ],
  coolant: [
    { key: "flood_pin", label: "Flood pin", type: "pin" },
    { key: "mist_pin", label: "Mist pin", type: "pin" },
    { key: "delay_ms", label: "Delay", type: "number", unit: "ms" },
  ],
  macro: [
    { key: "startup_line0", label: "Startup line 0" },
    { key: "startup_line1", label: "Startup line 1" },
    { key: "after_homing", label: "After homing" },
    { key: "after_reset", label: "After reset" },
    { key: "after_unlock", label: "After unlock" },
    { key: "macro0", label: "Macro 0" },
    { key: "macro1", label: "Macro 1" },
    { key: "macro2", label: "Macro 2" },
    { key: "macro3", label: "Macro 3" },
  ],
  io: [
    ...Array.from({ length: 8 }, (_, i) => ({
      key: `digital${i}_pin`,
      label: `Digital ${i}`,
      type: "pin" as const,
    })),
    ...Array.from({ length: 4 }, (_, i) => ({
      key: `analog${i}_pin`,
      label: `Analog ${i}`,
      type: "pin" as const,
    })),
  ],
  start: [
    { key: "must_home", label: "Must home", type: "boolean" },
    {
      key: "deactivate_parking",
      label: "Deactivate parking at startup",
      type: "boolean",
    },
    {
      key: "check_limits",
      label: "Check limits at startup",
      type: "boolean",
    },
  ],
  parking: [
    { key: "enable", label: "Parking enabled", type: "boolean" },
    {
      key: "axis",
      label: "Parking axis",
      type: "select",
      options: ["x", "y", "z", "a", "b", "c"],
    },
    {
      key: "target_mpos_mm",
      label: "Parking position",
      type: "number",
      unit: "mm",
    },
    {
      key: "rate_mm_per_min",
      label: "Parking rate",
      type: "number",
      unit: "mm/min",
    },
    {
      key: "pullout_distance_mm",
      label: "Pull-out distance",
      type: "number",
      unit: "mm",
    },
    {
      key: "pullout_rate_mm_per_min",
      label: "Pull-out rate",
      type: "number",
      unit: "mm/min",
    },
  ],
  display: [
    {
      key: "report_interval_ms",
      label: "Report interval",
      type: "number",
      unit: "ms",
    },
    { key: "i2c_num", label: "I²C bus", type: "number" },
    { key: "i2c_address", label: "Address (decimal)", type: "number" },
    { key: "width", label: "Width", type: "number", unit: "px" },
    { key: "height", label: "Height", type: "number", unit: "px" },
    { key: "flip", label: "Flip", type: "boolean" },
    { key: "mirror", label: "Mirror", type: "boolean" },
    {
      key: "radio_delay_ms",
      label: "Radio delay",
      type: "number",
      unit: "ms",
    },
  ],
  atc: [
    { key: "safe_z_mpos_mm", label: "Safe Z", type: "number", unit: "mm" },
    {
      key: "probe_seek_rate_mm_per_min",
      label: "Probe seek rate",
      type: "number",
      unit: "mm/min",
    },
    {
      key: "probe_feed_rate_mm_per_min",
      label: "Probe feed rate",
      type: "number",
      unit: "mm/min",
    },
    { key: "change_mpos_mm", label: "Change position array" },
    { key: "ets_mpos_mm", label: "Tool setter position array" },
    {
      key: "ets_rapid_z_mpos_mm",
      label: "Tool setter rapid Z",
      type: "number",
      unit: "mm",
    },
  ],
};

const DRIVER_FIELDS_BY_TYPE: Partial<Record<string, readonly string[]>> = {
  stepstick: [
    "type",
    "step_pin",
    "direction_pin",
    "disable_pin",
    "ms1_pin",
    "ms2_pin",
    "ms3_pin",
    "reset_pin",
  ],
  standard_stepper: ["type", "step_pin", "direction_pin", "disable_pin"],
  tmc_2130: [
    "type",
    "step_pin",
    "direction_pin",
    "disable_pin",
    "cs_pin",
    "spi_index",
    "r_sense_ohms",
    "run_amps",
    "hold_amps",
    "microsteps",
    "stallguard",
    "stallguard_debug",
    "toff_disable",
    "toff_stealthchop",
    "toff_coolstep",
    "run_mode",
    "homing_mode",
    "use_enable",
    "diag0_error",
    "diag0_otpw",
    "diag0_int_pushpull",
  ],
  tmc_5160: [
    "type",
    "step_pin",
    "direction_pin",
    "disable_pin",
    "cs_pin",
    "spi_index",
    "r_sense_ohms",
    "run_amps",
    "hold_amps",
    "microsteps",
    "stallguard",
    "stallguard_debug",
    "toff_disable",
    "toff_stealthchop",
    "toff_coolstep",
    "run_mode",
    "homing_mode",
    "use_enable",
    "diag0_error",
    "diag0_otpw",
    "diag0_int_pushpull",
    "tpfd",
  ],
  tmc_2208: [
    "type",
    "step_pin",
    "direction_pin",
    "disable_pin",
    "uart_num",
    "addr",
    "cs_pin",
    "r_sense_ohms",
    "run_amps",
    "hold_amps",
    "microsteps",
    "toff_disable",
    "toff_stealthchop",
    "run_mode",
    "homing_mode",
    "stallguard_debug",
    "toff_coolstep",
    "use_enable",
    "stallguard",
  ],
  tmc_2209: [
    "type",
    "step_pin",
    "direction_pin",
    "disable_pin",
    "uart_num",
    "addr",
    "cs_pin",
    "r_sense_ohms",
    "run_amps",
    "hold_amps",
    "homing_amps",
    "microsteps",
    "toff_disable",
    "toff_stealthchop",
    "run_mode",
    "homing_mode",
    "stallguard_debug",
    "toff_coolstep",
    "use_enable",
    "stallguard",
  ],
  tmc_5160pro: [
    "type",
    "step_pin",
    "direction_pin",
    "disable_pin",
    "cs_pin",
    "spi_index",
    "use_enable",
    "CHOPCONF",
    "COOLCONF",
    "THIGH",
    "TCOOLTHRS",
    "GCONF",
    "PWMCONF",
    "IHOLD_IRUN",
  ],
  tmc_2160pro: [
    "type",
    "step_pin",
    "direction_pin",
    "disable_pin",
    "cs_pin",
    "spi_index",
    "use_enable",
    "CHOPCONF",
    "COOLCONF",
    "THIGH",
    "TCOOLTHRS",
    "GCONF",
    "PWMCONF",
    "IHOLD_IRUN",
  ],
  tmc_2160: [
    "type",
    "step_pin",
    "direction_pin",
    "disable_pin",
    "cs_pin",
    "spi_index",
    "use_enable",
    "CHOPCONF",
    "COOLCONF",
    "THIGH",
    "TCOOLTHRS",
    "GCONF",
    "PWMCONF",
    "IHOLD_IRUN",
  ],
  rc_servo: [
    "type",
    "output_pin",
    "pwm_hz",
    "min_pulse_us",
    "max_pulse_us",
    "timer_ms",
  ],
  solenoid: [
    "type",
    "output_pin",
    "pwm_hz",
    "off_percent",
    "pull_percent",
    "hold_percent",
    "pull_ms",
    "direction_invert",
    "timer_ms",
  ],
  dynamixel2: ["type", "uart_num", "id", "count_min", "count_max", "timer_ms"],
  null_motor: ["type"],
};

const AXIS_OPTIONS = ["x", "y", "z", "a", "b", "c", "u", "v", "w"];

function driverFieldsFromConfig(
  config: FluidConfig | null,
  driverType: string,
): FieldDef[] | null {
  if (!config) return null;
  const driverOptions = Object.keys(config.items)
    .filter((key) => key.startsWith(MOTOR_DRIVER_PREFIX))
    .map((key) => key.slice(MOTOR_DRIVER_PREFIX.length));
  const driverKey = driverOptions.find(
    (key) => key.toLowerCase() === driverType.toLowerCase(),
  );
  if (!driverKey) return null;
  const items = config.items[MOTOR_DRIVER_PREFIX + driverKey] as Record<
    string,
    ConfigItem
  > | null;

  const typeField = FIELDS.driver.find((field) => field.key === "type")!;
  return [
    { ...typeField, options: driverOptions },
    ...Object.entries(items ?? {}).map(([key, item]) => {
      const known = FIELDS.driver.find((field) => field.key === key);
      const type: FieldDef["type"] =
        item.type === "pin"
          ? "pin"
          : item.type === "boolean"
            ? "boolean"
            : item.type === "enum" || item.type === "axis"
              ? "select"
              : item.type === "integer" || item.type === "float"
                ? "number"
                : "text";
      return {
        ...known,
        key,
        label:
          known?.label ??
          key
            .toLowerCase()
            .replace(/_/g, " ")
            .replace(/^./, (letter) => letter.toUpperCase()),
        type,
        options:
          item.type === "axis"
            ? AXIS_OPTIONS
            : (item.values?.map(String) ?? known?.options),
        unit: known?.unit ?? item.unit,
        min: item.min,
        max: item.max,
        description: item.description?.trim(),
      };
    }),
  ];
}

const COLORS: Record<NodeKind, string> = {
  machine: "#7c8ba1",
  stepping: "#d6943b",
  axes: "#438bc8",
  axis: "#4f8edc",
  motor: "#6f7fd5",
  driver: "#8b78e6",
  kinematics: "#5ba5a4",
  spindle: "#dc7659",
  bus: "#9c72c2",
  storage: "#8a78b0",
  control: "#d05265",
  probe: "#47a986",
  coolant: "#42a7ba",
  macro: "#a47851",
  io: "#4e9f83",
  start: "#b47b48",
  parking: "#b47b48",
  display: "#458fa8",
  atc: "#bf675b",
};
const HUB_PARTITIONS = [
  {
    id: "tooling",
    label: "Tooling",
    capabilities: ["Spindle / laser", "Probes", "Coolant", "Tool changer"],
    color: "#dc7659",
    direction: "left" as const,
    kinds: ["spindle", "probe", "coolant", "atc"] as NodeKind[],
    add: "spindle" as NodeKind,
  },
  {
    id: "motion",
    label: "Motion",
    capabilities: ["Stepping", "Axes", "Kinematics"],
    color: "#4f8edc",
    direction: "right" as const,
    kinds: ["stepping", "axes", "kinematics"] as NodeKind[],
    add: "kinematics" as NodeKind,
  },
  {
    id: "hardware",
    label: "Hardware",
    capabilities: ["Buses", "Storage", "User I/O", "Displays"],
    color: "#9c72c2",
    direction: "bottom" as const,
    kinds: ["bus", "storage", "io", "display"] as NodeKind[],
    add: "bus" as NodeKind,
  },
  {
    id: "safety",
    label: "Safety & automation",
    capabilities: ["Controls", "Parking", "Macros"],
    color: "#47a986",
    direction: "right" as const,
    kinds: ["control", "start", "parking", "macro"] as NodeKind[],
    add: "control" as NodeKind,
  },
];
const hubPartition = (kind: NodeKind) =>
  HUB_PARTITIONS.findIndex((p) => p.kinds.includes(kind));
const CHILDREN: Partial<Record<NodeKind, { kind: NodeKind; title: string }[]>> =
  {
    axes: [{ kind: "axis", title: "Axis" }],
    axis: [{ kind: "motor", title: "Motor" }],
    motor: [{ kind: "driver", title: "Motor driver" }],
    bus: [
      { kind: "storage", title: "SD card" },
      { kind: "display", title: "OLED display" },
    ],
    spindle: [{ kind: "atc", title: "Tool changer" }],
  };
const ROOT_OPTIONS: Record<
  string,
  { kind: NodeKind; title: string; repeatable?: boolean }[]
> = {
  tooling: [
    { kind: "spindle", title: "Spindle / Laser", repeatable: true },
    { kind: "probe", title: "Probe" },
    { kind: "coolant", title: "Coolant" },
    { kind: "atc", title: "Tool changer" },
  ],
  motion: [
    { kind: "stepping", title: "Stepping" },
    { kind: "axes", title: "Axes" },
    { kind: "kinematics", title: "Kinematics" },
  ],
  hardware: [
    { kind: "bus", title: "Hardware bus", repeatable: true },
    { kind: "storage", title: "SD card" },
    { kind: "io", title: "User inputs", repeatable: true },
    { kind: "io", title: "User outputs", repeatable: true },
    { kind: "display", title: "OLED display" },
  ],
  safety: [
    { kind: "control", title: "Control inputs" },
    { kind: "start", title: "Startup" },
    { kind: "parking", title: "Parking" },
    { kind: "macro", title: "Macros" },
  ],
};
const PARTITION_ORIGINS = {
  tooling: { x: 80, y: 290, dx: 0, dy: 125 },
  motion: { x: 900, y: 230, dx: 0, dy: 135 },
  hardware: { x: 360, y: 760, dx: 245, dy: 0 },
  safety: { x: 900, y: 650, dx: 0, dy: 125 },
} as const;
const defaults = (kind: NodeKind): Record<string, string> =>
  Object.fromEntries(
    FIELDS[kind].map((f) => [
      f.key,
      f.type === "boolean"
        ? "false"
        : f.type === "pin"
          ? "NO_PIN"
          : (f.options?.[0] ?? ""),
    ]),
  );

function defaultNodes(): NodeData[] {
  return layoutNodes([
    {
      id: "machine",
      kind: "machine",
      title: "Machine",
      subtitle: "FluidNC configuration",
      x: 40,
      y: 170,
      color: COLORS.machine,
      fields: { name: "My CNC", board: "ESP32 controller", meta: "" },
    },
    {
      id: "stepping",
      kind: "stepping",
      title: "Stepping",
      subtitle: "RMT · 4 µs pulse",
      x: 330,
      y: 40,
      color: COLORS.stepping,
      fields: {
        ...defaults("stepping"),
        engine: "RMT",
        idle_ms: "255",
        pulse_us: "4",
      },
    },
    {
      id: "axes",
      kind: "axes",
      title: "Axes",
      subtitle: "Shared axis configuration",
      x: 330,
      y: 170,
      color: COLORS.axes,
      fields: defaults("axes"),
    },
    ...["X", "Y", "Z"].flatMap((a, i) => [
      {
        id: `axis-${a}`,
        kind: "axis" as const,
        title: `${a} Axis`,
        subtitle: "Motion axis",
        x: 620,
        y: 100 + i * 180,
        color: COLORS.axis,
        parentId: "axes",
        yamlKey: a.toLowerCase(),
        fields: {
          ...defaults("axis"),
          axis: a.toLowerCase(),
          steps_per_mm: a === "Z" ? "400" : "80",
          max_rate_mm_per_min: a === "Z" ? "1000" : "3000",
          acceleration_mm_per_sec2: "100",
          max_travel_mm: a === "Z" ? "80" : "300",
        },
      },
      {
        id: `axis-${a}-motor0`,
        kind: "motor" as const,
        title: `${a} Motor 0`,
        subtitle: "stepstick · pins not assigned",
        x: 910,
        y: 100 + i * 180,
        color: COLORS.motor,
        parentId: `axis-${a}`,
        yamlKey: "motor0",
        fields: { ...defaults("motor"), driver: "stepstick" },
      },
    ]),
  ]);
}

function layoutNodes(source: NodeData[]): NodeData[] {
  const nodes = source.map((node) => ({ ...node }));
  const machine = nodes.find((node) => node.kind === "machine");
  if (!machine) return nodes;
  machine.x = 470;
  machine.y = 360;
  for (const partition of HUB_PARTITIONS) {
    const rootNodes = nodes.filter(
      (node) => !node.parentId && partition.kinds.includes(node.kind),
    );
    const origin =
      PARTITION_ORIGINS[partition.id as keyof typeof PARTITION_ORIGINS];
    rootNodes.forEach((node, index) => {
      node.x = origin.x + origin.dx * index;
      node.y = origin.y + origin.dy * index;
      layoutChildren(nodes, node, partition.direction);
    });
  }
  return nodes;
}

function layoutChildren(
  nodes: NodeData[],
  parent: NodeData,
  direction: "right" | "left" | "top" | "bottom",
) {
  const children = nodes.filter((node) => node.parentId === parent.id);
  if (!children.length) return;

  // Reserve perpendicular space for the complete descendant subtree. A
  // simple sibling index causes, for example, a two-motor Y axis to overlap
  // the X/Z motor rows because the axis level cannot see those grandchildren.
  const spans = children.map((child) => subtreeLeafCount(nodes, child));
  const totalSpan = spans.reduce((sum, span) => sum + span, 0);
  const horizontal = direction === "right" || direction === "left";
  const gap = horizontal ? 115 : 245;
  let cursor = (horizontal ? parent.y : parent.x) - ((totalSpan - 1) * gap) / 2;

  children.forEach((node, index) => {
    const span = spans[index];
    const center = cursor + ((span - 1) * gap) / 2;
    if (horizontal) {
      node.x = parent.x + (direction === "right" ? 290 : -290);
      node.y = center;
    } else {
      node.x = center;
      node.y = parent.y + (direction === "bottom" ? 125 : -125);
    }
    layoutChildren(nodes, node, direction);
    cursor += span * gap;
  });
}

function subtreeLeafCount(
  nodes: NodeData[],
  parent: NodeData,
  visiting = new Set<string>(),
): number {
  if (visiting.has(parent.id)) return 1;
  const nextVisiting = new Set(visiting).add(parent.id);
  const children = nodes.filter((node) => node.parentId === parent.id);
  return children.length
    ? children.reduce(
        (total, child) => total + subtreeLeafCount(nodes, child, nextVisiting),
        0,
      )
    : 1;
}

function branchDirection(nodes: NodeData[], node: NodeData) {
  let root = node;
  while (root.parentId)
    root = nodes.find((candidate) => candidate.id === root.parentId) ?? root;
  return HUB_PARTITIONS[Math.max(0, hubPartition(root.kind))].direction;
}

function scalarFields(source: unknown, defs: FieldDef[]) {
  const obj = (source && typeof source === "object" ? source : {}) as Record<
    string,
    unknown
  >;
  const known = Object.fromEntries(
    defs.map((f) => {
      const sourceKey = Object.keys(obj).find(
        (key) => key.toLowerCase() === f.key.toLowerCase(),
      );
      const raw = sourceKey == null ? undefined : obj[sourceKey];
      const fallback =
        f.type === "boolean"
          ? "false"
          : f.type === "pin"
            ? "NO_PIN"
            : (f.options?.[0] ?? "");
      if (raw == null) return [f.key, fallback];
      if (typeof raw === "object")
        return [f.key, Object.keys(raw as object).length === 0 ? "" : fallback];
      if (f.options) {
        const canonical = f.options.find(
          (option) => option.toLowerCase() === String(raw).toLowerCase(),
        );
        if (canonical != null) return [f.key, canonical];
      }
      return [f.key, String(raw)];
    }),
  );
  for (const [key, value] of Object.entries(obj)) {
    if (
      value == null ||
      typeof value === "object" ||
      defs.some((field) => field.key.toLowerCase() === key.toLowerCase())
    )
      continue;
    known[key] = String(value);
  }
  return known;
}

function inferredField(key: string, value: string): FieldDef {
  const label = key
    .replace(/_/g, " ")
    .replace(/^./, (letter) => letter.toUpperCase());
  if (/_pin$|^pin$/i.test(key)) return { key, label, type: "pin" };
  if (/^(?:true|false)$/i.test(value)) return { key, label, type: "boolean" };
  if (/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value))
    return { key, label, type: "number" };
  return { key, label, type: "text" };
}

function objectEntryIgnoreCase(
  source: unknown,
  wantedKey: string,
): [string, any] | null {
  if (!source || typeof source !== "object") return null;
  const object = source as Record<string, any>;
  const key = Object.keys(object).find(
    (candidate) => candidate.toLowerCase() === wantedKey.toLowerCase(),
  );
  return key == null ? null : [key, object[key]];
}

function objectValueIgnoreCase(source: unknown, wantedKey: string): any {
  return objectEntryIgnoreCase(source, wantedKey)?.[1];
}

function parseConfig(content: string): Record<string, any> {
  const root: Record<string, any> = {},
    stack: { indent: number; value: Record<string, any> }[] = [
      { indent: -1, value: root },
    ];
  for (const raw of splitYamlLines(content)) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    const match = raw.match(/^(\s*)([^:#]+):(?:\s*(.*))?$/);
    if (!match) continue;
    const indent = match[1].length,
      key = match[2].trim(),
      sourceToken = match[3] ?? "",
      token = sourceToken.trim();
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent)
      stack.pop();
    const parent = stack[stack.length - 1].value;
    if (!token) {
      const child: Record<string, any> = {};
      parent[key] = child;
      stack.push({ indent, value: child });
    } else {
      const quoted = token.match(/^(['"])(.*)\1$/);
      if (quoted) {
        parent[key] = quoted[2];
        continue;
      }
      const preserveWhitespace =
        /^(?:name|board|meta|atc|model|cw_cmd|ccw_cmd|off_cmd|set_rpm_cmd|get_min_rpm_cmd|get_max_rpm_cmd|get_rpm_cmd|idle)$/i.test(
          key,
        );
      const clean = preserveWhitespace ? sourceToken : token;
      parent[key] = /^true$/i.test(token)
        ? true
        : /^false$/i.test(token)
          ? false
          : /^-?\d+(?:\.\d+)?$/.test(token)
            ? Number(token)
            : clean;
    }
  }
  return root;
}

export function nodesFromYaml(content: string): NodeData[] {
  if (!content.trim()) return defaultNodes();
  try {
    const root = parseConfig(content);
    const nodes: NodeData[] = [
      {
        id: "machine",
        kind: "machine",
        title: "Machine",
        subtitle: "FluidNC configuration",
        x: 40,
        y: 220,
        color: COLORS.machine,
        fields: { ...scalarFields(root, FIELDS.machine) },
      },
    ];
    const steppingEntry = objectEntryIgnoreCase(root, "stepping");
    if (steppingEntry) {
      const stepping = steppingEntry[1];
      nodes.push({
        id: "stepping",
        kind: "stepping",
        title: "Stepping",
        subtitle: `${objectValueIgnoreCase(stepping, "engine") ?? "RMT"} stepping engine`,
        x: 330,
        y: 40,
        color: COLORS.stepping,
        fields: scalarFields(stepping, FIELDS.stepping),
        yamlKey: steppingEntry[0],
      });
    }
    const axesEntry = objectEntryIgnoreCase(root, "axes");
    const axes =
      axesEntry && typeof axesEntry[1] === "object" ? axesEntry[1] : {};
    nodes.push({
      id: "axes",
      kind: "axes",
      title: "Axes",
      subtitle: "Shared axis configuration",
      x: 330,
      y: 190,
      color: COLORS.axes,
      fields: scalarFields(axes, FIELDS.axes),
      yamlKey: axesEntry?.[0],
    });
    Object.entries(axes)
      .filter(([letter]) => /^[xyzabc]$/i.test(letter))
      .forEach(([letter, value], i) => {
        const axis = value as Record<string, any>,
          axisId = `axis-${letter.toUpperCase()}`;
        const fields: Record<string, string> = {
          ...scalarFields(axis, FIELDS.axis),
          axis: letter.toLowerCase(),
        };
        const homing = objectValueIgnoreCase(axis, "homing");
        if (homing && typeof homing === "object") {
          fields.homing_cycle = String(
            objectValueIgnoreCase(homing, "cycle") ?? "",
          );
          fields.homing_positive = String(
            objectValueIgnoreCase(homing, "positive_direction") ?? false,
          );
          fields.homing_mpos_mm = String(
            objectValueIgnoreCase(homing, "mpos_mm") ?? "",
          );
        }
        nodes.push({
          id: axisId,
          kind: "axis",
          title: `${letter.toUpperCase()} Axis`,
          subtitle: "Motion axis",
          x: 620,
          y: 90 + i * 190,
          color: COLORS.axis,
          parentId: "axes",
          fields,
          yamlKey: letter,
        });
        ["motor0", "motor1"].forEach((motorKey, motorIndex) => {
          const motorEntry = objectEntryIgnoreCase(axis, motorKey);
          if (!motorEntry) return;
          const motor = motorEntry[1] as Record<string, any>;
          const driverTypes = [
            "stepstick",
            "tmc_2130",
            "tmc_2208",
            "tmc_2209",
            "tmc_5160",
            "tmc_5160Pro",
            "tmc_2160Pro",
            "tmc_2160",
            "rc_servo",
            "solenoid",
            "dynamixel2",
            "standard_stepper",
            "null_motor",
          ];
          const driverKey =
            Object.keys(motor).find((key) =>
              driverTypes.some(
                (type) => type.toLowerCase() === key.toLowerCase(),
              ),
            ) ??
            Object.keys(motor).find(
              (key) =>
                motor[key] != null &&
                typeof motor[key] === "object" &&
                !/^homing$/i.test(key),
            );
          const driver =
            driverTypes.find(
              (type) => type.toLowerCase() === driverKey?.toLowerCase(),
            ) ??
            driverKey ??
            "stepstick";
          const driverFields =
            driverKey &&
            motor[driverKey] &&
            typeof motor[driverKey] === "object"
              ? motor[driverKey]
              : {};
          const motorId = `${axisId}-${motorKey}`;
          nodes.push({
            id: motorId,
            kind: "motor",
            title: `${letter.toUpperCase()} Motor ${motorIndex}`,
            subtitle: `${driver} · configured`,
            x: 910 + motorIndex * 250,
            y: 90 + i * 190 + motorIndex * 80,
            color: COLORS.motor,
            parentId: axisId,
            fields: scalarFields(motor, FIELDS.motor),
            yamlKey: motorEntry[0],
          });
          nodes.push({
            id: `${motorId}-${driver}`,
            kind: "driver",
            title: driver,
            subtitle: "Motor driver",
            x: 1200 + motorIndex * 250,
            y: 90 + i * 190 + motorIndex * 80,
            color: COLORS.driver,
            parentId: motorId,
            fields: {
              ...scalarFields(driverFields, FIELDS.driver),
              ...Object.fromEntries(
                Object.entries(driverFields)
                  .filter(
                    ([, value]) => value == null || typeof value !== "object",
                  )
                  .map(([key, value]) => [
                    key,
                    value == null ? "" : String(value),
                  ]),
              ),
              type: driver,
            },
            yamlKey: driverKey ?? driver,
          });
        });
      });
    const sectionKinds: [string, NodeKind, string][] = [
      ["control", "control", "Control inputs"],
      ["probe", "probe", "Probe"],
      ["coolant", "coolant", "Coolant"],
      ["macros", "macro", "Macros"],
      ["start", "start", "Startup"],
      ["parking", "parking", "Parking"],
      ["oled", "display", "OLED display"],
      ["atc_manual", "atc", "Tool changer"],
      ["sdcard", "storage", "SD card"],
      ["user_inputs", "io", "User inputs"],
      ["user_outputs", "io", "User outputs"],
    ];
    sectionKinds.forEach(([key, kind, title], i) => {
      const sectionEntry = objectEntryIgnoreCase(root, key);
      if (sectionEntry && sectionEntry[1] != null)
        nodes.push({
          id: `${kind}-${i}`,
          kind,
          title,
          subtitle: "Loaded from config.yaml",
          x: 920 + (i % 2) * 240,
          y: 80 + (i % 5) * 135,
          color: COLORS[kind],
          fields: scalarFields(sectionEntry[1], FIELDS[kind]),
          yamlKey: sectionEntry[0],
        });
    });
    const kinematicsEntry = objectEntryIgnoreCase(root, "kinematics");
    if (
      kinematicsEntry &&
      kinematicsEntry[1] &&
      typeof kinematicsEntry[1] === "object"
    ) {
      const configured = kinematicsEntry[1] as Record<string, unknown>;
      const typeEntry = Object.entries(configured).find(
        ([, value]) => value == null || typeof value === "object",
      );
      if (typeEntry) {
        const canonicalType =
          FIELDS.kinematics[0].options?.find(
            (option) => option.toLowerCase() === typeEntry[0].toLowerCase(),
          ) ?? typeEntry[0];
        nodes.push({
          id: "kinematics",
          kind: "kinematics",
          title: "Kinematics",
          subtitle: canonicalType,
          x: 920,
          y: 500,
          color: COLORS.kinematics,
          fields: {
            ...scalarFields(typeEntry[1], FIELDS.kinematics),
            type: canonicalType,
          },
          yamlKey: kinematicsEntry[0],
          yamlTypeKey: typeEntry[0],
        });
      }
    }
    Object.entries(root).forEach(([key, value], i) => {
      if (/^uart(?:_channel)?\d+$|^i2c\d+$|^(spi|i2so)$/i.test(key))
        nodes.push({
          id: `bus-${key}`,
          kind: "bus",
          title: key.toUpperCase(),
          subtitle: "Hardware bus",
          x: 1180,
          y: 80 + i * 90,
          color: COLORS.bus,
          fields: {
            ...scalarFields(value, FIELDS.bus),
            type: key.toLowerCase(),
          },
          yamlKey: key,
        });
    });
    const spindleTypes = FIELDS.spindle[0].options ?? [];
    for (const type of spindleTypes) {
      const sourceKey = Object.keys(root).find(
        (key) => key.toLowerCase() === type.toLowerCase(),
      );
      if (sourceKey != null && root[sourceKey] != null)
        nodes.push({
          id: `spindle-${sourceKey}`,
          kind: "spindle",
          title: sourceKey,
          subtitle: "Spindle / tool output",
          x: 920,
          y: 580,
          color: COLORS.spindle,
          fields: { ...scalarFields(root[sourceKey], FIELDS.spindle), type },
          yamlKey: sourceKey,
        });
    }
    return nodes.length > 1 ? layoutNodes(nodes) : defaultNodes();
  } catch {
    return defaultNodes();
  }
}

function PinEditor({
  value,
  onChange,
  hasI2so,
  uartChannels,
}: {
  value: string;
  onChange: (v: string) => void;
  hasI2so: boolean;
  uartChannels: string[];
}) {
  const parts = value.split(":");
  const base = parts[0].trim();
  const normalizedBase = base.toLowerCase();
  const dot = base.lastIndexOf(".");
  const family =
    normalizedBase === "no_pin"
      ? "NO_PIN"
      : normalizedBase === "void"
        ? "void"
        : dot > 0
          ? base.slice(0, dot).toLowerCase()
          : "gpio";
  const index = dot > 0 ? base.slice(dot + 1) : /^\d+$/.test(base) ? base : "0";
  const set = (nextFamily: string, nextIndex = index, attrs = parts.slice(1)) =>
    onChange(
      nextFamily === "NO_PIN" || nextFamily === "void"
        ? nextFamily
        : [nextFamily, nextIndex].join(".") +
            (attrs.length ? `:${attrs.join(":")}` : ""),
    );
  const families = Array.from(
    new Set([
      "NO_PIN",
      "gpio",
      ...(hasI2so || family === "i2so" ? ["i2so"] : []),
      ...uartChannels.map((channel) => channel.toLowerCase()),
      ...(family !== "NO_PIN" && family !== "gpio" && family !== "void"
        ? [family]
        : []),
      "void",
    ]),
  );
  const pinCount = family === "gpio" ? 49 : 32;
  const pinOptions = Array.from({ length: pinCount }, (_, i) => String(i));

  if (/^\d+$/.test(index) && !pinOptions.includes(index))
    pinOptions.push(index);
  return (
    <div className="grid grid-cols-[1fr_72px] gap-1.5">
      <select
        value={family}
        onChange={(e) => set(e.target.value)}
        className="rounded-md border studio-border studio-input px-2 py-2 font-mono text-xs outline-none"
      >
        {families.map((f) => (
          <option key={f}>{f}</option>
        ))}
      </select>
      {family !== "NO_PIN" && family !== "void" ? (
        <select
          value={index}
          onChange={(e) => set(family, e.target.value)}
          className="rounded-md border studio-border studio-input px-2 py-2 font-mono text-xs outline-none"
          aria-label={`${family} pin number`}
        >
          {pinOptions.map((pin) => (
            <option key={pin}>{pin}</option>
          ))}
        </select>
      ) : (
        <div />
      )}
      <select
        value={
          parts.find((part) => /^(?:low|high)$/i.test(part))?.toLowerCase() ??
          "high"
        }
        onChange={(e) =>
          set(family, index, [
            e.target.value,
            ...parts.slice(1).filter((part) => !/^(?:low|high)$/i.test(part)),
          ])
        }
        disabled={family === "NO_PIN" || family === "void"}
        className="rounded-md border studio-border studio-input px-2 py-1.5 text-[10px] outline-none"
      >
        <option>high</option>
        <option>low</option>
      </select>
      <select
        value={
          parts.find((part) => /^(?:pu|pd)$/i.test(part))?.toLowerCase() ?? ""
        }
        onChange={(e) =>
          set(family, index, [
            ...parts.slice(1).filter((part) => !/^(?:pu|pd)$/i.test(part)),
            ...(e.target.value ? [e.target.value] : []),
          ])
        }
        disabled={family === "NO_PIN" || family === "void"}
        className="rounded-md border studio-border studio-input px-2 py-1.5 text-[10px] outline-none"
      >
        <option value="">No pull</option>
        <option value="pu">Pull up</option>
        <option value="pd">Pull down</option>
      </select>
    </div>
  );
}

function Port({ side }: { side: "left" | "right" | "top" | "bottom" }) {
  return (
    <span
      className={`absolute h-2.5 w-2.5 rounded-full border-2 border-[var(--surface)] bg-current ${side === "left" ? "-left-1.5 top-1/2 -translate-y-1/2" : side === "right" ? "-right-1.5 top-1/2 -translate-y-1/2" : side === "top" ? "-top-1.5 left-1/2 -translate-x-1/2" : "-bottom-1.5 left-1/2 -translate-x-1/2"}`}
    />
  );
}

function MachineHub({
  node,
  nodes,
  selected,
  zoom,
  onSelect,
  onDrag,
  onAdd,
}: {
  node: NodeData;
  nodes: NodeData[];
  selected: boolean;
  zoom: number;
  onSelect: () => void;
  onDrag: (v: { id: string; dx: number; dy: number }) => void;
  onAdd: (kind: NodeKind, title: string) => void;
}) {
  const [openPartition, setOpenPartition] = useState<string | null>(null);
  const hubRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!openPartition) return;
    const close = (e: PointerEvent) => {
      if (!hubRef.current?.contains(e.target as Node)) setOpenPartition(null);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [openPartition]);
  return (
    <div
      ref={hubRef}
      onPointerDown={(e) => {
        e.stopPropagation();
        onSelect();
        onDrag({
          id: node.id,
          dx: (e.clientX - e.currentTarget.getBoundingClientRect().left) / zoom,
          dy: (e.clientY - e.currentTarget.getBoundingClientRect().top) / zoom,
        });
      }}
      className={`absolute w-[360px] studio-grabbable cursor-grab select-none rounded-xl border studio-node shadow-[0_14px_40px_rgba(0,0,0,.38)] ${selected ? "border-white/35 ring-1 ring-white/10" : "studio-border"}`}
      style={{ left: node.x, top: node.y }}
    >
      <div className="flex items-center gap-3 border-b studio-border px-4 py-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg studio-button text-[#aeb9ca]">
          <Cpu size={18} />
        </span>
        <span>
          <span className="block text-sm font-semibold">
            {node.fields.name || node.title}
          </span>
          <span className="block text-[10px] text-[#6f7c90]">
            {node.fields.board || "FluidNC configuration"}
          </span>
        </span>
      </div>
      <div className="grid grid-cols-2">
        {HUB_PARTITIONS.map((p, i) => {
          return (
            <div
              key={p.id}
              className={`relative h-[88px] p-3 ${i % 2 === 0 ? "border-r" : ""} ${i < 2 ? "border-b" : ""} studio-border`}
            >
              <div className="flex items-center gap-2">
                <span
                  className="h-2 w-2 shrink-0 rounded-sm"
                  style={{ background: p.color }}
                />
                <span className="text-[11px] font-bold uppercase leading-tight tracking-wider text-[#aab4c3]">
                  {p.label}
                </span>
                <button
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenPartition((current) =>
                      current === p.id ? null : p.id,
                    );
                  }}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded border studio-border studio-button text-[#8794a8] hover:border-white/25 hover:text-white"
                  title={`Add ${p.label.toLowerCase()} component`}
                >
                  <Plus size={12} />
                </button>
              </div>
              <div className="mt-1.5 grid grid-cols-2 gap-1">
                {p.capabilities.map((capability) => (
                  <span
                    key={capability}
                    className="whitespace-nowrap rounded border px-1.5 py-0.5 text-center text-[9px] font-medium leading-3 text-[#8e9aab]"
                    style={{
                      borderColor: `${p.color}35`,
                      backgroundColor: `${p.color}10`,
                    }}
                    title={capability}
                  >
                    {capability}
                  </span>
                ))}
              </div>
              {openPartition === p.id && (
                <div
                  onPointerDown={(e) => e.stopPropagation()}
                  onWheel={(e) => e.stopPropagation()}
                  className={`absolute z-50 mt-2 min-w-44 rounded-md border studio-border studio-panel p-1 shadow-2xl ${i % 2 === 0 ? "left-2" : "right-2"}`}
                >
                  {ROOT_OPTIONS[p.id].map((option) => {
                    const exists = nodes.some(
                      (existing) =>
                        !existing.parentId &&
                        existing.kind === option.kind &&
                        (option.kind !== "io" ||
                          existing.title === option.title),
                    );
                    const disabled = !option.repeatable && exists;
                    return (
                      <button
                        key={option.title}
                        disabled={disabled}
                        onClick={(e) => {
                          e.stopPropagation();
                          onAdd(option.kind, option.title);
                          setOpenPartition(null);
                        }}
                        className={`flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-xs ${disabled ? "cursor-not-allowed text-[#465164]" : "studio-text hover:bg-white/[.06]"}`}
                      >
                        <Plus
                          size={12}
                          style={{
                            color: disabled ? "#465164" : COLORS[option.kind],
                          }}
                        />
                        <span>{option.title}</span>
                        {disabled && (
                          <span className="ml-auto text-[9px] uppercase tracking-wider">
                            Added
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <span className="absolute -left-1.5 top-[100px] h-2.5 w-2.5 rounded-full border-2 border-[#1b212c] bg-[#dc7659]" />
      <span className="absolute -right-1.5 top-[100px] h-2.5 w-2.5 rounded-full border-2 border-[#1b212c] bg-[#4f8edc]" />
      <span className="absolute left-[85px] -bottom-1.5 h-2.5 w-2.5 rounded-full border-2 border-[#1b212c] bg-[#9c72c2]" />
      <span className="absolute -right-1.5 top-[187px] h-2.5 w-2.5 rounded-full border-2 border-[#1b212c] bg-[#47a986]" />
    </div>
  );
}

function GraphNode({
  node,
  selected,
  zoom,
  onSelect,
  onDrag,
  onAdd,
  inputSide,
}: {
  node: NodeData;
  selected: boolean;
  zoom: number;
  onSelect: () => void;
  onDrag: (v: { id: string; dx: number; dy: number }) => void;
  onAdd: (parent: NodeData, kind: NodeKind, title: string) => void;
  inputSide: "left" | "right" | "top" | "bottom";
}) {
  const [showChildren, setShowChildren] = useState(false);
  const nodeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showChildren) return;
    const close = (e: PointerEvent) => {
      if (!nodeRef.current?.contains(e.target as Node)) setShowChildren(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [showChildren]);
  const children = CHILDREN[node.kind] ?? [];
  return (
    <div
      ref={nodeRef}
      onPointerDown={(e) => {
        e.stopPropagation();
        onSelect();
        onDrag({
          id: node.id,
          dx: (e.clientX - e.currentTarget.getBoundingClientRect().left) / zoom,
          dy: (e.clientY - e.currentTarget.getBoundingClientRect().top) / zoom,
        });
      }}
      className={`absolute h-[76px] w-[210px] studio-grabbable cursor-grab select-none rounded-lg border studio-node text-left shadow-[0_8px_25px_rgba(0,0,0,.3)] active:cursor-grabbing ${selected ? "border-white/35 ring-1 ring-white/10" : "studio-border hover:border-white/20"}`}
      style={{ left: node.x, top: node.y }}
    >
      <Port side={inputSide} />
      <span
        className="block h-1 rounded-t-lg"
        style={{ background: node.color }}
      />
      <span className="flex h-[72px] items-center gap-3 p-3">
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md studio-icon-well"
          style={{ color: node.color }}
        >
          {node.kind === "axis" ? (
            <Gauge size={16} />
          ) : node.kind === "control" ? (
            <ShieldCheck size={16} />
          ) : node.kind === "probe" ? (
            <Crosshair size={16} />
          ) : node.kind === "bus" ? (
            <CircuitBoard size={16} />
          ) : node.kind === "stepping" ? (
            <Zap size={16} />
          ) : (
            <Settings2 size={16} />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold studio-text">
            {node.title}
          </span>
          <span className="line-clamp-2 text-[11px] leading-[14px] studio-muted">
            {node.subtitle}
          </span>
        </span>
        {children.length > 0 && (
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setShowChildren((v) => !v);
            }}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded border studio-border studio-button text-[#8794a8] hover:text-white"
            title="Add child"
          >
            <Plus size={12} />
          </button>
        )}
      </span>
      {showChildren && (
        <div
          onPointerDown={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
          className="absolute left-full top-3 z-30 ml-2 min-w-40 rounded-md border studio-border studio-panel p-1 shadow-2xl"
        >
          {children.map((child) => (
            <button
              key={child.kind}
              onClick={(e) => {
                e.stopPropagation();
                onAdd(node, child.kind, child.title);
                setShowChildren(false);
              }}
              className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-xs studio-text hover:bg-white/[.06]"
            >
              <Plus size={12} style={{ color: COLORS[child.kind] }} />
              {child.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ConfigStudio({
  content,
  onChange,
  isActive = true,
  firmwareVersion,
}: {
  content: string;
  onChange: (yaml: string) => void;
  isActive?: boolean;
  /** Connected firmware's espInfo.version; selects config_items.json's ref. */
  firmwareVersion?: string | null;
}) {
  const [nodes, setNodes] = useState<NodeData[]>(() => nodesFromYaml(content));
  const [selected, setSelected] = useState("machine");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [palette, setPalette] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLDivElement>(null);
  const [pendingPlacement, setPendingPlacement] = useState<{
    kind: NodeKind;
    title: string;
    position: { x: number; y: number };
  } | null>(null);
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const panning = useRef<{
    x: number;
    y: number;
    px: number;
    py: number;
  } | null>(null);
  const sourceRef = useRef(content);
  const undoRef = useRef<{ nodes: NodeData[]; source: string }[]>([]);
  const redoRef = useRef<{ nodes: NodeData[]; source: string }[]>([]);
  const [propertyQuery, setPropertyQuery] = useState("");
  const [mutationError, setMutationError] = useState("");
  const [fluidConfig, setFluidConfig] = useState<FluidConfig | null>(null);

  useEffect(() => {
    setPropertyQuery("");
    setMutationError("");
  }, [selected]);
  const active = nodes.find((n) => n.id === selected);
  const knownPropertyFields = active
    ? active.kind === "driver"
      ? (driverFieldsFromConfig(fluidConfig, active.fields.type) ??
        (DRIVER_FIELDS_BY_TYPE[active.fields.type.toLowerCase()]
          ? FIELDS.driver.filter((field) =>
              DRIVER_FIELDS_BY_TYPE[active.fields.type.toLowerCase()]?.includes(
                field.key,
              ),
            )
          : FIELDS.driver))
      : FIELDS[active.kind]
    : [];
  const propertyFields = active
    ? [
        ...knownPropertyFields,
        ...Object.entries(active.fields)
          .filter(
            ([key]) =>
              !knownPropertyFields.some(
                (field) => field.key.toLowerCase() === key.toLowerCase(),
              ),
          )
          .map(([key, value]) => inferredField(key, value)),
      ].map((field) =>
        field.key === "type" &&
        field.options &&
        active.fields.type &&
        !field.options.some(
          (option) => option.toLowerCase() === active.fields.type.toLowerCase(),
        )
          ? { ...field, options: [...field.options, active.fields.type] }
          : field,
      )
    : [];
  const snapshotNodes = (value: NodeData[]) =>
    value.map((node) => ({ ...node, fields: { ...node.fields } }));
  const recordHistory = () => {
    undoRef.current.push({
      nodes: snapshotNodes(nodes),
      source: sourceRef.current,
    });
    if (undoRef.current.length > 100) undoRef.current.shift();
    redoRef.current = [];
  };
  const restoreHistory = (direction: "undo" | "redo") => {
    const from = direction === "undo" ? undoRef : redoRef,
      to = direction === "undo" ? redoRef : undoRef,
      entry = from.current.pop();
    if (!entry) return;
    to.current.push({ nodes: snapshotNodes(nodes), source: sourceRef.current });
    setNodes(snapshotNodes(entry.nodes));
    sourceRef.current = entry.source;
    onChange(entry.source);
    setSelected(
      entry.nodes.some((node) => node.id === selected) ? selected : "machine",
    );
  };
  useEffect(() => {
    if (!content.trim()) onChange(contentFromNodes(nodes, content));
  }, []);
  useEffect(() => {
    // Successful loads are memoized per firmware ref; offline results can
    // retry when the version changes or the studio is reopened.
    if (!isActive) return;
    let cancelled = false;
    loadFluidConfig(firmwareVersion).then((config) => {
      if (!cancelled) setFluidConfig(config);
    });
    return () => {
      cancelled = true;
    };
  }, [isActive, firmwareVersion]);
  useEffect(() => {
    if (!palette) return;
    const close = (e: PointerEvent) => {
      if (!searchRef.current?.contains(e.target as Node)) setPalette(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [palette]);
  const hasI2so = nodes.some(
    (n) => n.kind === "bus" && n.fields.type === "i2so",
  );
  const uartChannels = nodes
    .filter(
      (n) => n.kind === "bus" && n.fields.type?.startsWith("uart_channel"),
    )
    .map((n) => n.fields.type);
  const edges = useMemo(
    () =>
      nodes
        .filter((n) => n.id !== "machine")
        .map((n, i) => ({
          from:
            (n.parentId && nodes.find((p) => p.id === n.parentId)) || nodes[0],
          to: n,
          i,
        })),
    [nodes],
  );
  const add = (kind: NodeKind, title: string) => {
    const partition = HUB_PARTITIONS[Math.max(0, hubPartition(kind))];
    const siblings = nodes.filter(
      (node) => !node.parentId && partition.kinds.includes(node.kind),
    );
    const origin =
      PARTITION_ORIGINS[partition.id as keyof typeof PARTITION_ORIGINS];
    setPendingPlacement({
      kind,
      title,
      position: {
        x: origin.x + origin.dx * siblings.length,
        y: origin.y + origin.dy * siblings.length,
      },
    });
  };
  const addChild = (parent: NodeData, kind: NodeKind, title: string) => {
    recordHistory();
    const id = `${kind}-${Date.now()}`;
    setNodes((ns) => {
      const siblingCount = ns.filter((n) => n.parentId === parent.id).length;
      const usedAxes = new Set(
        ns.filter((n) => n.kind === "axis").map((n) => n.fields.axis),
      );
      const axisLetter =
        ["x", "y", "z", "a", "b", "c"].find((a) => !usedAxes.has(a)) ?? "x";
      const usedMotorKeys = new Set(
        ns
          .filter((n) => n.kind === "motor" && n.parentId === parent.id)
          .map((n) => n.yamlKey),
      );
      const motorKey = ["motor0", "motor1"].find(
        (candidate) => !usedMotorKeys.has(candidate),
      );
      const nodeTitle =
        kind === "motor"
          ? `${parent.title.replace(" Axis", "")} Motor ${siblingCount}`
          : kind === "axis"
            ? `${axisLetter.toUpperCase()} Axis`
            : title;
      let root = parent;
      while (root.parentId)
        root = ns.find((node) => node.id === root.parentId) ?? root;
      const direction =
        HUB_PARTITIONS[Math.max(0, hubPartition(root.kind))].direction;
      const position =
        direction === "right"
          ? { x: parent.x + 290, y: parent.y + siblingCount * 105 }
          : direction === "left"
            ? { x: parent.x - 290, y: parent.y + siblingCount * 105 }
            : direction === "bottom"
              ? { x: parent.x + siblingCount * 245, y: parent.y + 125 }
              : { x: parent.x + siblingCount * 245, y: parent.y - 125 };
      const next = [
        ...ns,
        {
          id,
          kind,
          title: nodeTitle,
          subtitle:
            kind === "motor"
              ? "stepstick · pins not assigned"
              : "New child component",
          x: position.x,
          y: position.y,
          color: COLORS[kind],
          fields: {
            ...defaults(kind),
            ...(kind === "axis" ? { axis: axisLetter } : {}),
          },
          parentId: parent.id,
          yamlKey:
            kind === "axis"
              ? axisLetter
              : kind === "motor"
                ? (motorKey ?? `motor${siblingCount}`)
                : kind === "driver"
                  ? defaults(kind).type
                  : undefined,
        },
      ];
      const added = next[next.length - 1];
      const nextSource = insertNodeYaml(sourceRef.current, added, next);
      sourceRef.current = nextSource;
      onChange(nextSource);
      return next;
    });
    setSelected(id);
  };
  const update = (key: string, value: string) => {
    const changedNode = nodes.find((node) => node.id === selected);
    if (!changedNode) return;
    const structural =
      (changedNode.kind === "axis" && key === "axis") ||
      (["driver", "bus", "spindle", "kinematics"].includes(changedNode.kind) &&
        key === "type");
    const path = structural
      ? changedNode.kind === "kinematics"
        ? `${changedNode.yamlKey ?? "kinematics"}.${changedNode.yamlTypeKey ?? changedNode.fields.type}`
        : yamlPathForNode(changedNode, nodes)
      : yamlPathForField(changedNode, key, nodes);
    const nextSource = structural
      ? path
        ? renameYamlKey(sourceRef.current, path, value)
        : null
      : path
        ? patchYamlValue(
            sourceRef.current,
            path,
            value,
            propertyFields.find(
              (field) => field.key.toLowerCase() === key.toLowerCase(),
            )?.type,
          )
        : null;
    if (nextSource == null) {
      setMutationError(
        `Could not update ${path ?? key}; the YAML structure has changed. Review the YAML and try again.`,
      );
      return;
    }
    recordHistory();
    setMutationError("");
    setNodes((ns) =>
      ns.map((n) =>
        n.id === selected
          ? {
              ...n,
              fields: { ...n.fields, [key]: value },
              subtitle: key === "type" || key === "driver" ? value : n.subtitle,
              yamlKey:
                structural && changedNode.kind !== "kinematics"
                  ? value
                  : n.yamlKey,
              yamlTypeKey:
                structural && changedNode.kind === "kinematics"
                  ? value
                  : n.yamlTypeKey,
              title:
                changedNode.kind === "axis" && key === "axis"
                  ? `${value.toUpperCase()} Axis`
                  : n.title,
            }
          : n,
      ),
    );
    sourceRef.current = nextSource;
    onChange(nextSource);
  };
  const remove = () => {
    if (!active || active.kind === "machine") return;
    recordHistory();
    setNodes((ns) => {
      const removed = new Set([selected]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const node of ns)
          if (
            node.parentId &&
            removed.has(node.parentId) &&
            !removed.has(node.id)
          ) {
            removed.add(node.id);
            changed = true;
          }
      }
      const next = ns.filter((node) => !removed.has(node.id));
      const nextSource = removeNodeYaml(sourceRef.current, active, ns);
      sourceRef.current = nextSource;
      onChange(nextSource);
      return next;
    });
    setSelected("machine");
  };
  useEffect(() => {
    const deleteSelected = (event: KeyboardEvent) => {
      if (
        isActive &&
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "z"
      ) {
        event.preventDefault();
        restoreHistory(event.shiftKey ? "redo" : "undo");
        return;
      }
      if (!isActive) return;
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      if (!active || active.kind === "machine") return;
      event.preventDefault();
      remove();
    };
    window.addEventListener("keydown", deleteSelected);
    return () => window.removeEventListener("keydown", deleteSelected);
  }, [selected, active, nodes, content, isActive]);
  const screenToWorld = (e: React.PointerEvent) => ({
    x:
      (e.clientX - e.currentTarget.getBoundingClientRect().left - pan.x) / zoom,
    y: (e.clientY - e.currentTarget.getBoundingClientRect().top - pan.y) / zoom,
  });
  useEffect(() => {
    const cancel = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPendingPlacement(null);
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, []);
  const commitPlacement = (position: { x: number; y: number }) => {
    if (!pendingPlacement) return;
    recordHistory();
    const placement = pendingPlacement;
    const id = `${placement.kind}-${Date.now()}`;
    setNodes((ns) => {
      const fields = defaults(placement.kind);
      const next = [
        ...ns,
        {
          id,
          kind: placement.kind,
          title: placement.title,
          subtitle:
            placement.kind === "spindle"
              ? "Select spindle type"
              : "New component",
          x: position.x - 105,
          y: position.y - 38,
          color: COLORS[placement.kind],
          fields,
          yamlKey:
            placement.kind === "bus" || placement.kind === "spindle"
              ? fields.type
              : undefined,
        },
      ];
      const added = next[next.length - 1];
      const nextSource = insertNodeYaml(sourceRef.current, added, next);
      sourceRef.current = nextSource;
      onChange(nextSource);
      return next;
    });
    setSelected(id);
    setPendingPlacement(null);
  };
  const handleWheel = (e: React.WheelEvent<HTMLElement>) => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const cursor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const nextZoom = Math.min(
      1.7,
      Math.max(0.35, zoom * (e.deltaY > 0 ? 0.9 : 1.1)),
    );
    if (nextZoom === zoom) return;
    // Keep the world-space point beneath the pointer fixed on screen.
    const world = {
      x: (cursor.x - pan.x) / zoom,
      y: (cursor.y - pan.y) / zoom,
    };
    setPan({
      x: cursor.x - world.x * nextZoom,
      y: cursor.y - world.y * nextZoom,
    });
    setZoom(nextZoom);
  };
  const handleCanvasDown = (e: React.PointerEvent<HTMLElement>) => {
    if (pendingPlacement && e.target === e.currentTarget) {
      e.preventDefault();
      commitPlacement(screenToWorld(e));
      return;
    }
    if (e.target === e.currentTarget) {
      panning.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  };
  const handleCanvasMove = (e: React.PointerEvent<HTMLElement>) => {
    if (pendingPlacement) {
      const position = screenToWorld(e);
      setPendingPlacement((current) =>
        current
          ? {
              ...current,
              position: { x: position.x - 105, y: position.y - 38 },
            }
          : null,
      );
      return;
    }
    if (panning.current)
      setPan({
        x: panning.current.px + e.clientX - panning.current.x,
        y: panning.current.py + e.clientY - panning.current.y,
      });
    if (drag.current) {
      const p = screenToWorld(e);
      const d = drag.current;
      setNodes((ns) =>
        ns.map((n) =>
          n.id === d.id ? { ...n, x: p.x - d.dx, y: p.y - d.dy } : n,
        ),
      );
    }
  };
  const handleCanvasUp = () => {
    drag.current = null;
    panning.current = null;
  };
  return (
    <div className="config-studio relative flex min-h-0 flex-1 overflow-hidden bg-[#11151d] studio-text">
      <section
        className="relative min-w-0 flex-1 overflow-hidden"
        onWheel={handleWheel}
        onPointerDown={handleCanvasDown}
        onPointerMove={handleCanvasMove}
        onPointerUp={handleCanvasUp}
      >
        <div
          className="pointer-events-none absolute inset-0 opacity-40"
          style={{
            backgroundImage: "radial-gradient(#536071 1px, transparent 1px)",
            backgroundSize: `${20 * zoom}px ${20 * zoom}px`,
            backgroundPosition: `${pan.x}px ${pan.y}px`,
          }}
        />
        <div
          ref={searchRef}
          className="absolute left-3 top-3 z-40 w-64"
          onPointerDown={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-2 rounded-md border studio-border studio-panel px-3 py-2 shadow-xl focus-within:border-white/25">
            <Search size={14} className="studio-muted" />
            <input
              value={query}
              onFocus={() => setPalette(true)}
              onChange={(e) => {
                setQuery(e.target.value);
                setPalette(true);
              }}
              placeholder="Add node…"
              className="min-w-0 flex-1 bg-transparent text-xs text-[#d5dbe5] outline-none placeholder:text-[#657185]"
            />
            {query && (
              <button
                onClick={() => {
                  setQuery("");
                  setPalette(false);
                }}
                className="text-[10px] studio-muted hover:text-white"
              >
                Clear
              </button>
            )}
          </div>
          {palette && (
            <div className="mt-1 max-h-80 overflow-auto rounded-md border studio-border studio-panel p-1 shadow-2xl">
              {PALETTE.map((group) => {
                const matches = group.items.filter((item) =>
                  (item.title + item.sub)
                    .toLowerCase()
                    .includes(query.toLowerCase()),
                );
                if (!matches.length) return null;
                return (
                  <div key={group.group}>
                    <div className="px-2.5 pb-1 pt-2 text-[9px] font-bold uppercase tracking-widest text-[#59667a]">
                      {group.group}
                    </div>
                    {matches.map((item) => (
                      <button
                        key={item.title}
                        onClick={() => {
                          add(item.kind, item.title);
                          setPalette(false);
                          setQuery("");
                        }}
                        className="flex w-full items-center gap-2.5 rounded px-2.5 py-2 text-left hover:bg-white/[.06]"
                      >
                        <span
                          className="flex h-7 w-7 items-center justify-center rounded border studio-border studio-elevated"
                          style={{ color: COLORS[item.kind] }}
                        >
                          <Box size={13} />
                        </span>
                        <span className="min-w-0">
                          <span className="block text-xs studio-text">
                            {item.title}
                          </span>
                          <span className="block truncate text-[10px] studio-muted">
                            {item.sub}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-1 rounded-md border studio-border studio-panel p-1 shadow-xl">
          <button
            onClick={() => restoreHistory("undo")}
            disabled={!undoRef.current.length}
            title="Undo (⌘Z)"
            aria-label="Undo"
            className="p-1.5 text-[#8995a7] hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
          >
            <Undo2 size={14} />
          </button>
          <button
            onClick={() => restoreHistory("redo")}
            disabled={!redoRef.current.length}
            title="Redo (⌘⇧Z)"
            aria-label="Redo"
            className="p-1.5 text-[#8995a7] hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
          >
            <Redo2 size={14} />
          </button>
          <span className="mx-1 h-5 w-px bg-white/10" />
          <button
            onClick={() => setZoom((z) => Math.max(0.35, z - 0.1))}
            title="Zoom out"
            aria-label="Zoom out"
            className="p-1.5 text-[#8995a7] hover:text-white"
          >
            <Minus size={14} />
          </button>
          <span className="w-10 text-center text-[10px] text-[#7e8999]">
            {Math.round(zoom * 100)}%
          </span>
          <button
            onClick={() => setZoom((z) => Math.min(1.7, z + 0.1))}
            title="Zoom in"
            aria-label="Zoom in"
            className="p-1.5 text-[#8995a7] hover:text-white"
          >
            <Plus size={14} />
          </button>
          <button
            onClick={() => {
              setZoom(1);
              setPan({ x: 0, y: 0 });
            }}
            title="Reset view"
            aria-label="Reset view"
            className="p-1.5 text-[#8995a7] hover:text-white"
          >
            <Grid3X3 size={14} />
          </button>
        </div>
        <div
          className="absolute origin-top-left"
          style={{
            transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom})`,
          }}
        >
          <svg className="pointer-events-none absolute left-0 top-0 h-[1400px] w-[1900px] overflow-visible">
            {edges.map((e) => {
              const isHub = e.from.kind === "machine";
              const partition =
                HUB_PARTITIONS[Math.max(0, hubPartition(e.to.kind))];
              const direction = isHub
                ? partition.direction
                : branchDirection(nodes, e.from);
              const hubAnchors = {
                tooling: { x: 0, y: 105 },
                motion: { x: 360, y: 105 },
                hardware: { x: 90, y: 236 },
                safety: { x: 360, y: 192 },
              };
              const source = isHub
                ? {
                    x:
                      e.from.x +
                      hubAnchors[partition.id as keyof typeof hubAnchors].x,
                    y:
                      e.from.y +
                      hubAnchors[partition.id as keyof typeof hubAnchors].y,
                  }
                : direction === "right"
                  ? { x: e.from.x + 210, y: e.from.y + 38 }
                  : direction === "left"
                    ? { x: e.from.x, y: e.from.y + 38 }
                    : { x: e.from.x + 105, y: e.from.y + 76 };
              const target =
                direction === "right"
                  ? { x: e.to.x - 1, y: e.to.y + 38 }
                  : direction === "left"
                    ? { x: e.to.x + 211, y: e.to.y + 38 }
                    : { x: e.to.x + 105, y: e.to.y - 1 };
              const vector =
                direction === "right"
                  ? { x: 90, y: 0 }
                  : direction === "left"
                    ? { x: -90, y: 0 }
                    : { x: 0, y: 90 };
              return (
                <path
                  key={e.to.id}
                  d={`M${source.x},${source.y} C${source.x + vector.x},${source.y + vector.y} ${target.x - vector.x},${target.y - vector.y} ${target.x},${target.y}`}
                  fill="none"
                  stroke={e.to.color}
                  strokeOpacity=".42"
                  strokeWidth="2"
                />
              );
            })}
            {pendingPlacement &&
              (() => {
                const machine = nodes.find((node) => node.kind === "machine");
                if (!machine) return null;
                const partition =
                  HUB_PARTITIONS[
                    Math.max(0, hubPartition(pendingPlacement.kind))
                  ];
                const anchors = {
                  tooling: { x: 0, y: 105 },
                  motion: { x: 360, y: 105 },
                  hardware: { x: 90, y: 236 },
                  safety: { x: 360, y: 192 },
                };
                const anchor = anchors[partition.id as keyof typeof anchors];
                const source = {
                  x: machine.x + anchor.x,
                  y: machine.y + anchor.y,
                };
                const direction = partition.direction;
                const target =
                  direction === "right"
                    ? {
                        x: pendingPlacement.position.x,
                        y: pendingPlacement.position.y + 38,
                      }
                    : direction === "left"
                      ? {
                          x: pendingPlacement.position.x + 210,
                          y: pendingPlacement.position.y + 38,
                        }
                      : {
                          x: pendingPlacement.position.x + 105,
                          y: pendingPlacement.position.y,
                        };
                const vector =
                  direction === "right"
                    ? { x: 90, y: 0 }
                    : direction === "left"
                      ? { x: -90, y: 0 }
                      : { x: 0, y: 90 };
                return (
                  <path
                    d={`M${source.x},${source.y} C${source.x + vector.x},${source.y + vector.y} ${target.x - vector.x},${target.y - vector.y} ${target.x},${target.y}`}
                    fill="none"
                    stroke={COLORS[pendingPlacement.kind]}
                    strokeOpacity=".65"
                    strokeWidth="2"
                    strokeDasharray="5 4"
                  />
                );
              })()}
          </svg>
          {nodes.map((n) =>
            n.kind === "machine" ? (
              <MachineHub
                key={n.id}
                node={n}
                nodes={nodes}
                selected={selected === n.id}
                zoom={zoom}
                onSelect={() => setSelected(n.id)}
                onDrag={(value) => {
                  recordHistory();
                  drag.current = value;
                }}
                onAdd={add}
              />
            ) : (
              <GraphNode
                key={n.id}
                node={n}
                selected={selected === n.id}
                zoom={zoom}
                onSelect={() => setSelected(n.id)}
                onDrag={(value) => {
                  recordHistory();
                  drag.current = value;
                }}
                onAdd={addChild}
                inputSide={
                  (
                    {
                      right: "left",
                      left: "right",
                      top: "bottom",
                      bottom: "top",
                    } as const
                  )[branchDirection(nodes, n)]
                }
              />
            ),
          )}
          {pendingPlacement && (
            <div
              className="pointer-events-none absolute h-[76px] w-[210px] rounded-lg border border-dashed studio-node shadow-2xl"
              style={{
                left: pendingPlacement.position.x,
                top: pendingPlacement.position.y,
                borderColor: COLORS[pendingPlacement.kind],
              }}
            >
              <span
                className="block h-1 rounded-t-lg"
                style={{ background: COLORS[pendingPlacement.kind] }}
              />
              <span className="flex h-[72px] items-center gap-3 p-3">
                <span
                  className="flex h-8 w-8 items-center justify-center rounded-md studio-icon-well"
                  style={{ color: COLORS[pendingPlacement.kind] }}
                >
                  <Plus size={16} />
                </span>
                <span>
                  <span className="block text-xs font-semibold">
                    {pendingPlacement.title}
                  </span>
                  <span className="block text-[10px] studio-muted">
                    Click or tap to place
                  </span>
                </span>
              </span>
            </div>
          )}
        </div>
        {pendingPlacement ? (
          <div
            className="absolute bottom-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-3 rounded-md border px-3 py-2 text-xs shadow-xl"
            style={{
              borderColor: COLORS[pendingPlacement.kind],
              background: "var(--studio-panel)",
            }}
          >
            <span>
              Click or tap the canvas to place <b>{pendingPlacement.title}</b>
            </span>
            <button
              onClick={() => setPendingPlacement(null)}
              className="rounded border studio-border px-2 py-1 text-[#9aa6b8] hover:text-white"
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="absolute bottom-3 left-3 rounded border studio-border studio-panel px-2.5 py-1.5 text-[10px] text-[#69768a]">
            Drag canvas to pan · Scroll to zoom · Select a node to configure
          </div>
        )}
      </section>
      <aside className="z-20 w-[320px] shrink-0 border-l studio-border studio-panel">
        {active ? (
          <>
            <div className="flex items-center gap-3 border-b studio-border p-4">
              <span
                className="flex h-9 w-9 items-center justify-center rounded-md studio-icon-well"
                style={{ color: active.color }}
              >
                <SlidersHorizontal size={17} />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold">
                  {active.title}
                </span>
                <span className="block text-[10px] uppercase tracking-widest studio-muted">
                  {active.kind} node
                </span>
              </span>
              {active.kind !== "machine" && (
                <button
                  onClick={remove}
                  className="ml-auto rounded p-1.5 text-[#7c6370] hover:bg-red-500/10 hover:text-red-400"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
            <div className="border-b studio-border p-3">
              <label className="flex items-center gap-2 rounded-md border studio-border studio-input px-3 py-2.5 focus-within:border-blue-500/50">
                <Search size={15} className="shrink-0 text-[#707d90]" />
                <input
                  value={propertyQuery}
                  onChange={(e) => setPropertyQuery(e.target.value)}
                  placeholder="Search properties…"
                  aria-label="Search properties"
                  className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[#657185]"
                />
              </label>
            </div>
            <div className="h-[calc(100%-129px)] overflow-auto p-4">
              {mutationError && (
                <div className="mb-3 rounded-md border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                  {mutationError}
                </div>
              )}
              <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-[#707d90]">
                Properties
              </div>
              <div className="space-y-3">
                {propertyFields
                  .filter(
                    (f) =>
                      !propertyQuery ||
                      `${f.label} ${f.key}`
                        .toLowerCase()
                        .includes(propertyQuery.toLowerCase()),
                  )
                  .map((f) => (
                    <label key={f.key} className="block" title={f.description}>
                      <span className="studio-property-label mb-1.5 flex text-[13px] font-medium">
                        <span>{f.label}</span>
                        {f.unit && (
                          <span className="studio-property-unit ml-auto">
                            {f.unit}
                          </span>
                        )}
                      </span>
                      {f.type === "pin" ? (
                        <PinEditor
                          value={active.fields[f.key] ?? "NO_PIN"}
                          onChange={(v) => update(f.key, v)}
                          hasI2so={hasI2so}
                          uartChannels={uartChannels}
                        />
                      ) : f.type === "boolean" ? (
                        <button
                          onClick={() =>
                            update(
                              f.key,
                              active.fields[f.key] === "true"
                                ? "false"
                                : "true",
                            )
                          }
                          className={`studio-boolean-toggle flex w-full items-center justify-between rounded-md border px-2.5 py-2 text-xs ${active.fields[f.key] === "true" ? "studio-boolean-toggle-on" : ""}`}
                        >
                          <span>
                            {active.fields[f.key] === "true"
                              ? "Enabled"
                              : "Disabled"}
                          </span>
                          <span
                            className="studio-boolean-track h-4 w-7 rounded-full p-0.5"
                          >
                            <span
                              className={`block h-3 w-3 rounded-full bg-white transition-transform ${active.fields[f.key] === "true" ? "translate-x-3" : ""}`}
                            />
                          </span>
                        </button>
                      ) : f.options ? (
                        <select
                          value={active.fields[f.key]}
                          onChange={(e) => update(f.key, e.target.value)}
                          className="w-full rounded-md border studio-border studio-input px-2.5 py-2 text-xs outline-none"
                        >
                          {f.options.map((o) => (
                            <option key={o}>{o}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type={f.type === "number" ? "number" : "text"}
                          min={f.min}
                          max={f.max}
                          value={active.fields[f.key] ?? ""}
                          onChange={(e) => update(f.key, e.target.value)}
                          className="w-full rounded-md border studio-border studio-input px-2.5 py-2 font-mono text-xs outline-none"
                        />
                      )}
                    </label>
                  ))}
              </div>
            </div>
          </>
        ) : (
          <div className="p-5 text-xs text-[#758195]">
            Select a node to inspect it.
          </div>
        )}
      </aside>
    </div>
  );
}

export function yamlPathForNode(
  node: NodeData,
  nodes: NodeData[],
): string | null {
  if (node.kind === "stepping" || node.kind === "axes") return node.kind;
  if (node.kind === "axis") return `axes.${node.yamlKey ?? node.fields.axis}`;
  if (node.kind === "motor" || node.kind === "driver") {
    const motor =
      node.kind === "motor"
        ? node
        : nodes.find((candidate) => candidate.id === node.parentId);
    if (!motor) return null;
    const axis = nodes.find((candidate) => candidate.id === motor.parentId);
    if (!axis) return null;
    const base = `axes.${axis.yamlKey ?? axis.fields.axis}.${motor.yamlKey ?? "motor0"}`;
    return node.kind === "driver"
      ? `${base}.${node.yamlKey ?? node.fields.type}`
      : base;
  }
  const roots: Partial<Record<NodeKind, string>> = {
    control: "control",
    probe: "probe",
    coolant: "coolant",
    macro: "macros",
    start: "start",
    parking: "parking",
    display: "oled",
    atc: "atc_manual",
    storage: "sdcard",
  };
  if (node.kind === "kinematics") return node.yamlKey ?? "kinematics";
  if (roots[node.kind]) return node.yamlKey ?? roots[node.kind]!;
  if (node.kind === "bus") return node.yamlKey ?? node.fields.type ?? "uart1";
  if (node.kind === "spindle") return node.yamlKey ?? node.fields.type ?? "PWM";
  if (node.kind === "io")
    return node.title.toLowerCase().includes("input")
      ? "user_inputs"
      : "user_outputs";
  return null;
}

function yamlPathEquals(left: string, right: string) {
  return left.toLowerCase() === right.toLowerCase();
}

function yamlLineEnding(source: string) {
  return source.includes("\r\n") ? "\r\n" : source.includes("\r") ? "\r" : "\n";
}

function splitYamlLines(source: string) {
  return source.split(/\r\n|\n|\r/);
}

function joinYamlLines(lines: string[], source: string) {
  return lines.join(yamlLineEnding(source));
}

function insertNodeYaml(source: string, node: NodeData, nodes: NodeData[]) {
  const path = yamlPathForNode(node, nodes);
  if (!path) return source;
  if (yamlEntries(source).some((entry) => yamlPathEquals(entry.path, path)))
    return source;
  const generated = contentFromNodes(nodes, "");
  const generatedLines = splitYamlLines(generated),
    generatedIndex = yamlEntries(generated),
    target = generatedIndex.find((entry) => yamlPathEquals(entry.path, path));
  let block: string[];
  if (target) {
    let end = target.line + 1;
    while (end < generatedLines.length) {
      const indent = generatedLines[end].match(/^\s*/)?.[0].length ?? 0;
      if (generatedLines[end].trim() && indent <= target.indent) break;
      end++;
    }
    block = generatedLines
      .slice(target.line, end)
      .filter((line, index) => index === 0 || line.trim());
  } else {
    const key = path.slice(path.lastIndexOf(".") + 1);
    block = [`${key}:`];
  }
  const parentPath = path.includes(".")
      ? path.slice(0, path.lastIndexOf("."))
      : "",
    baseLines = splitYamlLines(source),
    baseIndex = yamlEntries(source),
    parent = baseIndex.find((entry) => yamlPathEquals(entry.path, parentPath));
  if (!parent) {
    const eol = yamlLineEnding(source);
    return `${source.replace(/\s*$/, "")}${eol}${eol}${block.map((line) => line.slice(target?.indent ?? 0)).join(eol)}${eol}`;
  }
  let insertAt = parent.line + 1;
  while (insertAt < baseLines.length) {
    const indent = baseLines[insertAt].match(/^\s*/)?.[0].length ?? 0;
    if (baseLines[insertAt].trim() && indent <= parent.indent) break;
    insertAt++;
  }
  const sourceIndent = target?.indent ?? 0,
    targetIndent = parent.indent + 2;
  block = block.map(
    (line) => `${" ".repeat(targetIndent)}${line.slice(sourceIndent)}`,
  );
  baseLines.splice(insertAt, 0, ...block);
  return joinYamlLines(baseLines, source);
}

function removeNodeYaml(source: string, node: NodeData, nodes: NodeData[]) {
  const path = yamlPathForNode(node, nodes);
  if (!path) return source;
  const lines = splitYamlLines(source),
    target = yamlEntries(source).find((entry) =>
      yamlPathEquals(entry.path, path),
    );
  if (!target) return source;
  let end = target.line + 1;
  while (end < lines.length) {
    const indent = lines[end].match(/^\s*/)?.[0].length ?? 0;
    if (lines[end].trim() && indent <= target.indent) break;
    end++;
  }
  let start = target.line;
  if (target.indent === 0 && start > 0 && !lines[start - 1].trim()) start--;
  lines.splice(start, end - start);
  return joinYamlLines(lines, source);
}

export function yamlPathForField(
  node: NodeData,
  key: string,
  nodes: NodeData[],
): string | null {
  if (node.kind === "machine") return key;
  if (node.kind === "stepping") return `stepping.${key}`;
  if (node.kind === "axes") return `axes.${key}`;
  if (node.kind === "axis") {
    const axis = node.yamlKey ?? node.fields.axis;
    const homing: Record<string, string> = {
      homing_cycle: "cycle",
      homing_positive: "positive_direction",
      homing_mpos_mm: "mpos_mm",
    };
    return homing[key]
      ? `axes.${axis}.homing.${homing[key]}`
      : key === "axis"
        ? null
        : `axes.${axis}.${key}`;
  }
  if (node.kind === "motor" || node.kind === "driver") {
    const motor =
      node.kind === "motor"
        ? node
        : nodes.find((candidate) => candidate.id === node.parentId);
    if (!motor) return null;
    const axis = nodes.find((candidate) => candidate.id === motor.parentId);
    if (!axis) return null;
    const base = `axes.${axis.yamlKey ?? axis.fields.axis}.${motor.yamlKey ?? "motor0"}`;
    if (node.kind === "motor") return `${base}.${key}`;
    if (key === "type") return null;
    return `${base}.${node.yamlKey ?? node.fields.type}.${key}`;
  }
  const sections: Partial<Record<NodeKind, string>> = {
    control: "control",
    probe: "probe",
    coolant: "coolant",
    macro: "macros",
    start: "start",
    parking: "parking",
    display: "oled",
    atc: "atc_manual",
    storage: "sdcard",
  };
  if (node.kind === "kinematics")
    return key === "type"
      ? null
      : `${node.yamlKey ?? "kinematics"}.${node.yamlTypeKey ?? node.fields.type}.${key}`;
  if (sections[node.kind])
    return `${node.yamlKey ?? sections[node.kind]}.${key}`;
  if (node.kind === "bus")
    return key === "type" ? null : `${node.yamlKey ?? node.fields.type}.${key}`;
  if (node.kind === "spindle")
    return key === "type" ? null : `${node.yamlKey ?? node.fields.type}.${key}`;
  if (node.kind === "io")
    return `${node.title.toLowerCase().includes("input") ? "user_inputs" : "user_outputs"}.${key}`;
  return null;
}

function renameYamlKey(source: string, path: string, nextKey: string) {
  if (!nextKey || /[:#\s]/.test(nextKey)) return null;
  const entries = yamlEntries(source);
  const existing = entries.find((entry) => yamlPathEquals(entry.path, path));
  if (!existing) return null;
  const parentPath = path.includes(".")
    ? path.slice(0, path.lastIndexOf("."))
    : "";
  const nextPath = parentPath ? `${parentPath}.${nextKey}` : nextKey;
  if (
    !yamlPathEquals(nextPath, path) &&
    entries.some((entry) => yamlPathEquals(entry.path, nextPath))
  )
    return null;
  const lines = splitYamlLines(source);
  lines[existing.line] = lines[existing.line].replace(
    /^(\s*)[^:#]+:/,
    `$1${nextKey}:`,
  );
  return joinYamlLines(lines, source);
}

export function formatYamlScalar(
  value: string,
  oldValue: string,
  path: string,
  fieldType?: FieldDef["type"],
) {
  if (!value) return "";
  if (
    /(^|\.)(macros\.(?:startup_line\d+|macro\d+|after_(?:homing|reset|unlock))|m6_macro)$/i.test(
      path,
    )
  )
    return value;
  const leaf = path.slice(path.lastIndexOf(".") + 1);
  const mustDoubleQuote = /^(?:passthrough_)?mode$/i.test(leaf);
  const fieldDefinition = Object.values(FIELDS)
    .flat()
    .find((field) => field.key.toLowerCase() === leaf.toLowerCase());
  const type = fieldType ?? fieldDefinition?.type;
  const numericToken = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
  if (
    /^(?:true|false)$/i.test(value) &&
    (type === "boolean" ||
      (fieldType === undefined && /^(?:true|false)$/i.test(oldValue)))
  )
    return value.toLowerCase();
  if (
    numericToken.test(value) &&
    (type === "number" ||
      (fieldType === undefined && numericToken.test(oldValue)))
  )
    return value;
  const looksAmbiguous =
    value.trim() !== value ||
    value.includes(":") ||
    value.includes("#") ||
    /^(?:true|false|null|~|-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)$/i.test(
      value,
    ) ||
    /^[{[|>?*&#%!@`-]/.test(value);
  const existingQuote = oldValue.match(/^(['"]).*\1$/)?.[1];
  const quote = mustDoubleQuote ? '"' : existingQuote;
  if (quote && !value.includes(quote)) return `${quote}${value}${quote}`;
  if ((mustDoubleQuote || looksAmbiguous) && !value.includes('"'))
    return `"${value}"`;
  // FluidNC does not implement general YAML escaping. If double quotes cannot
  // safely represent the scalar, retain its plain spelling instead of emitting
  // single-quote/escape syntax that FluidNC itself may not understand.
  return value;
}

export function patchYamlValue(
  source: string,
  path: string,
  value: string,
  fieldType?: FieldDef["type"],
): string | null {
  const lines = splitYamlLines(source),
    entries = yamlEntries(source),
    existing = entries.find((entry) => yamlPathEquals(entry.path, path));
  if (existing) {
    const old = existing.value;
    const formatted = formatYamlScalar(value, old, path, fieldType);
    lines[existing.line] =
      `${" ".repeat(existing.indent)}${existing.key}: ${formatted}`;
    return joinYamlLines(lines, source);
  }
  const parentPath = path.includes(".")
      ? path.slice(0, path.lastIndexOf("."))
      : "",
    key = path.slice(path.lastIndexOf(".") + 1),
    parent = entries.find((entry) => yamlPathEquals(entry.path, parentPath));
  if (!parent) return null;
  let insertAt = parent.line + 1;
  while (insertAt < lines.length) {
    const indent = lines[insertAt].match(/^\s*/)?.[0].length ?? 0;
    if (lines[insertAt].trim() && indent <= parent.indent) break;
    insertAt++;
  }
  const formatted = formatYamlScalar(value, "", path, fieldType);
  lines.splice(
    insertAt,
    0,
    `${" ".repeat(parent.indent + 2)}${key}:${formatted ? ` ${formatted}` : ""}`,
  );
  return joinYamlLines(lines, source);
}

function contentFromNodes(nodes: NodeData[], baseSource = "") {
  const out: string[] = ["# Generated by FigUI Config Studio"];
  const machine = nodes.find((n) => n.kind === "machine");
  if (machine) {
    out.push(
      `name: ${formatYamlScalar(machine.fields.name, "", "name")}`,
      `board: ${formatYamlScalar(machine.fields.board, "", "board")}`,
    );
    if (machine.fields.meta)
      out.push(`meta: ${formatYamlScalar(machine.fields.meta, "", "meta")}`);
  }
  const stepping = nodes.find((n) => n.kind === "stepping");
  if (stepping) {
    out.push(
      "",
      "stepping:",
      ...FIELDS.stepping
        .filter((f) => stepping.fields[f.key])
        .map(
          (f) =>
            `  ${f.key}: ${formatYamlScalar(stepping.fields[f.key], "", `stepping.${f.key}`)}`,
        ),
    );
  }
  const axes = nodes.filter((n) => n.kind === "axis");
  if (axes.length) {
    out.push("", "axes:");
    for (const a of axes) {
      out.push(`  ${a.yamlKey ?? a.fields.axis}:`);
      for (const f of FIELDS.axis.filter(
        (f) =>
          !f.key.startsWith("motor") &&
          ![
            "axis",
            "homing_cycle",
            "homing_positive",
            "homing_mpos_mm",
          ].includes(f.key) &&
          a.fields[f.key],
      ))
        out.push(`    ${f.key}: ${a.fields[f.key]}`);
      if (a.fields.homing_cycle) {
        out.push(
          "    homing:",
          `      cycle: ${a.fields.homing_cycle}`,
          `      positive_direction: ${a.fields.homing_positive}`,
          `      mpos_mm: ${a.fields.homing_mpos_mm || 0}`,
        );
      }
      const motors = nodes.filter(
        (n) => n.kind === "motor" && n.parentId === a.id,
      );
      motors.forEach((motor, index) => {
        out.push(`    ${motor.yamlKey ?? `motor${index}`}:`);
        for (const key of [
          "limit_neg_pin",
          "limit_pos_pin",
          "limit_all_pin",
          "hard_limits",
          "pulloff_mm",
        ]) {
          const value = motor.fields[key];
          if (value && value !== "NO_PIN" && value !== "false")
            out.push(`      ${key}: ${value}`);
        }
        const driverNode = nodes.find(
          (n) => n.kind === "driver" && n.parentId === motor.id,
        );
        const driver =
          driverNode?.yamlKey ||
          driverNode?.fields.type ||
          motor.fields.driver ||
          "stepstick";
        out.push(`      ${driver}:`);
        const driverFields = driverNode?.fields ?? motor.fields;
        const definitions = driverNode ? FIELDS.driver : FIELDS.motor;
        for (const f of definitions.filter(
          (f) => f.key !== "type" && f.key !== "driver",
        )) {
          const value = driverFields[f.key];
          if (value && value !== "NO_PIN" && value !== "false")
            out.push(`        ${f.key}: ${value}`);
        }
        for (const key of ["step_pin", "direction_pin"])
          if (!driverFields[key] || driverFields[key] === "NO_PIN")
            out.push(`        ${key}: NO_PIN`);
      });
    }
  }
  const simple: Partial<Record<NodeKind, string>> = {
    control: "control",
    probe: "probe",
    coolant: "coolant",
    macro: "macros",
    start: "start",
    parking: "parking",
    display: "oled",
    atc: "atc_manual",
    storage: "sdcard",
  };
  for (const n of nodes) {
    if (n.kind === "kinematics") {
      const type = n.fields.type || "Cartesian";
      const fields = Object.keys(n.fields).filter(
        (key) => key !== "type" && n.fields[key] !== "",
      );
      out.push(
        "",
        `${n.yamlKey ?? "kinematics"}:`,
        `  ${n.yamlTypeKey ?? type}:`,
        ...fields.map(
          (key) =>
            `    ${key}: ${formatYamlScalar(n.fields[key], "", `kinematics.${type}.${key}`)}`,
        ),
      );
    }
    const section = simple[n.kind];
    if (section) {
      const sectionLines =
        n.kind === "macro"
          ? FIELDS.macro.map(
              (f) =>
                `  ${f.key}:${n.fields[f.key] ? ` ${n.fields[f.key]}` : ""}`,
            )
          : FIELDS[n.kind]
              .filter((f) => n.fields[f.key] && n.fields[f.key] !== "false")
              .map((f) => `  ${f.key}: ${n.fields[f.key]}`);
      out.push("", `${n.yamlKey ?? section}:`, ...sectionLines);
    }
    if (n.kind === "bus") {
      const type = n.fields.type || "uart1";
      out.push(
        "",
        `${type}:`,
        ...FIELDS.bus
          .filter(
            (f) =>
              f.key !== "type" &&
              n.fields[f.key] &&
              n.fields[f.key] !== "NO_PIN",
          )
          .map(
            (f) =>
              `  ${f.key}: ${formatYamlScalar(n.fields[f.key], "", `${type}.${f.key}`)}`,
          ),
      );
    }
    if (n.kind === "spindle") {
      const type = n.fields.type || "PWM";
      out.push(
        "",
        `${type}:`,
        ...FIELDS.spindle
          .filter(
            (f) =>
              f.key !== "type" &&
              n.fields[f.key] &&
              n.fields[f.key] !== "NO_PIN",
          )
          .map((f) => `  ${f.key}: ${n.fields[f.key]}`),
      );
    }
    if (n.kind === "io") {
      out.push(
        "",
        `${n.title.toLowerCase().includes("input") ? "user_inputs" : "user_outputs"}:`,
        ...FIELDS.io
          .filter((f) => n.fields[f.key] && n.fields[f.key] !== "NO_PIN")
          .map((f) => `  ${f.key}: ${n.fields[f.key]}`),
      );
    }
  }
  let yaml = out.join("\n") + "\n";
  const axesGroup = nodes.find((n) => n.kind === "axes");
  const sharedDisable = axesGroup?.fields.shared_stepper_disable_pin;
  if (sharedDisable && sharedDisable !== "NO_PIN")
    yaml = yaml.replace(
      "axes:\n",
      `axes:\n  shared_stepper_disable_pin: ${sharedDisable}\n`,
    );
  return mergeGraphYaml(baseSource, yaml);
}

function mergeGraphYaml(baseSource: string, generatedSource: string) {
  if (!baseSource.trim()) return generatedSource;
  let lines = splitYamlLines(baseSource);
  for (const entry of yamlEntries(generatedSource)) {
    let index = yamlEntries(joinYamlLines(lines, baseSource));
    const existing = index.find((item) =>
      yamlPathEquals(item.path, entry.path),
    );
    if (existing && entry.hasValue) {
      lines[existing.line] =
        `${" ".repeat(existing.indent)}${entry.key}: ${entry.value}`;
      continue;
    }
    if (existing) continue;
    const parentPath = entry.path.includes(".")
      ? entry.path.slice(0, entry.path.lastIndexOf("."))
      : "";
    index = yamlEntries(joinYamlLines(lines, baseSource));
    const parent = index.find((item) => yamlPathEquals(item.path, parentPath));
    const indent = parent ? parent.indent + 2 : 0;
    let insertAt = lines.length;
    if (parent) {
      insertAt = parent.line + 1;
      while (insertAt < lines.length) {
        const currentIndent = lines[insertAt].match(/^\s*/)?.[0].length ?? 0;
        if (lines[insertAt].trim() && currentIndent <= parent.indent) break;
        insertAt++;
      }
    }
    lines.splice(
      insertAt,
      0,
      `${" ".repeat(indent)}${entry.key}:${entry.hasValue ? ` ${entry.value}` : ""}`,
    );
  }
  return joinYamlLines(lines, baseSource);
}

export function yamlEntries(source: string) {
  const result: {
      path: string;
      key: string;
      value: string;
      hasValue: boolean;
      indent: number;
      line: number;
    }[] = [],
    stack: { indent: number; key: string }[] = [];
  splitYamlLines(source).forEach((raw, line) => {
    if (!raw.trim() || raw.trimStart().startsWith("#")) return;
    const match = raw.match(/^(\s*)([^:#]+):(?:\s*(.*))?$/);
    if (!match) return;
    const indent = match[1].length,
      key = match[2].trim(),
      value = (match[3] ?? "").trim();
    while (stack.length && stack[stack.length - 1].indent >= indent)
      stack.pop();
    const path = [...stack.map((item) => item.key), key].join(".");
    result.push({ path, key, value, hasValue: value.length > 0, indent, line });
    if (!value) stack.push({ indent, key });
  });
  return result;
}
