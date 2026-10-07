import { loadFluidConfigStatus, type FluidSchema } from "./fluidSchema";

export type ConfigIssue = {
  severity: "error" | "warning";
  line: number;
  message: string;
  path?: string;
};
const PIN =
  /^(?:NO_PIN|void|(?:(?:gpio|i2so|uart_channel\d+|pinext[0-9])\.\d+)(?::(?:high|low|pu|pd|ds[0-3]))*)$/i;

export function validateFluidConfig(source: string): ConfigIssue[] {
  const issues: ConfigIssue[] = [],
    lines = source.split(/\r\n|\n|\r/);
  const stack: { indent: number; key: string }[] = [],
    siblingIndents = new Map<string, number>(),
    siblingKeys = new Map<string, Map<string, { key: string; line: number }>>();
  const pins = new Map<string, { line: number; path: string }>(),
    values = new Map<string, { value: string; line: number }>();
  if (!source.trim())
    issues.push({
      severity: "error",
      line: 1,
      message: "Configuration is empty.",
    });
  lines.forEach((raw, index) => {
    const line = index + 1;
    if (raw.includes("\t"))
      issues.push({
        severity: "error",
        line,
        message: "Tabs are not allowed; use spaces.",
      });
    if (/^\s*---\s*$/.test(raw))
      issues.push({
        severity: "error",
        line,
        message: "Unsupported YAML feature; use block-style FluidNC YAML.",
      });
    if (!raw.trim() || raw.trimStart().startsWith("#")) return;
    const match = raw.match(/^(\s*)([^:#]+):(?:\s*(.*))?$/);
    if (!match) {
      issues.push({
        severity: "error",
        line,
        message: "Expected a key followed by a colon.",
      });
      return;
    }
    const indent = match[1].length,
      key = match[2].trim(),
      rawValue = (match[3] ?? "").trim(),
      value = rawValue.replace(/^(['"])(.*)\1$/, "$2");
    while (stack.length && stack[stack.length - 1].indent >= indent)
      stack.pop();
    const parent = stack.map((item) => item.key).join("."),
      path = parent ? `${parent}.${key}` : key;
    const keysAtLevel = siblingKeys.get(parent) ?? new Map();
    const previousKey = keysAtLevel.get(key.toLowerCase());
    if (previousKey)
      issues.push({
        severity: "error",
        line,
        path,
        message: `Duplicate key; ${key} conflicts with ${previousKey.key} on line ${previousKey.line}.`,
      });
    else {
      keysAtLevel.set(key.toLowerCase(), { key, line });
      siblingKeys.set(parent, keysAtLevel);
    }
    const macroValue =
      /(^|\.)(macros\.(?:startup_line\d+|macro\d+|after_(?:homing|reset|unlock))|m6_macro)$/i.test(
        path,
      );
    const fullyQuoted = /^(?:".*"|'.*')$/.test(rawValue);
    if (
      (rawValue.startsWith('"') && !rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && !rawValue.endsWith("'"))
    )
      issues.push({
        severity: "error",
        line,
        path,
        message: "Quoted values must have matching opening and closing quotes.",
      });
    if (/^".*\\(?:["\\nrtu]).*"$/.test(rawValue))
      issues.push({
        severity: "error",
        line,
        path,
        message: "FluidNC does not support YAML-style quoted-string escapes.",
      });
    if (
      /^(?:passthrough_)?mode$/i.test(key) &&
      !/^[5-8][NEO][12]$/i.test(value)
    )
      issues.push({
        severity: "error",
        line,
        path,
        message:
          "Invalid UART mode; expected data bits, parity, and stop bits (for example 8N1).",
      });
    if (!macroValue && !fullyQuoted && /\s+#/.test(rawValue))
      issues.push({
        severity: "error",
        line,
        path,
        message: "Inline comments are not supported by FluidNC.",
      });
    if (
      !macroValue &&
      !fullyQuoted &&
      (/^[\[{]/.test(rawValue) ||
        /^[&*]/.test(rawValue) ||
        /^[|>][+-]?$/.test(rawValue))
    )
      issues.push({
        severity: "error",
        line,
        path,
        message: "Unsupported YAML feature; use block-style FluidNC YAML.",
      });
    const knownIndent = siblingIndents.get(parent);
    if (knownIndent == null) siblingIndents.set(parent, indent);
    else if (knownIndent !== indent)
      issues.push({
        severity: "error",
        line,
        path,
        message: `Inconsistent indentation under ${parent || "the document root"}.`,
      });
    if (!value) {
      stack.push({ indent, key });
      return;
    }
    values.set(path, { value, line });
    if (/_pin$|\.pin$/i.test(path)) {
      if (!PIN.test(value))
        issues.push({
          severity: "error",
          line,
          path,
          message: `Invalid FluidNC pin: ${value}`,
        });
      const base = value.split(":")[0].toLowerCase();
      if (base !== "no_pin" && base !== "void") {
        const previous = pins.get(base);
        if (previous)
          issues.push({
            severity: "warning",
            line,
            path,
            message: `${base} is already used on line ${previous.line} (${previous.path}).`,
          });
        else pins.set(base, { line, path });
      }
    }
    if (
      !/^(true|false)$/i.test(value) &&
      /(^|\.)(soft_limits|hard_limits|positive_direction|enable|enabled|must_home|check_limits|use_enable|off_on_alarm)$/i.test(
        path,
      )
    )
      issues.push({
        severity: "error",
        line,
        path,
        message: "Boolean values must be exactly true or false.",
      });
  });
  const normalizedValues = new Map(
    [...values].map(([path, entry]) => [path.toLowerCase(), entry]),
  );
  for (const axis of ["x", "y", "z", "a", "b", "c"])
    for (const motor of ["motor0", "motor1"]) {
      const prefix = `axes.${axis}.${motor}`,
        driverField = [...normalizedValues.keys()].find(
          (path) =>
            path.startsWith(`${prefix}.`) &&
            /\.(stepstick|standard_stepper|tmc_\d+|servo)\./i.test(path),
        );
      if (!driverField) continue;
      const driver = driverField.slice(0, driverField.lastIndexOf("."));
      for (const field of ["step_pin", "direction_pin"]) {
        const entry = normalizedValues.get(`${driver}.${field}`);
        if (!entry || /^(NO_PIN|no_pin)$/i.test(entry.value))
          issues.push({
            severity: "error",
            line: entry?.line ?? normalizedValues.get(driverField)?.line ?? 1,
            path: `${driver}.${field}`,
            message: `${axis.toUpperCase()} ${motor} requires a ${field.replace("_", " ")}.`,
          });
      }
    }
  if (![...values.keys()].some((path) => /^axes\.[xyzabc]\./i.test(path)))
    issues.push({
      severity: "warning",
      line: 1,
      path: "axes",
      message: "No configured axes were found.",
    });
  return issues.sort(
    (a, b) => a.line - b.line || (a.severity === "error" ? -1 : 1),
  );
}

type SchemaRule = Record<string, any>;
type SchemaViolation = { path: string; message: string };

function schemaErrorLine(source: string, target: string): number {
  if (!target) return 1;
  const lines = source.split(/\r\n|\n|\r/);
  const stack: { indent: number; key: string }[] = [];
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^(\s*)([^:#]+):/);
    if (!match) continue;
    const indent = match[1].length;
    while (stack.length && stack[stack.length - 1].indent >= indent)
      stack.pop();
    const key = match[2].trim();
    const path = [...stack.map((item) => item.key), key].join(".");
    const normalizedPath = path.toLowerCase();
    const normalizedTarget = target.toLowerCase();
    if (
      normalizedPath === normalizedTarget ||
      normalizedTarget.startsWith(`${normalizedPath}.`)
    ) {
      if (normalizedPath === normalizedTarget) return index + 1;
    }
    const hasValue = lines[index].slice(match[0].length).trim().length > 0;
    if (!hasValue) stack.push({ indent, key });
  }
  return 1;
}

function parseScalar(token: string, key: string): unknown {
  if (/^(?:passthrough_)?mode$/i.test(key))
    return token.replace(/^(['"])(.*)\1$/, "$2");
  if (/^true$/i.test(token)) return true;
  if (/^false$/i.test(token)) return false;
  if (/^(null|~)$/i.test(token)) return null;
  if (/^-?\d+$/.test(token)) return Number.parseInt(token, 10);
  if (
    /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)$/i.test(token) ||
    /^-?(?:\d+\.\d*|\d*\.\d+)$/.test(token)
  )
    return Number(token);
  if (/^".*"$/.test(token)) {
    try {
      return JSON.parse(token);
    } catch {
      return token.slice(1, -1);
    }
  }
  if (/^'.*'$/.test(token)) return token.slice(1, -1).replace(/''/g, "'");
  return token;
}

/** Parses the block-style YAML subset accepted by validateFluidConfig. */
function parseBlockYaml(
  source: string,
  scalarTokens?: Map<string, string>,
): unknown {
  const root: Record<string, unknown> = {};
  const stack: {
    indent: number;
    value: Record<string, unknown>;
    path: string;
  }[] = [{ indent: -1, value: root, path: "" }];
  for (const raw of source.split(/\r\n|\n|\r/)) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    const match = raw.match(/^(\s*)([^:#]+):(?:\s*(.*))?$/);
    if (!match) continue;
    const indent = match[1].length;
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent)
      stack.pop();
    const key = match[2].trim();
    const token = (match[3] ?? "").trim();
    const parent = stack[stack.length - 1];
    const path = parent.path ? `${parent.path}.${key}` : key;
    if (token) {
      parent.value[key] = parseScalar(token, key);
      scalarTokens?.set(path.toLowerCase(), token);
    } else {
      const child: Record<string, unknown> = {};
      parent.value[key] = child;
      stack.push({ indent, value: child, path });
    }
  }
  const emptyObjectsToNull = (value: unknown): unknown => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return value;
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return null;
    return Object.fromEntries(
      entries.map(([key, child]) => [key, emptyObjectsToNull(child)]),
    );
  };
  return emptyObjectsToNull(root);
}

function matchesType(value: unknown, type: string) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object")
    return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer")
    return typeof value === "number" && Number.isInteger(value);
  if (type === "number")
    return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function validateAgainstSchema(
  value: unknown,
  rule: SchemaRule,
  root: FluidSchema,
  path = "",
  issues: SchemaViolation[] = [],
  scalarTokens?: Map<string, string>,
): SchemaViolation[] {
  // FluidNC treats an empty optional scalar as unset. Config exports commonly
  // retain those keys (for example `atc:`), while JSON Schema represents the
  // empty value as null and would otherwise reject it as the scalar's type.
  if (value === null) return issues;
  if (rule.$ref) {
    const target = String(rule.$ref)
      .replace(/^#\//, "")
      .split("/")
      .reduce<unknown>(
        (current, key) =>
          (current as Record<string, unknown>)?.[
            key.replace(/~1/g, "/").replace(/~0/g, "~")
          ],
        root,
      );
    return target && typeof target === "object"
      ? validateAgainstSchema(
          value,
          target as SchemaRule,
          root,
          path,
          issues,
          scalarTokens,
        )
      : issues;
  }
  for (const part of rule.allOf ?? [])
    validateAgainstSchema(value, part, root, path, issues, scalarTokens);
  if (rule.oneOf) {
    const matches = rule.oneOf.filter(
      (part: SchemaRule) =>
        !validateAgainstSchema(value, part, root, path, [], scalarTokens)
          .length,
    ).length;
    if (matches !== 1)
      issues.push({ path, message: "must match exactly one allowed form" });
  }
  const types =
    rule.type == null ? [] : Array.isArray(rule.type) ? rule.type : [rule.type];
  const scalarToken = scalarTokens?.get(path.toLowerCase());
  if (
    types.includes("integer") &&
    typeof value === "number" &&
    scalarToken != null &&
    !/^-?\d+$/.test(scalarToken)
  )
    issues.push({
      path,
      message: "must be a plain decimal integer without a decimal point",
    });
  if (types.length && !types.some((type: string) => matchesType(value, type))) {
    issues.push({ path, message: `must be ${types.join(" or ")}` });
    return issues;
  }
  if (
    rule.enum &&
    !rule.enum.some((item: unknown) =>
      typeof item === "string" && typeof value === "string"
        ? item.toLowerCase() === value.toLowerCase()
        : Object.is(item, value),
    )
  )
    issues.push({ path, message: `must be one of ${rule.enum.join(", ")}` });
  if (typeof value === "number") {
    if (rule.minimum != null && value < rule.minimum)
      issues.push({ path, message: `must be at least ${rule.minimum}` });
    if (rule.maximum != null && value > rule.maximum)
      issues.push({ path, message: `must be at most ${rule.maximum}` });
  }
  if (typeof value === "string" && rule.pattern) {
    try {
      if (!new RegExp(rule.pattern, "i").test(value))
        issues.push({ path, message: "has an invalid format" });
    } catch {
      // Ignore an invalid pattern supplied by a remote schema.
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    const properties = rule.properties ?? {};
    const patterns = Object.entries(rule.patternProperties ?? {}) as [
      string,
      SchemaRule,
    ][];
    for (const required of rule.required ?? [])
      if (
        !Object.keys(object).some(
          (key) => key.toLowerCase() === String(required).toLowerCase(),
        )
      )
        issues.push({
          path: path ? `${path}.${required}` : required,
          message: "is required",
        });
    if (
      rule.maxProperties != null &&
      Object.keys(object).length > rule.maxProperties
    )
      issues.push({
        path,
        message: `must have at most ${rule.maxProperties} properties`,
      });
    for (const [key, child] of Object.entries(object)) {
      const childPath = path ? `${path}.${key}` : key;
      const propertyKey = Object.keys(properties).find(
        (candidate) => candidate.toLowerCase() === key.toLowerCase(),
      );
      if (propertyKey)
        validateAgainstSchema(
          child,
          properties[propertyKey],
          root,
          childPath,
          issues,
          scalarTokens,
        );
      else {
        const matchingPatterns = patterns.filter(([pattern]) =>
          new RegExp(pattern, "i").test(key),
        );
        if (matchingPatterns.length)
          for (const [, patternRule] of matchingPatterns)
            validateAgainstSchema(
              child,
              patternRule,
              root,
              childPath,
              issues,
              scalarTokens,
            );
        else if (
          rule.additionalProperties &&
          typeof rule.additionalProperties === "object"
        )
          validateAgainstSchema(
            child,
            rule.additionalProperties,
            root,
            childPath,
            issues,
            scalarTokens,
          );
        // Unknown keys are intentionally tolerated here. FluidNC accepts and
        // ignores or version-selects fields that the upstream schema omits;
        // that schema is canonical-generation guidance, not a compatibility
        // contract for configs produced by every supported firmware version.
      }
    }
  }
  return issues;
}

/** Uses the downloaded upstream schema when online, with local checks offline. */
export async function validateFluidConfigForSave(
  source: string,
  firmwareVersion?: string | null,
): Promise<ConfigIssue[]> {
  const localIssues = validateFluidConfig(source);
  if (localIssues.some((issue) => issue.severity === "error"))
    return localIssues;

  const { config, online } = await loadFluidConfigStatus(firmwareVersion);
  if (!online || !config) return localIssues;
  const { schema } = config;

  const scalarTokens = new Map<string, string>();
  const parsed = parseBlockYaml(source, scalarTokens);
  const schemaIssues = validateAgainstSchema(
    parsed,
    schema,
    schema,
    "",
    [],
    scalarTokens,
  ).map((error) => ({
    severity: "warning" as const,
    line: schemaErrorLine(source, error.path),
    path: error.path || undefined,
    message: `Schema: ${error.message}.`,
  }));
  return [...localIssues, ...schemaIssues].sort((a, b) => a.line - b.line);
}
