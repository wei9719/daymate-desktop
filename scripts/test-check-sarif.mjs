import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { checkSarifDirectory, evaluateSarif } from "./check-sarif.mjs";

function report(score = "7.0", results = [{ ruleId: "js/test-security" }]) {
  return {
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "CodeQL",
            rules: [
              {
                id: "js/test-security",
                defaultConfiguration: { level: "warning" },
                properties: { tags: ["security"], "security-severity": score },
              },
            ],
          },
        },
        results,
      },
    ],
  };
}

test("high/critical scores block, while a completed clean scan passes", () => {
  for (const score of [7, "7.0", "9.3", 10])
    assert.equal(evaluateSarif(report(score)).blocked.length, 1);
  assert.equal(evaluateSarif(report("6.9")).blocked.length, 0);
  assert.equal(evaluateSarif(report("9.3", [])).blocked.length, 0);
});

test("ruleIndex and default/result error severity cannot bypass the gate", () => {
  assert.equal(
    evaluateSarif(report("7.0", [{ ruleIndex: 0 }])).blocked.length,
    1,
  );
  assert.equal(
    evaluateSarif(
      report("5.0", [{ ruleId: "js/test-security", level: "error" }]),
    ).blocked.length,
    1,
  );
  const input = report(undefined);
  delete input.runs[0].tool.driver.rules[0].properties["security-severity"];
  input.runs[0].tool.driver.rules[0].defaultConfiguration.level = "error";
  assert.equal(evaluateSarif(input).blocked.length, 1);
  input.runs[0].tool.driver.rules[0].properties.tags = ["maintainability"];
  assert.equal(evaluateSarif(input).blocked.length, 0);
});

test("suppressed and existing alerts are not waived", () => {
  const result = {
    ruleId: "js/test-security",
    baselineState: "unchanged",
    suppressions: [{ kind: "external", status: "accepted" }],
  };
  assert.equal(evaluateSarif(report("8.1", [result])).blocked.length, 1);
});

test("CodeQL 2.26 query-pack extension rules block the real alert shape", () => {
  const input = report("7.8");
  const run = input.runs[0];
  const rules = run.tool.driver.rules;
  rules[0].id = "js/xss-through-dom";
  delete run.tool.driver.rules;
  run.tool.extensions = [
    { name: "codeql/javascript-queries", rules },
    { name: "codeql/threat-models" },
  ];
  run.results = [
    {
      ruleId: "js/xss-through-dom",
      rule: { id: "js/xss-through-dom", index: 0, toolComponent: { index: 0 } },
      level: "warning",
    },
  ];
  assert.deepEqual(evaluateSarif(input).blocked, [
    { ruleId: "js/xss-through-dom", score: 7.8, level: "warning" },
  ]);
  run.results[0].rule.toolComponent = { name: "codeql/javascript-queries" };
  assert.equal(evaluateSarif(input).blocked.length, 1);
  run.results[0].rule.toolComponent = { index: 99 };
  assert.throws(() => evaluateSarif(input), /tool component/);
  run.results[0].rule.toolComponent = { index: 0, name: "wrong-pack" };
  assert.throws(() => evaluateSarif(input), /tool component/);
  run.results = [];
  assert.equal(evaluateSarif(input).blocked.length, 0);
});

test("missing results/rules, unknown references and invalid scores fail closed", () => {
  assert.throws(() => evaluateSarif({ version: "2.1.0", runs: [] }));
  const missing = report();
  delete missing.runs[0].results;
  assert.throws(() => evaluateSarif(missing));
  assert.throws(() => evaluateSarif(report("7", [{ ruleId: "unknown" }])));
  assert.throws(() =>
    evaluateSarif(report("7", [{ ruleId: "js/test-security", ruleIndex: 42 }])),
  );
  for (const score of ["", "unknown", -1, 11, false])
    assert.throws(() => evaluateSarif(report(score)));
  const noSeverity = report();
  delete noSeverity.runs[0].tool.driver.rules[0].properties[
    "security-severity"
  ];
  assert.throws(() => evaluateSarif(noSeverity), /Missing security-severity/);
});

test("failed scanner invocations and additional runs are checked", () => {
  const failed = report("5", []);
  failed.runs[0].invocations = [{ executionSuccessful: false }];
  assert.throws(() => evaluateSarif(failed), /failed analysis/);
  const multiple = report("4", []);
  multiple.runs.push(report("8").runs[0]);
  assert.equal(evaluateSarif(multiple).blocked.length, 1);
});

test("missing, empty and corrupt output directories fail; all report files are inspected", (t) => {
  // Test files stay under the project's ignored dependency directory, never the user's data directory.
  const cache = path.resolve("node_modules/.cache");
  fs.mkdirSync(cache, { recursive: true });
  const directory = fs.mkdtempSync(path.join(cache, "daymate-sarif-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.throws(() => checkSarifDirectory());
  assert.throws(() => checkSarifDirectory(path.join(directory, "missing")));
  assert.throws(() => checkSarifDirectory(directory), /No generated/);
  fs.writeFileSync(
    path.join(directory, "first.sarif"),
    JSON.stringify(report("5", [])),
  );
  fs.mkdirSync(path.join(directory, "nested"));
  fs.writeFileSync(
    path.join(directory, "nested/second.sarif"),
    JSON.stringify(report("9")),
  );
  assert.deepEqual(
    checkSarifDirectory(directory).map((item) => item.blocked.length),
    [0, 1],
  );
  const runGate = () =>
    spawnSync(
      process.execPath,
      [path.resolve("scripts/check-sarif.mjs"), directory],
      { encoding: "utf8" },
    );
  assert.equal(runGate().status, 1, "a high alert must fail the actual CLI");
  fs.writeFileSync(
    path.join(directory, "nested/second.sarif"),
    JSON.stringify(report("9", [])),
  );
  assert.equal(
    runGate().status,
    0,
    "complete clean reports must pass the actual CLI",
  );
  fs.writeFileSync(path.join(directory, "bad.sarif"), "not JSON");
  assert.throws(() => checkSarifDirectory(directory), SyntaxError);
  assert.equal(runGate().status, 1, "corrupt output must fail the actual CLI");
});
