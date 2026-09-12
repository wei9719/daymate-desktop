import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { validateVersions } from "./check-version.mjs";
import { releaseNotes } from "./release-notes.mjs";

test("repository links and desktop opener follow the canonical repository", () => {
  const repository = "https://github.com/wei9719/daymate-desktop";
  const capability = JSON.parse(
    fs.readFileSync("src-tauri/capabilities/default.json", "utf8"),
  );
  const opener = capability.permissions.find(
    (entry) => entry.identifier === "opener:allow-open-url",
  );
  assert.deepEqual(
    opener.allow.filter((entry) => entry.url.startsWith("https://github.com/")),
    [{ url: repository }, { url: repository + "/*" }],
  );
  for (const file of ["README.md", "USER_GUIDE.md", "src/App.tsx"]) {
    const source = fs.readFileSync(file, "utf8");
    assert.ok(source.includes(repository), file);
    assert.ok(!source.includes("zhangweiguo9719-web/daymate-desktop"), file);
  }
});

test("external workflow actions use immutable commit SHAs", () => {
  for (const name of fs.readdirSync(".github/workflows")) {
    if (!name.endsWith(".yml")) continue;
    const workflow = fs.readFileSync(`.github/workflows/${name}`, "utf8");
    for (const match of workflow.matchAll(/^\s+(?:-\s+)?uses:\s+(\S+)/gm)) {
      if (match[1].startsWith("./")) continue;
      assert.match(
        match[1],
        /^[^@]+@[0-9a-f]{40}$/,
        `${name}: external action ${match[1]} must use a full commit SHA`,
      );
    }
  }
});

const changelog = `# Changelog
## [Unreleased]
### Added
- 尚未发布的功能
## [0.6.0] - 2026-09-08
### Added
- 新增 AI 调用额度。
### Changed
- 数据库迁移：v5，增加调用次数表，保留活动记录。
## [0.5.0] - 2026-09-07
### Added
- 旧版功能
`;

test("versions and exact release tag agree", () => {
  assert.equal(
    validateVersions(
      { "package.json": "0.6.0", "Cargo.lock": "0.6.0" },
      "v0.6.0",
    ),
    "0.6.0",
  );
});

test("stale lockfiles, missing versions and wrong tags block a release", () => {
  assert.throws(
    () => validateVersions({ "package.json": "0.6.0", "Cargo.lock": "0.5.0" }),
    /Version mismatch/,
  );
  assert.throws(
    () =>
      validateVersions({ "package.json": "0.6.0", "Cargo.lock": undefined }),
    /no version/,
  );
  for (const tag of [
    "0.6.0",
    "v0.5.0",
    "v0.6.0-rc.1",
    "v0.6.0; echo invalid",
  ]) {
    assert.throws(
      () => validateVersions({ "package.json": "0.6.0" }, tag),
      /does not match/,
    );
  }
});

test("invalid versions and leading zeroes cannot produce release names", () => {
  for (const version of [
    undefined,
    "01.2.3",
    "1.2",
    "v1.2.3",
    "1.2.3\ninvalid",
  ]) {
    assert.throws(
      () => validateVersions({ "package.json": version }),
      /stable X.Y.Z/,
    );
  }
});

test("release notes contain only the requested version plus download instructions", () => {
  const notes = releaseNotes(changelog.replaceAll("\n", "\r\n"), "0.6.0");
  assert.match(notes, /新增 AI 调用额度/);
  assert.match(notes, /数据库迁移：v5/);
  assert.match(notes, /DayMate_0\.6\.0_x64-setup\.exe/);
  assert.match(notes, /SHA256SUMS\.txt/);
  assert.doesNotMatch(notes, /尚未发布的功能|旧版功能/);
});

test("missing or duplicate changelog sections fail", () => {
  assert.throws(() => releaseNotes(changelog, "0.7.0"), /exactly one/);
  assert.throws(
    () =>
      releaseNotes(
        `${changelog}\n## [0.6.0] - 2026-09-08\n- duplicate`,
        "0.6.0",
      ),
    /exactly one/,
  );
});

test("a release needs a real date, changes and an explicit database migration statement", () => {
  assert.throws(
    () => releaseNotes(changelog.replace("2026-09-08", "2026-99-99"), "0.6.0"),
    /valid YYYY-MM-DD/,
  );
  assert.throws(
    () => releaseNotes(changelog.replace("2026-09-08", "2026-02-30"), "0.6.0"),
    /valid YYYY-MM-DD/,
  );
  assert.throws(
    () => releaseNotes("## [0.6.0] - 2026-09-08\n### Added\n", "0.6.0"),
    /no release changes/,
  );
  assert.throws(
    () => releaseNotes("## [0.6.0] - 2026-09-08\n- New feature\n", "0.6.0"),
    /数据库迁移/,
  );
});
