# Changelog

## 0.2.0 — 2026-08-16

- Portable update based on the v0.2 development line through dev.6: capability hot updates, configurable model providers, conversation trace and telemetry, bounded context attachments, local `/compact`, and the Plugin Center.
- Plugin Center supports explicit installation/removal of trusted third-party Harness packages; no third-party plugin or credential is bundled in the portable release.
- Reasoning labels use **Auto**, **Low**, **Medium**, **High**, and **Max** while retaining the compatible underlying API values.

## Post-v0.2 development experiments (not included in the v0.2.0 portable package)

The following working-tree experiments are retained for continued development only. The published v0.2.0 archive uses the validated dev.6 baseline with the reasoning-label presentation update.

### 0.2.0-dev.8 — 2026-08-16

- Prevented Current file and editor-tab context actions from materializing an entire large document before truncation.
- Added exception containment for Webview context actions so a failed attachment cannot freeze the chat interface.

### 0.2.0-dev.7 — 2026-08-16

- Fixed Current file context to retain the right-hand editor tab after the chat view receives focus.
- Added direct editor-tab drag-and-drop into the chat composer as a bounded context attachment, including visible unsaved documents.

## 0.2.0-dev.6 — 2026-08-16

- Added reviewed external-plugin installation and removal actions to the Plugin Center. Installation requires an explicit warning confirmation and restarts the local profile on the next task.

## 0.2.0-dev.5 — 2026-08-16

- Made `/compact` a real local Harness command rather than sending it to the model; the chat now shows the Host-confirmed compaction result.
- Added a native Plugin Center for running Skills, managing user-owned agent presets, and opening the VS Code controls for disabling or uninstalling this extension.
- Added user-preset deletion and an editor workflow for toggling a preset plugin with `disabled: true` or `disabled: false`.

## 0.2.0-dev.4 — 2026-08-16

- Fixed the Conversation / Trace tab visibility, so the trace panel now opens correctly.
- Moved turn, tool-call, LLM, and token metrics to the composer status line.
- Renamed reasoning controls to `auto`, `low`, `medium`, `high`, and `max`.
- Replaced the native session picker with a Copilot-style sidebar history that contains only sessions from the current workspace folder.
- Removed the duplicate top-right provider-settings entry and refreshed the Activity Bar icon.

## 0.2.0-dev.3 — 2026-08-16

- Fixed the Runtime **Local Runner** action: it starts an existing built Host instead of incorrectly rebuilding it on every click.
- Added bounded file/folder context selection, active-file Problems, and opt-in terminal-output attachments captured after extension activation.
- Added parallel Conversation/Trace views, in-session telemetry, a context-use meter, and Harness `/compact` control.
- Added an Auto/Low/Medium/High/**Max** reasoning-level selector for models that support it.

## 0.2.0-dev.2 — 2026-08-16

Development preview for configurable model providers.

- Replaced abbreviated model labels with **DeepSeek V4 Pro** and **DeepSeek V4 Flash**.
- Added native provider settings from the chat composer and Runtime view for OpenAI, Anthropic Claude, Google Gemini, and OpenAI-compatible APIs.
- Stores all provider keys in VS Code SecretStorage; Harness settings retain only environment-variable references.
- Added selected-model-aware connection validation and a generic third-party sidecar route.

## 0.2.0-dev.1 — 2026-08-16

Development preview for capability hot updates.

- Added a native Harness Hot update control group with auto-refresh toggle, manual refresh, watched-source status, pending changes, and update summaries.
- Watches Workspace Skills, user Skills, bundled Skills, and Harness settings.yaml.
- Defers automatic UI synchronization until a running task reaches a safe point.

## 0.1.0 — 2026-08-15

First portable preview release.

- Added an independent DeepSeek Harness VS Code sidebar.
- Added V4-Pro and Flash model selection, access modes, context attachments, and inline completion.
- Added per-file change cards, Explorer decorations, per-file revert, and optional workspace snapshots.
- Added Runtime and Harness refresh views plus a protected DeepSeek connection verification command.
- Packaged a DeepSeek-only portable runtime path with no Codex or Claude Code runtime dependencies.
