# DeepSeek Harness for VS Code

DeepSeek Harness is an independent VS Code agent sidebar. It provides a native VS Code experience for a local DeepSeek Harness runtime and does not use or modify GitHub Copilot Chat.

## Before you start

- VS Code 1.100 or newer
- Node.js 22.19+ or 24+ with Corepack
- A built DeepSeek Harness folder
- Your own DeepSeek API key

## First use

1. Install this VSIX with **Extensions: Install from VSIX...**.
2. Run **DeepSeek Harness: Select Harness Folder** and select the folder that contains Harness package.json.
3. Open the **DeepSeek Harness** icon in the Activity Bar.
4. Choose **Configure API Key** and enter your own DeepSeek key.
5. Optionally run **DeepSeek Harness: Verify DeepSeek Connection**.

The extension stores the key in VS Code SecretStorage. The key is never written to the workspace and is passed only to the extension’s owned local Harness process.

## What it provides

- Streaming chat, collapsible reasoning, tool activity, task progress, approvals, and questions.
- V4-Pro and Flash model selection.
- Inline editor completions accepted with <kbd>Tab</kbd>.
- Context attachments for selections, files, Problems, external files/folders, images, and ZIP archives.
- Read only, Workspace write, and All access modes.
- File-change cards below each turn, Explorer decorations, source jumps, per-file revert, and optional version snapshots.
- Runtime and Harness views for status, skills, presets, providers, and child agents.

Use **Workspace write** for normal coding. **All access** removes Harness approval prompts and should be used only for work you trust.

## Run from source

    corepack pnpm install
    corepack pnpm run check
    corepack pnpm run build
    corepack pnpm run package

For development, open this extension folder in VS Code and run the **Run Extension** launch configuration. The default Harness location is the sibling harness folder; run **DeepSeek Harness: Prepare Local Runtime** once on a new clone.

## Stop and troubleshoot

- **Stop** cancels the current agent request.
- **DeepSeek Harness: Stop Local Runner** stops the local sidecar process.
- **DeepSeek Harness: Refresh Runtime Status** checks the source path, key status, and Host status.
- **DeepSeek Harness: Refresh Harness Capabilities** reloads models, skills, presets, and child agents.

No API key, local chat history, or dependency directory is included in this VSIX.
