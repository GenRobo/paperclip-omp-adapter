import { createHash } from "node:crypto";
import path from "node:path";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import { ensurePathInEnv, runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { resolveOmpProfile } from "./profile.js";
import { requireRemoteOmpExecution } from "./policy.js";

const MODEL_CACHE_TTL_MS = 60_000;
const MODEL_DISCOVERY_TIMEOUT_SEC = 30;

type DiscoveryInput = {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
  profile?: unknown;
  agentDir?: unknown;
  configFiles?: unknown;
  extensions?: unknown;
  refresh?: unknown;
};

interface ResolvedDiscovery {
  command: string;
  cwd: string;
  env: Record<string, string>;
  profile: string | null;
  agentDir: string | null;
  configFiles: string[];
  extensions: string[];
  refresh: boolean;
}

type CachedModels = { expiresAt: number; models: AdapterModel[] };

const modelCache = new Map<string, CachedModels>();

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringEnv(value: unknown): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, item] of Object.entries(objectValue(value))) {
    if (typeof item === "string") env[key] = item;
  }
  return env;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(stringList);
  }
  const text = nonEmptyString(value);
  if (!text) return [];
  if (text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.flatMap(stringList);
    } catch {
      // Treat malformed JSON-looking input as a literal path below.
    }
  }
  const separator = text.includes("\n") ? /\r?\n/ : path.delimiter;
  return text.split(separator).map((item) => item.trim()).filter(Boolean);
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const result = nonEmptyString(value);
    if (result) return result;
  }
  return null;
}

function globalList(key: "PAPERCLIP_OMP_CONFIG_FILES" | "PAPERCLIP_OMP_EXTENSIONS"): string[] {
  return stringList(process.env[key]);
}

function resolveDiscovery(input: DiscoveryInput): ResolvedDiscovery {
  const inputEnv = stringEnv(input.env);
  const command = firstString(input.command, process.env.PAPERCLIP_OMP_COMMAND) ?? "omp";
  const cwd = firstString(input.cwd) ?? process.cwd();
  const profileSelection = resolveOmpProfile({ ...input, env: inputEnv });
  const profile = profileSelection.profile;
  const agentDir = firstString(
    input.agentDir,
    inputEnv.PI_CODING_AGENT_DIR,
    process.env.PAPERCLIP_OMP_AGENT_DIR,
  );
  const configFiles = stringList(input.configFiles);
  const extensions = stringList(input.extensions);
  const resolvedConfigFiles = configFiles.length ? configFiles : globalList("PAPERCLIP_OMP_CONFIG_FILES");
  const resolvedExtensions = extensions.length ? extensions : globalList("PAPERCLIP_OMP_EXTENSIONS");
  const env = stringEnv(ensurePathInEnv({ ...process.env, ...inputEnv }));

  if (profile) env.OMP_PROFILE = profile;
  else if (profileSelection.specified) {
    delete env.OMP_PROFILE;
    delete env.PI_PROFILE;
  }
  if (agentDir) env.PI_CODING_AGENT_DIR = agentDir;
  if (resolvedConfigFiles.length) env.PI_CONFIG_FILES = resolvedConfigFiles.join(path.delimiter);

  return {
    command,
    cwd,
    env,
    profile,
    agentDir,
    configFiles: resolvedConfigFiles,
    extensions: resolvedExtensions,
    refresh: input.refresh === true,
  };
}

function cacheKey(input: ResolvedDiscovery): string {
  const envHash = createHash("sha256");
  for (const [key, value] of Object.entries(input.env).sort(([a], [b]) => a.localeCompare(b))) {
    if (["PWD", "OLDPWD", "SHLVL", "_", "TERM_SESSION_ID"].includes(key)) continue;
    envHash.update(key).update("\0").update(value).update("\0");
  }
  return JSON.stringify({
    command: input.command,
    cwd: input.cwd,
    profile: input.profile,
    agentDir: input.agentDir,
    configFiles: input.configFiles,
    extensions: input.extensions,
    env: envHash.digest("hex"),
  });
}

function firstNonEmptyLine(value: string): string {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

function modelEnvelope(stdout: string): Record<string, unknown> | null {
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
      // Another line may contain the JSON payload.
    }
  }
  return null;
}

