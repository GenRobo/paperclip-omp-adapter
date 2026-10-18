import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  inferOpenAiCompatibleBiller,
  type AdapterExecutionContext,
  type AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import {
  type AdapterExecutionTargetPaperclipBridgeHandle,
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches,
  adapterExecutionTargetUsesManagedHome,
  adapterExecutionTargetUsesPaperclipBridge,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetDirectory,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  overrideAdapterExecutionTargetRemoteCwd,
  prepareAdapterExecutionTargetRuntime,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetCommandForLogs,
  resolveAdapterExecutionTargetTimeoutSec,
  runAdapterExecutionTargetProcess,
  startAdapterExecutionTargetPaperclipBridge,
} from "@paperclipai/adapter-utils/execution-target";
import * as executionTargetApi from "@paperclipai/adapter-utils/execution-target";
import {
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  asBoolean,
  asNumber,
  asString,
  buildInvocationEnvForLogs,
  buildPaperclipEnv,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  joinPromptSections,
  parseObject,
  readPaperclipIssueWorkModeFromContext,
  refreshPaperclipWorkspaceEnvForExecution,
  renderPaperclipWakePrompt,
  renderTemplate,
  sanitizeInheritedPaperclipEnv,
  stringifyPaperclipWakePayload,
} from "@paperclipai/adapter-utils/server-utils";
import { OMP_INSTALL_COMMAND } from "../metadata.js";
import {
  prepareOmpRuntimeConfig,
  resolveOmpCommand,
  type PreparedOmpRuntimeConfig,
} from "./config.js";
import {
  createOmpOutputAccumulator,
  isOmpUnknownSessionError,
  parseOmpJsonLine,
  type ParsedOmpOutput,
} from "./parse.js";
import { classifyOmpFailure } from "./failure.js";
import { createOmpProgressReporter } from "./progress.js";
import { ensureOmpSkills } from "./skills.js";
import { remoteOmpTargetPolicyCheck } from "./policy.js";
import { assertRuntimeMcpConfig, bridgedRuntimeMcpEnv, createRuntimeMcpPlan, MCP_OVERLAY_FILENAME, rejectRuntimeMcpSettingsConflicts } from "./mcp.js";
import { applyGitHubPatEnvironment, createGitHubPatPlan, materializeGitHubPatLaunchers } from "./github-pat.js";

const CAPABILITY_MANIFEST = {
  bindings: [
    "omp-jsonl",
    "session-dir-resume",
    "paperclip-workspace-env",
    "paperclip-skills",
    "local-execution",
    "ssh-execution",
    "sandbox-execution",
  ],
  limits: [
    "one-process-per-heartbeat",
    "no-live-steering",
    "no-interactive-dialogs",
    "no-rpc-transport",
    "schema-driven-ui-only",
    "no-provider-quota-hook",
    "no-remote-session-resume",
  ],
} as const;

type ProcessAttempt = {
  proc: {
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    stdout: string;
    stderr: string;
  };
  parsed: ParsedOmpOutput;
  pendingToolCount: number;
  sawProviderWork: boolean;
  reporterFailed: boolean;
};

function stringList(value: unknown, commaSeparated = false): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(commaSeparated ? /[\r\n,]+/ : /\r?\n/)
      : [];
  return values
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const REMOTE_PATH_FIELDS = ["configFiles", "extensions", "hooks", "pluginDirs"] as const;

export function rewriteRemoteConfigPaths(
  config: Record<string, unknown>,
  localCwd: string,
  remoteCwd: string,
): Record<string, unknown> {
  const rewritten = { ...config };
  for (const field of REMOTE_PATH_FIELDS) {
    const values = stringList(config[field]);
    if (values.length === 0) continue;
    rewritten[field] = values.map((value) => {
      const expanded = value === "~"
        ? os.homedir()
        : value.startsWith("~/") || value.startsWith("~\\")
          ? path.resolve(os.homedir(), value.slice(2))
          : path.resolve(localCwd, value);
      const relative = path.relative(localCwd, expanded);
      if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
        throw new Error(
          `Remote OMP ${field} path must be inside the synchronized workspace: ${value}`,
        );
      }
      return relative && relative !== "."
        ? path.posix.join(remoteCwd, ...relative.split(path.sep))
        : remoteCwd;
    });
  }
  return rewritten;
}

function firstNonEmptyLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

function safePathSegment(value: string): string {
  return encodeURIComponent(value).replaceAll(".", "%2E");
}

function executionCwdsMatch(saved: string, current: string, remote: boolean): boolean {
  return remote
    ? path.posix.normalize(saved) === path.posix.normalize(current)
    : path.resolve(saved) === path.resolve(current);
}

