import type {
  AdapterRuntimeCommandSpec,
  AdapterSessionCodec,
  AdapterSessionManagement,
  ServerAdapterModule,
} from "@paperclipai/adapter-utils";
import {
  agentConfigurationDoc,
  models,
  OMP_INSTALL_COMMAND,
  type,
} from "../metadata.js";
import { detectModel, getConfigSchema, resolveOmpCommand } from "./config.js";
import { execute } from "./execute.js";
import { listOmpModels, readOperatorModelCatalog, refreshOmpModels } from "./models.js";
import { getOmpQuotaWindows } from "./quota.js";
import { listOmpSkills, syncOmpSkills } from "./skills.js";
import { testEnvironment } from "./test.js";
import { requireRemoteOmpExecution } from "./policy.js";

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const value = raw as Record<string, unknown>;
    const sessionId = nonEmptyString(value.sessionId) ?? nonEmptyString(value.session_id);
    if (!sessionId) return null;
    const cwd = nonEmptyString(value.cwd);
    const sessionDir = nonEmptyString(value.sessionDir) ?? nonEmptyString(value.session_dir);
    const remoteExecution =
      typeof value.remoteExecution === "object" && value.remoteExecution !== null && !Array.isArray(value.remoteExecution)
        ? value.remoteExecution as Record<string, unknown>
        : null;
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(sessionDir ? { sessionDir } : {}),
      ...(remoteExecution ? { remoteExecution } : {}),
    };
  },
  serialize(params) {
    return this.deserialize(params);
  },
  getDisplayId(params) {
    return params ? nonEmptyString(params.sessionId) ?? nonEmptyString(params.session_id) : null;
  },
};

export const sessionManagement: AdapterSessionManagement = {
  supportsSessionResume: true,
  nativeContextManagement: "confirmed",
  defaultSessionCompaction: {
    enabled: true,
    maxSessionRuns: 0,
    maxRawInputTokens: 0,
    maxSessionAgeHours: 0,
  },
};

function getRuntimeCommandSpec(config: Record<string, unknown>): AdapterRuntimeCommandSpec {
  const command = resolveOmpCommand(config);
  return {
    command,
    detectCommand: command,
    installCommand: OMP_INSTALL_COMMAND,
  };
}

export function createServerAdapter(): ServerAdapterModule {
  const advertisedModels = requireRemoteOmpExecution() ? readOperatorModelCatalog() ?? [] : [...models];
  const listModels = async () => {
    const discovered = await listOmpModels();
    advertisedModels.length = 0;
    advertisedModels.push(...discovered);
    return discovered;
  };
  const refreshModels = async () => {
    const discovered = await refreshOmpModels();
    advertisedModels.length = 0;
    advertisedModels.push(...discovered);
    return discovered;
  };

  // Local discovery is optional. Remote-only hosts must supply an explicit catalog
  // through listModels instead of launching OMP during adapter registration.
  if (!requireRemoteOmpExecution()) void listModels();

  return {
    type,
    execute,
    testEnvironment,
    sessionCodec,
    sessionManagement,
    listSkills: listOmpSkills,
    syncSkills: syncOmpSkills,
    models: advertisedModels,
    listModels,
    refreshModels,
    supportsLocalAgentJwt: true,
    runtimeToolDelivery: "environment",
    getQuotaWindows: getOmpQuotaWindows,
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    requiresMaterializedRuntimeSkills: false,
    getRuntimeCommandSpec,
    agentConfigurationDoc,
    detectModel,
    getConfigSchema,
  };
}
