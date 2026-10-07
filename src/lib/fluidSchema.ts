// FluidNC's config item reference, generated from the firmware source's
// // @config annotations (tools/build_config_docs.py) and committed beside
// config_items.yaml. It replaces the retired hand-maintained
// tools/fluidnc-config-schema.json: the validation schema is now built from
// it here, mirroring FluidNC's tools/config_schema_adapter.py.
const CONFIG_ITEMS_URL = (ref: string) =>
  `https://raw.githubusercontent.com/bdring/FluidNC/${ref}/FluidNC/docs/config_items.json`;
const CACHE_KEY_PREFIX = "fluidui.fluidnc-config-items.v2:";
const LEGACY_CACHE_KEY = "fluidui.fluidnc-schema.v1";
const MAX_CONFIG_ITEMS_BYTES = 1_000_000;
const FALLBACK_REF = "main";

export type ConfigItem = {
  type?: string;
  min?: number;
  max?: number;
  values?: unknown[];
  default?: unknown;
  unit?: string;
  description?: string;
};

export type ConfigSection = Record<string, ConfigItem> | null;

export type ConfigItems = {
  [section: string]: unknown;
  section_meta?: Record<
    string,
    { repeatable?: boolean; key_pattern?: string; child_types?: string[] }
  >;
  pin_namespaces?: Record<string, { pattern: string }>;
  vfd_named_types?: string[];
  vfd_protocol_fields?: string[];
};

export type FluidSchema = {
  [key: string]: unknown;
  $defs?: Record<string, SchemaNode>;
};

export type SchemaNode = {
  $ref?: string;
  type?: string | string[];
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  pattern?: string;
  description?: string;
  properties?: Record<string, SchemaNode>;
  patternProperties?: Record<string, SchemaNode>;
  additionalProperties?: boolean | SchemaNode;
  maxProperties?: number;
  required?: string[];
  oneOf?: SchemaNode[];
  allOf?: SchemaNode[];
  not?: SchemaNode;
};

export type FluidConfig = {
  items: ConfigItems;
  schema: FluidSchema;
};

export type FluidConfigResult = {
  config: FluidConfig | null;
  online: boolean;
};

// --- schema builder: a port of FluidNC's tools/config_schema_adapter.py ----
// Keep in step with that file. Differences are deliberate: patterns carry no
// inline (?i:...) groups (the validator compiles every pattern with the "i"
// flag), and field descriptions are kept for the property editor.

const AXIS_LETTERS = ["x", "y", "z", "a", "b", "c", "u", "v", "w"];
const PIN_ATTR_SUFFIX = "(?::(?:high|low|pu|pd|ds[0-3]))*";
const PRIMITIVE_DEFS: Record<string, SchemaNode> = {
  boolean: { type: "boolean" },
  uartData: { type: "string", pattern: "^[5-8][NnEeOo][12]$" },
  floatArray: {
    type: "string",
    pattern: "^-?[0-9]+(\\.[0-9]+)?(\\s+-?[0-9]+(\\.[0-9]+)?)*$",
  },
  speedMap: {
    type: "string",
    pattern:
      "^[0-9]+=[0-9]+(\\.[0-9]+)?%?(\\s+[0-9]+=[0-9]+(\\.[0-9]+)?%?)*$",
  },
  macroLine: { type: ["string", "null"] },
};
const REF_TYPES: Record<string, string> = {
  boolean: "boolean",
  pin: "pinAny",
  uart_mode: "uartData",
  "std::vector<float>": "floatArray",
  "std::vector<Configuration::speedEntry>": "speedMap",
  macro: "macroLine",
};
const META_KEYS = new Set([
  "enum_types",
  "spindle_sections",
  "vfd_protocol_fields",
  "vfd_named_types",
  "pin_namespaces",
  "section_meta",
]);
const TOP_LEVEL_ITEMS = "(top-level machine items)";
export const MOTOR_DRIVER_PREFIX = "axes.<letter>.motorN.";

function pinAny(namespaces: ConfigItems["pin_namespaces"] = {}): SchemaNode {
  const alts = ["no_pin", "void", "gpio\\.[0-9]+"];
  for (const key of Object.keys(namespaces).sort())
    alts.push(namespaces[key].pattern);
  return {
    type: "string",
    pattern: `^(?:${alts.join("|")})${PIN_ATTR_SUFFIX}$`,
  };
}

function fieldSchema(field: ConfigItem): SchemaNode {
  const t = field.type;
  let node: SchemaNode;
  if (t === "integer" || t === "float") {
    node = { type: t === "integer" ? "integer" : "number" };
    if (field.min != null) node.minimum = field.min;
    if (field.max != null) node.maximum = field.max;
  } else if (t === "enum") {
    const values = [...(field.values ?? [])];
    node = { enum: values };
    if (values.every((v) => typeof v === "string")) node.type = "string";
    else if (values.every((v) => typeof v === "number" && Number.isInteger(v)))
      node.type = "integer";
  } else if (t === "axis") {
    node = { type: "string", enum: [...AXIS_LETTERS] };
  } else if (t && REF_TYPES[t]) {
    node = { $ref: `#/$defs/${REF_TYPES[t]}` };
  } else {
    node = { type: "string" };
  }
  if (field.description) node.description = field.description.trim();
  return node;
}

