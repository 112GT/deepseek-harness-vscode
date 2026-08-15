# DeepSeek Harness for VS Code

DeepSeek Harness 是独立的 VS Code 智能体侧边栏。它使用本地 DeepSeek Harness 运行时提供原生 VS Code 交互，不使用也不会修改 GitHub Copilot Chat。

## 开始前准备

- VS Code 1.100 或更高版本
- Node.js 22.19+ 或 24+，并包含 Corepack
- 已构建的 DeepSeek Harness 文件夹
- 你自己的 DeepSeek API Key

## 首次使用

1. 在 VS Code 中执行 **Extensions: Install from VSIX...** 安装扩展。
2. 执行 **DeepSeek Harness: Select Harness Folder**，选择包含 Harness package.json 的文件夹。
3. 点击 Activity Bar 中的 **DeepSeek Harness** 图标。
4. 选择 **Configure API Key**，输入你自己的 DeepSeek API Key。
5. 可选：执行 **DeepSeek Harness: Verify DeepSeek Connection**。

扩展会将密钥存入 VS Code SecretStorage，不会写入项目文件；密钥只会传给扩展启动的本地 Harness 进程。

## 功能

- 流式对话、可折叠思考过程、工具状态、任务进度、审批和提问。
- V4-Pro 与 Flash 模型选择。
- 编辑器灰字补全，按 <kbd>Tab</kbd> 接受。
- 选区、文件、Problems、外部文件/文件夹、图片和 ZIP 上下文。
- Read only、Workspace write、All access 三种权限。
- 每轮下方的文件变更卡片、资源管理器标识、跳转源文件、逐文件撤销和可选版本存档。
- Runtime 与 Harness 面板，显示状态、Skills、预设、模型提供方和子智能体。

日常开发建议使用 **Workspace write**。**All access** 会关闭 Harness 的审批提示，只应在完全信任任务时使用。

## 从源码运行

    corepack pnpm install
    corepack pnpm run check
    corepack pnpm run build
    corepack pnpm run package

开发时，在 VS Code 中打开本扩展文件夹，运行 **Run Extension** 启动配置。默认 Harness 路径是相邻的 harness 文件夹；新克隆的仓库需要先执行一次 **DeepSeek Harness: Prepare Local Runtime**。

## 停止与排错

- **Stop** 取消当前智能体请求。
- **DeepSeek Harness: Stop Local Runner** 停止本地侧车进程。
- **DeepSeek Harness: Refresh Runtime Status** 检查源码路径、密钥状态和 Host 状态。
- **DeepSeek Harness: Refresh Harness Capabilities** 重新加载模型、Skills、预设和子智能体。

此 VSIX 不包含 API Key、本地聊天记录或依赖目录。
