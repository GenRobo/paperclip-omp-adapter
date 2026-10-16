import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import {
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetDirectory,
  maybeRunSandboxInstallCommand,
  overrideAdapterExecutionTargetRemoteCwd,
  prepareAdapterExecutionTargetRuntime,
  resolveAdapterExecutionTargetCwd,
  runAdapterExecutionTargetProcess,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asNumber,
  asString,
  ensurePathInEnv,
  parseObject,
} from "@paperclipai/adapter-utils/server-utils";
import { OMP_INSTALL_COMMAND } from "../metadata.js";
import {
  prepareOmpRuntimeConfig,
  resolveOmpCommand,
  type PreparedOmpRuntimeConfig,
} from "./config.js";
import { parseOmpModelsOutput } from "./models.js";
import { rewriteRemoteConfigPaths } from "./execute.js";
import { remoteOmpTargetPolicyCheck } from "./policy.js";

const AUTH_ERROR_RE = /(?:auth(?:entication|orization)?\s+(?:required|failed)|api[_ -]?key|invalid\s+(?:key|token)|not\s+logged\s+in|login\s+required|credentials?\s+(?:missing|not found)|unauthorized|\b401\b|\b403\b)/i;
const CONFIG_ERROR_RE = /(?:models\.ya?ml|config\.ya?ml|validation failed|invalid (?:config|profile|yaml)|yaml.*(?:error|invalid)|unknown (?:setting|provider)|failed to load extension)/i;
const MODEL_ERROR_RE = /(?:model.*(?:not found|unavailable|unknown)|unknown model|no models? available)/i;

type PreparedTarget = {
  target: AdapterExecutionTarget | null;
  cwd: string;
  agentDir: string | null;
  restore(): Promise<void>;
};

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function stringEnv(value: unknown): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, item] of Object.entries(parseObject(value))) {
    if (typeof item === "string") env[key] = item;
  }
  return env;
}

function stringList(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\r?\n/)
      : [];
  return values
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function globalList(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  if (value.trim().startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) return stringList(parsed);
    } catch {
      // Use a native path list below.
    }
  }
  return value.split(value.includes("\n") ? /\r?\n/ : path.delimiter).map((item) => item.trim()).filter(Boolean);
}

function safeDetail(...values: string[]): string | null {
  const raw = values.flatMap((value) => value.split(/\r?\n/)).map((line) => line.trim()).find(Boolean);
  if (!raw) return null;
  const redacted = raw
    .replace(/(\bauthorization\s*:\s*bearer\s+)\S+/gi, "$1[REDACTED]")
    .replace(/((?:api[_ -]?key|token|secret|password|authorization)\s*[:=]\s*)\S+/gi, "$1[REDACTED]")
    .replace(/(:\/\/)[^\s/@:]+:[^\s/@]+@/g, "$1[REDACTED]@");
  const compact = redacted.replace(/\s+/g, " ").trim();
  return compact.length > 300 ? `${compact.slice(0, 299)}…` : compact;
}

function addFailureCheck(checks: AdapterEnvironmentCheck[], evidence: string, detail: string | null): void {
  if (CONFIG_ERROR_RE.test(evidence)) {
    checks.push({
      code: "omp_models_config_invalid",
      level: "error",
      message: "OMP model/config loading failed.",
      ...(detail ? { detail } : {}),
      hint: "Validate the selected profile, config overlays, extensions, and models.yml with `omp models --json` in this environment.",
    });
  } else if (MODEL_ERROR_RE.test(evidence)) {
    checks.push({
      code: "omp_model_unavailable",
      level: "warn",
      message: "OMP could not resolve an available model.",
      ...(detail ? { detail } : {}),
      hint: "Run `omp models --json` with the same profile and config, or enter a valid custom provider/model selector.",
    });
  } else if (AUTH_ERROR_RE.test(evidence)) {
    checks.push({
      code: "omp_provider_auth_required",
      level: "warn",
      message: "OMP is installed, but provider authentication is not ready.",
      ...(detail ? { detail } : {}),
      hint: "Bind the provider credential environment variable or authenticate the selected OMP profile, then retry.",
    });
  } else {
    checks.push({
      code: "omp_models_probe_failed",
      level: "error",
      message: "`omp models --json` failed.",
      ...(detail ? { detail } : {}),
      hint: "Run the same command in the selected environment to inspect OMP startup and extension diagnostics.",
    });
  }
}

