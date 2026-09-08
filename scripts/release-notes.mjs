import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readVersions, validateVersions } from "./check-version.mjs";

export function releaseNotes(changelog, version) {
  validateVersions({ "package.json": version });
  const headings = [
    ...changelog.matchAll(/^## \[([^\]]+)\](?: - ([^\r\n]+))?\s*$/gm),
  ];
  const matches = headings.filter((heading) => heading[1] === version);
  if (matches.length !== 1) {
    throw new Error(
      `CHANGELOG.md must contain exactly one [${version}] section.`,
    );
  }
  const heading = matches[0];
  const date = heading[2];
  const parsedDate = new Date(`${date}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date ?? "") ||
    Number.isNaN(parsedDate.getTime()) ||
    parsedDate.toISOString().slice(0, 10) !== date
  ) {
    throw new Error(
      `CHANGELOG.md [${version}] needs a valid YYYY-MM-DD release date.`,
    );
  }
  const nextHeading = headings[headings.indexOf(heading) + 1];
  const body = changelog
    .slice(heading.index + heading[0].length, nextHeading?.index)
    .trim();
  if (!/^- \S/m.test(body)) {
    throw new Error(`CHANGELOG.md [${version}] has no release changes.`);
  }
  if (!/数据库迁移[：:]\s*\S/.test(body)) {
    throw new Error(
      `CHANGELOG.md [${version}] must state 数据库迁移：无 or describe the migration.`,
    );
  }
  return `# DayMate v${version}\n\n发布日期：${date}\n\n${body}\n\n## 下载与校验\n\n下载下方的 \`DayMate_${version}_x64-setup.exe\` 安装包，双击安装即可，无需安装 Node.js 或 Rust。\n\n\`SHA256SUMS.txt\` 提供安装包的 SHA-256 校验值；在 PowerShell 中运行 \`Get-FileHash .\\DayMate_${version}_x64-setup.exe -Algorithm SHA256\` 可核对文件完整性。\n`;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const [tag, output, ...extra] = process.argv.slice(2);
    if (!tag || extra.length) {
      throw new Error(
        "Usage: node scripts/release-notes.mjs vX.Y.Z [output.md]",
      );
    }
    const version = validateVersions(readVersions(), tag);
    const notes = releaseNotes(
      fs.readFileSync("CHANGELOG.md", "utf8"),
      version,
    );
    if (output) fs.writeFileSync(output, notes, "utf8");
    else process.stdout.write(notes);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
