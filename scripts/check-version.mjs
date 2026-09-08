import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function validateVersions(versions, tag) {
  const version = versions["package.json"];
  if (typeof version !== "string" || !stableVersion.test(version)) {
    throw new Error(
      "package.json must contain a stable X.Y.Z version without leading zeroes.",
    );
  }
  for (const [file, value] of Object.entries(versions)) {
    if (value !== version) {
      throw new Error(
        `Version mismatch: ${file} has ${value ?? "no version"}; expected ${version}.`,
      );
    }
  }
  if (tag !== undefined && tag !== `v${version}`) {
    throw new Error(`Release tag ${tag} does not match v${version}.`);
  }
  return version;
}

export function readVersions(root = ".") {
  const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
  const packageJson = JSON.parse(read("package.json"));
  const packageLock = JSON.parse(read("package-lock.json"));
  const cargo = read("src-tauri/Cargo.toml").match(
    /\[package\]([\s\S]*?)(?=\n\[|$)/,
  )?.[1];
  const cargoLock = read("src-tauri/Cargo.lock")
    .split("[[package]]")
    .find((entry) => /^name = "daymate-desktop"$/m.test(entry));
  return {
    "package.json": packageJson.version,
    "package-lock.json": packageLock.version,
    'package-lock.json packages[""]': packageLock.packages?.[""]?.version,
    "src-tauri/tauri.conf.json": JSON.parse(read("src-tauri/tauri.conf.json"))
      .version,
    "src-tauri/Cargo.toml": cargo?.match(/^version = "([^"]+)"/m)?.[1],
    "src-tauri/Cargo.lock": cargoLock?.match(/^version = "([^"]+)"/m)?.[1],
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== "--tag")) {
      throw new Error("Usage: node scripts/check-version.mjs [--tag vX.Y.Z]");
    }
    const version = validateVersions(readVersions(), args[1]);
    console.log(`DayMate versions are consistent: ${version}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
