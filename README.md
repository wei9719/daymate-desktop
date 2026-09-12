<p align="center">
  <img src="src-tauri/icons/icon.png" width="128" alt="DayMate 图标" />
</p>

# DayMate 日伴

> 每天开机，陪你回顾昨天、安排今天，也给生活添一点乐趣。

DayMate 是一款 Windows 优先、本地优先的桌面陪伴应用。它不是企业监控软件，也不是要求用户维护复杂清单的项目管理工具。它只想帮用户看见昨天、选出今天最值得做的一件事，并更轻松地开始。

当前版本：`0.8.0`（MVP 开发版）

[⬇️ 直接下载 DayMate 0.8.0 Windows 安装包](https://github.com/zhangweiguo9719-web/daymate-desktop/releases/download/v0.8.0/DayMate_0.8.0_x64-setup.exe) · [查看最新版本](https://github.com/zhangweiguo9719-web/daymate-desktop/releases/latest) · [中文使用手册](USER_GUIDE.md) · [自带 API Key 配置指南](docs/ai-setup.md)

想看懂代码为什么这样设计？从[工程手册：架构、数据流与岗位能力映射](docs/engineering-handbook.md)开始，再看[截至 2026-09-12 的论文、官方项目与技术取舍](docs/research-and-decisions-v0.8.0.md)。本版[验证记录](docs/verification-v0.8.0.md)单独列出已通过检查和仍需真机验证的部分。

## 已实现

- 五步首次引导：昵称、身份、陪伴语气、隐私说明、第一项任务
- 今日首页：问候、今日三件事、规则选任务、每日精神补给
- 任务：新增、完成、删除、优先级、预计时间、截止日期
- 专注模式：截止时刻倒计时、暂停/继续、提前完成；隐藏后继续计时、重新打开恢复当前会话
- 每日内容：好句、应用内智能音乐、轻松一刻、微挑战；音乐与其他卡片独立切换
- 音乐偏好与搜索：智能、专注、国风民乐、古典、自然、电子六类，支持本地歌曲导入
- 心情音乐：选择场景、心情与“陪伴此刻 / 提一点精神”，无需 AI 也可获得最多五首候选及基于真实元数据的解释
- 本机音乐反馈：喜欢、不喜欢、撤销和清除；推荐结合反馈及近期播放去重，找歌保留搜索相关顺序
- 播放控制：随机推荐、自动连播、顺序播放、单曲循环；切换页面或收起窗口后继续播放
- 浮动球播放律动，以及托盘/浮动球原生右键退出菜单
- 键鼠活跃判断：展示鼠标点击、键盘按键和最近输入时间，避免亮屏造成使用时长误判
- 应用级时间分析：真实程序图标、应用停留时长与占比、横向排行图和环形分布图（最多展示当日前 100 项，原记录保留）
- 四首 CC0 音乐随应用离线提供，网络曲库不可用时也能播放
- 每日舒适背景：七套柔和渐变按日期稳定轮换，也可随时手动换景
- 多 AI 服务商设置与连接测试，包含硅基流动通义千问预设；API Key 安全保存到 Windows 凭据管理器
- 按服务商记住地址和模型，显式获取可用模型并筛选；保持手动输入及具体排错提示
- 按自选场景、心情和时段推荐音乐，独立生成原创鼓励；临时推荐不会覆盖长期音乐偏好
- AI 发送预览、默认关闭的活动汇总分享、每日请求上限、近期结果缓存、失败本地回退
- 系统开机启动读写与撤销、保留数据目录、专注完成提醒及测试通知
- 隐私控制：活动记录、窗口标题、空闲检测开关和二次确认删除
- Windows 活动采集后端：前台进程、可选窗口标题、5 分钟空闲排除、60 秒批量落库
- SQLite 数据库：WAL、迁移记录、会话索引、本地日期历史查询和真实昨日简报；正常退出确认写入待保存活动
- 系统托盘基础入口
- 可拖动桌面浮动球：收起主窗口后常驻桌面，点击恢复
- 深浅主题、本地状态持久化、前端测试、版本一致性检查
- 安全与兼容加固：密钥绑定接口、浮球最小权限、事务迁移、损坏设置恢复备份和云端双 Windows 安装验证

## 应用截图

![DayMate 0.2.0 今日主界面与 Audius 音乐推荐](docs/screenshots/daymate-dashboard-v0.2.0.png)

![DayMate 桌面浮动球](docs/screenshots/daymate-floating-ball.png)

![DayMate 0.3.0 键鼠活跃时间回顾](docs/screenshots/daymate-review-v0.3.0.png)

## 技术栈

| 层         | 技术                                            | 用途                                                 |
| ---------- | ----------------------------------------------- | ---------------------------------------------------- |
| 桌面容器   | Tauri 2                                         | 窗口、托盘、安装包、Rust 命令桥接                    |
| 前端       | React 19 + TypeScript + Vite 7                  | 页面和交互                                           |
| 状态       | Zustand                                         | 用户设置与任务状态，本地持久化                       |
| UI         | 原生 CSS + Lucide React                         | 轻量界面与图标                                       |
| 桌面后端   | Rust + Windows Icons                            | Windows 活动采集、本机程序图标提取、隐私边界、数据库 |
| 本地数据库 | SQLite / rusqlite                               | 应用使用会话与迁移记录                               |
| 音乐       | Audius API + 本地可解释排序 + 单一 Audio 控制器 | 真实目录候选、心情/反馈重排、跨页连播与 CC0 离线兜底 |
| AI 接口    | OpenAI 兼容协议 + Windows Credential Manager    | 多平台配置、连接测试和密钥隔离                       |
| 校验测试   | TypeScript、Vitest、Playwright、Clippy、CodeQL  | 类型、版本化合成评测、云端 UI/安装、安全与构建质量   |
| 发布       | GitHub Actions + GitHub Releases                | Tag 触发 Windows 构建和发布                          |

## 架构

```text
React UI
  ├─ 今日 / 任务 / 专注 / 每日内容 / 每日背景
  ├─ 主窗口 / 可拖动桌面浮动球
  ├─ Zustand：任务、用户偏好、可恢复专注、本机音乐反馈
  ├─ 音乐：目录召回 → 资格过滤 → 心情/反馈排序 → 单一播放控制器
  ├─ 可选 AI：发送预览 → 受控类别/鼓励 → 校验或本地回退
  └─ native.ts：唯一 Tauri 调用边界
             │ invoke
Rust / Tauri ├─ Windows 前台应用与空闲检测
             ├─ AI 密钥系统凭据存储与连接测试
             ├─ 60 秒内存聚合 + 正常退出保存确认
             └─ SQLite：活动会话 + AI 调用次数 + 迁移记录
```

关键设计说明见 [docs/architecture.md](docs/architecture.md)；详细算法权重、存储位置、AI 请求边界和岗位证据见[工程手册](docs/engineering-handbook.md)。另见[安全与兼容性说明](docs/security-compatibility.md)及[隐私边界](PRIVACY.md)。

## 项目目录

```text
daymate-desktop/
├─ src/                  # React 前端
│  ├─ data/              # 本地每日内容
│  ├─ App.tsx            # 页面和核心交互
│  ├─ store.ts           # 状态与选任务规则
│  ├─ focusStore.ts      # 当前专注会话与恢复
│  ├─ musicStore.ts      # 有界本机音乐反馈
│  ├─ features/music/   # 共享播放器、候选界面、本地导入
│  ├─ services/         # 推荐排序、AI 契约、日期和恢复规则
│  └─ native.ts          # Tauri 命令适配层
├─ src-tauri/            # Rust 桌面后端
│  ├─ src/lib.rs         # 活动采集、命令、托盘
│  ├─ src/database.rs    # 事务迁移与版本保护
│  ├─ src/ai.rs          # AI 请求、密钥绑定、预算与校验
│  └─ tauri.conf.json    # 窗口和安装包配置
├─ docs/                 # 架构、开发、发布说明
├─ scripts/              # 版本一致性检查
├─ .github/workflows/    # CI 与 Release
└─ CHANGELOG.md          # 正式更新纪要
```

## 本地运行

普通前端预览（不采集系统活动）：

```powershell
npm install
npm run dev
```

完整桌面模式：

```powershell
npm install
npm run desktop:dev
```

Windows 构建需要 Node.js、Rust MSVC 工具链、Visual Studio C++ Build Tools、Windows 10/11 SDK 和 WebView2。详见 [docs/development.md](docs/development.md)。

## 检查命令

```powershell
npm run lint
npm run format:check
npm run typecheck
npm run test
npm run eval:music
npm run build
npm run version:check
node --test scripts/test-release.mjs
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

## 构建安装包

```powershell
npm run desktop:build
```

成功后产物位于：

```text
src-tauri/target/release/bundle/nsis/
```

普通用户不需要安装 Node.js 或 Rust，只需从 GitHub Releases 下载 `setup.exe` 安装包。

## GitHub 发布

1. 把所有用户可见修改写入 `CHANGELOG.md` 的 `[Unreleased]`。
2. 发布时移动到版本段，并同步三个版本号。
3. 合并到 `main` 并等待 CI 通过，再创建并推送 `vX.Y.Z` Tag。
4. GitHub Actions 校验 Tag、执行同一套质量检查，从 CHANGELOG 提取说明；构建并验证安装包及 SHA256 文件后公开 Release。

完整流程见 [docs/release.md](docs/release.md)。

## 隐私承诺

- 默认记录应用名称和活跃时长；窗口标题默认关闭。
- 不记录键盘输入、不截屏、不读取聊天与文档正文。
- 活动数据默认只保存在本机 SQLite。
- AI Key 只保存在 Windows 凭据管理器；普通配置中不保存或回显完整密钥。
- 智能音乐会向 Audius 发送场景检索词、目标心情标签或主动输入的搜索词，并加载所选音频；不发送任务标题、活动明细、本机反馈或近期播放列表。
- 心情由用户选择，不根据键鼠输入推断；本机反馈最多 200 条，可清除，不上传 AI。
- 本仓库附带的 D 盘启动脚本把开发数据保存到 `D:\DayMate\data`；正式安装版默认遵循系统应用数据目录。
- 当前 MVP 不包含账号、云同步或活动数据上传。
- 所有记录开关可关闭，活动数据可删除。

## 当前边界

- 当前优先支持 Windows 10/11。
- 自动安装验证使用 GitHub 托管 Windows Server 2022/2025，不等同于真实 Windows 10/11 全功能验收；目前安装包没有商业代码签名，Windows 可能显示发布者提醒。
- 新版保存 AI 密钥后若降级到旧应用，需要重新配置密钥。活动数据库仍为 v5，升级前建议备份数据。
- 任务与偏好当前由 WebView 本地存储保存；活动记录使用 SQLite。后续版本会统一迁移至 SQLite。
- 开机自启与通知通过 Tauri 官方插件实现；Windows 勿扰模式可能隐藏通知横幅，设置页提供系统状态和测试按钮。
- AI 已用于场景音乐与独立鼓励；每日自然语言总结和 AI 图片生成尚未上线。背景继续本地轮换，不自动消耗生图额度。
- 音乐排序是可解释规则，不是训练后的推荐模型。固定合成评测不代表真实满意度；开放目录不保证收录所有中文商业歌曲。
- 日历史查询与当前专注恢复已实现；周视图、完整专注历史、任务编辑/重复规则、统一 SQLite 迁移和完整备份恢复仍需后续开发。岗位映射说明的是可展示工程能力，不保证覆盖所有职位要求。

## 开源协议

[MIT](LICENSE)
