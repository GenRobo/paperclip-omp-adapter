import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { parse as parseYaml } from "yaml";

export const MCP_OVERLAY_FILENAME = "paperclip-mcp-policy.yml";
const WORKLOAD_SERVER = "gr-workloads";
const RUNTIME_TOOLS_SERVER = "paperclip-runtime-tools";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type ServerConfig = Record<string, unknown>;

export interface RuntimeMcpPlan {
  servers: Record<string, ServerConfig>;
  httpServers: { connectionId: string; bridgeId: string; url: string; token: string; tokenVariable: string; urlVariable: string }[];
  env: Record<string, string>;
  guidance: string;
  workloadCommand: string | null;
  operatorConfig: string | null;
}

export function createRuntimeMcpPlan(
  tools: AdapterExecutionContext["runtimeTools"],
  runtime: AdapterExecutionContext["runtimeMcp"],
  issueId: string,
  operatorEnv: NodeJS.ProcessEnv = process.env,
): RuntimeMcpPlan | null {
  const command = operatorEnv.PAPERCLIP_WORKLOAD_MCP_COMMAND?.trim();
  const operatorConfig = operatorEnv.PAPERCLIP_OMP_MCP_CONFIG?.trim() || null;
  if (command && (!path.posix.isAbsolute(command) && !path.win32.isAbsolute(command) || /[\r\n\0$]/.test(command))) {
    throw new Error("PAPERCLIP_WORKLOAD_MCP_COMMAND must be a trusted absolute executable path, not a shell command or environment expression.");
  }
  if (operatorConfig && !path.isAbsolute(operatorConfig)) {
    throw new Error("PAPERCLIP_OMP_MCP_CONFIG must be an absolute host-owned MCP configuration path.");
  }
  const workloadCommand = command && issueId ? command : null;
  if (workloadCommand && !UUID.test(issueId)) throw new Error("Workload MCP requires a canonical native issue UUID.");
  const servers: Record<string, ServerConfig> = Object.create(null) as Record<string, ServerConfig>;
  const httpServers: RuntimeMcpPlan["httpServers"] = [];
  const env: Record<string, string> = {};
  const guidance: string[] = [];
  const addHttp = (connectionId: string, url: string, token: string) => {
    if (!connectionId || /[\r\n\0]/.test(connectionId)) throw new Error("Native runtime MCP requires a connection identity.");
    // Native assigned gateways use `assignment:<digest>`, not an MCP-safe name.
    // Keep identity lossless in host state; detect any resulting key collision.
    const name = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(connectionId)
      ? connectionId
      : `paperclip-${createHash("sha256").update(connectionId).digest("hex").slice(0, 24)}`;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) || Object.hasOwn(servers, name) || name === WORKLOAD_SERVER) {
      throw new Error("Native runtime MCP connection identities must be unique safe names and must not conflict with reserved workload names.");
    }
    let endpoint: URL;
    try { endpoint = new URL(url); }
    catch { throw new Error("Native runtime MCP supplied an invalid HTTP endpoint."); }
    if (!["https:", "http:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || !token || /[\r\n\0]/.test(token)) {
      throw new Error("Native runtime MCP requires an HTTP(S) endpoint without URL credentials and a valid bearer token.");
    }
    const tokenVariable = `PAPERCLIP_OMP_MCP_TOKEN_${httpServers.length}`;
    const urlVariable = `PAPERCLIP_OMP_MCP_URL_${httpServers.length}`;
    env[tokenVariable] = `Bearer ${token}`;
    env[urlVariable] = url;
    httpServers.push({ connectionId, bridgeId: name, url, token, tokenVariable, urlVariable });
    // Resolve at launch: remote servers use the run's authenticated local bridge.
    servers[name] = { type: "http", url: `\${${urlVariable}}`, headers: { Authorization: `\${${tokenVariable}}` }, timeout: 30_000 };
  };
  const nativeServers = runtime?.getServers() ?? [];
  if (tools) {
    // Paperclip's native_mcp delivery supplies this authority in BOTH interfaces.
    // Its human display name is not a configuration key; connectionId is stable.
    const delivered = nativeServers.find(server => server.connectionId === RUNTIME_TOOLS_SERVER);
    if (delivered && (delivered.url !== tools.mcpEndpoint || delivered.token !== tools.bearerToken)) {
      throw new Error("Native runtime tool interfaces disagree about their MCP authority.");
    }
    if (!delivered) addHttp(RUNTIME_TOOLS_SERVER, tools.mcpEndpoint, tools.bearerToken);
    guidance.push(tools.guidance);
  }
  for (const server of nativeServers) addHttp(server.connectionId, server.url, server.token);
  if (workloadCommand) {
    servers[WORKLOAD_SERVER] = { type: "stdio", command: workloadCommand, args: [], timeout: 30_000 };
    guidance.push("Use gr-workloads MCP tools for this issue's persistent applications. Keep caller request/operation UUIDs stable across reconnects and turns. Poll gr_operation_status for completion; its images are real tool image content. Never repeat an indeterminate edit with a new ID. Save work before explicitly releasing a lease.");
  }
  if (Object.keys(servers).length === 0 && !operatorConfig) return null;
  guidance.push("Paperclip runtime MCP tools are registered in this run's isolated OMP agent directory. Do not print native API or MCP bearer credentials.");
  return { servers, httpServers, env, guidance: guidance.join("\n\n"), workloadCommand, operatorConfig };
}