/** Parse the exact `omp models --json` envelope without trusting individual rows. */
export function parseOmpModelsOutput(stdout: string): AdapterModel[] {
  const envelope = modelEnvelope(stdout);
  if (!envelope || !Array.isArray(envelope.models)) return [];

  const models: AdapterModel[] = [];
  const seen = new Set<string>();
  for (const item of envelope.models) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const provider = nonEmptyString(row.provider);
    const modelId = nonEmptyString(row.id);
    const selector = nonEmptyString(row.selector);
    if (!provider || !modelId || !selector || seen.has(selector)) continue;
    seen.add(selector);
    const name = nonEmptyString(row.name);
    models.push({ id: selector, label: name ?? selector });
  }
  return models;
}

function buildArgs(input: ResolvedDiscovery): string[] {
  const args = ["models"];
  if (input.refresh) args.push("refresh");
  args.push("--json");
  for (const file of input.configFiles) args.push("--config", file);
  for (const extension of input.extensions) args.push("--extension", extension);
  return args;
}
/** Explicit host catalog, independent of agent config and local OMP installation. */
export function readOperatorModelCatalog(): AdapterModel[] | null {
  const raw = process.env.PAPERCLIP_ADAPTER_MODELS?.trim();
  if (!raw) return null;
  try {
    const catalog: unknown = JSON.parse(raw);
    if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) throw new Error("Expected an object.");
    const rows = (catalog as Record<string, unknown>).omp_local;
    if (rows === undefined) return null;
    if (!Array.isArray(rows)) throw new Error("Expected an array.");
    return rows.map((value) => {
      const row = objectValue(value);
      if (typeof row.id !== "string" || !row.id) throw new Error("Expected a model id.");
      return { id: row.id, label: typeof row.label === "string" ? row.label : row.id };
    });
  } catch {
    throw Object.assign(
      new Error('PAPERCLIP_ADAPTER_MODELS must be a JSON object mapping adapter types to arrays of {id,label?}; configure its omp_local entry with explicit provider/model selectors.'),
      { code: "omp_model_catalog_invalid" },
    );
  }
}

export async function discoverOmpModels(input: DiscoveryInput = {}): Promise<AdapterModel[]> {
  if (requireRemoteOmpExecution()) {
    const models = readOperatorModelCatalog();
    if (models) return models;
    throw Object.assign(
      new Error('Local OMP model discovery is disabled by PAPERCLIP_OMP_REQUIRE_REMOTE=true. Set an explicit provider/model in agent config.model; populate the model picker with host PAPERCLIP_ADAPTER_MODELS={"omp_local":[{"id":"provider/model"}]}.'),
      { code: "omp_explicit_model_required" },
    );
  }
  const resolved = resolveDiscovery(input);
  const key = cacheKey(resolved);
  const now = Date.now();
  for (const [cachedKey, value] of modelCache) {
    if (value.expiresAt <= now) modelCache.delete(cachedKey);
  }
  const cached = modelCache.get(key);
  if (!resolved.refresh && cached && cached.expiresAt > now) return cached.models;

  const result = await runChildProcess(
    `omp-models-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    resolved.command,
    buildArgs(resolved),
    {
      cwd: resolved.cwd,
      env: resolved.env,
      timeoutSec: MODEL_DISCOVERY_TIMEOUT_SEC,
      graceSec: 3,
      onLog: async () => {},
    },
  );

  const invocation = resolved.refresh ? "omp models refresh --json" : "omp models --json";
  if (result.timedOut) throw new Error(`\`${invocation}\` timed out after ${MODEL_DISCOVERY_TIMEOUT_SEC}s.`);
  if ((result.exitCode ?? 1) !== 0) {
    const detail = firstNonEmptyLine(result.stderr) || firstNonEmptyLine(result.stdout);
    throw new Error(detail ? `\`${invocation}\` failed: ${detail}` : `\`${invocation}\` failed.`);
  }
  if (!modelEnvelope(result.stdout)) {
    throw new Error(`\`${invocation}\` returned an invalid JSON envelope.`);
  }

  const models = parseOmpModelsOutput(result.stdout);
  modelCache.set(key, { expiresAt: now + MODEL_CACHE_TTL_MS, models });
  return models;
}

export async function listOmpModels(): Promise<AdapterModel[]> {
  if (requireRemoteOmpExecution()) return discoverOmpModels();
  try {
    return await discoverOmpModels();
  } catch {
    return [];
  }
}

export async function refreshOmpModels(): Promise<AdapterModel[]> {
  if (requireRemoteOmpExecution()) return discoverOmpModels({ refresh: true });
  try {
    return await discoverOmpModels({ refresh: true });
  } catch {
    return [];
  }
}

export function resetOmpModelsCacheForTests(): void {
  modelCache.clear();
}
