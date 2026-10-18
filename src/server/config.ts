import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AdapterConfigSchema,
  AdapterModel,
  ConfigFieldOption,
  ConfigFieldSchema,
} from "@paperclipai/adapter-utils";
import {
  ensurePathInEnv,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { listOmpModels, readOperatorModelCatalog } from "./models.js";
import { normalizeOmpProfile, resolveOmpProfile } from "./profile.js";
import { requireRemoteOmpExecution } from "./policy.js";
import { materializeRuntimeMcp, type RuntimeMcpPlan } from "./mcp.js";

const CONFIG_PROBE_TIMEOUT_SEC = 15;
const CONFIG_BLOCK_ALLOWLIST: Record<string, true> = {
  defaultThinkingLevel: true,
  disabledExtensions: true,
  disabledProviders: true,
  enabledModels: true,
  extensions: true,
  modelProviderOrder: true,
  modelRoles: true,
  modelTags: true,
  providers: true,
  retry: true,
  skills: true,
  tools: true,
};
const MODEL_BLOCK_ALLOWLIST: Record<string, true> = { modelOverrides: true, providers: true };
const YAML_FILENAMES = ["config.yml", "config.yaml", "models.yml", "models.yaml"] as const;

export interface PreparedOmpRuntimeConfig {
  agentDir: string | null;
  profile: string | null;
  profileSpecified: boolean;
  materialized: boolean;
  notes: string[];
  cleanup(): Promise<void>;
}

type RuntimeSelection = {
  profile: string | null;
  profileSpecified: boolean;
  agentDir: string | null;
  sourceAgentDir: string | null;
  env: Record<string, string>;
};

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const result = nonEmptyString(value);
    if (result) return result;
  }
  return null;
}

function stringEnv(value: unknown): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, item] of Object.entries(objectValue(value))) {
    if (typeof item === "string") env[key] = item;
  }
  return env;
}

function configRoot(env: Record<string, string> = {}): string {
  const configured = firstString(env.PI_CONFIG_DIR, process.env.PI_CONFIG_DIR) ?? ".omp";
  if (configured === "~") return os.homedir();
  if (configured.startsWith("~/") || configured.startsWith("~\\")) {
    return path.resolve(os.homedir(), configured.slice(2));
  }
  return path.resolve(os.homedir(), configured);
}

function profileAgentDir(profile: string | null, env: Record<string, string> = {}): string | null {
  return profile ? path.join(configRoot(env), "profiles", profile, "agent") : null;
}

function runtimeSelection(config: unknown): RuntimeSelection {
  const record = objectValue(config);
  const configuredEnv = stringEnv(record.env);
  const profileSelection = resolveOmpProfile(record);
  const profile = profileSelection.profile;
  const configuredAgentDir = firstString(
    record.agentDir,
    configuredEnv.PI_CODING_AGENT_DIR,
    process.env.PAPERCLIP_OMP_AGENT_DIR,
    process.env.PI_CODING_AGENT_DIR,
  );
  const root = configRoot(configuredEnv);
  const derivedProfileDir = profileAgentDir(profile, configuredEnv);
  return {
    profile,
    profileSpecified: profileSelection.specified,
    agentDir: profile ? null : configuredAgentDir,
    sourceAgentDir: derivedProfileDir ?? configuredAgentDir ?? path.join(root, "agent"),
    env: configuredEnv,
  };
}

export function resolveOmpCommand(config: unknown): string {
  return firstString(objectValue(config).command, process.env.PAPERCLIP_OMP_COMMAND) ?? "omp";
}

function envPathList(value: string | undefined): string[] {
  const text = nonEmptyString(value);
  if (!text) return [];
  if (text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          .map((item) => item.trim());
      }
    } catch {
      // Fall through to the native path-list representation.
    }
  }
  return text.split(text.includes("\n") ? /\r?\n/ : path.delimiter).map((item) => item.trim()).filter(Boolean);
}

