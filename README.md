# DeepSeek Harness for VS Code

[简体中文](README.zh-CN.md) · [Release notes](CHANGELOG.md) · [Security](SECURITY.md)

An independent VS Code sidebar for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It provides a Copilot-style agent experience while keeping the local Harness runtime separate from GitHub Copilot.

> This is a community integration, not an official DeepSeek or Microsoft product.

## Highlights

- Native VS Code Activity Bar sidebar with streaming chat, collapsible reasoning, tool activity, task progress, approvals, and questions.
- DeepSeek model selector limited to **V4-Pro** and **Flash**.
- Editor ghost-text completions, accepted with <kbd>Tab</kbd>.
- Context attachments for selections, the active file, Problems, external files/folders, images, and ZIP archives.
- Three access modes: **Read only**, **Workspace write**, and **All access**.
- Per-turn file-change cards, Explorer decorations, direct jumps to edited source, per-file revert, and optional workspace snapshots.
- Runtime and Harness views for status, skills, presets, providers, and child agents.
- The API key stays in VS Code SecretStorage; it is never written to the workspace or bundled into a release.

## Requirements

- Desktop VS Code 1.100 or newer
- Node.js 22.19+ or 24+ with Corepack
- A DeepSeek API key supplied by each user on their own computer

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
5. Open the **DeepSeek Harness** Activity Bar icon, choose **Configure API Key**, and enter your own DeepSeek key.
6. Optionally run **DeepSeek Harness: Verify DeepSeek Connection** to validate the local setup.

The first setup downloads dependencies and builds the local Harness runtime. Later use does not require running the setup script again.

## Daily use

- Use the composer’s context control to attach a selection, file, Problems, or external material. Every attachment can be removed before sending.
- Select **V4-Pro** or **Flash** from the model dropdown.
- Prefer **Workspace write** for normal coding. **All access** allows unrestricted file access and disables Harness approval prompts.
- Review the change card under each completed response. Click its line count to open the real edited file; use the per-file revert action when needed.
- Enable DeepSeek Harness: Version Snapshots to save turn snapshots under .deepseek-harness-history in the workspace.
- **Stop** cancels the active request. **DeepSeek Harness: Stop Local Runner** stops the local sidecar process.

## Capability hot updates

The Harness view contains a **Hot update** group with an automatic-refresh switch, an immediate refresh action, watched-source list, pending-change indicator, and the last update summary.

When enabled, it watches:

- Workspace Skills under .agents/skills and .dsh/skills
- User Skills in the private local Harness home, under .agents/skills and .dsh/skills
- User-authored agent presets under the private local Harness home .agent-presets directory
- Bundled Skills in the selected Harness runtime
- The local Harness settings.yaml file, including provider and agent-preset configuration

Changed capabilities are re-read without reinstalling the extension. A task already running retains its original Skill set; changes are applied after the task reaches a safe point, normally before the next turn.

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
