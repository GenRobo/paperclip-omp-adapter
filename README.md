# Paperclip OMP Adapter

[![CI](https://github.com/GenRobo/paperclip-omp-adapter/actions/workflows/ci.yml/badge.svg)](https://github.com/GenRobo/paperclip-omp-adapter/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40genrobo%2Fpaperclip-omp-adapter.svg)](https://www.npmjs.com/package/@genrobo/paperclip-omp-adapter)
[![license](https://img.shields.io/npm/l/%40genrobo%2Fpaperclip-omp-adapter.svg)](LICENSE)

External Paperclip adapter for running Oh My Pi (OMP) CLI in headless mode with native model discovery, custom providers, resumable local sessions, skills synchronization, multi-workspace support, and structured transcripts.

## Overview

This adapter integrates OMP into Paperclip as an external adapter module (`omp_local`). It communicates with the host Paperclip instance via the `@paperclipai/adapter-utils` contract and parses OMP's non-interactive JSONL event stream into Paperclip transcript entries.

## Feature Matrix

| Feature | Paperclip Integration | OMP CLI Mapping |
|---|---|---|
| Model Discovery | Dynamic model list and badge updates | `omp models --json` and `omp models refresh --json` |
| Execution Mode | Headless execution per heartbeat run | `omp --mode json -p` |
| Session Resume | Resumes conversation across runs | `--session-dir <dir> --resume <id>` |
| Multi-Workspace | Multi-workspace context synchronization | `--add-dir <path>` (repeatable) |
| Thinking / Reasoning | Live transcript streaming plus durable `omp.thinking` run events | `--thinking <level>`, `--print-thoughts` |
| Tool Events | Real-time tool calls, progress updates, durable `omp.tool` run events | Maps `tool_execution_*` to Paperclip entries |
| Skills Integration | Paperclip workspace skills synchronization | Links skills into `~/.omp/agent/skills` |
| Cancellation | Host-driven run abortion | Listens to `ctx.signal` and signals process group |
| Targets | Local and remote execution | Direct spawn, SSH, or managed sandboxes |

## Requirements

- Node.js >= 24.11.0
- Paperclip 2026.1012.0 (adapter helper and shared contracts pinned to this release)
- Oh My Pi (OMP) installed in the selected execution environment (`omp` executable available in `PATH` or explicitly configured via `command`); remote-only deployments do not need OMP on the Paperclip hub

Install OMP globally:

```bash
npm install -g @oh-my-pi/pi-coding-agent@latest
```

## Installation

### Via Paperclip CLI

After publishing this fork's package, install it in a running Paperclip instance with:

```bash
paperclipai adapter install --payload-json '{"packageName":"@genrobo/paperclip-omp-adapter","version":"0.8.0"}' --json
```

To upgrade an existing installation:

```bash
paperclipai adapter reinstall omp_local --json
```

### Verification

Check that the adapter is registered and loaded:

```bash
paperclipai adapter get omp_local --json
```

Verify model discovery for a company:

```bash
paperclipai adapter models omp_local --company-id <company-id> --json
```

### Remote-only deployment policy

Set these variables on the **Paperclip server process/container**, not in an agent's adapter configuration:

```bash
PAPERCLIP_OMP_REQUIRE_REMOTE=true
PAPERCLIP_ADAPTER_MODELS='{"omp_local":[{"id":"provider/model","label":"Display name"}]}'
```

The policy is enabled by `true` (case-insensitive, surrounding whitespace ignored). When unset or another value, normal local-library behavior is preserved. Adapter type remains `omp_local`; this is an operator deployment policy, not a new adapter or agent-editable setting.

- `execute` and `testEnvironment` require a host-supplied `executionTarget` with `kind: "remote"`, a nonempty `remoteCwd`, and either `transport: "ssh"` with a valid Paperclip SSH `spec`, or `transport: "sandbox"` with a live host `runner.execute` function. Execution also retains the existing host legacy SSH `executionTransport.remoteExecution` contract.
- Missing/local/malformed targets fail before workspace creation, command resolution, installation, probes, or local OMP spawn. `execute` returns `exitCode: 1`, `errorFamily: "configuration"`, `errorCode: "omp_remote_target_required"`; environment testing returns `status: "fail"` with the same check code.
- Agent `config`, `config.env`, and serialized target-like configuration cannot disable the host policy or supply the host runner. Remote connectivity/setup failures propagate; there is no local fallback. Operators remain responsible for placing the supplied SSH/sandbox target on the separate runner, not on the hub.
- Model listing/refresh and adapter registration never invoke local OMP under this policy. They reuse Paperclip's existing `PAPERCLIP_ADAPTER_MODELS` JSON object, specifically its `omp_local` array of `{id,label?}` entries. Missing labels default to the id; an empty array is an explicit empty catalog. This is a picker catalog, not provider credentials or proof of model availability.
- Without an `omp_local` catalog, listing/refresh reject with error `code: "omp_explicit_model_required"` and instructions to set agent `config.model` to a provider/model selector. The configuration schema remains usable as a free-text model combobox; automatic model detection returns `null`. Invalid catalog JSON/OMP entries reject with `code: "omp_model_catalog_invalid"`.
- Host quota discovery returns `ok: false` and no windows without invoking `omp usage`. Environment tests with a valid remote target still perform their OMP model/auth probes remotely.

Configure the Paperclip host to permit this external adapter on the selected remote environment and supply a real provider runner/SSH connection. This package does not provision an environment or make an otherwise ineligible host dispatch remote.

## Configuration Reference

The adapter exposes the following configuration schema fields under an agent's adapter configuration:

### Core Execution
- `command` (string): Path to the OMP executable. Default: `omp`.
- `model` (string): Default model selector (e.g., `anthropic/claude-3-7-sonnet`, `openai/gpt-4o`).
- `thinking` (string): Reasoning level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `auto`).
- `printThoughts` (boolean): Stream thinking blocks into the Paperclip transcript (`--print-thoughts`). Default: `true`; `false` passes `--hide-thinking`. Thinking only appears when the selected model actually emits reasoning deltas.
- `profile` (string): Named OMP profile to activate (`OMP_PROFILE`).

### Workspace & Sessions
- `cwd` (string): Working directory override. Defaults to the Paperclip issue workspace.
- `addDirs` (textarea): Additional directory paths passed via repeatable `--add-dir` flags.
- `sessionDir` (string): Directory for storing OMP session state.
- `noSession` (boolean): Set true to disable session resumption (ephemeral execution).
- `allowHome` (boolean): Pass `--allow-home` if working directly in the user home directory.

### Capabilities & Tools
- `tools` (string): Comma-separated list of enabled tool names.
- `noTools` (boolean): Disable default OMP tools.
- `skills` (string): Comma-separated list of explicit skill names to enable.
- `noSkills` (boolean): Disable built-in skills discovery.
- `noRules` (boolean): Skip loading `RULES.md`.
- `approvalMode` (select): Tool execution approval policy (`yolo`, `write`, `always-ask`). Default: `yolo`, always passed as `--approval-mode` so the run never depends on `tools.approvalMode` in the OMP config.

### Diagnostics & Extensions
- `timeoutSec` (number): Maximum wall-clock execution time in seconds before SIGINT. Default: `43200` (12 hours).
- `graceSec` (number): Grace period before SIGKILL after SIGINT. Default: `20`.
- `configFiles` (textarea): Custom `config.yml` overlay paths.
- `extensions` (textarea): Paths to custom OMP extensions.
- `pluginDirs` (textarea): Paths to plugin directories.
- `hooks` (textarea): Paths to hook files.
- `extraArgs` (textarea): Raw additional flags passed to the OMP CLI.

## Development

### Building and Testing

```bash
git clone https://github.com/GenRobo/paperclip-omp-adapter.git
cd paperclip-omp-adapter
npm ci
npm run typecheck
npm test
```

### Testing Local Package in Paperclip

Pack the local repository and install the tarball directly into your Paperclip instance:

```bash
TARBALL=$(npm pack)
paperclipai adapter install --payload-json "{\"packageName\":\"$PWD/$TARBALL\",\"version\":\"0.8.0\"}" --json
```

### Maintaining this fork

Use Node 24 (at least 24.11.0; deployment toolchain 24.21.0). Keep `@paperclipai/adapter-utils` and `@paperclipai/shared` pinned together to the deployed Paperclip contract. After changing package identity/version/dependencies, regenerate and commit the lockfile with the supported toolchain before `npm ci` or publication:

```bash
npm install --package-lock-only --ignore-scripts
npm ci --ignore-scripts
npm run typecheck
npm test
npm run pack:check
```

The smoke suite exercises the public server adapter's denied local/missing/malformed targets, immutable host policy, explicit model catalog, and remote runner failure propagation without local fallback. Existing policy-off execution tests cover the normal library behavior. Remote deployment acceptance additionally needs a real SSH/sandbox integration run; the smoke runner failure fixture does not claim a successful remote execution.

### Changes in 0.8.0

- Adopted `@genrobo/paperclip-omp-adapter` and the GenRobo fork metadata; retained the original MIT license and attribution.
- Pinned Paperclip helper/shared contracts to 2026.1012.0.
- Added operator-owned remote-only execution/environment enforcement and non-spawning model/config/quota discovery on the hub.
- Reused the host's explicit model catalog contract; retained `omp_local` and existing policy-off behavior.

## License

MIT