async function prepareTarget(
  runId: string,
  target: AdapterExecutionTarget | null,
  cwd: string,
  localAgentDir: string | null,
): Promise<PreparedTarget> {
  if (target?.kind !== "remote") {
    return { target, cwd, agentDir: localAgentDir, restore: async () => {} };
  }

  const prepared = await prepareAdapterExecutionTargetRuntime({
    runId,
    target,
    adapterKey: "omp-envtest",
    workspaceLocalDir: cwd,
    installCommand: OMP_INSTALL_COMMAND,
    detectCommand: null,
    assets: localAgentDir ? [{ key: "agentDir", localDir: localAgentDir }] : [],
  });
  const remoteCwd = prepared.workspaceRemoteDir ?? target.remoteCwd;
  return {
    target: overrideAdapterExecutionTargetRemoteCwd(target, remoteCwd) ?? null,
    cwd: remoteCwd,
    agentDir: prepared.assetDirs.agentDir ?? null,
    restore: async () => {
      await prepared.restoreWorkspace().catch(() => {});
    },
  };
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = resolveOmpCommand(config);
  const target = ctx.executionTarget ?? null;
  const policyFailure = remoteOmpTargetPolicyCheck(target);
  if (policyFailure) {
    return {
      adapterType: ctx.adapterType,
      status: "fail",
      checks: [policyFailure],
      testedAt: new Date().toISOString(),
    };
  }
  const remote = target?.kind === "remote";
  const configuredCwd = asString(config.cwd, "").trim();
  const cwd = remote
    ? path.resolve(configuredCwd || process.cwd())
    : resolveAdapterExecutionTargetCwd(target, configuredCwd, process.cwd());
  const runId = `omp-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const targetLabel = remote ? ctx.environmentName ?? describeAdapterExecutionTarget(target) : null;

  if (targetLabel) {
    checks.push({
      code: "omp_environment_target",
      level: "info",
      message: `Probing inside environment: ${targetLabel}`,
    });
  }

  try {
    await ensureAdapterExecutionTargetDirectory(runId, remote ? null : target, cwd, {
      cwd,
      env: {},
      createIfMissing: false,
    });
    checks.push({ code: "omp_cwd_valid", level: "info", message: `Working directory is valid: ${cwd}` });
  } catch (error) {
    checks.push({
      code: "omp_cwd_invalid",
      level: "error",
      message: error instanceof Error ? error.message : "The configured working directory is invalid.",
      detail: cwd,
      hint: "Choose an existing directory inside the selected execution environment.",
    });
  }

  let preparedConfig: PreparedOmpRuntimeConfig | null = null;
  let preparedTarget: PreparedTarget | null = null;
  try {
    try {
      preparedConfig = await prepareOmpRuntimeConfig(config, { forceMaterialized: remote });
      for (const note of preparedConfig.notes) {
        checks.push({
          code: note.startsWith("Skipped ") ? "omp_runtime_config_skipped" : "omp_runtime_config",
          level: note.startsWith("Skipped ") ? "warn" : "info",
          message: note,
          ...(note.startsWith("Skipped ")
            ? { hint: "Use inline modelsYaml with environment-referenced credentials for remote custom providers." }
            : {}),
        });
      }
    } catch (error) {
      checks.push({
        code: "omp_runtime_config_failed",
        level: "error",
        message: "Could not prepare OMP runtime configuration.",
        detail: safeDetail(error instanceof Error ? error.message : String(error)),
        hint: "Check agentDir permissions and the inline modelsYaml configuration.",
      });
    }

    if (!preparedConfig || checks.some((check) => check.level === "error")) {
      return {
        adapterType: ctx.adapterType,
        status: summarizeStatus(checks),
        checks,
        testedAt: new Date().toISOString(),
      };
    }

    try {
      preparedTarget = await prepareTarget(runId, target, cwd, preparedConfig.agentDir);
    } catch (error) {
      checks.push({
        code: "omp_runtime_target_prepare_failed",
        level: "error",
        message: "Could not prepare OMP configuration in the selected execution environment.",
        detail: safeDetail(error instanceof Error ? error.message : String(error)),
        hint: "Verify environment connectivity and writable runtime storage, then retry.",
      });
      return {
        adapterType: ctx.adapterType,
        status: summarizeStatus(checks),
        checks,
        testedAt: new Date().toISOString(),
      };
    }

    let executionConfig = config;
    try {
      if (remote) executionConfig = rewriteRemoteConfigPaths(config, cwd, preparedTarget.cwd);
    } catch (error) {
      checks.push({
        code: "omp_remote_path_invalid",
        level: "error",
        message: "An OMP path cannot be projected into the remote workspace.",
        detail: safeDetail(error instanceof Error ? error.message : String(error)),
        hint: "Use paths inside config.cwd or paths relative to that synchronized workspace.",
      });
      return {
        adapterType: ctx.adapterType,
        status: summarizeStatus(checks),
        checks,
        testedAt: new Date().toISOString(),
      };
    }

    const configuredEnv = stringEnv(executionConfig.env);
    const remoteConfiguredEnv = Object.fromEntries(
      Object.entries(configuredEnv).filter(([key]) =>
        !key.startsWith("PAPERCLIP_") || key === "PAPERCLIP_API_KEY" || key === "PAPERCLIP_API_URL"),
    );
    const env = remote
      ? stringEnv(ensurePathInEnv(remoteConfiguredEnv))
      : stringEnv(ensurePathInEnv({ ...process.env, ...configuredEnv }));
    const profile = preparedConfig.profile;
    const clearProfile = preparedConfig.materialized || (preparedConfig.profileSpecified && profile === null);
    if (clearProfile) {
      env.OMP_PROFILE = "";
      env.PI_PROFILE = "";
    } else if (profile) {
      env.OMP_PROFILE = profile;
    }
    if (preparedTarget.agentDir) env.PI_CODING_AGENT_DIR = preparedTarget.agentDir;
    else if (process.env.PAPERCLIP_OMP_AGENT_DIR?.trim()) {
      env.PI_CODING_AGENT_DIR = process.env.PAPERCLIP_OMP_AGENT_DIR.trim();
    }

    const installCheck = await maybeRunSandboxInstallCommand({
      runId,
      target: preparedTarget.target,
      adapterKey: "omp",
      installCommand: OMP_INSTALL_COMMAND,
      detectCommand: command,
      env,
    }).catch((error): AdapterEnvironmentCheck => ({
      code: "omp_install_probe_failed",
      level: "warn",
      message: "Could not run the sandbox OMP installation check.",
      detail: safeDetail(error instanceof Error ? error.message : String(error)),
      hint: `Install OMP manually with: ${OMP_INSTALL_COMMAND}`,
    }));
    if (installCheck) checks.push(installCheck);

    try {
      await ensureAdapterExecutionTargetCommandResolvable(command, preparedTarget.target, preparedTarget.cwd, env);
    } catch (error) {
      checks.push({
        code: "omp_command_unresolvable",
        level: "error",
        message: "The configured OMP command is not executable in this environment.",
        detail: safeDetail(error instanceof Error ? error.message : String(error), command),
        hint: `Set command to an executable path or install OMP with: ${OMP_INSTALL_COMMAND}`,
      });
      return {
        adapterType: ctx.adapterType,
        status: summarizeStatus(checks),
        checks,
        testedAt: new Date().toISOString(),
      };
    }

    try {
      const version = await runAdapterExecutionTargetProcess(
        `${runId}-version`,
        preparedTarget.target,
        command,
        ["--version"],
        {
          cwd: preparedTarget.cwd,
          env,
          timeoutSec: 15,
          graceSec: 3,
          onLog: async () => {},
        },
      );
      const detail = safeDetail(version.stdout, version.stderr);
      if (version.timedOut) {
        checks.push({
          code: "omp_version_timed_out",
          level: "error",
          message: "`omp --version` timed out.",
          hint: "Run the configured command manually and check runtime startup dependencies.",
        });
      } else if ((version.exitCode ?? 1) !== 0) {
        checks.push({
          code: "omp_version_failed",
          level: "error",
          message: "The configured command did not complete `--version` successfully.",
          ...(detail ? { detail } : {}),
          hint: "Confirm command points to the OMP CLI rather than a shell command or another executable.",
        });
      } else {
        checks.push({
          code: "omp_version_ok",
          level: "info",
          message: detail ? `OMP command is ready: ${detail}` : `OMP command is ready: ${command}`,
        });
      }
    } catch (error) {
      checks.push({
        code: "omp_version_failed",
        level: "error",
        message: "Could not run the configured OMP command with `--version`.",
        detail: safeDetail(error instanceof Error ? error.message : String(error)),
        hint: "Confirm command is an executable path available inside this environment.",
      });
    }

    if (checks.some((check) => check.code === "omp_version_failed" || check.code === "omp_version_timed_out")) {
      return {
        adapterType: ctx.adapterType,
        status: summarizeStatus(checks),
        checks,
        testedAt: new Date().toISOString(),
      };
    }

    const configuredFiles = stringList(executionConfig.configFiles);
    const configuredExtensions = stringList(executionConfig.extensions);
    const configFiles = configuredFiles.length
      ? configuredFiles
      : remote ? [] : globalList(process.env.PAPERCLIP_OMP_CONFIG_FILES);
    const extensions = configuredExtensions.length
      ? configuredExtensions
      : remote ? [] : globalList(process.env.PAPERCLIP_OMP_EXTENSIONS);
    const args = ["models", "--json"];
    for (const file of configFiles) args.push("--config", file);
    if (executionConfig.noExtensions === true) args.push("--no-extensions");
    else for (const extension of extensions) args.push("--extension", extension);

    try {
      const result = await runAdapterExecutionTargetProcess(
        `${runId}-models`,
        preparedTarget.target,
        command,
        args,
        {
          cwd: preparedTarget.cwd,
          env,
          timeoutSec: Math.max(15, asNumber(config.modelProbeTimeoutSec, 60)),
          graceSec: 5,
          onLog: async () => {},
        },
      );
      const evidence = `${result.stderr}\n${result.stdout}`;
      const detail = safeDetail(result.stderr, result.stdout);
      if (result.timedOut) {
        checks.push({
          code: "omp_models_probe_timed_out",
          level: "warn",
          message: "`omp models --json` timed out while loading providers.",
          hint: "Retry, or disable a stalled discovery provider/extension in the selected OMP profile.",
        });
      } else if ((result.exitCode ?? 1) !== 0) {
        addFailureCheck(checks, evidence, detail);
      } else if (CONFIG_ERROR_RE.test(result.stderr)) {
        addFailureCheck(checks, result.stderr, detail);
      } else {
        const models = parseOmpModelsOutput(result.stdout);
        if (models.length === 0) {
          checks.push({
            code: "omp_models_empty",
            level: "warn",
            message: "OMP returned no available models.",
            ...(detail ? { detail } : {}),
            hint: "Authenticate a provider, start a configured local engine, or supply isolated modelsYaml and matching environment credentials.",
          });
        } else {
          checks.push({
            code: "omp_models_discovered",
            level: "info",
            message: `OMP reported ${models.length} available model${models.length === 1 ? "" : "s"}.`,
          });
        }

        const configuredModel = asString(config.model, "").trim();
        if (configuredModel) {
          if (/^@[A-Za-z][A-Za-z0-9_-]*$/.test(configuredModel)) {
            checks.push({
              code: "omp_model_role_alias",
              level: "info",
              message: `Configured model uses OMP role alias: ${configuredModel}`,
            });
          } else if (models.some((model) => model.id === configuredModel)) {
            checks.push({
              code: "omp_model_available",
              level: "info",
              message: `Configured model is available: ${configuredModel}`,
            });
          } else {
            checks.push({
              code: "omp_model_not_listed",
              level: "warn",
              message: `Configured model is not in OMP's available-model list: ${configuredModel}`,
              hint: "Free-text custom selectors remain allowed; verify the provider is loaded and authenticated with the same profile/config.",
            });
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addFailureCheck(checks, message, safeDetail(message));
    }
  } finally {
    await preparedTarget?.restore().catch(() => {});
    await preparedConfig?.cleanup().catch(() => {});
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