function stringsOnly(env: NodeJS.ProcessEnv | Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function configuredModelProvider(model: string): string | null {
  if (!model || model.startsWith("@")) return null;
  const separator = model.indexOf("/");
  return separator > 0 ? model.slice(0, separator) : null;
}

function resolveBiller(env: Record<string, string>, provider: string | null): string {
  return provider ?? inferOpenAiCompatibleBiller(env, null) ?? "unknown";
}

function addWakeEnvironment(
  env: Record<string, string>,
  runId: string,
  context: Record<string, unknown>,
): void {
  env.PAPERCLIP_RUN_ID = runId;
  const taskId = asString(context.taskId, "").trim() || asString(context.issueId, "").trim();
  const wakeReason = asString(context.wakeReason, "").trim();
  const wakeCommentId = asString(context.wakeCommentId, "").trim() || asString(context.commentId, "").trim();
  const approvalId = asString(context.approvalId, "").trim();
  const approvalStatus = asString(context.approvalStatus, "").trim();
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const wakePayload = stringifyPaperclipWakePayload(context.paperclipWake);
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);
  if (taskId) env.PAPERCLIP_TASK_ID = taskId;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (wakePayload) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayload;
  if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
}

function buildOmpArgs(input: {
  config: Record<string, unknown>;
  context?: Record<string, unknown>;
  cwd?: string;
  systemPrompt: string;
  userPrompt: string;
  sessionDir: string;
  resumeSessionId: string | null;
  omitProfile: boolean;
  effectiveProfile: string | null;
  mcpConfigPath?: string;
}): string[] {
  const { config } = input;
  const args = ["--mode", "json", "-p"];
  const baseSystemPrompt = asString(config.systemPrompt, "").trim();
  if (baseSystemPrompt) args.push("--system-prompt", baseSystemPrompt);
  args.push("--append-system-prompt", input.systemPrompt);
  const model = asString(config.model, "").trim();
  const thinking = (asString(config.thinking, "") || asString(config.thinkingEffort, "") || asString(config.effort, "")).trim();
  const profile = input.effectiveProfile ?? "";
  const smol = asString(config.smolModel, "").trim();
  const slow = asString(config.slowModel, "").trim();
  const plan = asString(config.planModel, "").trim();
  const modelCycle = stringList(config.modelCycle, true);
  const tools = stringList(config.tools, true);
  const skills = stringList(config.skills, true);
  const approvalMode = asString(config.approvalMode, "").trim();
  const noSession = asBoolean(config.noSession, false);

  if (model) args.push("--model", model);
  args.push(asBoolean(config.printThoughts, true) ? "--print-thoughts" : "--hide-thinking");
  if (thinking) args.push("--thinking", thinking);
  if (profile && !input.omitProfile) args.push("--profile", profile);
  if (smol) args.push("--smol", smol);
  if (slow) args.push("--slow", slow);
  if (plan) args.push("--plan", plan);
  if (modelCycle.length > 0) args.push("--models", modelCycle.join(","));
  if (asBoolean(config.noTools, false)) args.push("--no-tools");
  if (tools.length > 0) args.push("--tools", tools.join(","));
  if (skills.length > 0) args.push("--skills", skills.join(","));

  args.push(
    "--approval-mode",
    ["always-ask", "write", "yolo"].includes(approvalMode) ? approvalMode : "yolo",
  );

  if (asBoolean(config.advisor, false)) args.push("--advisor");
  const noPrewalk = asBoolean(config.noPrewalk, false);
  const prewalkInto = asString(config.prewalkInto, "").trim();
  if (noPrewalk) {
    args.push("--no-prewalk");
  } else {
    if (asBoolean(config.prewalk, false)) args.push("--prewalk");
    if (prewalkInto) args.push("--prewalk-into", prewalkInto);
  }
  if (asBoolean(config.allowHome, false)) args.push("--allow-home");
  const planYolo = asBoolean(config.planYolo, false);
  const planYoloInto = asString(config.planYoloInto, "").trim();
  if (planYolo) {
    args.push("--plan-yolo");
    if (planYoloInto) args.push("--plan-yolo-into", planYoloInto);
  }

  const maxTime = asString(config.maxTime, "").trim() || (asNumber(config.maxTime, 0) > 0 ? String(asNumber(config.maxTime, 0)) : "");
  if (maxTime) args.push("--max-time", maxTime);
  for (const configFile of stringList(config.configFiles)) args.push("--config", configFile);
  for (const extension of stringList(config.extensions)) args.push("--extension", extension);
  for (const pluginDir of stringList(config.pluginDirs)) args.push("--plugin-dir", pluginDir);
  for (const hook of stringList(config.hooks)) args.push("--hook", hook);

  if (asBoolean(config.noExtensions, false)) args.push("--no-extensions");
  if (asBoolean(config.noSkills, false)) args.push("--no-skills");
  if (asBoolean(config.noRules, false)) args.push("--no-rules");
  if (asBoolean(config.noLsp, false)) args.push("--no-lsp");
  if (asBoolean(config.noPty, false)) args.push("--no-pty");
  if (asBoolean(config.noTitle, true)) args.push("--no-title");

  if (noSession) {
    args.push("--no-session");
  } else {
    args.push("--session-dir", input.sessionDir);
    if (input.resumeSessionId) args.push("--resume", input.resumeSessionId);
  }

  const primaryCwd = input.cwd ? path.resolve(input.cwd) : "";
  const addedDirs = new Set<string>();
  for (const dir of stringList(config.addDirs)) {
    const resolved = path.resolve(dir);
    if (resolved && resolved !== primaryCwd && !addedDirs.has(resolved)) {
      addedDirs.add(resolved);
      args.push("--add-dir=" + resolved);
    }
  }
  if (input.context && Array.isArray(input.context.paperclipWorkspaces)) {
    for (const ws of input.context.paperclipWorkspaces) {
      if (ws && typeof ws === "object" && !Array.isArray(ws)) {
        const wsCwd = asString((ws as Record<string, unknown>).cwd, "").trim();
        if (wsCwd) {
          const resolved = path.resolve(wsCwd);
          if (resolved && resolved !== primaryCwd && !addedDirs.has(resolved)) {
            addedDirs.add(resolved);
            args.push("--add-dir=" + resolved);
          }
        }
      }
    }
  }
  args.push(...stringList(config.extraArgs));
  if (input.mcpConfigPath) args.push("--config", input.mcpConfigPath);
  args.push(input.userPrompt);
  return args;
}

