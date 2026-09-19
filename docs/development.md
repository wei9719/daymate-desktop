# 开发说明

适用于 v0.9.0 源码。下面列出开发与验证入口，不代表本版已经通过全部检查或完成发布；结果以对应 GitHub Actions 和 Release 为准。

## 前置环境

- Windows 10/11
- Node.js 22 LTS（CI 使用此版本）
- Rust stable MSVC
- Visual Studio 2022：`Desktop development with C++`
- Windows 10/11 SDK
- WebView2 Runtime

Tauri 官方 Windows 环境要求同时包含 Microsoft C++ Build Tools 与 WebView2。

Python、PyTorch 和模型不是桌面基础功能的必需依赖。只有复用已有本地模型时才需要相应环境；打包桌面应用不会自动下载或捆绑它们。

## 安装与运行

```powershell
git clone https://github.com/wei9719/daymate-desktop.git
cd daymate-desktop
npm ci
npm run tauri dev
```

只调前端时使用 `npm run dev`，此时 `native.ts` 返回安全空数据，不会采集桌面活动。

`npm run desktop:dev` 会自动发现 Visual Studio、Windows SDK 和仓库同级 Rust 工具链，把开发数据写到仓库父目录的 `data`，临时文件和 npm 缓存写到父目录的 `.cache`。本机项目位于 D 盘时，这些文件也留在 D 盘。直接运行应用时可以通过 `DAYMATE_DATA_DIR` 指定自定义目录。脚本会返回实际构建退出码。

## 可选：已有本地模型服务

准备已经安装兼容 `torch`、`transformers` 与 safetensors 支持的 Python 环境，以及完整 `Qwen2.5-1.5B-Instruct` 模型目录。在对应版本源码根目录执行：

```powershell
$PythonPath = Read-Host '已有 Python 可执行文件的完整路径'
$ModelPath = Read-Host '已有 Qwen2.5-1.5B-Instruct 模型目录的完整路径'
./scripts/local-ai.ps1 -Action start -PythonPath $PythonPath -ModelPath $ModelPath
./scripts/local-ai.ps1 -Action status
```

服务隐藏启动，显示 `loading` 不等于已完成加载。等待后手动检查，在 DayMate 设置中选择“本地模型（已有文件）”，使用 `http://127.0.0.1:8765/v1` 和 `Qwen2.5-1.5B-Instruct`，点击“检查本地模型状态”。就绪后可获取模型、测试连接，再通过发送预览确认音乐或鼓励请求。模型路径由启动脚本接收，不是设置里的 Base URL。

链路为 **React 设置/确认 → `native.ts` → Rust 校验/预算 → 回环 HTTP → `local_ai/server.py` → `runtime.py` 离线加载的 Qwen → 文字/受限类别 → Rust 输出校验或规则回退**。这是独立 Python 服务，不直接调用原项目的 LLM-Twin RAG、聊天记录、LoRA 或业务模块。模型不生成图片或实际歌曲，在线音乐目录仍由原音乐模块独立访问。

没有云端 Key，不自动下载、复制或修改模型，不自动安装 Python/CUDA；文件不完整时报告错误。服务仅监听本机、单路推理、有界输入/输出，不能转发到公网。选择服务商或启动桌面应用不会拉起模型；退出桌面应用也不会停止服务。释放资源请显式执行：

```powershell
./scripts/local-ai.ps1 -Action stop
```

默认运行目录是仓库父目录的 `runtime/local-ai`，保存状态、日志、临时目录和依赖缓存；模型仍留在原目录。可通过 `-RuntimeDir` 指定其他非系统盘目录，此后启停与状态检查保持同一参数。`-Port` 默认 8765，改端口后同步应用 Base URL。启动脚本仅管理可验证归属的本次服务进程树，不批量终止其他 Python 任务。

模型推理会占用内存/显存，健康就绪不证明真实文本生成成功。无 Key 回环服务不能认证本机其他进程；提示词与回答不写日志，但进程状态文件可能含个人路径，不要公开整个运行目录。完整准备、安全限额和排错见[本地模型指南](local-ai.md)。

## 质量检查

```powershell
npm run lint
npm run format:check
npm run typecheck
npm run test
npm run eval:music
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
$env:PYTHONDONTWRITEBYTECODE = '1'
python -m unittest discover -s local_ai/tests -v
./scripts/test-local-ai-launcher.ps1
```

