import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";

async function loadModule(entryPoint) {
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    write: false,
    logLevel: "silent",
  });
  const source = Buffer.from(result.outputFiles[0].contents).toString("base64");
  return import(`data:text/javascript;base64,${source}`);
}

const validation = await loadModule("src/lib/configValidation.ts");
const studio = await loadModule("src/components/ConfigStudio.tsx");

const mixedCaseConfig = `name: Sample
BOARD: SampleBoard
Planner_Blocks: 16
UART2:
  TXD_PIN: GPIO.17
  RXD_PIN: gpio.16
  MODE: "8E1"
UART_CHANNEL1:
  UART_NUM: 2
  REPORT_INTERVAL_MS: 0
  MESSAGE_LEVEL: info
AXES:
  X:
    Steps_Per_Mm: 80.0
    MOTOR0:
      STEPSTICK:
        STEP_PIN: GPIO.26
        DIRECTION_PIN: gpio.27
START:
  MUST_HOME: TRUE
  deactivate_parking: false
  CHECK_LIMITS: true
PARKING:
  ENABLE: false
  AXIS: Z
  pullout_distance_mm: 5.0
KINEMATICS:
  COREXY:
MACROS:
  MACRO0: $H&$G
  MACRO1: #fr
probe:
  pin: pinext0.3:PU:LOW
`;

assert.deepEqual(validation.validateFluidConfig(mixedCaseConfig), []);

assert.deepEqual(
  validation.validateFluidConfig(
    `axes:\n  x:\n    steps_per_mm: 80\nuart1:\n  mode: 8E1\n`,
  ),
  [],
);

const duplicate = validation.validateFluidConfig(`name: A\nNAME: B\n`);
const duplicateError = duplicate.find((issue) =>
  /Duplicate key/.test(issue.message),
);
assert.equal(duplicateError?.severity, "error");

for (const invalid of [
  `axes: { x: {} }\n`,
  `axes:\n  x: &shared\n`,
  `meta: value # comment\n`,
  `meta: |\n  value\n`,
  `name: "unterminated\n`,
  `uart1:\n  mode: "9N1"\n`,
  `probe:\n  pin: void.0\n`,
  `probe:\n  pin: NO_PIN:low\n`,
  `probe:\n  pin: pinext10.1\n`,
  `---\nname: test\n`,
]) {
  assert.ok(
    validation
      .validateFluidConfig(invalid)
      .some((issue) => issue.severity === "error"),
    invalid,
  );
}

const patched = studio.patchYamlValue(
  mixedCaseConfig,
  "axes.x.steps_per_mm",
  "81.5",
);
assert.ok(patched?.includes("    Steps_Per_Mm: 81.5"));
assert.ok(patched?.includes("BOARD: SampleBoard"));
assert.equal(
  studio.patchYamlValue(`UART1:\n  MODE: "8N1"\n`, "uart1.mode", "8E1"),
  `UART1:\n  MODE: "8E1"\n`,
);
assert.equal(studio.formatYamlScalar("$H&$G", "", "macros.macro0"), "$H&$G");
assert.equal(
  studio.formatYamlScalar("Board: Rev A", "", "board"),
  '"Board: Rev A"',
);

const nodes = studio.nodesFromYaml(mixedCaseConfig);
const find = (kind) => nodes.filter((node) => node.kind === kind);
assert.equal(find("machine")[0].fields.Planner_Blocks, "16");
assert.equal(find("axis")[0].fields.axis, "x");
assert.equal(find("driver")[0].fields.type, "stepstick");
assert.equal(find("start").length, 1);
assert.equal(find("parking").length, 1);
assert.equal(find("kinematics")[0].fields.type, "CoreXY");
assert.equal(
  find("bus").some((node) => node.fields.type === "uart_channel1"),
  true,
);

const exactStrings = studio.nodesFromYaml(
  `name: Robot  \nboard: "001"\naxes:\n  x:\n    steps_per_mm: 80\n`,
);
const exactMachine = exactStrings.find((node) => node.kind === "machine");
assert.equal(exactMachine?.fields.name, "Robot  ");
assert.equal(exactMachine?.fields.board, "001");

const crlf = "BOARD: SampleBoard\r\nAXES:\r\n  X:\r\n    STEPS_PER_MM: 80\r\n";
assert.equal(
  validation
    .validateFluidConfig(crlf)
    .some((issue) => issue.severity === "error"),
  false,
);
const patchedCrlf = studio.patchYamlValue(crlf, "axes.x.steps_per_mm", "81");
assert.ok(patchedCrlf?.includes("    STEPS_PER_MM: 81\r\n"));
assert.equal(/(^|[^\r])\n/.test(patchedCrlf ?? ""), false);

