# Agent Note: Platform-specific shell for jsonrpc-agent

Status: implemented

English | [中文](2026-08-14-jsonrpc-platform-shell.zh.md)

## Problem

The JSON-RPC coding-agent composition exposed `bash` on Windows, where the executable may resolve to an unavailable WSL launcher instead of a usable command interpreter.

## Decision

`examples/jsonrpc-agent/cordis.yml` composes exactly one foreground shell family: `dsh-pwsh-local` with `dsh-tool-pwsh` on Windows, and `dsh-bash-local` with `dsh-tool-bash` on Linux and macOS.

The agent-spine's bundled Bash consumer is disabled so the composition owns the platform-specific tool and shared shell environment explicitly.

## Alternatives considered

**Require WSL on Windows.** WSL is optional and its Bash syntax does not match native Windows workspace paths.

**Translate Bash commands in the VS Code extension.** Command translation would change model-visible tool behavior and cannot reliably translate shell syntax.

## Consequences

Windows agents receive a `pwsh` tool and native PowerShell paths; Linux and macOS agents retain the `bash` tool. Both platforms keep foreground-only execution and the same filesystem, subagent, todo, persistence, and compaction services.