export function detectionEnv(): Record<string, string> {
  const profileSelection = resolveOmpProfile({});
  const agentDir = firstString(process.env.PAPERCLIP_OMP_AGENT_DIR);
  const configFiles = envPathList(process.env.PAPERCLIP_OMP_CONFIG_FILES);
  const env = stringEnv(ensurePathInEnv({ ...process.env }));
  if (profileSelection.profile) env.OMP_PROFILE = profileSelection.profile;
  else if (profileSelection.specified) {
    delete env.OMP_PROFILE;
    delete env.PI_PROFILE;
  }
  if (agentDir) env.PI_CODING_AGENT_DIR = agentDir;
  if (configFiles.length) env.PI_CONFIG_FILES = configFiles.join(path.delimiter);
  return env;
}

function jsonObjectFromOutput(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  const candidates = [trimmed, ...trimmed.split(/\r?\n/).reverse().map((line) => line.trim())];
  for (const candidate of candidates) {
    if (!candidate.startsWith("{") || !candidate.endsWith("}")) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Ignore non-JSON diagnostic lines.
    }
  }
  return null;
}

async function configProbe(command: string, args: string[], env: Record<string, string>) {
  return runChildProcess(
    `omp-config-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    command,
    args,
    {
      cwd: process.cwd(),
      env,
      timeoutSec: CONFIG_PROBE_TIMEOUT_SEC,
      graceSec: 3,
      onLog: async () => {},
    },
  );
}

export async function detectModel(): Promise<{
  model: string;
  provider: string;
  source: string;
  candidates?: string[];
} | null> {
  if (requireRemoteOmpExecution()) return null;
  const command = resolveOmpCommand({});
  try {
    const env = detectionEnv();
    const result = await configProbe(command, ["config", "get", "modelRoles", "--json"], env);
    if (result.timedOut || (result.exitCode ?? 1) !== 0) return null;
    const payload = jsonObjectFromOutput(result.stdout);
    const roles = objectValue(payload?.value);
    const model = nonEmptyString(roles.default);
    if (!model) return null;

    const candidates: string[] = [];
    for (const value of Object.values(roles)) {
      const selector = nonEmptyString(value);
      if (selector && !candidates.includes(selector)) candidates.push(selector);
    }
    if (!candidates.includes(model)) candidates.unshift(model);

    let source = "OMP effective modelRoles.default";
    try {
      const pathResult = await configProbe(command, ["config", "path"], env);
      const agentDir = !pathResult.timedOut && (pathResult.exitCode ?? 1) === 0
        ? firstString(pathResult.stdout.split(/\r?\n/)[0])
        : null;
      if (agentDir) source = path.join(agentDir, "config.yml");
    } catch {
      // The effective value is still authoritative when the optional path probe fails.
    }

    const slash = model.indexOf("/");
    return {
      model,
      provider: slash > 0 ? model.slice(0, slash) : "",
      source,
      ...(candidates.length > 1 ? { candidates } : {}),
    };
  } catch {
    return null;
  }
}

async function profileOptions(): Promise<ConfigFieldOption[]> {
  const names = new Set<string>();
  try {
    const entries = await fs.readdir(path.join(configRoot(), "profiles"), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const normalized = normalizeOmpProfile(entry.name);
        if (normalized) names.add(normalized);
      } catch {
        // Ignore directories OMP itself cannot activate as profiles.
      }
    }
  } catch {
    // A profiles directory is optional.
  }
  try {
    const configured = resolveOmpProfile({}).profile;
    if (configured) names.add(configured);
  } catch {
    // Invalid environment profiles are reported by the environment probe.
  }
  return [
    { value: "", label: "Default profile" },
    ...[...names].sort().map((name) => ({ value: name, label: name })),
  ];
}

function modelOptions(models: AdapterModel[]): ConfigFieldOption[] {
  return models.map((model) => {
    const slash = model.id.indexOf("/");
    return {
      value: model.id,
      label: model.label === model.id ? model.id : `${model.label} (${model.id})`,
      ...(slash > 0 ? { group: model.id.slice(0, slash) } : {}),
    };
  });
}

export async function getConfigSchema(): Promise<AdapterConfigSchema> {
  const [models, detected, profiles] = await Promise.all([
    requireRemoteOmpExecution() ? readOperatorModelCatalog() ?? [] : listOmpModels(),
    detectModel(),
    profileOptions(),
  ]);
  const options = modelOptions(models);
  let defaultProfile = "";
  try {
    defaultProfile = resolveOmpProfile({}).profile ?? "";
  } catch {
    // Environment validation reports invalid profile values.
  }
  const roleField = (key: string, label: string, hint: string): ConfigFieldSchema => ({
    key,
    label,
    type: "combobox",
    options,
    hint,
    group: "Models",
  });

  return {
    fields: [
      {
        key: "model",
        label: "Model",
        type: "combobox",
        options,
        ...(detected ? { default: detected.model } : {}),
        hint: requireRemoteOmpExecution()
          ? "Remote-only deployment: set an explicit provider/model selector. Local OMP discovery is disabled; the operator can populate this picker with PAPERCLIP_ADAPTER_MODELS.omp_local."
          : "Exact OMP selector (provider/model). Free text is accepted for custom or extension providers.",
        group: "Models",
      },
      roleField("smolModel", "Small/fast model", "Optional selector passed to OMP --smol for cheap auxiliary work."),
      roleField("slowModel", "Slow/reasoning model", "Optional selector passed to OMP --slow for difficult auxiliary work."),
      roleField("planModel", "Planning model", "Optional selector passed to OMP --plan."),
      {
        key: "thinking",
        label: "OMP thinking override",
        type: "select",
        options: ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"].map((value) => ({ value, label: value })),
        hint: "Full OMP thinking level. Overrides the top-level Paperclip effort setting.",
        group: "Models",
      },
      {
        key: "modelCycle",
        label: "Model cycle allowlist",
        type: "text",
        hint: "Optional comma-separated selectors passed to OMP --models.",
        group: "Models",
      },

      {
        key: "modelsYaml",
        label: "Isolated models.yml",
        type: "textarea",
        hint: "Optional complete models.yml. It runs in an isolated OMP agent directory; reference secrets by environment variable name instead of embedding values.",
        group: "Models",
      },
      {
        key: "command",
        label: "OMP command",
        type: "text",
        default: resolveOmpCommand({}),
        hint: "Executable name or absolute path. PAPERCLIP_OMP_COMMAND is the global fallback.",
        group: "Runtime",
      },
      {
        key: "cwd",
        label: "Fallback working directory",
        type: "text",
        hint: "Used only when Paperclip does not provide an execution workspace.",
        group: "Runtime",
      },
      {
        key: "profile",
        label: "OMP profile",
        type: "combobox",
        options: profiles,
        default: defaultProfile,
        hint: "Named ~/.omp profile. Profiles override agentDir in OMP.",
        group: "Runtime",
      },
      {
        key: "agentDir",
        label: "OMP agent directory",
        type: "text",
        default: firstString(process.env.PAPERCLIP_OMP_AGENT_DIR) ?? undefined,
        hint: "Optional PI_CODING_AGENT_DIR override for the default profile.",
        group: "Runtime",
      },
      {
        key: "timeoutSec",
        label: "Process timeout seconds",
        type: "number",
        default: 43200,
        hint: "Paperclip terminates the OMP process after this many seconds. 43200 = 12 hours, sized for long autonomous runs.",
        group: "Runtime",
      },
      {
        key: "graceSec",
        label: "Termination grace seconds",
        type: "number",
        default: 20,
        hint: "Seconds between the stop signal and SIGKILL, so OMP can close the session and flush its session file.",
        group: "Runtime",
      },
      {
        key: "maxTime",
        label: "OMP max time seconds",
        type: "text",
        hint: "Optional in-session deadline passed to OMP --max-time.",
        group: "Runtime",
      },
      {
        key: "sessionDir",
        label: "Session directory",
        type: "text",
        hint: "Optional OMP session directory override. Paperclip otherwise uses an agent-scoped directory.",
        group: "Runtime",
      },
      {
        key: "noSession",
        label: "Ephemeral session",
        type: "toggle",
        default: false,
        hint: "Pass --no-session and return no resumable Paperclip session metadata.",
        group: "Runtime",
      },
      {
        key: "allowHome",
        label: "Allow home as cwd",
        type: "toggle",
        default: false,
        hint: "Pass OMP --allow-home when the resolved workspace is the user's home directory.",
        group: "Runtime",
      },
      {
        key: "approvalMode",
        label: "Approval mode",
        type: "select",
        default: "yolo",
        options: [
          { value: "yolo", label: "Auto-approve (yolo)" },
          { value: "write", label: "Ask before writes" },
          { value: "always-ask", label: "Always ask" },
        ],
        hint: "Headless runs default to yolo; choose a stricter mode when interactive approval is available. Applied even when the field is empty, so the run does not depend on tools.approvalMode in the OMP config.",
        group: "Capabilities",
      },
      {
        key: "printThoughts",
        label: "Print thinking thoughts",
        type: "toggle",
        default: true,
        hint: "Thinking blocks are streamed into the Paperclip transcript. Turn off to shrink run logs.",
        group: "Capabilities",
      },
      {
        key: "addDirs",
        label: "Secondary workspaces",
        type: "textarea",
        hint: "One workspace root per line. Remote runs require paths inside the synchronized workspace and remap them into the runner; unstaged host directories are not available.",
        group: "Runtime",
      },
      {
        key: "tools",
        label: "Tool allowlist",
        type: "text",
        hint: "Comma-separated OMP tool names. Empty preserves OMP's complete default toolset.",
        group: "Capabilities",
      },
      {
        key: "noTools",
        label: "Disable default tools",
        type: "toggle",
        default: false,
        hint: "Pass --no-tools. Combine with a tool allowlist to enable only those tools.",
        group: "Capabilities",
      },
      { key: "advisor", label: "Enable advisor", type: "toggle", default: false, group: "Capabilities" },
      { key: "noPrewalk", label: "Disable configured prewalk", type: "toggle", default: false, group: "Capabilities" },
      {
        key: "prewalk",
        label: "Enable prewalk",
        type: "toggle",
        default: false,
        group: "Capabilities",
        meta: { visibleWhen: { key: "noPrewalk", notValues: ["true"] } },
      },
      {
        key: "prewalkInto",
        label: "Prewalk target model",
        type: "text",
        group: "Capabilities",
        meta: { visibleWhen: { key: "noPrewalk", notValues: ["true"] } },
      },
      { key: "planYolo", label: "Enable plan yolo", type: "toggle", default: false, group: "Capabilities" },
      {
        key: "planYoloInto",
        label: "Plan yolo target model",
        type: "text",
        group: "Capabilities",
        meta: { visibleWhen: { key: "planYolo", value: "true" } },
      },
      {
        key: "configFiles",
        label: "Config overlays",
        type: "textarea",
        hint: "One OMP config.yml overlay path per line, in precedence order.",
        group: "Extensions",
      },
      {
        key: "extensions",
        label: "Extensions",
        type: "textarea",
        hint: "One OMP extension path per line.",
        group: "Extensions",
      },
      {
        key: "pluginDirs",
        label: "Plugin directories",
        type: "textarea",
        hint: "One OMP --plugin-dir path per line.",
        group: "Extensions",
      },
      {
        key: "hooks",
        label: "Hooks",
        type: "textarea",
        hint: "One OMP hook/extension path per line.",
        group: "Extensions",
      },
      {
        key: "skills",
        label: "Skill filter",
        type: "text",
        hint: "Optional comma-separated OMP skill names. Empty keeps normal skill discovery.",
        group: "Extensions",
      },
      { key: "noExtensions", label: "Disable extension discovery", type: "toggle", default: false, group: "Extensions" },
      { key: "noSkills", label: "Disable skills", type: "toggle", default: false, group: "Extensions" },
      { key: "noRules", label: "Disable rules", type: "toggle", default: false, group: "Extensions" },
      { key: "noLsp", label: "Disable LSP", type: "toggle", default: false, group: "Capabilities" },
      { key: "noPty", label: "Disable PTY tools", type: "toggle", default: false, group: "Capabilities" },
      { key: "noTitle", label: "Disable terminal title", type: "toggle", default: true, group: "Capabilities" },
      {
        key: "systemPrompt",
        label: "OMP base system prompt",
        type: "textarea",
        hint: "Optional replacement for OMP's base system prompt. Paperclip's execution contract is still appended.",
        group: "Advanced",
      },
      {
        key: "extraArgs",
        label: "Extra OMP arguments",
        type: "textarea",
        hint: "One literal argument per line. Arguments are passed directly without shell evaluation.",
        group: "Advanced",
      },
      {
        key: "instructionsFilePath",
        label: "Instructions bundle path",
        type: "text",
        hint: "Optional Paperclip-managed instructions bundle path.",
        group: "Advanced",
      },
    ],
  };
}

type YamlRecord = Record<string, unknown>;

function parseYamlRecord(content: string): YamlRecord {
  if (/\t/.test(content) || /(?:^|\s)!(?:!|<)/.test(content)) {
    throw new Error("OMP YAML contains unsupported tags or tab indentation.");
  }
  const parsed: unknown = parseYaml(content, { maxAliasCount: 50 });
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OMP YAML must contain a top-level mapping.");
  }
  return parsed as YamlRecord;
}

function sensitiveKey(key: string): "apiKey" | "secret" | null {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalized === "apikey") return "apiKey";
  if (
    /(?:secret|password|credential|cookie|authorization|privatekey|clientsecret|accesskey|headers?)$/.test(normalized) ||
    (normalized.endsWith("token") && normalized !== "maxtokens" && normalized !== "inputtokens" && normalized !== "outputtokens")
  ) return "secret";
  return null;
}

function stringContainsCredential(value: string): boolean {
  return (
    value.includes("$(") ||
    /:\/\/[^\s/@]+@/.test(value) ||
    /[?&#](?:api[_-]?key|access[_-]?token|token|secret|password|auth(?:orization)?)(?:=|%3d)/i.test(value)
  );
}

function containsCredential(
  value: unknown,
  env: Record<string, string>,
  key = "",
  seen = new WeakSet<object>(),
): boolean {
  const kind = sensitiveKey(key);
  if (kind === "apiKey") {
    return typeof value !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ||
      !nonEmptyString(env[value]);
  }
  if (kind === "secret") return true;
  if (typeof value === "string") return stringContainsCredential(value);
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return true;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((item) => containsCredential(item, env, "", seen));
  }
  return Object.entries(value).some(([childKey, item]) => containsCredential(item, env, childKey, seen));
}

function projectYaml(
  content: string,
  kind: "config" | "models",
  env: Record<string, string>,
  options: { omitPathSettings?: boolean; notes?: string[] } = {},
): string | null {
  const parsed = parseYamlRecord(content);
  const allowlist = kind === "config" ? CONFIG_BLOCK_ALLOWLIST : MODEL_BLOCK_ALLOWLIST;
  const projected: YamlRecord = Object.create(null) as YamlRecord;
  for (const [key, value] of Object.entries(parsed)) {
    if (!Object.hasOwn(allowlist, key)) continue;
    if (kind === "config" && options.omitPathSettings && key === "extensions") {
      options.notes?.push("Skipped config extensions during remote materialization; use workspace-relative adapter extensions instead.");
      continue;
    }
    if (key === "providers" && value !== null && typeof value === "object" && !Array.isArray(value)) {
      const providers: YamlRecord = Object.create(null) as YamlRecord;
      for (const [provider, providerConfig] of Object.entries(value)) {
        if (containsCredential(providerConfig, env)) {
          options.notes?.push(`Skipped provider ${provider}: credential-bearing configuration cannot be materialized.`);
          continue;
        }
        providers[provider] = providerConfig;
      }
      if (Object.keys(providers).length > 0) projected[key] = providers;
      continue;
    }
    if (!containsCredential(value, env, key)) projected[key] = value;
  }
  return Object.keys(projected).length > 0 ? stringifyYaml(projected, { lineWidth: 0 }) : null;
}

function validatedInlineModelsYaml(content: string, env: Record<string, string>): string {
  const parsed = parseYamlRecord(content);
  for (const [key, value] of Object.entries(parsed)) {
    if (!Object.hasOwn(MODEL_BLOCK_ALLOWLIST, key)) continue;
    if (containsCredential(value, env, key)) {
      throw new Error(
        "modelsYaml contains credential-bearing fields. Bind secrets through config.env and reference the environment variable name from apiKey.",
      );
    }
  }
  const projected = projectYaml(content, "models", env);
  if (!projected) {
    throw new Error("modelsYaml contains no supported modelOverrides or providers configuration.");
  }
  return projected;
}

async function copySanitizedYaml(
  sourceDir: string,
  targetDir: string,
  filenames: readonly (typeof YAML_FILENAMES)[number][],
  notes: string[],
  env: Record<string, string>,
  omitPathSettings = false,
): Promise<void> {
  for (const filename of filenames) {
    const source = path.join(sourceDir, filename);
    let content: string;
    try {
      content = await fs.readFile(source, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      notes.push(`Could not read ${filename}; it was not materialized.`);
      continue;
    }
    const projected = projectYaml(
      content,
      filename.startsWith("models.") ? "models" : "config",
      env,
      { omitPathSettings, notes },
    );
    if (!projected) {
      notes.push(`Skipped ${filename}: no whitelisted, non-secret configuration could be materialized safely.`);
      continue;
    }
    await fs.writeFile(path.join(targetDir, filename), projected, { encoding: "utf8", mode: 0o600 });
    notes.push(`Materialized sanitized ${filename} without auth state.`);
  }
}

export async function prepareOmpRuntimeConfig(
  config: unknown,
  options: { forceMaterialized?: boolean; runtimeMcp?: RuntimeMcpPlan | null } = {},
): Promise<PreparedOmpRuntimeConfig> {
  const record = objectValue(config);
  const selection = runtimeSelection(record);
  const hasInlineModels = typeof record.modelsYaml === "string" && record.modelsYaml.trim().length > 0;
  const mustMaterialize = hasInlineModels || options.forceMaterialized === true || Boolean(options.runtimeMcp);
  if (!mustMaterialize) {
    return {
      agentDir: selection.agentDir,
      profile: selection.profile,
      profileSpecified: selection.profileSpecified,
      materialized: false,
      notes: selection.profile && firstString(record.agentDir)
        ? ["OMP profile selection takes precedence over agentDir."]
        : [],
      cleanup: async () => {},
    };
  }

  const notes: string[] = [];
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-omp-agent-"));
  await fs.chmod(tempDir, 0o700);
  let cleaned = false;
  const materializationEnv = { ...stringEnv(process.env), ...selection.env };
  try {
    if (selection.sourceAgentDir) {
      const files = hasInlineModels
        ? (["config.yml", "config.yaml"] as const)
        : YAML_FILENAMES;
      await copySanitizedYaml(
        selection.sourceAgentDir,
        tempDir,
        files,
        notes,
        materializationEnv,
        options.forceMaterialized === true,
      );
    }
    if (hasInlineModels) {
      const inlineModels = validatedInlineModelsYaml(record.modelsYaml as string, materializationEnv);
      await fs.writeFile(path.join(tempDir, "models.yml"), inlineModels, {
        encoding: "utf8",
        mode: 0o600,
      });
      notes.push("Using a sanitized inline models.yml; credentials must remain in environment bindings.");
    } else {
      notes.push("Using a materialized OMP agent directory; agent.db and secret-bearing configuration were not copied.");
    }
    if (options.runtimeMcp) {
      await materializeRuntimeMcp(tempDir, selection.sourceAgentDir, options.runtimeMcp);
      notes.push("Materialized native MCP servers with an isolated project-discovery policy; operator MCP configuration was not overwritten.");
    }
    return {
      agentDir: tempDir,
      profile: selection.profile,
      profileSpecified: selection.profileSpecified,
      materialized: true,
      notes,
      cleanup: async () => {
        if (cleaned) return;
        cleaned = true;
        await fs.rm(tempDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
