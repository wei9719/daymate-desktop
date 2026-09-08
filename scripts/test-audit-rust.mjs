import assert from "node:assert/strict";
import test from "node:test";
import { auditRust, evaluateRustAudit } from "./audit-rust.mjs";

const metadata = {
  packages: [
    { id: "windows-id", name: "windows-dependency", version: "1.2.3" },
    { id: "linux-id", name: "linux-dependency", version: "4.5.6" },
  ],
  resolve: { nodes: [{ id: "windows-id" }] },
};
const warning = (name, version) => ({
  package: { name, version },
  advisory: { id: "RUSTSEC-TEST", title: "Synthetic advisory" },
});
const clean = () => ({
  vulnerabilities: { count: 0, list: [] },
  warnings: {},
  settings: { ignore: [], target_os: [], target_arch: [], severity: null },
});

test("any vulnerability in the full lockfile blocks even outside Windows", () => {
  const report = clean();
  report.vulnerabilities = {
    count: 1,
    list: [warning("linux-dependency", "4.5.6")],
  };
  assert.equal(evaluateRustAudit(report, metadata).blocked, true);
});

test("unsound Windows dependencies block without an advisory allowlist", () => {
  const report = clean();
  report.warnings.unsound = [warning("windows-dependency", "1.2.3")];
  assert.equal(evaluateRustAudit(report, metadata).blocked, true);
});

test("non-Windows and maintenance warnings stay visible without masquerading as Windows failures", () => {
  const report = clean();
  report.warnings.unsound = [warning("linux-dependency", "4.5.6")];
  report.warnings.unmaintained = [warning("windows-dependency", "1.2.3")];
  const result = evaluateRustAudit(report, metadata);
  assert.equal(result.blocked, false);
  assert.equal(result.warnings.length, 2);
  assert.equal(result.warnings[0].windows, false);
  assert.equal(result.warnings[1].windows, true);
});

test("missing metadata and inconsistent reports fail closed", () => {
  assert.throws(() => evaluateRustAudit(clean(), {}), /refusing to pass/);
  assert.throws(() => evaluateRustAudit({}, metadata));
  assert.throws(
    () =>
      evaluateRustAudit(clean(), {
        ...metadata,
        resolve: { nodes: [{ id: "unknown" }] },
      }),
    /unknown package/,
  );
});

test("hidden ignore lists and full-lock platform filters are forbidden", () => {
  const report = clean();
  report.settings.ignore = ["RUSTSEC-TEST"];
  assert.throws(() => evaluateRustAudit(report, metadata), /must not suppress/);
  report.settings.ignore = [];
  report.settings.target_os = ["windows"];
  assert.throws(() => evaluateRustAudit(report, metadata), /must not suppress/);
});

test("cargo metadata command failures cannot produce a successful audit", () => {
  let calls = 0;
  assert.throws(
    () =>
      auditRust(() =>
        ++calls === 1
          ? { status: 0, stdout: JSON.stringify(clean()) }
          : { status: 101, stdout: "" },
      ),
    /resolution failed/,
  );
});

test("audit execution and JSON failures fail closed", () => {
  assert.throws(
    () =>
      auditRust(() => ({
        status: null,
        error: new Error("missing executable"),
      })),
    /could not run/,
  );
  assert.throws(
    () => auditRust(() => ({ status: 0, stdout: "not JSON" })),
    SyntaxError,
  );
  assert.throws(
    () => auditRust(() => ({ status: 1, stdout: JSON.stringify(clean()) })),
    /could not finish/,
  );
});
