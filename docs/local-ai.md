# 本地 AI：复用已有模型，免 API Key

适用于 DayMate 0.9.0；说明核对日期：2026-09-20。本功能是可选增强，任务、统计、本地内容与心情音乐排序仍不需要模型。

## 它是什么，不是什么

DayMate 的 `local_ai/` 是独立 Python 文本推理服务，使用已有的 PyTorch、Transformers 环境与 `Qwen2.5-1.5B-Instruct` safetensors 模型。桌面应用经 Rust 请求回环地址，再把结果交给原有的内容和推荐逻辑。

- 不需要商汤、硅基流动或其他云端 API Key；不会自动换用云端服务。
- 不下载、复制、训练或修改模型，不自动安装 Python/CUDA 依赖。
- 不读取其他项目的 RAG、聊天日志、LoRA 或业务模块；复用模型文件不等于复用那个项目的记忆。
- 不自动启动、更新或操作本机已有 DayMate，也不自动关闭其他模型进程。
- 模型和 Python 环境不包含在 Windows 安装包内。普通下载用户不配置此功能也能使用基础应用；已有模型的开发者需取得对应版本源码中的服务与启动脚本。
- 只生成文字和受限音乐类别，不生成图片、不操控电脑、不把商业歌曲变为免费曲目。在线音乐目录与流媒体仍可能联网。

## 需要准备什么

1. 已存在的 Python 可执行文件，所在环境已安装兼容的 `torch`、`transformers`、`accelerate` 和 `safetensors`。`accelerate` 用于显式设备映射；已测版本组合见验证记录。
2. 已存在的完整 `Qwen2.5-1.5B-Instruct` 模型目录，包含配置、分词器和 safetensors 权重；仅有一个权重文件通常不足以加载。
3. 足够的可用内存/显存。本指南不保证所有 GPU、驱动或 Python 组合都能运行，也不承诺固定生成速度。
4. DayMate 源码中的 `local_ai/` 和 `scripts/local-ai.ps1`，从项目根目录执行以下命令。