export function bridgedRuntimeMcpEnv(plan: RuntimeMcpPlan, bridgeEnv: Record<string, string>): Record<string, string> {
  const baseUrl = bridgeEnv.PAPERCLIP_API_URL;
  const bridgeToken = bridgeEnv.PAPERCLIP_API_KEY;
  if (!baseUrl || !bridgeToken) throw new Error("Remote native MCP requires an authenticated Paperclip bridge.");
  const env: Record<string, string> = {};
  for (const server of plan.httpServers) {
    env[server.urlVariable] = new URL(`/api/runtime-mcp/${server.bridgeId}`, baseUrl).href;
    env[server.tokenVariable] = `Bearer ${bridgeToken}`;
  }
  return env;
}

export function assertRuntimeMcpConfig(config: Record<string, unknown>): void {
  const env = config.env;
  if (env && typeof env === "object" && !Array.isArray(env)) {
    for (const key of Object.keys(env)) {
      if (key === "PI_CONFIG_FILES" || key === "PAPERCLIP_WORKLOAD_MCP_COMMAND" || key.startsWith("PAPERCLIP_OMP_MCP_") || key === "PAPERCLIP_API_KEY" || key === "PAPERCLIP_API_URL" || key === "PAPERCLIP_TASK_ID" || key === "PAPERCLIP_RUN_ID") {
        throw new Error(`Native runtime MCP does not accept agent-supplied ${key}; configure trusted runtime authority on the host.`);
      }
    }
  }
  const extraArgs = Array.isArray(config.extraArgs) ? config.extraArgs : typeof config.extraArgs === "string" ? config.extraArgs.split(/\r?\n/) : [];
  if (extraArgs.some(value => typeof value === "string" && /^(?:--|--profile(?:=.*)?|--config(?:=.*)?)$/.test(value.trim()))) {
    throw new Error("Native runtime MCP rejects extraArgs that replace the prepared profile/configuration or terminate option parsing; use the normal configFiles field for overlays.");
  }
}