const fluidSchema = await loadModule("src/lib/fluidSchema.ts");
const configItems = {
  "axes.<letter>.motorN": {},
  section_meta: {},
  axes: { idle_ms: { type: "integer", min: 0 } },
  pin_namespaces: { pinext: { pattern: "pinext[0-9]\\.[0-9]+" } },
};
const cachePrefix = "fluidui.fluidnc-config-items.v2:";
const cache = new Map();
const browserGlobals = {
  navigator: { onLine: true },
  window: { setTimeout, clearTimeout },
  localStorage: {
    getItem: (key) => cache.get(key) ?? null,
    setItem: (key, value) => cache.set(key, value),
    removeItem: (key) => cache.delete(key),
  },
  fetch: async () => {
    fetchCount++;
    if (fetchFails) throw new Error("Network unavailable");
    return { ok: true, status: 200, text: async () => fetchedText };
  },
};
let fetchedText = JSON.stringify(configItems);
let fetchCount = 0;
let fetchFails = false;
let refIndex = 0;
const nextRef = () => `v9.0.${++refIndex}`;
const originalGlobals = new Map();
for (const [key, value] of Object.entries(browserGlobals)) {
  originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, value });
}
try {
  const ref = nextRef();
  const request = fluidSchema.loadFluidConfigStatus(ref);
  assert.equal(fluidSchema.loadFluidConfigStatus(ref), request);
  const result = await request;
  assert.equal(result.online, true);
  assert.deepEqual(result.config.items, configItems);
  assert.equal(
    result.config.schema.properties.axes.properties.idle_ms.minimum,
    0,
  );
  assert.ok(result.config.schema.$defs.pinAny.pattern.includes("pinext[0-9]"));
  assert.equal(fluidSchema.loadFluidConfigStatus(ref), request);
  assert.equal(await fluidSchema.loadFluidConfigStatus(ref), result);
  assert.equal(await fluidSchema.loadFluidConfig(ref), result.config);
  assert.equal(fetchCount, 1);

  {
    // Field-less sections (null_motor, NoSpindle, ...) are null in the real
    // config_items.json and must not cause the whole file to be rejected.
    const ref = nextRef();
    fetchedText = JSON.stringify({ ...configItems, NoSpindle: null });
    const withNull = await fluidSchema.loadFluidConfigStatus(ref);
    assert.equal(withNull.online, true);
    assert.ok(withNull.config.schema.properties.NoSpindle);
  }

  const invalidItems = [null, [], {}, { ...configItems, section_meta: null }];
  for (const invalid of [null, [], "invalid", 1, true]) {
    for (const section of ["section_meta", "axes", "axes.<letter>.motorN"])
      // A null section is valid (field-less types such as NoSpindle load
      // that way); only the required metadata/motor blocks must be objects.
      if (invalid !== null || section !== "axes")
        invalidItems.push({ ...configItems, [section]: invalid });
    invalidItems.push({ ...configItems, pin_namespaces: invalid });
  }
  for (const entry of [
    null,
    [],
    "invalid",
    {},
    { pattern: null },
    { pattern: 1 },
  ])
    invalidItems.push({ ...configItems, pin_namespaces: { pinext: entry } });
  for (const invalid of invalidItems) {
    const ref = nextRef();
    fetchedText = JSON.stringify(invalid);
    assert.deepEqual(await fluidSchema.loadFluidConfigStatus(ref), {
      config: null,
      online: false,
    });
    assert.equal(cache.has(cachePrefix + ref), false);
    cache.set(cachePrefix + ref, fetchedText);
    browserGlobals.navigator.onLine = false;
    assert.deepEqual(await fluidSchema.loadFluidConfigStatus(ref), {
      config: null,
      online: false,
    });
    browserGlobals.navigator.onLine = true;
  }

  fetchedText = JSON.stringify(configItems);
  for (const mode of ["offline", "cached offline", "network failure"]) {
    const ref = nextRef();
    if (mode !== "offline") cache.set(cachePrefix + ref, fetchedText);
    browserGlobals.navigator.onLine = mode === "network failure";
    fetchFails = mode === "network failure";
    const request = fluidSchema.loadFluidConfigStatus(ref);
    assert.equal(fluidSchema.loadFluidConfigStatus(ref), request);
    const fallback = await request;
    assert.equal(fallback.online, false);
    assert.deepEqual(
      fallback.config?.items ?? null,
      mode === "offline" ? null : configItems,
    );
    browserGlobals.navigator.onLine = true;
    fetchFails = false;
    const countBeforeRetry = fetchCount;
    const retry = fluidSchema.loadFluidConfigStatus(ref);
    assert.notEqual(retry, request);
    const result = await retry;
    assert.equal(result.online, true);
    assert.deepEqual(result.config.items, configItems);
    assert.equal(fetchCount, countBeforeRetry + 1);
    assert.equal(fluidSchema.loadFluidConfigStatus(ref), retry);
  }
} finally {
  for (const [key, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
}

console.log("Config compatibility tests passed.");

for (const filename of process.argv.slice(2)) {
  const source = await readFile(filename, "utf8");
  const issues = validation.validateFluidConfig(source);
  const errors = issues.filter((issue) => issue.severity === "error");
  const auditFailures = [];
  const entries = studio.yamlEntries(source);
  const nodes = studio.nodesFromYaml(source);
  const entryPaths = new Set(entries.map((entry) => entry.path.toLowerCase()));
  const expectedAxes = entries.filter((entry) =>
    /^axes\.[xyzabc]$/i.test(entry.path),
  ).length;
  const expectedMotors = entries.filter((entry) =>
    /^axes\.[xyzabc]\.motor[01]$/i.test(entry.path),
  ).length;
  const actualAxes = nodes.filter((node) => node.kind === "axis").length;
  const actualMotors = nodes.filter((node) => node.kind === "motor").length;
  if (actualAxes !== expectedAxes)
    auditFailures.push(`Studio loaded ${actualAxes}/${expectedAxes} axes`);
  if (actualMotors !== expectedMotors)
    auditFailures.push(
      `Studio loaded ${actualMotors}/${expectedMotors} motors`,
    );

  const normalizedLf = source.replace(/\r\n|\r/g, "\n");
  const variants = {
    "mixed-case keys": normalizedLf
      .split("\n")
      .map((line, lineIndex) =>
        line.replace(/^(\s*)([^:#]+)(:)/, (_, indent, key, colon) =>
          line.trimStart().startsWith("#")
            ? line
            : `${indent}${[...key]
                .map((character, index) =>
                  /[a-z]/i.test(character)
                    ? (index + lineIndex) % 2
                      ? character.toUpperCase()
                      : character.toLowerCase()
                    : character,
                )
                .join("")}${colon}`,
        ),
      )
      .join("\n"),
    "doubled indentation": normalizedLf
      .split("\n")
      .map((line) => line.replace(/^( +)/, (indent) => indent.repeat(2)))
      .join("\n"),
    "CRLF line endings": normalizedLf.replace(/\n/g, "\r\n"),
    "no final newline": normalizedLf.replace(/\n+$/, ""),
  };
  for (const [variantName, variant] of Object.entries(variants)) {
    const variantErrors = validation
      .validateFluidConfig(variant)
      .filter((issue) => issue.severity === "error");
    if (variantErrors.length)
      auditFailures.push(
        `${variantName} produced: ${variantErrors[0].message}`,
      );
    const variantNodes = studio.nodesFromYaml(variant);
    if (
      variantNodes.filter((node) => node.kind === "axis").length !==
        actualAxes ||
      variantNodes.filter((node) => node.kind === "motor").length !==
        actualMotors
    )
      auditFailures.push(`${variantName} changed the Studio graph`);
  }

  const rootKinds = {
    start: "start",
    parking: "parking",
    kinematics: "kinematics",
    probe: "probe",
    control: "control",
    coolant: "coolant",
    macros: "macro",
    oled: "display",
    atc_manual: "atc",
    sdcard: "storage",
  };
  for (const [root, kind] of Object.entries(rootKinds))
    if (entryPaths.has(root) && !nodes.some((node) => node.kind === kind))
      auditFailures.push(`Studio did not load ${root}:`);

  let exercisedFields = 0;
  for (const node of nodes) {
    const nodePath = studio.yamlPathForNode(node, nodes);
    if (
      node.kind !== "machine" &&
      nodePath &&
      !entryPaths.has(nodePath.toLowerCase())
    )
      auditFailures.push(`Node path is missing: ${nodePath}`);
    for (const [key, value] of Object.entries(node.fields)) {
      if (!value || key === "type" || key === "axis") continue;
      const path = studio.yamlPathForField(node, key, nodes);
      if (!path || !entryPaths.has(path.toLowerCase())) continue;
      exercisedFields++;
      const mixedCasePath = path
        .split("")
        .map((character, index) =>
          /[a-z]/i.test(character)
            ? index % 2
              ? character.toUpperCase()
              : character.toLowerCase()
            : character,
        )
        .join("");
      const patched = studio.patchYamlValue(source, mixedCasePath, value);
      if (patched == null) {
        auditFailures.push(`Could not patch ${path} case-insensitively`);
        continue;
      }
      const sourceUsesCrlf = source.includes("\r\n");
      const patchUsesCrlf = patched.includes("\r\n");
      if (sourceUsesCrlf !== patchUsesCrlf)
        auditFailures.push(`Line-ending style changed while patching ${path}`);
      const introducedErrors = validation
        .validateFluidConfig(patched)
        .filter((issue) => issue.severity === "error");
      if (introducedErrors.length)
        auditFailures.push(
          `Patching ${path} introduced: ${introducedErrors[0].message}`,
        );
    }
  }
  console.log(
    `${filename}: ${errors.length} errors, ${issues.length - errors.length} warnings, ${exercisedFields} field edits and ${Object.keys(variants).length} transformed variants exercised`,
  );
  for (const issue of issues.filter((issue) => issue.severity === "warning"))
    console.warn(`  L${issue.line} ${issue.path ?? ""} ${issue.message}`);
  if (errors.length) {
    for (const issue of errors)
      console.error(`  L${issue.line} ${issue.path ?? ""} ${issue.message}`);
    process.exitCode = 1;
  }
  if (auditFailures.length) {
    for (const failure of [...new Set(auditFailures)])
      console.error(`  AUDIT ${failure}`);
    process.exitCode = 1;
  }
}
