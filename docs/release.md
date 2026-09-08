# GitHub 发布流程

版本遵守 Semantic Versioning：修复为 PATCH，兼容新增为 MINOR，不兼容变更为 MAJOR。当前发布流程仅接受正式版本 `X.Y.Z`，Tag 必须精确为 `vX.Y.Z`。

## 准备版本

1. 更新 `main`，从 `codex/release-vX.Y.Z` 分支准备发布。
2. 把 `CHANGELOG.md` 的 Unreleased 内容移到唯一的 `## [X.Y.Z] - YYYY-MM-DD` 小节，并保留空的 Unreleased 小节。
3. 在本版纪要写明 `数据库迁移：无。`，或写明迁移版本、变化和已有数据的处理方式。这是发布的必填信息。
4. 同步 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`，更新 `package-lock.json` 与 `src-tauri/Cargo.lock` 中的项目版本。应用关于页从项目版本读取。
5. 在本地完成与 CI 相同的检查，再提交和推送发布准备分支。

以下示例以 `0.6.0` 为例，后续发布时替换版本号：

```powershell
git switch main
git pull --ff-only origin main
git switch -c codex/release-v0.6.0
# 此时编辑版本文件和 CHANGELOG，再更新锁文件。
npm install --package-lock-only --ignore-scripts
npm run desktop:check
npm ci
npm run version:check -- --tag v0.6.0
node scripts/release-notes.mjs v0.6.0
npm run format:check
npm run lint
npm run typecheck
npm run test
node --test scripts/test-release.mjs
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml
git diff --check
git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json CHANGELOG.md
git commit -m "chore: prepare v0.6.0 release"
git push -u origin codex/release-v0.6.0
```

如果本机终端没有加载 Visual Studio C++ 环境，Rust 检查可使用 README 中的 `desktop:check`、`desktop:clippy`、`desktop:test` 包装命令。检查失败时先修复，不能跳过后继续发布。

## 创建 Tag

发布准备分支合并后，等待 `main` 对应提交的 CI 全部通过，然后打 Tag。Tag 必须指向已合并到 `main` 的提交；不要移动或覆盖已发布的 Tag。

```powershell
git switch main
git pull --ff-only origin main
npm run version:check -- --tag v0.6.0
git tag -a v0.6.0 -m "DayMate v0.6.0"
git push origin v0.6.0
```

## 自动发布顺序

`.github/workflows/release.yml` 复用 `ci.yml` 的完整质量检查，保证 PR、main 和 Tag 发布执行相同门禁：格式、Lint、类型检查、前端测试、发布脚本测试、前端构建、版本一致性、Rust fmt、Clippy 与 Rust 测试。Rust 依赖使用锁文件。

仓库通过 `.gitattributes` 与 `.prettierrc.json` 统一使用 LF 换行，即使 Windows Git 开启 `core.autocrlf=true`，新检出的源文件也保持 LF。已有工作目录更新规则后可运行 `npx prettier --write .` 统一格式，再执行格式检查；不要通过关闭门禁解决换行差异。

通过后，发布工作流按以下顺序执行：

1. 验证 Tag 与三个版本文件、两个锁文件一致，且提交属于 `main`。
2. 仅从 `CHANGELOG.md` 的对应版本提取 Release Notes，验证日期、更新内容与数据库迁移说明，并附加下载和校验说明。
3. 使用 Tauri 官方构建 Action 生成 Windows x64 安装包。
4. 在 GitHub 托管 Windows runner 上静默安装刚生成的安装包，运行安装与启动冒烟测试。
5. 计算安装包 SHA-256，创建或续传未公开的 Release 草稿，上传安装包和 `SHA256SUMS.txt`。
6. 核对两个远端资产的名称、大小和上传完成状态；GitHub 返回摘要时一并核对 SHA-256。
7. 全部成功后才公开 Release，并设置为最新版本。

`scripts/smoke-windows.ps1` 仅允许在 GitHub 托管 Windows runner 执行，不在开发者电脑或自托管机器安装测试副本。测试使用 `RUNNER_TEMP` 下的唯一安装目录、独立 `DAYMATE_DATA_DIR` 与 WebView 缓存：确认 NSIS 安装成功、SQLite 文件头有效、主进程持续存活，以及第二次启动正常退出且原实例仍存活。结束时只清理本次启动的进程及其子进程，临时安装和数据随托管 runner 销毁。

冒烟测试没有验证界面渲染、按钮交互、音乐播放、通知、开机启动或重启后的行为，也不代表这些场景已通过验收；它们仍需后面的人工验收。测试失败会阻止安装包公开发布。

普通用户从 [最新版本下载页](https://github.com/zhangweiguo9719-web/daymate-desktop/releases/latest) 下载 `DayMate_X.Y.Z_x64-setup.exe` 即可，不需要开发环境。正式中文更新说明以 CHANGELOG 为准，GitHub 自动提交列表不替代它。

## 失败与重试

- 编译、检查、上传或校验失败时，流程会停止；已经创建的草稿保持未公开，可重跑失败的工作流。
- 重跑只允许补全草稿。若该版本已经公开，流程拒绝覆盖安装包，请使用新的补丁版本发布修复。
- 同一个 Tag 的发布串行执行，防止并发运行互相覆盖资产。
- 不手动公开缺少安装包或 SHA256 校验文件的草稿；先检查 Actions 错误并修复。

## 人工验收

- 在干净 Windows 10/11 环境安装，并对照 `SHA256SUMS.txt` 核验下载文件。
- 完成首次引导、创建任务、专注 5 分钟。
- 使用两个应用，离开电脑后核对统计。
- 验证暂停记录、标题默认关闭、删除活动数据。
- 验证托盘退出、重复启动单实例以及卸载。
- 从旧版升级，核对活动数据、任务和设置仍然存在；有迁移时按本版更新说明检查。
