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
npm install -g @oh-my-pi/pi-coding-agent@18.11.0
```

## Installation

### Via Paperclip CLI

After publishing this fork's package, install it in a running Paperclip instance with:

```bash
paperclipai adapter install --payload-json '{"packageName":"@genrobo/paperclip-omp-adapter","version":"0.11.0"}' --json
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

### Native MCP and persistent workload tools (OMP 18.11.0)

Native `runtimeTools` and `runtimeMcp` are materialized into a private per-run
`mcp.json` using OMP's `mcpServers` convention. Native connection identities,
not display names, identify servers; unsafe MCP key characters are mapped to
stable hashed names without losing the host-side connection identity.

Remote HTTP MCP connections use the authenticated execution-target bridge.
The host retains each exact upstream endpoint and bearer token; the runner
receives only its granted `/api/runtime-mcp/<bridge-id>` routes and per-run
bridge credential. Generated JSON uses environment references for URLs and
authorization. Unknown grants, query overrides and endpoint aliases fail
closed; forwarding rejects redirects.

This remote feature requires the infrastructure repository's
[`runtime-mcp-bridge.patch`](https://github.com/GenRobo/GR_Agentic_Sim_Team_Infra/blob/main/containers/paperclip/runtime-mcp-bridge.patch)
and `PAPERCLIP_RUNTIME_MCP_BRIDGE_VERSION=1` exported by the host's
`@paperclipai/adapter-utils`. The adapter must resolve that patched SDK, not a
second unpatched nested copy. A stock helper package fails explicitly rather
than sending host-local URLs or native connection tokens into the runner.
Local execution continues to use its native environment-bound credentials.

For issue-scoped workload tools, set this **only on the trusted Paperclip server
process**, never in an agent's adapter `config.env`:

```bash
PAPERCLIP_WORKLOAD_MCP_COMMAND=/opt/gr-workload-mcp-client/bin/gr-workload-mcp-client
# Optional: explicit operator-owned native MCP configuration on the Paperclip host
PAPERCLIP_OMP_MCP_CONFIG=/etc/paperclip/omp/mcp.json
```

The command is an absolute executable path **inside the execution target**.
Install `services/workload-mcp-client` from the infrastructure repository at
`/opt/gr-workload-mcp-client`, with a trusted Node >=24.11.0 on `PATH` (the
entrypoint uses `#!/usr/bin/env node`). The package pins MCP SDK 1.29.0 and
provides `bin/gr-workload-mcp-client`; image preparation uses:

```bash
npm ci --ignore-scripts
npm run build
npm prune --omit=dev --ignore-scripts
chmod 0555 bin/gr-workload-mcp-client
```

Make the installation and Node binary operator-owned and read-only to the
sandbox user. No runtime package download, agent-supplied command, broker
secret, or new worker listener is used. The client inherits native
`PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`, `PAPERCLIP_RUN_ID`, and
`PAPERCLIP_TASK_ID`; remote issue runs require a working native Paperclip bridge.
The native server must permit only the `gr.workloads` issue routes through both
bridge transports and have the workloads plugin installed. Missing authority
fails explicitly. The API URL is an HTTP(S) origin, not an `/api` URL.

An optional operator MCP file is merged without modifying its source, preserving
servers and enable/disable lists. Reserved server-name collisions, aliases of
native endpoints/executables, malformed files, and unselected inherited
`mcp.json`/`.mcp.json` fail closed. Select intentional existing agent-directory
MCP configuration explicitly with `PAPERCLIP_OMP_MCP_CONFIG`; it is never
implicitly promoted from an agent-selected directory. Operator MCP entries and
their referenced executables must themselves be safe for the execution target.
Agent-supplied authority variables, `config.env.PI_CONFIG_FILES`, and raw
profile/config override arguments are rejected while native MCP is active;
use the normal `configFiles` field for ordinary overlays. Settings that disable
the native discovery provider or a required runtime MCP server fail clearly
rather than quietly removing tools.

A final trusted `--config` overlay disables **only MCP project discovery**
before OMP deduplication, so project `mcp.json` cannot shadow runtime tools.
It waits for MCP startup discovery to settle (individual server deadlines remain
bounded). It does not disable discovery providers, skills, rules, or unrelated
OMP features. Configured ordinary overlays still apply before this policy.
Temporary configuration is removed by the existing per-run cleanup.

The base workload tools are `gr_request_resource`, `gr_list_resources`,
`gr_resource_status`, `gr_application_tools`, `gr_call_application`,
`gr_operation_status`, and `gr_release_resource`. Mutations require a
caller-retained request/operation UUID: transport reconnection must reuse that
ID with the same payload. HTTP calls have a 20-second deadline and no automatic
retry; uncertain mutations are not represented as failures safe to repeat.
Completed operation results preserve actual MCP image/resource blocks and
structured output, including failed application results with partial-mutation
warnings and `isError: true`. Do not re-execute indeterminate edits; save desired
state before explicit release.

The workload server deadline is 900,000 ms so committed engineering source can
transfer in bounded resumable batches. Native HTTP MCP servers retain their
30-second deadline. OMP 18.11.0's `OMP_MCP_TIMEOUT_MS` overrides per-server values:
leave it unset for this deployment. An override below 900,000 ms can interrupt
source transfer before its progress receipt; do not treat that timeout as proof
that nothing was accepted. Discover the deployed client's actual tool inventory;
engineering-capable clients also provide `gr_freeze_source`.

Development checks include `npm test` here and, in the client package,
`npm run typecheck && npm test`. Deployment qualification must additionally
exercise real OMP tool discovery, native bridge authentication, and completed
image delivery to the model; source/config preparation tests are not that proof.

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

## Explicit selected-repository GitHub PAT

This optional mode does **not** require Paperclip Cloud and does not manufacture
a managed OAuth grant. It requires a Linux controller, an isolated remote native
issue run with a GitHub policy capability, and `git`, `gh` and Node installed in
the runner (`/usr/bin/git`, `/usr/bin/gh`, and trusted Node on `PATH`).

Store the PAT once as an organization secret named `PAPERCLIP_GITHUB_TOKEN`.
In the authorized project's **Configuration → Env**, add `GR_GITHUB_TOKEN`,
choose **Organization secret**, then **Create new secret…**. Enter the shared
secret name and PAT, choose **Create & bind**, then **Save changes**. Other
approved projects can select that existing secret instead of copying its value.
The stored secret is organization-level; its environment binding is per-project.
Never paste a PAT into a plain project variable, agent configuration, repository
URL, this policy, or an operator's inherited environment.

The native secret name also supports Paperclip's host-side private checkout
when no managed GitHub identity is configured. That company-level facility is
separate from exporting the token to a runner.

Set the **host** environment
`PAPERCLIP_OMP_GITHUB_PAT_POLICY=/etc/gr/github/policy.json` and mount a regular,
operator-owned policy read-only, without group/other write permission:

```json
{
  "schemaVersion": 2,
  "companies": {
    "11111111-1111-4111-8111-111111111111": {
      "projects": {
        "33333333-3333-4333-8333-333333333333": {
          "repository": "example-org/project",
          "secretId": "44444444-4444-4444-8444-444444444444",
          "agents": ["22222222-2222-4222-8222-222222222222"]
        }
      }
    }
  }
}
```

The native workspace must identify the exact authorized project and HTTPS
`github.com` repository. The resolved `GR_GITHUB_TOKEN` must carry one successful
native binding for the policy's secret UUID. Missing, substituted or ambiguous
provenance fails closed before contacting GitHub. Before export, the adapter
also checks native run policy: only an eligible run with **absent** managed
identity can use this mode. Unavailable, revoked, low-trust or already-configured
managed identity is not a fallback opportunity. Schema 1 policies are rejected;
operators must migrate all grants before deploying this release.
GitHub `/user` and repository responses establish the real token owner's
identity and repository visibility; actual push/PR operations still enforce
GitHub permissions. Token-free run-local launchers clear ambient credentials,
use a URL-scoped HTTPS Git helper, and set the verified owner's noreply Git
identity. Local credential-free Git archive operations remain usable.

**Host prerequisite:** secret provenance must describe the effective environment,
not every earlier layer. Paperclip 2026.1012.0 concatenates manifests even when a
later plain value overrides a secret reference. The GR deployment applies its
native `secret-provenance.patch`: environment < agent < project < routine <
trusted projection; an override invalidates the earlier binding, even with equal
bytes. Do not deploy this mode on an unqualified host with stale manifests.
The same host patch makes strict secret mode recognize the GitHub token variable
names without treating `MAX_TOKENS` or `TOKEN_BUDGET` as credentials.

Grant only selected repositories and necessary Contents/PR permissions, with
expiry. A shared fine-grained PAT can cover multiple selected repositories under
one resource owner. Every credential-bearing runner can technically access
that entire selected set; project admission does not narrow GitHub's token scope.
GitHub permissions and branch protection are the authority ceiling: this is not
an egress sandbox, does not create a bot identity, and does not prohibit direct
branch writes by itself. Bind it only to approved engineering projects.
Public-repository readability is not proof of a selected write grant. Do not run
untrusted repository scripts in this credential-bearing runner; send committed
source to the credential-free Slurm test environment. Stop affected runs before
rotating/rebinding/revoking access, then revoke the old PAT at GitHub. The policy
pins a secret UUID, not a binding UUID or binding scope: the same approved secret
bound at another native layer can still satisfy admission. Removing only the
project reference is therefore not a complete revocation procedure; remove the
operator grant to deny future launches. Admission is checked at run start, not a
replacement for provider revocation.

The POSIX test suite exercises actual Git commits, credential-helper host
scoping, login-shell startup and anonymous source export, plus denied actor,
repository and native-policy cases. Real native GitHub push/PR qualification
requires an owner-provided selected-repository PAT; fixture tests do not prove
that external authorization.

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
paperclipai adapter install --payload-json "{\"packageName\":\"$PWD/$TARBALL\",\"version\":\"0.11.0\"}" --json
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

### Changes in 0.11.0

- Replaced agent-wide PAT grants with schema-2 project/repository/secret/agent admission.
- Required native secret-binding provenance before PAT export; rejected missing, substituted and ambiguous bindings.
- Documented shared organization-secret setup and the selected-repository authority ceiling.
- Qualified POSIX adapter smoke, native-policy denial, and real Git identity/credential-helper/source-export behavior; external push/PR proof remains deployment-specific.

### Changes in 0.10.0

- Added opt-in host-owned company/agent/repository PAT grants, native trust-policy preflight and verified GitHub-owner identity without Paperclip Cloud.
- Added isolated token-free Git/gh launchers; no ambient credential fallback or PAT-bearing installation/version probes.
- Increased the persistent workload MCP deadline to support bounded engineering source transfers.

### Changes in 0.9.0

- Materialized native runtime/project MCP and issue-scoped workload tools in isolated OMP configuration.
- Preserved native identity, deduplicated matching dual delivery, and rejected conflicting authority, inherited untrusted MCP configuration and project overrides.
- Routed remote native MCP through exact host-owned grants with rebased bridge credentials; required the qualified patched host SDK.
- Exercised a real Paperclip artist on the remote OMP runner, including live Slurm Blender edits, image delivery, saved artifacts and native task review.

### Changes in 0.8.0

- Adopted `@genrobo/paperclip-omp-adapter` and the GenRobo fork metadata; retained the original MIT license and attribution.
- Pinned Paperclip helper/shared contracts to 2026.1012.0.
- Added operator-owned remote-only execution/environment enforcement and non-spawning model/config/quota discovery on the hub.
- Reused the host's explicit model catalog contract; retained `omp_local` and existing policy-off behavior.

## License

MIT

