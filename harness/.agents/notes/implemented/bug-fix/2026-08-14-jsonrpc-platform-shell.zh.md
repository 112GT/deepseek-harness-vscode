# Agent Note: jsonrpc-agent 的平台 Shell

Status: implemented

[English](2026-08-14-jsonrpc-platform-shell.md) | 中文

## Problem

JSON-RPC 编码 agent 组合在 Windows 上暴露 `bash`；该可执行文件可能解析为不可用的 WSL 启动器，而不是可用的命令解释器。

## Decision

`examples/jsonrpc-agent/cordis.yml` 在每个平台只组合一个前台 shell 系列：Windows 使用 `dsh-pwsh-local` 与 `dsh-tool-pwsh`，Linux 和 macOS 使用 `dsh-bash-local` 与 `dsh-tool-bash`。

该组合禁用 agent-spine 内置的 Bash consumer，并显式拥有平台特定工具和共享 shell 环境。

## Alternatives considered

**在 Windows 上要求 WSL。** WSL 是可选组件，且 Bash 语法不匹配原生 Windows workspace 路径。

**在 VS Code 扩展中翻译 Bash 命令。** 命令翻译会改变模型可见的工具行为，且无法可靠翻译 shell 语法。

## Consequences

Windows agent 获得 `pwsh` 工具和原生 PowerShell 路径；Linux 和 macOS agent 保留 `bash` 工具。两个平台都保留仅前台执行，以及相同的文件系统、子 agent、待办、持久化和上下文压缩服务。
