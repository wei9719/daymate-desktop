# Security Policy

当前维护 Windows x64 最新版本。发布采用固定提交版本的 Actions、只读构建/测试权限、全量依赖审计和云端兼容性检查；只有最终发布任务拥有 Release 写权限。安全机制及未验证边界见 [安全与兼容性说明](docs/security-compatibility.md)。这些检查不等同于独立渗透测试或“没有任何风险”的保证。

AI 凭据只在本机系统凭据管理器中保存，并绑定接口地址；不通过前端返回密钥。请只配置自己信任的服务地址，服务商收到请求后如何处理数据由其政策决定。不要将 API Key 放进 Base URL。

CodeQL 扫描 TypeScript/JavaScript，高危结果与 error 级安全结果会阻止构建发布。缺失或异常的 SARIF 报告不会被视为通过；已有或被标记 suppressed 的高危结果也不豁免。本地音频只允许已支持格式，检查文件头及大小后重建为固定音频 MIME，不把任意文件类型直接作为播放地址。

每周及每次 CI/发布运行 npm 与 RustSec 检查，所有 Rust 漏洞、Windows 实际依赖中的 unsound 问题和 npm 高危问题会阻止发布。停维护及非 Windows 依赖警示仍公开报告，不以全局忽略规则隐藏。发现新的高风险问题时应优先修复再发布。

请不要在公开 Issue 中粘贴 API Key、活动明细、窗口标题或个人路径。安全与隐私问题优先使用仓库的私密漏洞报告功能；若仓库尚未启用，请只提交不含敏感细节的 Privacy concern Issue，请求维护者建立私密沟通渠道。