function objectSchema(fields: ConfigSection | undefined) {
  const properties: Record<string, SchemaNode> = {};
  for (const [name, field] of Object.entries(fields ?? {}))
    properties[name] = fieldSchema(field);
  return {
    type: ["object", "null"],
    additionalProperties: false,
    properties,
  } satisfies SchemaNode;
}

export function buildFluidSchema(items: ConfigItems): FluidSchema {
  const sections: Record<string, ConfigSection> = {};
  for (const [key, value] of Object.entries(items))
    if (!META_KEYS.has(key)) sections[key] = value as ConfigSection;
  const sectionMeta = items.section_meta ?? {};
  const vfdProtocolFields = new Set(items.vfd_protocol_fields ?? []);
  const keyRe = (path: string) => `^${sectionMeta[path]?.key_pattern ?? ""}$`;
  const sorted = (keys: string[]) => [...keys].sort();

  const defs: Record<string, SchemaNode> = {
    ...PRIMITIVE_DEFS,
    pinAny: pinAny(items.pin_namespaces),
  };

  // --- axes: group fields + per-letter blocks ---
  const driverSections = sorted(
    Object.keys(sections).filter((k) => k.startsWith(MOTOR_DRIVER_PREFIX)),
  );
  const motorBlock: SchemaNode = objectSchema(sections["axes.<letter>.motorN"]);
  const driverKeys = driverSections.map((path) => path.split(".").pop()!);
  driverSections.forEach((path, i) => {
    motorBlock.properties![driverKeys[i]] = objectSchema(sections[path]);
  });
  // A motorN block selects exactly one driver type (GenericFactory).
  motorBlock.oneOf = driverKeys.map((key) => ({ required: [key] }));

  const axisLetter: SchemaNode = objectSchema(sections["axes.<letter>"]);
  axisLetter.properties!.homing = objectSchema(sections["axes.<letter>.homing"]);
  axisLetter.patternProperties = {
    [keyRe("axes.<letter>.motorN")]: motorBlock,
  };
  const axes: SchemaNode = objectSchema(sections.axes);
  axes.patternProperties = { [keyRe("axes.<letter>")]: axisLetter };

  // --- kinematics: at most one type block ---
  const kinematics: SchemaNode = {
    type: ["object", "null"],
    additionalProperties: false,
    maxProperties: 1,
    properties: Object.fromEntries(
      sorted(Object.keys(sections))
        .filter((k) => k.startsWith("kinematics."))
        .map((k) => [k.split(".").slice(1).join("."), objectSchema(sections[k])]),
    ),
  };

  // --- extenders: pinextenderN -> {chip: fields} ---
  const chipFields = sections["extenders.pinextenderN.<i2c_chip>"];
  const childTypes =
    sectionMeta["extenders.pinextenderN.<i2c_chip>"]?.child_types ?? [];
  const extenders: SchemaNode = {
    type: ["object", "null"],
    additionalProperties: false,
    patternProperties: {
      [keyRe("extenders.pinextenderN")]: {
        type: ["object", "null"],
        additionalProperties: false,
        maxProperties: 1,
        properties: Object.fromEntries(
          childTypes.map((chip) => [chip, objectSchema(chipFields)]),
        ),
      },
    },
  };

  // --- root properties ---
  const props: Record<string, SchemaNode> = {};
  for (const [name, field] of Object.entries(sections[TOP_LEVEL_ITEMS] ?? {}))
    // `meta` is loose on purpose: real configs put a bare date there.
    props[name] =
      name === "meta"
        ? { type: ["string", "number", "boolean", "null"] }
        : fieldSchema(field);

  const nested: Record<string, SchemaNode> = { axes, kinematics, extenders };
  const nestedPrefixes = ["axes.", "kinematics.", "extenders."];
  const numbered = new Set(["uartN", "uart_channelN", "i2cN"]);

  const subsections: Record<string, Record<string, SchemaNode>> = {};
  for (const [key, body] of Object.entries(sections)) {
    if (!key.includes(".") || nestedPrefixes.some((p) => key.startsWith(p)))
      continue;
    const dot = key.lastIndexOf(".");
    const parent = key.slice(0, dot),
      sub = key.slice(dot + 1);
    if (parent in sections && !sub.includes("<") && !sub.endsWith("N"))
      (subsections[parent] ??= {})[sub] = objectSchema(body);
  }

  const patternProps: Record<string, SchemaNode> = {};
  for (const [key, body] of Object.entries(sections)) {
    if (key === TOP_LEVEL_ITEMS || key in nested) continue;
    if (nestedPrefixes.some((p) => key.startsWith(p))) continue;
    if (key.includes(".") && key.slice(0, key.lastIndexOf(".")) in sections)
      continue;
    const obj: SchemaNode = objectSchema(body);
    Object.assign(obj.properties!, subsections[key] ?? {});
    if (numbered.has(key)) patternProps[keyRe(key)] = obj;
    else props[key] = obj;
  }
  Object.assign(props, nested);

  const modbusFields = sections.ModbusVFD ?? {};
  for (const name of items.vfd_named_types ?? [])
    props[name] = objectSchema(
      Object.fromEntries(
        Object.entries(modbusFields).filter(([k]) => !vfdProtocolFields.has(k)),
      ),
    );

  return {
    type: "object",
    properties: props,
    patternProperties: patternProps,
    additionalProperties: false,
    $defs: defs,
  };
}

