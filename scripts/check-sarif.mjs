import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function evaluateSarif(report) {
  if (
    report?.version !== "2.1.0" ||
    !Array.isArray(report.runs) ||
    !report.runs.length
  ) {
    throw new Error("Missing or unsupported SARIF runs; refusing to pass.");
  }
  const blocked = [];
  let resultCount = 0;
  for (const run of report.runs) {
    const driver = run?.tool?.driver;
    const extensions = run?.tool?.extensions ?? [];
    if (
      driver?.name !== "CodeQL" ||
      !Array.isArray(extensions) ||
      !Array.isArray(run.results)
    ) {
      throw new Error("Incomplete CodeQL rules/results; refusing to pass.");
    }
    // Recent CodeQL versions store query-pack rules in tool.extensions, not tool.driver.
    const components = [driver, ...extensions];
    const ruleMaps = new Map();
    let ruleCount = 0;
    for (const component of components) {
      const rules = component?.rules ?? [];
      if (!Array.isArray(rules))
        throw new Error("Invalid CodeQL rule collection.");
      const byId = new Map(rules.map((rule) => [rule.id, rule]));
      if (
        byId.size !== rules.length ||
        rules.some((rule) => typeof rule.id !== "string" || !rule.id)
      ) {
        throw new Error("Invalid or duplicate CodeQL rule identifiers.");
      }
      ruleMaps.set(component, byId);
      ruleCount += rules.length;
    }
    if (!ruleCount) throw new Error("Missing CodeQL rules; refusing to pass.");
    if (
      run.invocations?.some(
        (item) =>
          item.executionSuccessful === false ||
          item.toolExecutionNotifications?.some(
            (notice) => notice.level === "error",
          ),
      )
    ) {
      throw new Error("CodeQL reported an incomplete or failed analysis.");
    }
    for (const result of run.results) {
      resultCount++;
      const reference = result.rule?.toolComponent;
      let component = driver;
      if (reference) {
        if (reference.index != null) {
          component = Number.isInteger(reference.index)
            ? extensions[reference.index]
            : undefined;
        } else {
          const matches = components.filter(
            (item) =>
              (reference.name != null || reference.guid != null) &&
              (reference.name == null || item.name === reference.name) &&
              (reference.guid == null || item.guid === reference.guid),
          );
          component = matches.length === 1 ? matches[0] : undefined;
        }
        if (
          !component ||
          (reference.name != null && component.name !== reference.name) ||
          (reference.guid != null && component.guid !== reference.guid)
        ) {
          throw new Error(
            "An alert references an unknown or inconsistent tool component.",
          );
        }
      }
      const rules = component.rules ?? [];
      const byId = ruleMaps.get(component);
      const id = result.ruleId ?? result.rule?.id;
      const index = result.ruleIndex ?? result.rule?.index;
      const rule = id
        ? byId.get(id)
        : Number.isInteger(index)
          ? rules[index]
          : undefined;
      if (
        !rule ||
        (result.ruleId != null &&
          result.rule?.id != null &&
          result.ruleId !== result.rule.id) ||
        (result.ruleIndex != null &&
          result.rule?.index != null &&
          result.ruleIndex !== result.rule.index) ||
        (index != null &&
          (!Number.isInteger(index) || rules[index]?.id !== rule.id)) ||
        !rule.properties
      ) {
        throw new Error("An alert is missing valid rule/severity metadata.");
      }
      const rawScore = rule.properties["security-severity"];
      const score = rawScore == null ? undefined : Number(rawScore);
      if (
        rawScore != null &&
        ((typeof rawScore !== "number" && typeof rawScore !== "string") ||
          String(rawScore).trim() === "" ||
          !Number.isFinite(score) ||
          score < 0 ||
          score > 10)
      ) {
        throw new Error(`Invalid security-severity for ${rule.id}.`);
      }
      const tags = rule.properties.tags ?? [];
      if (!Array.isArray(tags))
        throw new Error(`Invalid security tags for ${rule.id}.`);
      const security = score != null || tags.includes("security");
      const level =
        result.level ?? rule.defaultConfiguration?.level ?? "warning";
      if (!["none", "note", "warning", "error"].includes(level))
        throw new Error(`Invalid alert level for ${rule.id}.`);
      if (security && score == null && level !== "error")
        throw new Error(`Missing security-severity for ${rule.id}.`);
      // Do not exempt suppressed or baseline alerts: a present high-risk result must be fixed.
      if ((score != null && score >= 7) || (security && level === "error")) {
        blocked.push({ ruleId: rule.id, score, level });
      }
    }
  }
  return { resultCount, blocked };
}

export function checkSarifDirectory(directory) {
  if (!directory || !fs.statSync(directory).isDirectory())
    throw new Error("A generated SARIF directory is required.");
  const files = [];
  function collect(current) {
    for (const item of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, item.name);
      if (item.isDirectory()) collect(file);
      else if (item.isFile() && item.name.endsWith(".sarif")) files.push(file);
    }
  }
  collect(directory);
  if (!files.length)
    throw new Error("No generated SARIF reports found; refusing to pass.");
  return files.map((file) => ({
    file,
    ...evaluateSarif(JSON.parse(fs.readFileSync(file, "utf8"))),
  }));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const reports = checkSarifDirectory(process.argv[2]);
    let count = 0;
    for (const report of reports) {
      console.log(
        `${path.basename(report.file)}: ${report.resultCount} results, ${report.blocked.length} blocking security alerts.`,
      );
      for (const finding of report.blocked) {
        console.error(
          `BLOCKED ${finding.ruleId}: security-severity=${finding.score ?? "not supplied"}, level=${finding.level}`,
        );
        count++;
      }
    }
    if (count) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
