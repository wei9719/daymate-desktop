# 开发说明

## 前置环境

- Windows 10/11
- Node.js 22 LTS（CI 使用此版本）
- Rust stable MSVC
- Visual Studio 2022：`Desktop development with C++`
- Windows 10/11 SDK
- WebView2 Runtime

Tauri 官方 Windows 环境要求同时包含 Microsoft C++ Build Tools 与 WebView2。

## 安装与运行

```powershell
git clone https://github.com/zhangweiguo9719-web/daymate-desktop.git
cd daymate-desktop
npm ci
npm run tauri dev
```

只调前端时使用 `npm run dev`，此时 `native.ts` 返回安全空数据，不会采集桌面活动。

`npm run desktop:dev` 会自动发现 Visual Studio、Windows SDK 和仓库同级 Rust 工具链，把开发数据写到仓库父目录的 `data`，临时文件和 npm 缓存写到父目录的 `.cache`。本机项目位于 D 盘时，这些文件也留在 D 盘。直接运行应用时可以通过 `DAYMATE_DATA_DIR` 指定自定义目录。脚本会返回实际构建退出码。

## 质量检查

```powershell
npm run lint
npm run format:check
npm run typecheck
npm run test
npm run build
npm run version:check
node --test scripts/test-release.mjs
node --test scripts/test-audit-rust.mjs
node --test scripts/test-check-sarif.mjs
npm audit --include=dev --audit-level=high --registry=https://registry.npmjs.org
cargo install cargo-audit --version 0.22.2 --locked
node scripts/audit-rust.mjs
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

## 开发约束

- 用户可见改动必须更新 `CHANGELOG.md`。
- 不采集键盘输入、截图、正文内容。
- 不在日志中记录 API Key、窗口标题或任务全文。
- 数据库结构只通过迁移前进，不删除重建用户数据库。
- 新系统能力先放 Rust，再通过 `native.ts` 暴露给前端。
- 新增原生命令必须加入 `build.rs` 的 AppManifest，再明确授权对应窗口；不要恢复 `core:default` 或给浮球授予数据/密钥权限。自动生成的命令权限由构建脚本生成，手工修改 capability。
- 修改兼容逻辑需覆盖旧数据库、损坏存储、午夜、暂停/恢复和休眠等边界；升级测试只用合成数据。

AI 自动化测试只使用临时 SQLite 与本机 HTTP 服务，不需要生产 Key，不会发送个人数据。实测供应商接口应通过应用设置中的测试连接，并使用少量请求。工程决策见 [AI 工程复查](ai-development-review.md)。

维护者在已保存自己的硅基流动密钥并同意实际请求后，可执行 `powershell -NoProfile -File scripts/windows-desktop.ps1 live-ai-test` 验证 Qwen3-8B 的模型目录、连接、场景音乐和独立鼓励。该显式检查最多使用 6 次请求预算，只发送固定短句与虚构场景，不启动桌面 UI；普通 `cargo test` 与 CI 默认跳过，不读取生产凭据。测试数据库与临时文件仍放在仓库父目录的 `.cache/tmp`，这份预算独立于用户日常数据库。更多说明见 [AI 配置指南](ai-setup.md)和[实测记录](ai-verification.md)。

浏览器截图与交互测试使用精确锁定的 Playwright，仅在 GitHub 托管 Linux 工作流执行 `npm run test:ui`；不要在用户电脑下载浏览器或伪造环境变量绕过 cloud-only 守卫。本地可用 `npm run test:ui -- --list` 检查测试发现，它不会启动浏览器。测试从虚构偏好启动，音乐接口固定为明确的测试样例，不注入 Tauri 内部对象或生产 Key；结果不能代替原生 IPC 和真实流媒体验证。CI/Release 会保存设置、每日内容截图和失败证据。

`--daymate-data-dir-base64=` 是应用注册开机启动时生成的内部参数，用于保留含空格或中文的数据目录。一般开发时使用 `DAYMATE_DATA_DIR` 即可。为其他主机配置 `TAURI_DEV_HOST` 时，需要在 `devCsp` 中添加对应的开发 WebSocket 地址；生产策略不受影响。