// --- loading ------------------------------------------------------------

/** The git ref whose config_items.json matches the connected firmware: its
 * release tag for a release build ("v4.1.1", "v4.0.5-pre4", optionally
 * "-dirty"), else main for dev builds ("v4.1.1 (branch-sha)") or unknown. */
export function configItemsRef(firmwareVersion?: string | null): string {
  const match = firmwareVersion
    ?.trim()
    .match(/^(?:FluidNC\s+)?(v\d+\.\d+\.\d+(?:-(?!dirty$)[0-9A-Za-z.]+)?)(?:-dirty)?$/);
  return match ? match[1] : FALLBACK_REF;
}

function parseConfig(text: string | null): FluidConfig | null {
  if (!text || text.length > MAX_CONFIG_ITEMS_BYTES) return null;
  try {
    const items = JSON.parse(text) as ConfigItems;
    const isObject = (value: unknown): value is Record<string, unknown> =>
      value !== null && typeof value === "object" && !Array.isArray(value);
    if (
      !isObject(items) ||
      !items["axes.<letter>.motorN"] ||
      !isObject(items.section_meta)
    )
      return null;
    for (const [key, section] of Object.entries(items))
      if (!META_KEYS.has(key) && !isObject(section)) return null;
    if (
      items.pin_namespaces !== undefined &&
      (!isObject(items.pin_namespaces) ||
        Object.values(items.pin_namespaces).some(
          (entry) => !isObject(entry) || typeof entry.pattern !== "string",
        ))
    )
      return null;
    return { items, schema: buildFluidSchema(items) };
  } catch {
    return null;
  }
}

function readCache(ref: string): string | null {
  try {
    return localStorage.getItem(CACHE_KEY_PREFIX + ref);
  } catch {
    // Storage is optional; the in-bundle definitions remain the final fallback.
    return null;
  }
}

function writeCache(ref: string, text: string) {
  try {
    localStorage.removeItem(LEGACY_CACHE_KEY);
    localStorage.setItem(CACHE_KEY_PREFIX + ref, text);
  } catch {
    // A full/disabled cache must not prevent use of the downloaded data.
  }
}

function fetchConfigItems(ref: string, signal: AbortSignal) {
  return fetch(CONFIG_ITEMS_URL(ref), {
    signal,
    credentials: "omit",
  });
}

function cachedResult(ref: string): FluidConfigResult {
  const config =
    parseConfig(readCache(ref)) ??
    (ref !== FALLBACK_REF ? parseConfig(readCache(FALLBACK_REF)) : null);
  return { config, online: false };
}

async function fetchConfig(ref: string): Promise<FluidConfigResult> {
  if (typeof navigator !== "undefined" && !navigator.onLine)
    return cachedResult(ref);

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 5000);
  try {
    let fetchedRef = ref;
    let response = await fetchConfigItems(ref, controller.signal);
    // Release tags that predate config_items.json have no copy; main's is
    // the closest available description.
    if (response.status === 404 && ref !== FALLBACK_REF) {
      fetchedRef = FALLBACK_REF;
      response = await fetchConfigItems(FALLBACK_REF, controller.signal);
    }
    if (!response.ok)
      throw new Error(`Config items request failed: ${response.status}`);
    const text = await response.text();
    const config = parseConfig(text);
    if (!config) throw new Error("Invalid FluidNC config items response");
    writeCache(fetchedRef, text);
    return { config, online: true };
  } catch {
    return cachedResult(ref);
  } finally {
    window.clearTimeout(timeout);
  }
}

const pending = new Map<string, Promise<FluidConfigResult>>();

/** Config items + schema matching firmwareVersion (espInfo.version). */
export function loadFluidConfigStatus(
  firmwareVersion?: string | null,
): Promise<FluidConfigResult> {
  const ref = configItemsRef(firmwareVersion);
  let request = pending.get(ref);
  if (!request) {
    request = fetchConfig(ref).then((result) => {
      if (!result.online) pending.delete(ref);
      return result;
    });
    pending.set(ref, request);
  }
  return request;
}

export function loadFluidConfig(
  firmwareVersion?: string | null,
): Promise<FluidConfig | null> {
  return loadFluidConfigStatus(firmwareVersion).then((result) => result.config);
}