最后两项只需 Python 标准库和 PowerShell：使用假加载器检查本地协议与脚本纯函数，不下载模型、不使用 GPU、不启动或停止真实推理进程。它们不能证明 safetensors、CUDA、回答质量或真实进程树退出通过；真实推理与资源释放应单独显式验收并记录边界。

## 开发约束

- 用户可见改动必须更新 `CHANGELOG.md`。
- 不采集键盘输入、截图、正文内容。
- 不在日志中记录 API Key、窗口标题或任务全文。
- 数据库结构只通过迁移前进，不删除重建用户数据库。
- 新系统能力先放 Rust，再通过 `native.ts` 暴露给前端。
- 新增原生命令必须加入 `build.rs` 的 AppManifest，再明确授权对应窗口；不要恢复 `core:default` 或给浮球授予数据/密钥权限。自动生成的命令权限由构建脚本生成，手工修改 capability。
- 修改兼容逻辑需覆盖旧数据库、损坏存储、午夜、暂停/恢复和休眠等边界；升级测试只用合成数据。
- 本地模型协议变更同步 Python、Rust、设置页与 `docs/local-ai.md`；保留离线加载、回环绑定、有限并发/输入和无密钥分支，不把权重、运行目录或个人路径提交仓库。

AI 自动化测试只使用临时 SQLite、本机假 HTTP 服务与假模型加载器，不需要生产 Key，不会发送个人数据；不要把假服务测试当成真实 Qwen 推理。实测供应商接口应使用独立诊断或应用设置中的测试连接，并限制请求量。工程决策见 [v0.8.0 研究与取舍](research-and-decisions-v0.8.0.md)，代码链路见[工程手册](engineering-handbook.md)。

维护者在已保存自己的硅基流动密钥并同意实际请求后，可执行 `powershell -NoProfile -File scripts/windows-desktop.ps1 live-ai-test` 验证 Qwen3-8B 的模型目录、连接、三组场景/心情/意图及独立鼓励。该显式检查最多使用 6 次请求预算，只发送固定短句与虚构场景，不启动桌面 UI；普通 `cargo test` 与 CI 默认跳过，不读取生产凭据。测试数据库与临时文件仍放在仓库父目录的 `.cache/tmp`，这份预算独立于用户日常数据库。更多说明见 [AI 配置指南](ai-setup.md)和 [v0.8.0 历史实测记录](verification-v0.8.0.md)，历史结果不代表 v0.9.0 或本地模型已通过。

资源较紧张的开发机可使用 `npm run test -- --maxWorkers=1` 和 `$env:CARGO_BUILD_JOBS='1'` 限制并发，不通过跳过检查解决内存不足。避免模型冷加载与大型 Node/Rust 检查同时争用内存；完成真实推理后先显式停止所管理服务，再顺序验证。CI 使用独立 runner 完成同一套测试，不依赖个人 GPU 或权重。

`vitest.config.ts` 把单元测试发现范围限定在 `src/**/*.test.{ts,tsx}`，避免扫描 Rust 构建目录；React 转换仍使用 Vite 官方插件。浏览器 e2e 不混入 Vitest，新增单元测试放在相邻源码目录。

浏览器截图与交互测试使用精确锁定的 Playwright，仅在 GitHub 托管 Linux 工作流执行 `npm run test:ui`；不要在用户电脑下载浏览器或伪造环境变量绕过 cloud-only 守卫。本地可用 `npm run test:ui -- --list` 检查测试发现，它不会启动浏览器。测试从虚构偏好启动，音乐接口固定为明确的测试样例，不注入 Tauri 内部对象或生产 Key；结果不能代替原生 IPC 和真实流媒体验证。CI/Release 会保存设置、每日内容截图和失败证据。

本地模型的浏览器用例只验证选项、免 Key 界面和原生不可用说明，不连接真实健康接口、不自动启动模型，也不把静态按钮状态当成推理成功。

`--daymate-data-dir-base64=` 是应用注册开机启动时生成的内部参数，用于保留含空格或中文的数据目录。一般开发时使用 `DAYMATE_DATA_DIR` 即可。为其他主机配置 `TAURI_DEV_HOST` 时，需要在 `devCsp` 中添加对应的开发 WebSocket 地址；生产策略不受影响。