服务只从显式选定目录离线加载，缺文件或依赖不兼容时失败，不通过自动下载来补齐。模型加载使用 `local_files_only=True`、`use_safetensors=True`、`trust_remote_code=False` 及离线环境变量。该做法依据 [Transformers 离线模式](https://huggingface.co/docs/transformers/installation#offline-mode)与[本地模型加载参数](https://huggingface.co/docs/transformers/main_classes/model#transformers.PreTrainedModel.from_pretrained)。请使用可信来源文件，并遵守 [Qwen 官方模型卡和许可证](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct)，不要把已有权重、Python 环境或私有数据提交到 DayMate 仓库。

## 启动、查看状态和停止

下面的交互输入只用于填写自己已有的路径，没有预置维护者电脑路径，也不会下载任何内容。

```powershell
# 当前目录应为 daymate-desktop 源码根目录。
$PythonPath = Read-Host '已有 Python 可执行文件的完整路径'
$ModelPath = Read-Host '已有 Qwen2.5-1.5B-Instruct 模型目录的完整路径'
./scripts/local-ai.ps1 -Action start -PythonPath $PythonPath -ModelPath $ModelPath
./scripts/local-ai.ps1 -Action status
```

`start` 隐藏后台启动服务，看到 `loading` 即可返回，不会等到 GPU 模型加载结束。等待后再次执行 `status`，确认健康状态再在 DayMate 中测试生成。`loading` 不是成功生成，服务端口能连通或模型目录有名称也不是推理通过的证据。

只有 `start` 需要 Python 和模型路径；`status`、`stop` 不需要重新提供它们。

```powershell
./scripts/local-ai.ps1 -Action stop
```

默认运行目录为项目目录上一级的 `runtime/local-ai`，不是系统用户目录。运行状态、日志、临时目录和依赖缓存都放在运行目录中，不修改模型目录。若项目位于非系统盘，默认运行目录也跟随放在那里。也可显式指定已有的非系统盘位置；此后 `start/status/stop` 必须使用同一个 `RuntimeDir`：

```powershell
$RuntimeDir = Read-Host '本次服务的运行目录完整路径'
./scripts/local-ai.ps1 -Action start -PythonPath $PythonPath -ModelPath $ModelPath -RuntimeDir $RuntimeDir
./scripts/local-ai.ps1 -Action status -RuntimeDir $RuntimeDir
./scripts/local-ai.ps1 -Action stop -RuntimeDir $RuntimeDir
```

启动和停止操作按规范化运行目录互斥，进程记录原子写入，避免快速重复启动覆盖记录。停止脚本校验 PID、UTC 启动时刻、可执行文件以及完整运行目录参数，持有进程句柄后，只对子进程归属仍可确认的本次进程树按子先父后停止；兼容虚拟环境 Python 把推理放在子进程中的情况。不按 `python` 名称批量结束，也不在检查后另按 PID 重新选择结束对象。若状态不匹配或端口属于其他程序，脚本报告问题，不去关闭无关程序。端口和模型锁只防止 DayMate 服务重复加载，无法阻止其他项目占用同一模型或 GPU；显存不足时请自行判断并停止不再使用的模型任务。

## 在 DayMate 中配置

1. 确认独立服务已启动并结束加载。
2. 打开“设置 → AI 服务”，选择“本地模型（已有文件）”（内部标识 `local`），此时不显示密钥输入框。
3. 默认接口根地址为 `http://127.0.0.1:8765/v1`，模型标识为 `Qwen2.5-1.5B-Instruct`；配置项可编辑，但必须对应实际本机服务。不要追加 `/chat/completions`、填入模型文件夹路径或其他平台 Key。
4. 点击“检查本地模型状态”，按“模型正在加载”“本地模型忙碌中”或错误说明处理；它不自动轮询或启动服务。健康检查不计入 AI 请求预算，也不自动改变已填模型。
5. 本地模型就绪后点击获取模型，再测试连接；只有返回合格正文才是生成成功。
6. 开启 AI 增强，在音乐推荐或独立鼓励的发送预览中确认本次字段后使用。

目录、测试和生成请求仍受 DayMate 的最小化字段、每日次数、输出校验和本地回退规则约束。单独的状态检查只读取健康信息，不消耗生成预算。浏览器预览不具备原生本地服务桥接能力，会给出对应说明；请勿把预览按钮状态当作桌面已实测。关闭 AI 开关或退出桌面应用不会自动停止独立 Python 服务，需要时执行 `stop`。

## 接口和安全边界

服务只监听 `127.0.0.1:8765`，不用于公网部署。接口使用部分兼容的文本对话结构，不等于完整云端 API：

| 接口                        | 用途与边界                                           |
| --------------------------- | ---------------------------------------------------- |
| `GET /v1/health`            | 查看当前健康/加载状态；不是生成质量验收              |
| `GET /v1/models`            | 返回本服务模型目录；不扫描其他项目的模型或记忆       |
| `POST /v1/chat/completions` | 仅非流式文字对话，模型 ID 为 `Qwen2.5-1.5B-Instruct` |

请求必须携带 `X-DayMate-Local: 1`；Host 只允许对应端口的 `127.0.0.1` 或 `localhost`，拒绝带 Origin 的请求。POST 只接受 `application/json`，请求体最多 16 KiB，最多 32 条消息、合计 6000 字符，输入最多 2048 Token、生成最多 512 个新 Token。单路推理忙时返回 429，加载中返回 503；不把无效请求排成无限队列。流式输出、工具调用、图片和任意扩展参数不属于支持范围。

这些限制降低浏览器跨站调用与无界资源使用的风险，但 **无 Key 回环服务不能认证同一电脑上的其他进程或用户**。不要放宽绑定地址、通过端口转发公开服务，也不要把该标准库 `ThreadingHTTPServer` 当作公开生产服务器。DayMate 的 Rust 桥接负责添加本地协议标记，普通浏览器直接打开接口或照搬云端 cURL 示例不一定可用。

提示词和回答只进入推理所需内存，不保存到服务日志、模型目录或活动 SQLite；错误信息不暴露模型路径、提示词或输出正文。运行目录仍可能含启动路径等本机状态信息，提交 Issue 前应检查，不要直接公开整个目录。详细数据范围见[隐私说明](../PRIVACY.md)。

## 常见问题

| 现象                   | 处理方式                                                           |
| ---------------------- | ------------------------------------------------------------------ |
| 连接被拒绝             | 先运行 `status`；确认服务已启动、端口未被其他程序占用              |
| 一直 `loading` 或 503  | 模型仍在加载；等待后检查状态，不重复启动多个服务                   |
| `error` 或模型加载失败 | 检查选定目录是否完整、依赖版本与硬件是否兼容；不会自动下载替代模型 |
| 429 忙碌               | 等待当前推理结束后再手动尝试；不连续点击制造队列                   |
| 显存或内存不足         | 先停止自己不需要的模型任务；DayMate 不会替你结束其他项目           |
| 有模型名，但生成失败   | 目录不是生成测试；检查真实短句生成，不把空正文或截断视为通过       |
| AI 已关闭但 GPU 仍占用 | 独立服务还在运行，使用同一 `RuntimeDir` 执行 `stop`                |
| 想完全离线听歌         | 选择随包离线曲目或合法本地音频；仅切换本地 AI 不会关闭在线曲库     |

## 测试与证据

无需模型或 PyTorch 的协议单元测试：

```powershell
$env:PYTHONDONTWRITEBYTECODE = '1'
python -m unittest discover -s local_ai/tests -v
./scripts/test-local-ai-launcher.ps1
```

CI 在 Windows Server 2022/2025 使用标准库与假加载器执行 Python 测试，不下载模型、安装推理依赖、读取 Key 或使用 GPU。启动脚本测试只提取纯函数，检查新旧时间格式、完整运行目录匹配、互斥名称和原子状态写入，不执行启动/停止入口，不结束任何实际进程。测试通过只证明覆盖到的协议、验证与状态逻辑；不证明真实 safetensors 可加载、CUDA 可用、中文回答合格或音乐推荐更符合偏好。真实父子进程退出与显存释放仍需单独验收。

真实推理需维护者另行显式验证：记录 Python/PyTorch/Transformers 版本与设备、离线加载结果、固定短句是否有有效正文、服务退出是否释放所管理进程；不把真实提示词、回答或私人路径写进公开报告。服务就绪后可执行 `python -B -m local_ai.verify`，只发送五组固定虚构输入，不启动模型或桌面应用。验证服务不要求启动或操控用户旧版桌面应用，也不属于常规 CI；本轮设备、成功与失败样本、耗时和退出结果见 [v0.9.0 验证记录](verification-v0.9.0.md)。

`response_format: json_object` 在本服务中是提示约束，不是语法级解码保证；桌面仍严格检查结果，无效时回退规则。新增 Python 与已有 JavaScript/TypeScript 分别执行 CodeQL 扫描，配置依据 [GitHub 官方语言配置说明](https://docs.github.com/zh/code-security/reference/code-scanning/workflow-configuration-options)，不为扫描安装模型或推理依赖。
