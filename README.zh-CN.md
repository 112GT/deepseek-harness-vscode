# DeepSeek Harness for VS Code

[English](README.md) · [更新日志](CHANGELOG.md) · [安全说明](SECURITY.md)

这是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的独立 VS Code 侧边栏集成。它提供接近 Copilot 的交互体验，但不依赖、也不嵌入 GitHub Copilot。

> 本项目是社区集成，不是 DeepSeek 或 Microsoft 的官方产品。

## 主要功能

- 原生 Activity Bar 侧边栏：流式对话、可折叠思考过程、工具状态、任务进度、审批与提问。
- 模型下拉列表仅提供 **V4-Pro** 与 **Flash**。
- 编辑器灰字补全，按 <kbd>Tab</kbd> 接受。
- 可附加选区、当前文件、Problems、外部文件/文件夹、图片和 ZIP。
- 三种权限：**Read only**、**Workspace write**、**All access**。
- 每轮对话下方显示文件变更、资源管理器变更标识、跳转源文件、单文件撤销与可选版本存档。
- Runtime 与 Harness 面板可查看运行状态、Skills、预设、模型提供方及子智能体。
- API Key 只保存在本机 VS Code SecretStorage，不写入工作区，也不随发布包分发。

## 环境要求

- VS Code 桌面版 1.100 或更高版本
- Node.js 22.19+ 或 24+，并包含 Corepack
- 每位用户在自己的电脑上填写自己的 DeepSeek API Key

## 安装便携发布包

1. 从 GitHub Releases 下载并完整解压发布压缩包。
2. 在解压后的目录执行初始化脚本：

   **Windows PowerShell**

       Set-ExecutionPolicy -Scope Process Bypass
       .\setup.ps1

   **Linux 或 macOS**

       sh setup.sh

3. 在 VS Code 中执行 **Extensions: Install from VSIX...**，选择包内的 VSIX 文件。
4. 执行 **DeepSeek Harness: Select Harness Folder**，选择刚才解压目录中的 harness 文件夹。
5. 点击 Activity Bar 中的 **DeepSeek Harness** 图标，选择 **Configure API Key**，输入你自己的 DeepSeek API Key。
6. 可选：执行 **DeepSeek Harness: Verify DeepSeek Connection**，验证本地连接。

首次初始化会下载依赖并构建本地 Harness 运行时，耗时取决于网络；之后正常使用无需重复执行初始化脚本。

## 日常使用

- 使用输入框中的上下文选项附加选区、文件、Problems 或外部资料；每个附件在发送前都能删除。
- 从模型下拉列表选择 **V4-Pro** 或 **Flash**。
- 一般编程建议使用 **Workspace write**。**All access** 允许不受限制的文件访问，并会关闭 Harness 的审批提示。
- 每次任务完成后，在对话下方查看变更卡片；点击行数可跳转到真实源文件；需要时可逐文件撤销。
- 打开 DeepSeek Harness: Version Snapshots 后，每轮文件快照会存到项目目录的 .deepseek-harness-history/。
- 对话中的 **Stop** 只中断当前请求；**DeepSeek Harness: Stop Local Runner** 会关闭本地侧车进程。

## 能力热更新

Harness 面板新增 **Hot update** 分组，提供自动刷新开关、立即刷新、监听源列表、待处理变更和最后更新摘要。

打开自动刷新后，插件会监听：

- 工作区 .agents/skills 和 .dsh/skills 中的 Skills
- 私有本地 Harness 主目录 .agents/skills 和 .dsh/skills 中的用户 Skills
- 私有本地 Harness 主目录 .agent-presets 中的用户 Agent Preset
- 已选择 Harness 运行时自带的 Skills
- 本地 Harness 的 settings.yaml，其中包括模型提供方和 Agent Preset 配置

这些能力文件变更后无需重装插件。正在运行的任务会保留开始时的 Skill 集合；变更会在任务到达安全点后应用，通常是下一轮开始前。

扩展 TypeScript 代码、VSIX 安装包、已编译的 Harness 代码和进程环境中的密钥不能在线替换；它们分别需要重启 Runner、重载 VS Code 或安装新版本。

## 从源码构建

    cd extension
    corepack pnpm install
    corepack pnpm run check
    corepack pnpm run build
    corepack pnpm run package

首次还需构建复制的 Harness 运行时：

    cd harness
    corepack pnpm install --frozen-lockfile
    corepack pnpm run build

开发时，在 VS Code 中打开 extension/，运行 **Run Extension** 启动配置。

## 目录说明

    extension/   VS Code 扩展源码
    harness/     完整、可构建的 DeepSeek-only Harness 源码

生成的压缩包、VSIX、依赖目录、临时测试目录、日志、密钥和本地聊天快照都不会进入 Git。

## 许可证

内置的上游 DeepSeek Harness 源码采用 MIT 许可证；本集成也采用 [MIT License](LICENSE)。
