# DeepSeek Harness for VS Code

[简体中文](README.zh-CN.md) · [Release notes](CHANGELOG.md) · [Security](SECURITY.md)

An independent VS Code sidebar for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It provides a Copilot-style agent experience while keeping the local Harness runtime separate from GitHub Copilot.

> This is a community integration, not an official DeepSeek or Microsoft product.

## Highlights

- Native VS Code Activity Bar sidebar with streaming chat, collapsible reasoning, tool activity, task progress, approvals, and questions.
- Full-name model selector for **DeepSeek V4 Pro** and **DeepSeek V4 Flash**, plus configurable OpenAI, Anthropic Claude, Google Gemini, and OpenAI-compatible API routes.
- Editor ghost-text completions, accepted with <kbd>Tab</kbd>.
- Context attachments for selections, the active file, Problems, external files/folders, images, and ZIP archives.
- Bounded context attachments: up to 16 items / 100K text characters per request; folder context is combined into one named attachment.
- Conversation and Trace tabs, live in-session telemetry, context-use meter, manual `/compact`, and Auto through **Max** reasoning controls.
- Three access modes: **Read only**, **Workspace write**, and **All access**.
- Per-turn file-change cards, Explorer decorations, direct jumps to edited source, per-file revert, and optional workspace snapshots.
- Runtime and Harness views for status, skills, presets, providers, and child agents, plus a Plugin Center for Skill invocation and preset management.
- The API key stays in VS Code SecretStorage; it is never written to the workspace or bundled into a release.

## Requirements

- Desktop VS Code 1.100 or newer
- Node.js 22.19+ or 24+ with Corepack
- An API key supplied by each user on their own computer for the provider they choose

## Portable release scope

The v0.2 portable update follows the v0.1 release layout: the archive contains the VSIX, the DeepSeek-only Harness source, and the Windows/Linux/macOS setup scripts. It starts without third-party Harness plugins.

It does **not** include API keys, VS Code SecretStorage, local Harness profiles, chat history, `node_modules`, third-party plugin packages or configuration (including ModLens), or any workspace files. Users may install trusted third-party plugins themselves from the Plugin Center after setup; those plugins and their credentials remain local to that user's computer.

## Install a portable release

1. Download and extract the complete release archive from GitHub Releases.
2. Run the setup script from the extracted folder:

   **Windows PowerShell**

       Set-ExecutionPolicy -Scope Process Bypass
       .\setup.ps1

   **Linux or macOS**

       sh setup.sh

3. In VS Code, run **Extensions: Install from VSIX...** and select the included VSIX file.
4. Run **DeepSeek Harness: Select Harness Folder**, then select the extracted harness folder.
5. Open the **DeepSeek Harness** Activity Bar icon, choose **Manage Model Providers**, and configure DeepSeek or another supported provider.
6. Optionally run **DeepSeek Harness: Verify Model Connection** to validate the selected model.

The first setup downloads dependencies and builds the local Harness runtime. Later use does not require running the setup script again.

## Daily use

- Use the composer’s context control to attach a selection, file, Problems, or external material. Every attachment can be removed before sending.
- Select **DeepSeek V4 Pro** or **DeepSeek V4 Flash** from the model dropdown. Its final item opens provider setup for OpenAI, Claude, Gemini, and OpenAI-compatible endpoints (for example Qwen, Kimi, GLM, MiniMax, OpenRouter, or a self-hosted gateway).
- Provider keys stay in VS Code SecretStorage. The local Harness `settings.yaml` contains only provider names, endpoints, models, and environment-variable references; changing a provider restarts the local Runner before the next request.
- Prefer **Workspace write** for normal coding. **All access** allows unrestricted file access and disables Harness approval prompts.
- Review the change card under each completed response. Click its line count to open the real edited file; use the per-file revert action when needed.
- Enable DeepSeek Harness: Version Snapshots to save turn snapshots under .deepseek-harness-history in the workspace.
- **Local Runner** starts the already-built sidecar. **Prepare Local Runtime** is only for a new/unbuilt Harness source; **Stop** cancels the active request.
- **Current Problems** means VS Code diagnostics (errors and warnings) for the active editor file, not the entire workspace. **Current terminal output** can attach commands/output captured after extension activation when shell integration is available.

## Capability hot updates

The Harness view contains a **Hot update** group with an automatic-refresh switch, an immediate refresh action, watched-source list, pending-change indicator, and the last update summary.

When enabled, it watches:

- Workspace Skills under .agents/skills and .dsh/skills
- User Skills in the private local Harness home, under .agents/skills and .dsh/skills
- User-authored agent presets under the private local Harness home .agent-presets directory
- Bundled Skills in the selected Harness runtime
- The local Harness settings.yaml file, including provider and agent-preset configuration

Changed capabilities are re-read without reinstalling the extension. A task already running retains its original Skill set; changes are applied after the task reaches a safe point, normally before the next turn.

The **Open Plugin Center** action in the Harness view invokes a Skill, installs or removes a trusted external Harness package, creates or manages a user-owned agent preset, or opens VS Code's native extension controls. External-package installation requires an explicit warning confirmation because package install scripts and runtime code run outside Harness sandboxing. In a user preset's `agent.cordis.yml`, use `disabled: false` to enable a plugin row and `disabled: true` to disable it; use the same UI to delete a user preset. VS Code's extension controls are the supported place to disable or uninstall the whole extension.

Extension code, a VSIX package, compiled Harness code, and process environment credentials are not hot-swapped. Those require a Runner restart, VS Code reload, or a new extension version as appropriate.

## Build from source

    cd extension
    corepack pnpm install
    corepack pnpm run check
    corepack pnpm run build
    corepack pnpm run package

Build the copied Harness runtime once:

    cd harness
    corepack pnpm install --frozen-lockfile
    corepack pnpm run build

For development, open extension/ in VS Code and run the **Run Extension** launch configuration.

## Repository layout

    extension/   VS Code extension source
    harness/     Full, buildable DeepSeek-only Harness source

Generated archives, VSIX files, dependency directories, scratch workspaces, logs, keys, and local chat snapshots are intentionally excluded from Git.

## License

The bundled upstream DeepSeek Harness source is MIT licensed. This integration is also released under the [MIT License](LICENSE).