async function buildPrompts(input: {
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  agent: AdapterExecutionContext["agent"];
  runId: string;
  resumedSession: boolean;
  cwd: string;
  onLog: AdapterExecutionContext["onLog"];
}): Promise<{
  systemPrompt: string;
  userPrompt: string;
  promptMetrics: Record<string, number>;
  notes: string[];
}> {
  const templateData = {
    agentId: input.agent.id,
    companyId: input.agent.companyId,
    runId: input.runId,
    company: { id: input.agent.companyId },
    agent: input.agent,
    run: { id: input.runId, source: "on_demand" },
    context: input.context,
  };
  const notes: string[] = [];
  const instructionsPath = asString(input.config.instructionsFilePath, "").trim();
  let instructions = "";
  if (instructionsPath) {
    const resolvedPath = path.resolve(input.cwd, instructionsPath);
    try {
      const contents = await fs.readFile(resolvedPath, "utf8");
      instructions = joinPromptSections([
        contents,
        `The above agent instructions were loaded from ${resolvedPath}. Resolve relative file references from ${path.dirname(resolvedPath)}/.`,
      ]);
      notes.push(`Loaded agent instructions from ${resolvedPath}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await input.onLog("stderr", `[paperclip] Warning: could not read agent instructions file "${resolvedPath}": ${reason}\n`);
      notes.push(`Configured instructionsFilePath ${resolvedPath}, but it could not be read.`);
    }
  }

  const paperclipContract = renderTemplate(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE, templateData);
  const systemPrompt = joinPromptSections([instructions, paperclipContract]);
  const promptTemplate = asString(input.config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const bootstrapTemplate = asString(input.config.bootstrapPromptTemplate, "");
  const bootstrapPrompt = !input.resumedSession && bootstrapTemplate.trim()
    ? renderTemplate(bootstrapTemplate, templateData).trim()
    : "";
  const wakePrompt = renderPaperclipWakePrompt(input.context.paperclipWake, {
    resumedSession: input.resumedSession,
  });
  const wakePayload = parseObject(input.context.paperclipWake);
  const recoveryWake = Object.keys(parseObject(wakePayload.recovery)).length > 0 ||
    asString(wakePayload.reason, "").trim() === "source_scoped_recovery_action";
  const heartbeatPrompt = (
    (input.resumedSession && wakePrompt.length > 0) || recoveryWake
  )
    ? ""
    : renderTemplate(promptTemplate, templateData).trim();
  const sessionHandoff = asString(input.context.paperclipSessionHandoffMarkdown, "").trim();
  const userPrompt = joinPromptSections([
    bootstrapPrompt,
    wakePrompt,
    sessionHandoff,
    heartbeatPrompt,
  ]);
  return {
    systemPrompt,
    userPrompt,
    promptMetrics: {
      systemPromptChars: systemPrompt.length,
      instructionsChars: instructions.length,
      promptChars: userPrompt.length,
      bootstrapPromptChars: bootstrapPrompt.length,
      wakePromptChars: wakePrompt.length,
      sessionHandoffChars: sessionHandoff.length,
      heartbeatPromptChars: heartbeatPrompt.length,
    },
    notes,
  };
}


export function applyPreparedOmpAgentEnvironment(
  env: Record<string, string>,
  prepared: PreparedOmpRuntimeConfig,
  agentDir: string | null = prepared.agentDir,
): void {
  if (agentDir) env.PI_CODING_AGENT_DIR = agentDir;
  if (!prepared.materialized && !(prepared.profileSpecified && prepared.profile === null)) return;
  env.OMP_PROFILE = "";
  env.PI_PROFILE = "";
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const policyFailure = remoteOmpTargetPolicyCheck(executionTarget);
  if (policyFailure) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: policyFailure.code,
      errorFamily: "configuration",
      errorMessage: `${policyFailure.message} ${policyFailure.hint}`,
    };
  }
  const remote = adapterExecutionTargetIsRemote(executionTarget);
  const workspace = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspace.cwd, "").trim();
  const configuredCwd = asString(config.cwd, "").trim();
  const cwd = workspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const issueId = asString(context.taskId, "").trim() || asString(context.issueId, "").trim();
  const runtimeMcp = createRuntimeMcpPlan(ctx.runtimeTools, ctx.runtimeMcp, issueId);
  if (runtimeMcp) {
    assertRuntimeMcpConfig(config);
    if (remote && runtimeMcp.httpServers.length &&
        (!adapterExecutionTargetUsesPaperclipBridge(executionTarget) ||
         !("PAPERCLIP_RUNTIME_MCP_BRIDGE_VERSION" in executionTargetApi) ||
         executionTargetApi.PAPERCLIP_RUNTIME_MCP_BRIDGE_VERSION !== 1)) {
      throw new Error("Remote native MCP requires the host SDK's runtime MCP bridge version 1; no direct hub credentials or unreachable host endpoints are sent to the runner.");
    }
    const overlayFiles = [
      ...stringList(config.configFiles),
      ...(!remote ? (process.env.PI_CONFIG_FILES ?? "").split(path.delimiter).filter(Boolean) : []),
    ].map(filename => path.resolve(cwd, filename.startsWith("~/") || filename.startsWith("~\\") ? path.join(os.homedir(), filename.slice(2)) : filename));
    await rejectRuntimeMcpSettingsConflicts([
      path.join(cwd, ".omp", "config.yml"),
      path.join(cwd, ".omp", "settings.json"),
      path.join(cwd, ".claude", "settings.json"),
      ...overlayFiles,
    ], runtimeMcp);
  }
  const preparedConfig = await prepareOmpRuntimeConfig(config, { forceMaterialized: remote, runtimeMcp });
  let restoreWorkspace: (() => Promise<void>) | null = null;
  let paperclipBridge: AdapterExecutionTargetPaperclipBridgeHandle | null = null;
  try {
    await ensureOmpSkills(config, preparedConfig.agentDir ?? undefined);

    const configuredEnv = parseObject(config.env);
    const githubPat = await createGitHubPatPlan({
      companyId: agent.companyId, projectId: asString(workspace.projectId, ""), agentId: agent.id, issueId,
      repoUrl: asString(workspace.repoUrl, ""), remote, env: configuredEnv,
      workspaceMode: asString(workspace.mode, ""), workspaceStrategy: asString(workspace.strategy, ""),
      executionWorkspaceId: asString(context.executionWorkspaceId, ""),
      secretManifest: parseObject(context.paperclipSecrets).manifest,
    });
    if (githubPat) {
      if (!preparedConfig.agentDir) throw new Error("GitHub PAT execution requires an isolated runtime asset directory.");
      await materializeGitHubPatLaunchers(preparedConfig.agentDir);
    }
    const env: Record<string, string> = buildPaperclipEnv(agent);
    addWakeEnvironment(env, runId, context);
    const workspaceHints = Array.isArray(context.paperclipWorkspaces)
      ? context.paperclipWorkspaces.filter(
          (value): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value),
        )
      : [];
    let effectiveExecutionCwd = executionTarget?.kind === "remote" ? executionTarget.remoteCwd : cwd;
    refreshPaperclipWorkspaceEnvForExecution({
      env,
      envConfig: {},
      workspaceCwd,
      workspaceSource: asString(workspace.source, ""),
      workspaceStrategy: asString(workspace.strategy, ""),
      workspaceId: asString(workspace.workspaceId, ""),
      workspaceRepoUrl: asString(workspace.repoUrl, ""),
      workspaceRepoRef: asString(workspace.repoRef, ""),
      workspaceBranch: asString(workspace.branch, ""),
      workspaceWorktreePath: asString(workspace.worktreePath, ""),
      workspaceHints,
      agentHome: asString(workspace.agentHome, ""),
      executionTargetIsRemote: remote,
      executionCwd: effectiveExecutionCwd,
    });
    for (const [key, value] of Object.entries(configuredEnv)) {
      if (typeof value !== "string") continue;
      if (key.startsWith("PAPERCLIP_") && Object.hasOwn(env, key)) continue;
      env[key] = value;
    }
    if (authToken && (runtimeMcp || !env.PAPERCLIP_API_KEY)) env.PAPERCLIP_API_KEY = authToken;
    if (runtimeMcp && !remote) Object.assign(env, runtimeMcp.env);
    const runtimeToolGuidance = runtimeMcp?.guidance ?? "";
    applyPreparedOmpAgentEnvironment(env, preparedConfig);

    const inheritedLocalEnv = stringsOnly(sanitizeInheritedPaperclipEnv(process.env));
    applyPreparedOmpAgentEnvironment(inheritedLocalEnv, preparedConfig, null);
    if (preparedConfig.materialized || (preparedConfig.profileSpecified && preparedConfig.profile === null)) {
      inheritedLocalEnv.OMP_PROFILE = "";
      inheritedLocalEnv.PI_PROFILE = "";
    }
    const localRuntimeEnv = stringsOnly(ensurePathInEnv({ ...inheritedLocalEnv, ...env }));
    const targetEnv = remote ? stringsOnly(ensurePathInEnv(env)) : localRuntimeEnv;
    // Version probes/install checks do not need the real host-side run authority.
    if (remote && adapterExecutionTargetUsesPaperclipBridge(executionTarget)) delete targetEnv.PAPERCLIP_API_KEY;
    delete targetEnv.GR_GITHUB_TOKEN;
    const command = resolveOmpCommand(config);
    const timeoutSec = resolveAdapterExecutionTargetTimeoutSec(
      executionTarget,
      asNumber(config.timeoutSec, 43200),
    );
    const graceSec = asNumber(config.graceSec, 20);

    await ensureAdapterExecutionTargetRuntimeCommandInstalled({
      runId,
      target: executionTarget,
      installCommand: ctx.runtimeCommandSpec?.installCommand,
      detectCommand: ctx.runtimeCommandSpec?.detectCommand ?? command,
      cwd,
      env: targetEnv,
      timeoutSec,
      graceSec,
      onLog,
    });
    await ensureAdapterExecutionTargetCommandResolvable(command, executionTarget, cwd, targetEnv, {
      installCommand: OMP_INSTALL_COMMAND,
      timeoutSec,
    });

    let runtimeRootDir: string | null = null;
    let executionConfig = config;
    if (remote) {
      await onLog(
        "stdout",
        `[paperclip] Syncing workspace and OMP runtime assets to ${describeAdapterExecutionTarget(executionTarget)}.\n`,
      );
      const preparedTarget = await prepareAdapterExecutionTargetRuntime({
        runId,
        target: executionTarget,
        adapterKey: "omp",
        workspaceLocalDir: cwd,
        timeoutSec,
        installCommand: ctx.runtimeCommandSpec?.installCommand ?? OMP_INSTALL_COMMAND,
        detectCommand: ctx.runtimeCommandSpec?.detectCommand ?? command,
        onProgress: (line) => onLog("stdout", line),
        onRuntimeProgress: ctx.onRuntimeProgress,
        assets: preparedConfig.agentDir
          ? [{ key: "agentDir", localDir: preparedConfig.agentDir, followSymlinks: true }]
          : [],
      });
      restoreWorkspace = () => preparedTarget.restoreWorkspace((line) => onLog("stdout", line));
      effectiveExecutionCwd = preparedTarget.workspaceRemoteDir ?? effectiveExecutionCwd;
      executionConfig = { ...rewriteRemoteConfigPaths(config, cwd, effectiveExecutionCwd), noSession: true };
      runtimeRootDir = preparedTarget.runtimeRootDir;
      applyPreparedOmpAgentEnvironment(env, preparedConfig, preparedTarget.assetDirs.agentDir ?? null);
      if (adapterExecutionTargetUsesManagedHome(executionTarget) && runtimeRootDir) env.HOME = runtimeRootDir;
      refreshPaperclipWorkspaceEnvForExecution({
        env,
        envConfig: {},
        workspaceCwd,
        workspaceSource: asString(workspace.source, ""),
        workspaceStrategy: asString(workspace.strategy, ""),
        workspaceId: asString(workspace.workspaceId, ""),
        workspaceRepoUrl: asString(workspace.repoUrl, ""),
        workspaceRepoRef: asString(workspace.repoRef, ""),
        workspaceBranch: asString(workspace.branch, ""),
        workspaceWorktreePath: asString(workspace.worktreePath, ""),
        workspaceHints,
        agentHome: asString(workspace.agentHome, ""),
        executionTargetIsRemote: true,
        executionCwd: effectiveExecutionCwd,
      });
      applyPreparedOmpAgentEnvironment(env, preparedConfig, preparedTarget.assetDirs.agentDir ?? null);
    }

    const runtimeTarget = overrideAdapterExecutionTargetRemoteCwd(executionTarget, effectiveExecutionCwd);
    if (remote && adapterExecutionTargetUsesPaperclipBridge(runtimeTarget)) {
      const bridgeInput = {
        runId,
        target: runtimeTarget,
        runtimeRootDir,
        adapterKey: "omp",
        timeoutSec,
        hostApiToken: env.PAPERCLIP_API_KEY,
        hostApiUrl: env.PAPERCLIP_API_URL,
        runtimeMcpServers: runtimeMcp?.httpServers,
        onLog,
      };
      paperclipBridge = await startAdapterExecutionTargetPaperclipBridge(bridgeInput);
      if (paperclipBridge) {
        Object.assign(env, paperclipBridge.env);
        if (runtimeMcp) Object.assign(env, bridgedRuntimeMcpEnv(runtimeMcp, paperclipBridge.env));
      }
    }
    if (runtimeMcp?.workloadCommand) {
      if (!env.PAPERCLIP_API_URL || !env.PAPERCLIP_API_KEY || env.PAPERCLIP_TASK_ID !== issueId || env.PAPERCLIP_RUN_ID !== runId || (remote && !paperclipBridge)) {
        throw new Error("Workload MCP requires native issue/run authority and, for remote runs, a working Paperclip API bridge.");
      }
    }

    const omitProfile = preparedConfig.materialized || (preparedConfig.profileSpecified && preparedConfig.profile === null);
    const invocationEnv = remote ? stringsOnly(ensurePathInEnv(env)) : localRuntimeEnv;
    if (remote) applyPreparedOmpAgentEnvironment(invocationEnv, preparedConfig, env.PI_CODING_AGENT_DIR ?? null);
    if (githubPat) {
      if (!invocationEnv.PI_CODING_AGENT_DIR) throw new Error("GitHub PAT runtime assets were not installed.");
      applyGitHubPatEnvironment(invocationEnv, invocationEnv.PI_CODING_AGENT_DIR, githubPat);
    }
    const invocationProbeEnv = { ...invocationEnv };
    delete invocationProbeEnv.GR_GITHUB_TOKEN;
    if (runtimeMcp?.workloadCommand) {
      await ensureAdapterExecutionTargetCommandResolvable(
        runtimeMcp.workloadCommand,
        runtimeTarget,
        cwd,
        invocationProbeEnv,
        { timeoutSec: Math.min(timeoutSec || 15, 15) },
      );
    }
    const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(
      command,
      runtimeTarget,
      cwd,
      invocationProbeEnv,
    );
    const loggedEnv = buildInvocationEnvForLogs(remote ? invocationEnv : env, {
      runtimeEnv: invocationEnv,
      includeRuntimeKeys: ["HOME"],
      resolvedCommand,
    });

    const runtimeParams = parseObject(runtime.sessionParams);
    const savedSessionId = asString(runtimeParams.sessionId, runtime.sessionId ?? "").trim();
    const savedCwd = asString(runtimeParams.cwd, "").trim();
    const savedSessionDir = asString(runtimeParams.sessionDir, "").trim();
    const savedRemoteExecution = parseObject(runtimeParams.remoteExecution);
    const ephemeralSession = asBoolean(executionConfig.noSession, false);
    const canResume = Boolean(
      !ephemeralSession &&
      savedSessionId &&
      (!savedCwd || executionCwdsMatch(savedCwd, effectiveExecutionCwd, remote)) &&
      adapterExecutionTargetSessionMatches(savedRemoteExecution, runtimeTarget),
    );
    if (savedSessionId && !canResume) {
      await onLog(
        "stdout",
        `[paperclip] OMP session "${savedSessionId}" does not match the current workspace or execution target; starting fresh.\n`,
      );
    }

    const configuredSessionDir = asString(executionConfig.sessionDir, "").trim();
    const defaultSessionDir = remote
      ? path.posix.join(
          runtimeRootDir ?? path.posix.join(effectiveExecutionCwd, ".paperclip-runtime", "omp"),
          "sessions",
          safePathSegment(agent.id),
        )
      : path.join(os.homedir(), ".omp", "paperclip", "sessions", safePathSegment(agent.id));
    const sessionDir = canResume && savedSessionDir
      ? savedSessionDir
      : configuredSessionDir || defaultSessionDir;
    if (!ephemeralSession) {
      await ensureAdapterExecutionTargetDirectory(runId, runtimeTarget, sessionDir, {
        cwd,
        env: invocationEnv,
        timeoutSec: Math.min(timeoutSec || 15, 15),
        graceSec: Math.min(graceSec, 5),
        onLog,
        createIfMissing: true,
      });
    }

    const prompts = await buildPrompts({
      config: executionConfig,
      context,
      agent,
      runId,
      resumedSession: canResume,
      cwd,
      onLog,
    });
    if (runtimeToolGuidance) {
      prompts.systemPrompt = joinPromptSections([prompts.systemPrompt, runtimeToolGuidance]);
      prompts.promptMetrics.systemPromptChars = prompts.systemPrompt.length;
    }
    const commandNotes = [
      ...preparedConfig.notes,
      ...prompts.notes,
      canResume ? `Resuming OMP session ${savedSessionId}` : `Using fresh OMP session directory ${sessionDir}`,
      ...(remote ? ["Remote execution uses an ephemeral OMP session; remote runtime directories are per run."] : []),
      ...(githubPat ? [`Explicit repository PAT: ${githubPat.login} (${githubPat.userId}), approved workspace ${githubPat.repository}; not a managed Paperclip GitHub grant.`] : []),
    ];

    const runAttempt = async (resumeSessionId: string | null): Promise<ProcessAttempt> => {
      const args = buildOmpArgs({
        config: executionConfig,
        context,
        cwd,
        systemPrompt: prompts.systemPrompt,
        userPrompt: prompts.userPrompt,
        sessionDir,
        resumeSessionId,
        omitProfile,
        effectiveProfile: preparedConfig.profile,
        mcpConfigPath: runtimeMcp && env.PI_CODING_AGENT_DIR
          ? (remote ? path.posix : path).join(env.PI_CODING_AGENT_DIR, MCP_OVERLAY_FILENAME)
          : undefined,
      });
      if (onMeta) {
        await onMeta({
          adapterType: "omp_local",
          command: resolvedCommand,
          cwd: effectiveExecutionCwd,
          commandArgs: args.map((value, index) => index === args.length - 1 ? `<prompt ${prompts.userPrompt.length} chars>` : value),
          commandNotes,
          env: loggedEnv,
          prompt: prompts.userPrompt,
          promptMetrics: prompts.promptMetrics,
          context,
        });
      }

      let stdoutBuffer = "";
      let reporterFailed = false;
      let logQueue = Promise.resolve();
      const queueLog = (stream: "stdout" | "stderr", chunk: string): Promise<void> => {
        logQueue = logQueue.then(() => onLog(stream, chunk)).catch(() => {});
        return logQueue;
      };
      const reporter = createOmpProgressReporter(ctx.onRuntimeProgress, ctx.onEvent);
      const accumulator = createOmpOutputAccumulator();
      const ingestLine = async (line: string): Promise<void> => {
        const trimmed = line.trim();
        if (!trimmed) return;
        const event = parseOmpJsonLine(trimmed);
        accumulator.push(trimmed, event);
        try {
          await reporter.ingest(trimmed, event);
        } catch {
          reporterFailed = true;
        }
      };
      const bufferedOnLog = async (stream: "stdout" | "stderr", chunk: string): Promise<void> => {
        if (stream === "stderr") {
          await queueLog(stream, chunk);
          return;
        }
        stdoutBuffer += chunk;
        let newline = stdoutBuffer.indexOf("\n");
        while (newline >= 0) {
          const completeLine = stdoutBuffer.slice(0, newline + 1);
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          await queueLog("stdout", completeLine);
          await ingestLine(completeLine);
          newline = stdoutBuffer.indexOf("\n");
        }
      };

      let spawnedPgid: number | null = null;
      let spawnedPid: number | null = null;
      let abortHandler: (() => void) | null = null;

      const handleSpawn = async (meta: { pid: number; processGroupId: number | null; startedAt: string }) => {
        spawnedPid = meta.pid;
        spawnedPgid = meta.processGroupId;
        if (onSpawn) await onSpawn(meta);
        if (ctx.signal?.aborted) {
          triggerProcessAbort();
        }
      };

      const triggerProcessAbort = () => {
        try {
          if (spawnedPgid && spawnedPgid > 0) {
            process.kill(-spawnedPgid, "SIGINT");
          } else if (spawnedPid && spawnedPid > 0) {
            process.kill(spawnedPid, "SIGINT");
          }
        } catch {
          // Process may have already exited.
        }
      };

      if (ctx.signal) {
        abortHandler = () => triggerProcessAbort();
        if (ctx.signal.aborted) {
          triggerProcessAbort();
        } else {
          ctx.signal.addEventListener("abort", abortHandler, { once: true });
        }
      }

      await ctx.onCancellationReady?.();

      let proc;
      try {
        proc = await runAdapterExecutionTargetProcess(runId, runtimeTarget, command, args, {
          cwd,
          env: invocationEnv,
          timeoutSec,
          graceSec,
          onSpawn: handleSpawn,
          onRuntimeProgress: ctx.onRuntimeProgress,
          onLog: bufferedOnLog,
          runLogTail: paperclipBridge?.runLogTail,
        });
      } finally {
        if (ctx.signal && abortHandler) {
          ctx.signal.removeEventListener("abort", abortHandler);
        }
      }
      if (stdoutBuffer) {
        await queueLog("stdout", stdoutBuffer);
        await ingestLine(stdoutBuffer);
      }
      await logQueue;
      try {
        await reporter.flush();
      } catch {
        reporterFailed = true;
      }
      return {
        proc,
        parsed: accumulator.result(),
        pendingToolCount: reporter.pendingToolCount(),
        sawProviderWork: reporter.sawProviderWork(),
        reporterFailed,
      };
    };

    const toResult = (
      attempt: ProcessAttempt,
      retriedFresh: boolean,
      priorAttempt?: ProcessAttempt,
    ): AdapterExecutionResult => {
      const parsedError = attempt.parsed.errors.find((error) => error.trim()) ?? "";
      const stderrLine = firstNonEmptyLine(attempt.proc.stderr);
      const processExitCode = attempt.proc.exitCode ?? (attempt.proc.signal ? 1 : 0);
      const effectiveExitCode = processExitCode === 0 && parsedError ? 1 : processExitCode;
      const resolvedSessionId = ephemeralSession
        ? null
        : attempt.parsed.sessionId ?? (!retriedFresh ? savedSessionId || null : null);
      const remoteExecution = remote ? adapterExecutionTargetSessionIdentity(runtimeTarget) : null;
      const sessionParams = resolvedSessionId
        ? {
            sessionId: resolvedSessionId,
            cwd: effectiveExecutionCwd,
            sessionDir,
            ...(remoteExecution ? { remoteExecution } : {}),
          }
        : null;
      const provider = attempt.parsed.provider ?? configuredModelProvider(asString(executionConfig.model, "").trim());
      const model = attempt.parsed.model ?? (asString(executionConfig.model, "").trim() || null);
      const fallbackError = parsedError || stderrLine || `OMP exited with code ${effectiveExitCode}.`;
      const failed = effectiveExitCode !== 0 || attempt.proc.timedOut;
      const classification = failed
        ? classifyOmpFailure({
            parsedError,
            stderr: attempt.proc.stderr,
            timedOut: attempt.proc.timedOut,
            exitCode: effectiveExitCode,
            signal: attempt.proc.signal,
          })
        : { errorCode: null, errorFamily: null, retryNotBefore: null };
      const cancelled = ctx.signal?.aborted === true && (failed || attempt.proc.signal !== null);
      const executionRecovery = cancelled && resolvedSessionId && attempt.pendingToolCount === 0
        ? { kind: "interrupted", providerStopped: true, sessionPreserved: true, actionOutcomes: "settled" } as const
        : !attempt.sawProviderWork && failed
          ? { kind: "bootstrap", providerWorkStarted: false } as const
          : null;
      const result: AdapterExecutionResult & { usageBasis: "per_run" } = {
        exitCode: effectiveExitCode,
        signal: attempt.proc.signal,
        timedOut: attempt.proc.timedOut,
        errorMessage: attempt.proc.timedOut
          ? `Timed out after ${timeoutSec}s`
          : failed
            ? fallbackError
            : null,
        ...(classification.errorCode ? { errorCode: classification.errorCode } : {}),
        ...(classification.errorFamily ? { errorFamily: classification.errorFamily } : {}),
        ...(classification.retryNotBefore ? { retryNotBefore: classification.retryNotBefore } : {}),
        ...(executionRecovery ? { executionRecovery } : {}),
        usage: attempt.parsed.usage,
        usageBasis: "per_run",
        sessionId: resolvedSessionId,
        sessionParams,
        sessionDisplayId: resolvedSessionId,
        provider,
        biller: resolveBiller(invocationEnv, provider),
        model,
        billingType: "unknown",
        costUsd: attempt.parsed.costUsd,
        ...(attempt.parsed.costUsd > 0 ? { cacheAdjustedCostUsd: attempt.parsed.costUsd } : {}),
        summary: attempt.parsed.finalMessage ?? attempt.parsed.messages.at(-1) ?? null,
        clearSession: retriedFresh && !resolvedSessionId,
        resultJson: {
          ...(executionRecovery?.kind === "interrupted"
            ? { executionCancellation: { state: "acknowledged" } }
            : {}),
          stdout: attempt.proc.stdout,
          stderr: attempt.proc.stderr,
          errors: attempt.parsed.errors,
          toolCalls: attempt.parsed.toolCalls,
          unknownLines: attempt.parsed.unknownLines,
          ...(attempt.reporterFailed ? { progressReporterFailed: true } : {}),
          capabilityManifest: CAPABILITY_MANIFEST,
          ...(priorAttempt
            ? {
                staleSessionAttempt: {
                  stdout: priorAttempt.proc.stdout,
                  stderr: priorAttempt.proc.stderr,
                },
              }
            : {}),
        },
      };
      return result;
    };

    const initial = await runAttempt(canResume ? savedSessionId : null);
    const initialFailed = !initial.proc.timedOut && (
      (initial.proc.exitCode ?? 0) !== 0 || initial.parsed.errors.length > 0
    );
    if (
      canResume &&
      initialFailed &&
      isOmpUnknownSessionError(initial.proc.stdout, initial.proc.stderr)
    ) {
      await onLog(
        "stdout",
        `[paperclip] OMP session "${savedSessionId}" is unavailable; retrying once with a fresh session.\n`,
      );
      const retry = await runAttempt(null);
      return toResult(retry, true, initial);
    }
    return toResult(initial, false);
  } finally {
    try {
      await Promise.all([
        paperclipBridge?.stop(),
        restoreWorkspace?.(),
      ]);
    } finally {
      await preparedConfig.cleanup();
    }
  }
}
