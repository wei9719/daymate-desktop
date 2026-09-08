import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const target = "x86_64-pc-windows-msvc";

export function evaluateRustAudit(report, metadata) {
  if (
    !Array.isArray(report?.settings?.ignore) ||
    report.settings.ignore.length ||
    !Array.isArray(report.settings.target_os) ||
    report.settings.target_os.length ||
    !Array.isArray(report.settings.target_arch) ||
    report.settings.target_arch.length ||
    report.settings.severity != null
  ) {
    throw new Error(
      "Full-lock RustSec auditing must not suppress advisories or filter severity/platforms.",
    );
  }
  if (
    !Array.isArray(report?.vulnerabilities?.list) ||
    report.vulnerabilities.count !== report.vulnerabilities.list.length ||
    !report.warnings ||
    typeof report.warnings !== "object" ||
    !Array.isArray(metadata?.packages) ||
    !metadata.packages.length ||
    !Array.isArray(metadata?.resolve?.nodes) ||
    !metadata.resolve.nodes.length
  ) {
    throw new Error(
      "Incomplete RustSec report or Windows dependency metadata; refusing to pass.",
    );
  }
  const packages = new Map(metadata.packages.map((item) => [item.id, item]));
  const windowsPackages = new Set();
  for (const node of metadata.resolve.nodes) {
    const item = packages.get(node.id);
    if (!item?.name || !item.version) {
      throw new Error("Windows dependency graph contains an unknown package.");
    }
    windowsPackages.add(`${item.name}@${item.version}`);
  }
  const warnings = [];
  for (const [kind, entries] of Object.entries(report.warnings)) {
    if (!Array.isArray(entries))
      throw new Error("Invalid RustSec warning list.");
    for (const entry of entries) {
      if (!entry?.package?.name || !entry.package.version) {
        throw new Error("A RustSec warning is missing package identity.");
      }
      warnings.push({
        kind,
        package: `${entry.package.name}@${entry.package.version}`,
        advisory: entry.advisory?.id ?? "no advisory ID",
        title: entry.advisory?.title ?? kind,
        windows: windowsPackages.has(
          `${entry.package.name}@${entry.package.version}`,
        ),
      });
    }
  }
  const windowsUnsound = warnings.filter(
    (item) => item.kind === "unsound" && item.windows,
  );
  return {
    vulnerabilities: report.vulnerabilities.list,
    warnings,
    windowsUnsound,
    blocked: report.vulnerabilities.count > 0 || windowsUnsound.length > 0,
  };
}

export function auditRust(
  execute = (args) =>
    spawnSync("cargo", args, {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    }),
) {
  const auditArgs = ["audit", "--file", "src-tauri/Cargo.lock", "--json"];
  if (process.env.RUSTSEC_DATABASE_PATH)
    auditArgs.push("--db", process.env.RUSTSEC_DATABASE_PATH);
  const audit = execute(auditArgs);
  if (audit.stderr) process.stderr.write(audit.stderr);
  if (audit.error || audit.signal || !Number.isInteger(audit.status)) {
    throw new Error("The RustSec auditor could not run; refusing to pass.");
  }
  const report = JSON.parse(audit.stdout);
  if (audit.status !== 0 && !report?.vulnerabilities?.count) {
    throw new Error("RustSec could not finish its audit; refusing to pass.");
  }
  const metadata = execute([
    "metadata",
    "--format-version",
    "1",
    "--locked",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--filter-platform",
    target,
  ]);
  if (metadata.stderr) process.stderr.write(metadata.stderr);
  if (metadata.error || metadata.signal || metadata.status !== 0) {
    throw new Error("Windows dependency resolution failed; refusing to pass.");
  }
  return evaluateRustAudit(report, JSON.parse(metadata.stdout));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const result = auditRust();
    for (const item of result.vulnerabilities) {
      console.error(
        `VULNERABILITY ${item.package.name}@${item.package.version}: ${item.advisory.id} ${item.advisory.title}`,
      );
    }
    // Keep every warning visible. Target selection is computed, never an advisory ignore list.
    for (const item of result.warnings) {
      console.log(
        `WARNING ${item.kind} ${item.package}: ${item.advisory} ${item.title} [${item.windows ? "Windows dependency" : "outside Windows target"}]`,
      );
    }
    console.log(
      `RustSec: ${result.vulnerabilities.length} vulnerabilities across Cargo.lock; ${result.windowsUnsound.length} unsound warnings in ${target}; ${result.warnings.length} total warnings.`,
    );
    if (result.blocked) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