export async function rejectRuntimeMcpSettingsConflicts(files: string[], plan: RuntimeMcpPlan): Promise<void> {
  const reserved = new Set(Object.keys(plan.servers).map(name => `mcp:${name}`));
  for (const filename of new Set(files)) {
    let text: string;
    try { text = await fs.readFile(filename, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error("Unable to read settings for native MCP isolation.");
    }
    let parsed: unknown;
    try { parsed = parseYaml(text); }
    catch { throw new Error("Settings must parse successfully before native MCP authority can be enabled."); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const settings = parsed as Record<string, unknown>;
    const disabledProviders = settings.disabledProviders;
    const disabledExtensions = settings.disabledExtensions;
    if ((Array.isArray(disabledProviders) && disabledProviders.includes("native")) ||
        (Array.isArray(disabledExtensions) && disabledExtensions.some(value => typeof value === "string" && reserved.has(value)))) {
      throw new Error("OMP settings disable a required native runtime MCP server/provider; resolve the conflict instead of silently removing trusted tools.");
    }
  }
}

async function readConfig(filename: string, required: boolean): Promise<Record<string, unknown> | null> {
  let text: string;
  try { text = await fs.readFile(filename, "utf8"); }
  catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Unable to read the operator MCP configuration.");
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error("Operator MCP configuration must be valid JSON."); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Operator MCP configuration must be an object.");
  const config = value as Record<string, unknown>;
  if (config.mcpServers !== undefined && (config.mcpServers === null || typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers))) {
    throw new Error("Operator MCP mcpServers must be an object.");
  }
  for (const field of ["disabledServers", "enabledServers"]) {
    if (config[field] !== undefined && (!Array.isArray(config[field]) || !(config[field] as unknown[]).every(value => typeof value === "string"))) {
      throw new Error("Operator MCP server enable/disable lists must contain names only.");
    }
  }
  return config;
}

export async function materializeRuntimeMcp(agentDir: string, sourceAgentDir: string | null, plan: RuntimeMcpPlan): Promise<void> {
  // Source agentDir may be agent-editable. Never silently promote its MCP commands
  // into trusted runtime config; require the operator to select that file explicitly.
  const trustedPath = plan.operatorConfig ? await fs.realpath(plan.operatorConfig) : null;
  await rejectRuntimeMcpSettingsConflicts(
    ["config.yml", "config.yaml"].map(filename => path.join(agentDir, filename)),
    plan,
  );
  if (sourceAgentDir) {
    for (const filename of ["mcp.json", ".mcp.json"]) {
      const source = path.join(sourceAgentDir, filename);
      const inherited = await readConfig(source, false);
      if (!inherited) continue;
      if (!trustedPath || await fs.realpath(source) !== trustedPath) {
        throw new Error("Inherited agent-directory MCP configuration is not trusted. Select the intentional operator file with host PAPERCLIP_OMP_MCP_CONFIG instead.");
      }
    }
  }
  const operator = trustedPath ? await readConfig(trustedPath, true) : null;
  const merged = Object.assign(Object.create(null) as Record<string, ServerConfig>, operator?.mcpServers ?? {});
  const disabled = operator?.disabledServers as string[] | undefined;
  for (const [name, server] of Object.entries(plan.servers)) {
    if (Object.hasOwn(merged, name) || disabled?.includes(name)) {
      throw new Error(`Operator MCP configuration conflicts with native runtime server ${name}; resolve the conflict rather than overriding it.`);
    }
    const nativeUrl = plan.httpServers.find(candidate => candidate.bridgeId === name)?.url;
    for (const existing of Object.values(merged)) {
      if (existing && typeof existing === "object" && ((nativeUrl && existing.url === nativeUrl) || (server.url && existing.url === server.url) || (server.command && existing.command === server.command))) {
        throw new Error("Operator MCP configuration aliases a native runtime endpoint or executable; remove the ambiguous duplicate.");
      }
    }
    merged[name] = server;
  }
  await fs.writeFile(path.join(agentDir, "mcp.json"), JSON.stringify({ ...operator, mcpServers: merged }, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
  // Last CLI overlay beats both project and configured overlays. Filtering occurs
  // before MCP deduplication in pinned OMP, so even disabled project entries cannot shadow us.
  // No provider-wide toggles: operator skills/rules/extensions remain untouched.
  await fs.writeFile(path.join(agentDir, MCP_OVERLAY_FILENAME), "mcp:\n  enableProjectConfig: false\n  startupTimeoutMs: 0\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
}
