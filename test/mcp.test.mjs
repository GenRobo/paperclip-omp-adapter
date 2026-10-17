import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareOmpRuntimeConfig } from "../dist/server/config.js";
import { assertRuntimeMcpConfig, bridgedRuntimeMcpEnv, createRuntimeMcpPlan, materializeRuntimeMcp, rejectRuntimeMcpSettingsConflicts } from "../dist/server/mcp.js";

const issueId = "11111111-1111-4111-8111-111111111111";
const command = "/opt/gr-workload-mcp-client/bin/gr-workload-mcp-client";
const operatorEnv = { PAPERCLIP_WORKLOAD_MCP_COMMAND: command };

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "operator");
  await fs.mkdir(source);
  return { root, source };
}

test("materialization preserves operator servers and source bytes without persisting run tokens", async (t) => {
  const { source } = await temporary(t);
  const original = JSON.stringify({ mcpServers: { approved: { command: "/opt/operator/server", args: ["--stdio"], env: { SOURCE: "operator" } } }, disabledServers: ["retired"], enabledServers: ["approved"] }, null, 2);
  const configFile = path.join(source, "mcp.json");
  await fs.writeFile(configFile, original);
  await fs.writeFile(path.join(source, "config.yml"), "skills:\n  enabled: true\n  customDirectories: [/opt/operator/skills]\n");
  const plan = createRuntimeMcpPlan(undefined, { getServers: () => [{ name: "native-http", url: "https://native.example/mcp", token: "test-runtime-token", connectionId: "test" }] }, issueId, { ...operatorEnv, PAPERCLIP_OMP_MCP_CONFIG: configFile });
  const prepared = await prepareOmpRuntimeConfig({ agentDir: source, env: { OMP_PROFILE: "", PI_PROFILE: "" } }, { runtimeMcp: plan });
  t.after(prepared.cleanup);
  assert.notEqual(prepared.agentDir, source);
  const contents = await fs.readFile(path.join(prepared.agentDir, "mcp.json"), "utf8");
  const merged = JSON.parse(contents);
  assert.deepEqual(merged.mcpServers.approved, JSON.parse(original).mcpServers.approved);
  assert.deepEqual(merged.disabledServers, ["retired"]);
  assert.equal(await fs.readFile(configFile, "utf8"), original);
  assert.ok(!contents.includes("test-runtime-token"));
  assert.equal(plan.env.PAPERCLIP_OMP_MCP_TOKEN_0, "Bearer test-runtime-token");
  assert.equal(merged.mcpServers["gr-workloads"].command, command);
  assert.match(await fs.readFile(path.join(prepared.agentDir, "config.yml"), "utf8"), /\/opt\/operator\/skills/);
  if (process.platform !== "win32") assert.equal((await fs.stat(path.join(prepared.agentDir, "mcp.json"))).mode & 0o077, 0);
  await prepared.cleanup();
  await assert.rejects(fs.stat(prepared.agentDir), { code: "ENOENT" });
  assert.equal(await fs.readFile(configFile, "utf8"), original);
});

test("agent directory cannot promote inherited executable MCP config without operator selection", async (t) => {
  const { source } = await temporary(t);
  const file = path.join(source, "mcp.json");
  const original = '{"mcpServers":{"gr-workloads":{"command":"/workspace/attack"}}}';
  await fs.writeFile(file, original);
  const plan = createRuntimeMcpPlan(undefined, undefined, issueId, operatorEnv);
  await assert.rejects(prepareOmpRuntimeConfig({ agentDir: source, env: { OMP_PROFILE: "", PI_PROFILE: "" } }, { runtimeMcp: plan }), /not trusted/);
  assert.equal(await fs.readFile(file, "utf8"), original);
});

test("operator reserved names, disable lists, and endpoint aliases fail without overwriting source", async (t) => {
  const { root, source } = await temporary(t);
  const file = path.join(source, "mcp.json");
  const native = { name: "Paperclip projects", connectionId: "paperclip-project-tools", url: "https://native.example/projects", token: "native-project-grant" };
  for (const config of [
    { mcpServers: { "gr-workloads": { command: "/opt/other" } } },
    { disabledServers: ["gr-workloads"] },
    { mcpServers: { alias: { command } } },
    { mcpServers: { alias: { type: "http", url: native.url } } },
  ]) {
    const original = JSON.stringify(config);
    await fs.writeFile(file, original);
    const plan = createRuntimeMcpPlan(undefined, { getServers: () => [native] }, issueId, { ...operatorEnv, PAPERCLIP_OMP_MCP_CONFIG: file });
    await assert.rejects(materializeRuntimeMcp(root, source, plan), /conflict|ambiguous/);
    assert.equal(await fs.readFile(file, "utf8"), original);
    await assert.rejects(fs.stat(path.join(root, "mcp.json")), { code: "ENOENT" });
  }
});

test("unselected alternate .mcp.json cannot hide behind the trusted operator file", async (t) => {
  const { root, source } = await temporary(t);
  const file = path.join(source, "mcp.json");
  await fs.writeFile(file, '{"mcpServers":{}}');
  await fs.writeFile(path.join(source, ".mcp.json"), '{"mcpServers":{"injected":{"command":"/workspace/injected"}}}');
  const plan = createRuntimeMcpPlan(undefined, undefined, issueId, { ...operatorEnv, PAPERCLIP_OMP_MCP_CONFIG: file });
  await assert.rejects(materializeRuntimeMcp(root, source, plan), /not trusted/);
});

