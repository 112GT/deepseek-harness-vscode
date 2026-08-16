# DeepSeek Harness for VS Code

DeepSeek Harness is an independent VS Code agent sidebar. It provides a native VS Code experience for a local DeepSeek Harness runtime and does not use or modify GitHub Copilot Chat.

## Before you start

- VS Code 1.100 or newer
- Node.js 22.19+ or 24+ with Corepack
- A built DeepSeek Harness folder
- Your own API key for DeepSeek or another configured provider

## First use

1. Install this VSIX with **Extensions: Install from VSIX...**.
2. Run **DeepSeek Harness: Select Harness Folder** and select the folder that contains Harness package.json.
3. Open the **DeepSeek Harness** icon in the Activity Bar.
4. Choose **Manage Model Providers** and configure DeepSeek, OpenAI, Anthropic Claude, Google Gemini, or an OpenAI-compatible endpoint.
5. Optionally run **DeepSeek Harness: Verify Model Connection**.

The extension stores the key in VS Code SecretStorage. The key is never written to the workspace and is passed only to the extension’s owned local Harness process.

## What it provides

- Streaming chat, collapsible reasoning, tool activity, task progress, approvals, and questions.
- Full-name **DeepSeek V4 Pro** and **DeepSeek V4 Flash** selection, plus OpenAI, Claude, Gemini, and OpenAI-compatible provider setup.
- Inline editor completions accepted with <kbd>Tab</kbd>.
- Context attachments for selections, files, Problems, external files/folders, images, and ZIP archives.
- Bounded file/folder context, terminal-output attachments, Conversation/Trace tabs, telemetry, context meter, and manual compaction.
- Read only, Workspace write, and All access modes.
- File-change cards below each turn, Explorer decorations, source jumps, per-file revert, and optional version snapshots.
- Runtime and Harness views for status, skills, presets, providers, and child agents, plus a Plugin Center for Skill invocation and preset management.

Use **Workspace write** for normal coding. **All access** removes Harness approval prompts and should be used only for work you trust.

## Run from source

    corepack pnpm install
    corepack pnpm run check
    corepack pnpm run build
    corepack pnpm run package

For development, open this extension folder in VS Code and run the **Run Extension** launch configuration. The default Harness location is the sibling harness folder; run **DeepSeek Harness: Prepare Local Runtime** once on a new clone.

## Stop and troubleshoot

- **Stop** cancels the current agent request.
- **DeepSeek Harness: Start Local Runner** starts an existing built sidecar; **Stop Local Runner** stops it.
- **DeepSeek Harness: Refresh Runtime Status** checks the source path, key status, and Host status.
- **DeepSeek Harness: Refresh Harness Capabilities** reloads models, skills, presets, and child agents.
- **DeepSeek Harness: Open Plugin Center** invokes a Skill, installs or removes a trusted external Harness package, creates or manages user presets, or opens VS Code's native controls for disabling or uninstalling this extension. External-package installation always asks for confirmation because package code runs outside Harness sandboxing. In a user preset's `agent.cordis.yml`, set a plugin row to `disabled: false` or `disabled: true` and start a new session after saving.

Provider keys are stored in VS Code SecretStorage. Harness settings retain only non-secret environment-variable references. No API key, local chat history, or dependency directory is included in this VSIX.

The VSIX includes no third-party Harness plugin or plugin profile. Install third-party packages explicitly from the Plugin Center after setup; each package and any separate credential configuration remains local to the user's computer.
