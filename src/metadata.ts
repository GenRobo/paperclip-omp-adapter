export const type = "omp_local";
export const label = "Oh My Pi (OMP)";
export const OMP_INSTALL_COMMAND = "npm install -g @oh-my-pi/pi-coding-agent@latest";

export const models: Array<{ id: string; label: string }> = [];

export const agentConfigurationDoc = `# omp_local agent configuration

Use when:
- Paperclip should run the local Oh My Pi (OMP) coding-agent CLI with its complete headless tool, skill, rule, hook, extension, task/subagent, memory, and model-provider stack
- You need local OMP sessions resumed across Paperclip heartbeats
- You need built-in, fetched, custom models, custom providers, local engines, or extension-registered providers discovered by OMP itself

Don't use when:
- You need a webhook or hosted agent endpoint rather than a CLI process
- You need live mid-turn steering or interactive OMP dialogs; Paperclip's external adapter contract is heartbeat-oriented
- OMP is unavailable in the selected execution environment

Core fields:
- model: exact OMP selector (provider/model); free text is accepted for custom providers
- command: OMP executable, default omp
- cwd: fallback working directory when Paperclip has no execution workspace
- profile / agentDir: select local OMP auth, settings, sessions, models.yml, and caches; remote runs upload sanitized configuration only
- modelsYaml: optional isolated inline models.yml; provide credentials through Paperclip environment secret bindings
- thinking: off, minimal, low, medium, high, xhigh, max, or auto
- smolModel / slowModel / planModel: role overrides used by OMP's auxiliary work
- tools / noTools: optional comma-separated allowlist and explicit default-tool disable; blank preserves OMP's complete default toolset
- modelCycle: optional selectors passed to OMP --models
- approvalMode: yolo, write, or always-ask; always passed to OMP, defaulting to yolo for headless runs
- extensions / hooks / pluginDirs / configFiles: newline-separated OMP paths
- advisor, prewalk/noPrewalk, planYolo, skills, rules, LSP, PTY, title, allowHome, and ephemeral-session controls map directly to OMP flags
- systemPrompt replaces OMP's base prompt while Paperclip's execution contract remains appended
- timeoutSec / graceSec / maxTime: Paperclip process deadline, termination grace, and OMP in-session deadline

Model behavior:
- Normally, Paperclip model listing calls omp models --json and refresh calls omp models refresh --json
- OMP returns available models only; unavailable models remain enterable manually
- Active ~/.omp/agent/models.yml, profile-specific config, runtime discovery, and extension providers are authoritative
- With host PAPERCLIP_OMP_REQUIRE_REMOTE=true, model discovery never invokes OMP locally. Set model explicitly; the operator can populate the picker via PAPERCLIP_ADAPTER_MODELS.omp_local

Operational behavior:
- Host PAPERCLIP_OMP_REQUIRE_REMOTE=true rejects missing/local targets before command probes or execution; agent config and config.env cannot disable this policy
- Remote-only deployments require a host-provided SSH target or sandbox provider runner; the adapter type remains omp_local
- Each heartbeat runs omp --mode json -p under Paperclip process supervision
- Local sessions use an adapter-owned --session-dir and exact --resume id; remote runs are deliberately ephemeral because Paperclip remote runtime directories are per run
- Raw OMP JSONL is streamed unchanged; unknown events fall back to raw transcript output
- Paperclip skills are linked into OMP's active agent skills directory without modifying the project workspace
`;