test("native runtime authority cannot be replaced by agent configuration", () => {
  for (const name of ["PI_CONFIG_FILES", "PAPERCLIP_WORKLOAD_MCP_COMMAND", "PAPERCLIP_OMP_MCP_CONFIG", "PAPERCLIP_OMP_MCP_TOKEN_0", "PAPERCLIP_TASK_ID", "PAPERCLIP_RUN_ID", "PAPERCLIP_API_KEY", "PAPERCLIP_API_URL"]) {
    assert.throws(() => assertRuntimeMcpConfig({ env: { [name]: "attacker" } }), /agent-supplied/);
  }
  for (const value of ["--", "--profile=attacker", "--profile", "--config", "--config=attacker.yml"]) {
    assert.throws(() => assertRuntimeMcpConfig({ extraArgs: [value] }), /rejects extraArgs/);
  }
  assert.equal(createRuntimeMcpPlan(undefined, undefined, issueId, {}), null);
  assert.equal(createRuntimeMcpPlan(undefined, undefined, "", operatorEnv), null);
  assert.throws(() => createRuntimeMcpPlan(undefined, undefined, issueId, { PAPERCLIP_WORKLOAD_MCP_COMMAND: "npx arbitrary-package" }), /absolute executable/);
});

test("invalid runtime endpoints and conflicting connection identities reject before writing config", () => {
  for (const server of [
    { url: "file:///etc/passwd", token: "test", connectionId: "test" },
    { url: "https://user:password@example.test", token: "test", connectionId: "test" },
    { url: "https://example.test", token: "test\r\nHeader: value", connectionId: "test" },
    { url: "https://example.test", token: "test", connectionId: "gr-workloads" },
  ]) assert.throws(() => createRuntimeMcpPlan(undefined, { getServers: () => [{ ...server, name: "Display name" }] }, issueId, operatorEnv));
  const server = { name: "Display name", url: "https://example.test", token: "test", connectionId: "test" };
  assert.throws(() => createRuntimeMcpPlan(undefined, { getServers: () => [server, server] }, issueId, operatorEnv), /unique/);
});

test("native display names and dual tool delivery preserve one exact authority per connection", () => {
  const tools = { mcpEndpoint: "https://native.example/connections", bearerToken: "connections-token", guidance: "Use native tools" };
  const projects = { name: "Paperclip projects", url: "https://native.example/projects", token: "projects-token", connectionId: "paperclip-project-tools" };
  const connections = { name: "Paperclip connections", url: tools.mcpEndpoint, token: tools.bearerToken, connectionId: "paperclip-runtime-tools" };
  const plan = createRuntimeMcpPlan(tools, { getServers: () => [projects, connections] }, issueId, operatorEnv);
  assert.deepEqual(Object.keys(plan.servers).sort(), ["gr-workloads", "paperclip-project-tools", "paperclip-runtime-tools"]);
  assert.equal(plan.env.PAPERCLIP_OMP_MCP_URL_0, projects.url);
  assert.equal(plan.env.PAPERCLIP_OMP_MCP_URL_1, tools.mcpEndpoint);
  assert.deepEqual(plan.httpServers.map(server => [server.connectionId, server.token]), [
    ["paperclip-project-tools", "projects-token"],
    ["paperclip-runtime-tools", "connections-token"],
  ]);
  for (const changed of [{ token: "different-token" }, { url: "https://other.example/mcp" }]) {
    assert.throws(() => createRuntimeMcpPlan(tools, { getServers: () => [projects, { ...connections, ...changed }] }, issueId, operatorEnv), /disagree/);
  }
});

test("native assigned gateway identities remain distinct without exporting host grants to the runner", async (t) => {
  const { root } = await temporary(t);
  const servers = [
    { name: "Assigned tools", connectionId: "assignment:abc", url: "http://127.0.0.1:8443/mcp/gateways/one", token: "first-host-grant" },
    { name: "Assigned tools", connectionId: "assignment-abc", url: "http://127.0.0.1:8443/mcp/gateways/two", token: "second-host-grant" },
  ];
  const plan = createRuntimeMcpPlan(undefined, { getServers: () => servers }, issueId, operatorEnv);
  assert.notEqual(plan.httpServers[0].bridgeId, plan.httpServers[1].bridgeId);
  for (const server of plan.httpServers) assert.match(server.bridgeId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
  const env = bridgedRuntimeMcpEnv(plan, { PAPERCLIP_API_URL: "http://127.0.0.1:12345", PAPERCLIP_API_KEY: "sandbox-bridge-grant" });
  await materializeRuntimeMcp(root, null, plan);
  const runtimeState = JSON.stringify(env) + await fs.readFile(path.join(root, "mcp.json"), "utf8");
  for (const server of servers) {
    assert.ok(!runtimeState.includes(server.token));
    assert.ok(!runtimeState.includes(server.url));
  }
  assert.throws(() => bridgedRuntimeMcpEnv(plan, { PAPERCLIP_API_URL: "http://127.0.0.1:12345" }), /authenticated/);
});

test("settings cannot silently disable native runtime tools while unrelated operator settings survive", async (t) => {
  const { root } = await temporary(t);
  const file = path.join(root, "project.yml");
  const plan = createRuntimeMcpPlan(undefined, undefined, issueId, operatorEnv);
  for (const text of ["disabledProviders: [native]\n", "disabledExtensions: ['mcp:gr-workloads']\n"]) {
    await fs.writeFile(file, text);
    await assert.rejects(rejectRuntimeMcpSettingsConflicts([file], plan), /disable a required/);
    assert.equal(await fs.readFile(file, "utf8"), text);
  }
  const operator = "skills: { enabled: true }\ndisabledProviders: [cursor]\ndisabledExtensions: ['mcp:unrelated']\n";
  await fs.writeFile(file, operator);
  await rejectRuntimeMcpSettingsConflicts([file], plan);
  assert.equal(await fs.readFile(file, "utf8"), operator);
});
