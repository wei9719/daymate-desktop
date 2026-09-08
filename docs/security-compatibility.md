# v0.6.1 安全与兼容性验证记录

记录日期：2026-09-08。目标版本：v0.6.1。本页区分本地验证证据与云端发布门禁；云端实际结果以本版 [Actions 运行记录](https://github.com/zhangweiguo9719-web/daymate-desktop/actions/workflows/release.yml)为准，不代表软件不存在未知风险。

## 已执行的检查

最终本机源码回归：前端 106 项、Rust 34 项、发布/审计/SARIF 脚本 21 项，共 161 项通过。真实供应商调用测试明确跳过，本轮不使用生产密钥。TypeScript、ESLint、Prettier、Rust fmt、Clippy 和前端构建均通过。首次并行前端运行曾因本机负载导致 worker 启动超时，降低本地并发后完整重跑通过，没有跳过失败测试。云端仍使用统一的默认测试命令。

| 检查               | 证据与结果                                                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm 全量依赖审计   | 使用官方 registry，包含开发/构建依赖；修复前 5 个受影响依赖，最小兼容更新后报告 0 个已知漏洞。未使用 `--force` 做大版本升级。                                                                           |
| RustSec 全锁审计   | `cargo-audit 0.22.2` 扫描 596 个锁定依赖；公告库含 1242 条记录，提交 `8a1eb4f933fb5821add5b4e98601ebd90b8b3538`。最终全锁 0 条 vulnerability，Windows 目标依赖 0 条 unsound，仍有 18 条警示，详见下文。 |
| 发布与安全策略脚本 | `node --test scripts/test-release.mjs scripts/test-audit-rust.mjs scripts/test-check-sarif.mjs`：21 项通过，覆盖版本/Tag/更新纪要、Actions SHA、RustSec 故障拒绝及真实 CodeQL 报告结构和高危阻断。      |
| 静态脚本检查       | 相关 JavaScript 的 ESLint 通过；PowerShell smoke 与工作流内嵌脚本完成语法解析；合成旧库 SQL 在内存 SQLite 中执行验证通过。                                                                              |

这些操作没有启动或安装本机旧版/新版 DayMate，没有读取真实用户数据库，也没有调用用户的 AI Key。

应用侧同时实施密钥与接口地址绑定、主窗口/浮球独立原生命令权限、音乐返回值校验与大小限制、事务迁移、损坏设置恢复副本，以及暂停/删除/午夜/休眠的采样边界保护。旧 WebView 若不支持流式读取响应，会使用离线曲目，不依赖不可信的 Content-Length 放开响应大小限制；详见[技术架构](architecture.md)与[隐私说明](../PRIVACY.md)。

### 本次修复的 Rust 依赖

- `event-listener 5.4.1 → 5.4.2`：移除可修复的线程安全警示，修复版本依据 [RUSTSEC-2026-0221](https://rustsec.org/advisories/RUSTSEC-2026-0221.html)。
- `chacha20 0.10.1 → 0.10.2`：替换已被撤回的版本，新版本状态查自 [crates.io 官方版本记录](https://crates.io/crates/chacha20/versions)。

只更新指定包和所需锁条目，不进行全量依赖大版本升级。

### 保留并公开的间接依赖警示

| 类别                           | 当前情况与处理                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Windows 依赖元数据中的停维护包 | `paste 1.0.15`、`unic-char-property`、`unic-char-range`、`unic-common`、`unic-ucd-ident`、`unic-ucd-version`。共 6 条；不等同于已确认的可利用漏洞，但存在长期维护风险，需跟进上游替换。参见 [paste 公告](https://rustsec.org/advisories/RUSTSEC-2024-0436.html)、[unic 公告示例](https://rustsec.org/advisories/RUSTSEC-2025-0081.html)。        |
| 非 Windows 依赖链              | GTK3 相关 10 条和 `proc-macro-error` 1 条停维护警示，另有 `glib 0.18.5` 的 unsound 警示。glib 的修复需要升级到不兼容的 0.20 系列，不能强行替换 Tauri/GTK3 所需依赖。参见 [GTK3 公告](https://rustsec.org/advisories/RUSTSEC-2024-0415.html)、[glib 公告](https://rustsec.org/advisories/RUSTSEC-2024-0429.html)。本版本不据此宣称 Linux 可发布。 |

没有为这些包添加 RustSec `ignore`。Windows 归属来自当前默认特性下的依赖元数据，不是手写排除表；它包含构建依赖，不是“这些代码必然进入最终 exe”的证明。新增特性或平台时必须重新评估。

## 持续安全门禁

CodeQL 直接检查生成的 SARIF，而非只看扫描任务是否执行完成。安全分值至少 7、error 级安全结果及不完整报告会阻止发布；已有或 suppressed 的高危结果也不豁免。扫描覆盖 JavaScript/TypeScript，Rust 仍采用编译检查、单元测试和依赖审计，不宣称已做 Rust CodeQL 分析。Tag 执行同样扫描和门禁，仅不上传告警/数据库，避免上传行为干扰发布兼容性。

门禁曾回放提交 `a8d8dec` 的真实 CodeQL 2.26.4 报告（分析编号 `1738436364`）：正确识别 1 条 `js/xss-through-dom`、安全分值 7.8，并返回失败。报告中的标准扩展规则引用也有回归测试；音频导入补丁后的扫描结论以本版最终云端记录为准，没有手工忽略该规则或关闭告警。

`dependency-audit.yml` 供 CI/Release 复用，也支持手动和每周运行：

1. 官方 npm registry 审计整个锁文件，明确包含 dev；high/critical 导致失败，较低等级仍显示在报告中。阈值含义参见 [npm audit 文档](https://docs.npmjs.com/cli/v11/commands/npm-audit/)。
2. 固定安装 `cargo-audit 0.22.2 --locked`，下载当前 RustSec 公告库，不使用过期数据库绕过检查。
3. `scripts/audit-rust.mjs` 阻断全锁的所有 vulnerability；再依据 `cargo metadata --locked --filter-platform x86_64-pc-windows-msvc` 阻断 Windows 依赖中的 unsound。公告、解析或依赖元数据失败不会被当作通过，所有维护/撤回等警示逐条输出。拒绝隐藏的 ignore、平台或严重级别过滤。元数据语义见 [Cargo 官方文档](https://doc.rust-lang.org/cargo/commands/cargo-metadata.html)。

复现安全检查：

```powershell
npm audit --package-lock-only --include=dev --audit-level=high --registry=https://registry.npmjs.org
cargo install cargo-audit --version 0.22.2 --locked
node --test scripts/test-release.mjs scripts/test-audit-rust.mjs
node scripts/audit-rust.mjs
```

依赖公告会继续变化，“今天没有匹配到漏洞”不是永久安全承诺。自定义开发盘可通过 `CARGO_HOME` 和 `RUSTSEC_DATABASE_PATH` 将工具缓存及公告库存放到非系统盘。

## 发布供应链

所有外部 Actions 固定完整提交 SHA，checkout 不保留 Git 凭据；默认只有 `contents: read`。只有最后上传发布的 job 拥有 `contents: write`，编译、安装和测试 job 没有仓库写权限。CodeQL 仅在自己的分析 job 获得 `security-events: write`。这些措施依据 [GitHub 官方安全建议](https://docs.github.com/en/actions/reference/security/secure-use)。

发布顺序：统一 CI/审计 → 验证版本、Tag 属于 main、CHANGELOG 对应版本 → 构建一次 → 保存不可变 artifact → 四组安装 smoke → 创建草稿并上传 exe/校验和 → 校验资产 → 正式公开。测试与发布下载同一个 artifact ID，不重新构建“未经测试的另一份包”。重跑使用独立 artifact 名称；已经公开的 Release 拒绝覆盖。

SHA256 校验和用于下载完整性检查，不等同于 Windows Authenticode 签名；本流程没有借此宣称解决 SmartScreen 信誉或代码签名问题。

## 云端兼容测试范围

v0.6.1 采用以下测试矩阵；这是发布必须执行的门禁，不将配置文件本身视为测试成功。四组全部通过后，工作流才会公开 Release，运行链接会附在本版发布说明中。

| GitHub runner  | 空白数据启动 | 合成 v4 活动数据升级 |
| -------------- | ------------ | -------------------- |
| `windows-2022` | 必须通过     | 必须通过             |
| `windows-2025` | 必须通过     | 必须通过             |

每组在独立 GitHub 托管机器上，将同一个 NSIS 安装包静默安装到带中文和空格的路径，并使用独立的 `DAYMATE_DATA_DIR` 和 WebView 数据目录。检查安装文件、有效 SQLite、首次进程持续存活、第二次启动正常退出且原进程仍在。旧库用例只使用虚构记录，并验证升级到 schema v5 后活动秒数、点击/按键数和路径没有丢失。脚本有托管 Windows runner 守卫，最终只清理自己启动的进程。

NSIS 的安装目录参数顺序依据 [NSIS 官方说明](https://nsis.sourceforge.io/Docs/Chapter3.html)；跳过快捷方式等开关依据 [Tauri 的 NSIS 模板](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi)。

### 尚未验证、不能由 smoke 代替的项目

- GitHub 的 Windows 2022/2025 runner 是 Windows Server 镜像，不是 Windows 10/11 客户端实机测试，见 [官方镜像列表](https://github.com/actions/runner-images)。
- 没有验证完整 UI、键鼠点击交互、通知、自启动/重启、托盘和音乐播放体验。
- 合成数据库升级不等于所有历史版本的安装器原地升级；没有读取或覆盖用户真实旧数据。
- 不覆盖 ARM64、32 位 Windows、Linux/macOS、所有显卡/WebView/输入法组合或长时间压力测试。

客户端体验仍需要独立的 Windows 10/11 人工验收；不要把上述安装 smoke 描述为所有界面功能或长期使用场景已通过。
