import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createServerAdapter } from "../dist/index.js";
import { prepareOmpRuntimeConfig } from "../dist/server/config.js";
import {
  applyPreparedOmpAgentEnvironment,
  rewriteRemoteConfigPaths,
} from "../dist/server/execute.js";
import { classifyOmpFailure } from "../dist/server/failure.js";
import { parseOmpJsonl } from "../dist/server/parse.js";
import { createOmpProgressReporter } from "../dist/server/progress.js";
import { boundOmpResultJson, OMP_RESULT_JSON_MAX_BYTES } from "../dist/server/result.js";
import { getOmpQuotaWindows } from "../dist/server/quota.js";
import { resolveOmpProfile } from "../dist/server/profile.js";
import { discoverOmpModels } from "../dist/server/models.js";

const adapter = createServerAdapter();
assert.equal(adapter.type, "omp_local");
assert.equal(adapter.sessionManagement?.supportsSessionResume, true);
assert.equal(adapter.supportsInstructionsBundle, true);
assert(adapter.listModels && adapter.refreshModels && adapter.detectModel);
assert(adapter.listSkills && adapter.syncSkills && adapter.getConfigSchema);

const uiParserSource = await fs.readFile(new URL("../dist/ui-parser.js", import.meta.url), "utf8");
const uiParserExports = {};
const uiParserModule = { exports: uiParserExports };
new Function("exports", "module", "self", "globalThis", uiParserSource)(
  uiParserExports,
  uiParserModule,
  undefined,
  undefined,
);
const parseStdoutLine = uiParserModule.exports.parseStdoutLine;
const transcriptTs = "2026-07-20T23:52:22Z";
assert.deepEqual(
  parseStdoutLine(JSON.stringify({
    type: "thinking_level_changed",
    thinkingLevel: "high",
    configured: "auto",
    resolved: "high",
  }), transcriptTs),
  [{ kind: "system", ts: transcriptTs, text: "OMP thinking level: high" }],
);
for (const event of [
  { type: "turn_start" },
  {
    type: "message_update",
    assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: " concise" },
  },
  {
    type: "tool_execution_update",
    toolCallId: "call-1",
    toolName: "read",
    partialResult: { content: [] },
  },
]) {
  assert.deepEqual(parseStdoutLine(JSON.stringify(event), transcriptTs), []);
}
assert.deepEqual(
  parseStdoutLine(JSON.stringify({ type: "future_omp_event" }), transcriptTs),
  [{ kind: "stdout", ts: transcriptTs, text: '{"type":"future_omp_event"}' }],
);

const schema = await adapter.getConfigSchema();
const schemaKeys = new Set(schema.fields.map((field) => field.key));
for (const key of ["model", "profile", "agentDir", "modelsYaml", "tools", "extensions", "pluginDirs", "configFiles"]) {
  assert(schemaKeys.has(key), `missing config field: ${key}`);
}

assert.deepEqual(
  resolveOmpProfile({ env: { OMP_PROFILE: "", PI_PROFILE: "work" } }, {}),
  { profile: null, specified: true },
);
assert.deepEqual(resolveOmpProfile({ profile: "default" }, {}), { profile: null, specified: true });
assert.throws(() => resolveOmpProfile({ profile: "CON" }, {}), /Invalid OMP profile/);
assert.throws(() => resolveOmpProfile({ profile: "trailing." }, {}), /Invalid OMP profile/);

const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-omp-test-"));
const profileAgentDir = path.join(root, "profiles", "work", "agent");
await fs.mkdir(profileAgentDir, { recursive: true });
await fs.writeFile(
  path.join(profileAgentDir, "models.yml"),
  `providers:\n  safe-provider:\n    baseUrl: http://127.0.0.1:9/v1\n    api: openai-completions\n    apiKey: SAFE_PROVIDER_KEY\n    models:\n      - id: safe-model\n        contextWindow: 4096\n        maxTokens: 1024\n`,
);
await fs.writeFile(
  path.join(profileAgentDir, "config.yml"),
  `extensions:\n  - ~/.omp/extensions/private.ts\ndisabledExtensions: []\n`,
);

const prepared = await prepareOmpRuntimeConfig(
  {
    env: {
      PI_CONFIG_DIR: root,
      OMP_PROFILE: "work",
      SAFE_PROVIDER_KEY: "must-not-be-serialized",
    },
  },
  { forceMaterialized: true },
);
try {
  assert.equal(prepared.profile, "work");
  assert.equal(prepared.materialized, true);
  assert(prepared.agentDir);
  const yaml = await fs.readFile(path.join(prepared.agentDir, "models.yml"), "utf8");
  assert.match(yaml, /safe-provider:/);
  assert.match(yaml, /apiKey: SAFE_PROVIDER_KEY/);
  assert.doesNotMatch(yaml, /must-not-be-serialized/);
  const configYaml = await fs.readFile(path.join(prepared.agentDir, "config.yml"), "utf8");
  assert.doesNotMatch(configYaml, /^extensions:/m);
  assert(prepared.notes.some((note) => note.includes("Skipped config extensions")));

  const remoteEnv = {
    PI_CODING_AGENT_DIR: "/local/agent",
    OMP_PROFILE: "work",
    PI_PROFILE: "work",
  };
  applyPreparedOmpAgentEnvironment(remoteEnv, prepared, "/remote/assets/agent");
  assert.equal(remoteEnv.PI_CODING_AGENT_DIR, "/remote/assets/agent");
  assert.equal(remoteEnv.OMP_PROFILE, "");
  assert.equal(remoteEnv.PI_PROFILE, "");
} finally {
  await prepared.cleanup();
}
const explicitDefault = await prepareOmpRuntimeConfig({ env: { OMP_PROFILE: "", PI_PROFILE: "work" } });
assert.equal(explicitDefault.profile, null);
assert.equal(explicitDefault.profileSpecified, true);

await assert.rejects(
  () => prepareOmpRuntimeConfig({
    modelsYaml: `providers:\n  unsafe:\n    api: openai-completions\n    apiKey: literal-secret\n    models:\n      - id: unsafe\n        contextWindow: 4096\n        maxTokens: 1024\n`,
  }),
  /credential-bearing fields/,
);
await assert.rejects(
  () => prepareOmpRuntimeConfig({
    modelsYaml: `providers: { unsafe: { api: openai-completions, apiKey: literal-secret, models: [{ id: unsafe, contextWindow: 4096, maxTokens: 1024 }] } }`,
  }),
  /credential-bearing fields/,
);

for (const baseUrl of [
  "https://api.example/v1?api_key=literal",
  "https://TOKEN@api.example/v1",
]) {
  await assert.rejects(
    () => prepareOmpRuntimeConfig({
      modelsYaml: `providers:\n  unsafe:\n    baseUrl: ${baseUrl}\n    api: openai-completions\n    models:\n      - id: unsafe\n        contextWindow: 4096\n        maxTokens: 1024\n`,
    }),
    /credential-bearing fields/,
  );
}

// The wire cause, not a tool error or assistant text, determines deadline failure.
const deadlineTermination = { reason: "deadline", deadlineAt: 1792900800000 };
const priorSuccess = {
  role: "assistant", timestamp: 1, stopReason: "stop",
  content: [{ type: "text", text: "Earlier work completed successfully." }],
  usage: { input: 7, output: 3, cacheRead: 1, cost: { total: 0.002 } },
};
const interruptedToolTurn = {
  role: "assistant", timestamp: 2, stopReason: "toolUse",
  content: [{ type: "toolCall", id: "deadline-tool", name: "bash", arguments: { command: "build" } }],
  usage: { input: 10, output: 4, cacheRead: 2, cost: { total: 0.003 } },
};
const laterSuccess = {
  role: "assistant", timestamp: 3, stopReason: "stop",
  content: [{ type: "text", text: "Later work really succeeded." }],
};
const failedAssistant = {
  role: "assistant", timestamp: 4, stopReason: "error",
  errorMessage: "Provider temporarily unavailable.", content: [],
};
const toolTimeoutResult = {
  content: [{ type: "text", text: "Deadline exceeded; artifact saved at /workspace/partial.glb" }],
  details: { artifactPath: "/workspace/partial.glb" },
};
const deadlineToolEvents = [
  { type: "turn_end", message: priorSuccess },
  { type: "message_end", message: interruptedToolTurn },
  { type: "tool_execution_start", toolCallId: "deadline-tool", toolName: "bash", args: { command: "build" } },
  { type: "tool_execution_end", toolCallId: "deadline-tool", toolName: "bash", isError: true, result: toolTimeoutResult },
  { type: "turn_end", message: interruptedToolTurn },
];
const deadlineEnd = {
  type: "agent_end", isTerminal: true, yielded: true,
  termination: deadlineTermination, messages: [priorSuccess, interruptedToolTurn],
};
const successEnd = { type: "agent_end", isTerminal: true, messages: [laterSuccess] };
const deadlineCases = {
  DEADLINE_DURING_TOOL: { deadline: true, events: [...deadlineToolEvents, deadlineEnd] },
  DEADLINE_NONZERO: { deadline: true, exitCode: 3, events: [...deadlineToolEvents, deadlineEnd] },
  DEADLINE_STALE_STOP: { deadline: true, events: [
    ...deadlineToolEvents, { ...deadlineEnd, messages: [priorSuccess] },
  ] },
  DEADLINE_NO_ASSISTANT: { deadline: true, events: [
    ...deadlineToolEvents, { ...deadlineEnd, messages: [] },
  ] },
  DEADLINE_THEN_REAL_SUCCESS: { events: [
    ...deadlineToolEvents, deadlineEnd, { type: "message_end", message: laterSuccess }, successEnd,
  ] },
  TOOL_LOCAL_TIMEOUT_SUCCESS: { events: [
    ...deadlineToolEvents, { type: "message_end", message: laterSuccess }, successEnd,
  ] },
  ORDINARY_YIELD: { events: [
    ...deadlineToolEvents, { type: "agent_end", isTerminal: true, yielded: true, messages: [interruptedToolTurn] },
  ] },
  TIMEOUT_TEXT_SUCCESS: { events: [
    ...deadlineToolEvents, { ...successEnd, messages: [{
      ...laterSuccess, content: [{ type: "text", text: "Deadline exceeded is only quoted tool output, not the run outcome." }],
    }] },
  ] },
  MODEL_RETRY_SUCCESS: { events: [
    ...deadlineToolEvents, { type: "message_end", message: failedAssistant },
    { type: "auto_retry_end", success: false, finalError: "Provider temporarily unavailable." },
    { type: "message_end", message: laterSuccess }, successEnd,
  ] },
};
for (const [name, scenario] of Object.entries(deadlineCases)) {
  const parsed = parseOmpJsonl(scenario.events.map((event) => JSON.stringify(event)).join("\n"));
  assert.deepEqual(parsed.termination, scenario.deadline ? deadlineTermination : null, name);
  assert.equal(parsed.errors.length, scenario.deadline ? 1 : 0, name);
  if (scenario.deadline) assert.equal(parsed.finalMessage, null, name);
  assert.deepEqual(parsed.usage, { inputTokens: 17, outputTokens: 7, cachedInputTokens: 3 }, name);
  assert.equal(parsed.costUsd, 0.005, name);
  assert.deepEqual(parsed.toolCalls[0].result, toolTimeoutResult, name);
  assert.equal(parsed.toolCalls[0].isError, true, name);
  assert.ok(parsed.messages.includes("Earlier work completed successfully."), "partial text evidence remains available");
  const terminalEntries = parseStdoutLine(JSON.stringify(scenario.events.at(-1)), transcriptTs);
  assert.equal(terminalEntries[0].isError, scenario.deadline === true, name);
  if (scenario.deadline) {
    assert.equal(terminalEntries[0].subtype, "deadline", name);
    assert.equal(terminalEntries[0].text, "OMP agent deadline exceeded.", name);
    assert.deepEqual(terminalEntries[0].errors, ["OMP agent deadline exceeded."], name);
  }
}
const parseEvents = (events) => parseOmpJsonl(events.map((event) => JSON.stringify(event)).join("\n"));
for (const event of [
  { type: "message_end", message: laterSuccess },
  { type: "turn_end", message: laterSuccess },
  { type: "auto_retry_end", success: true },
  { ...successEnd, isTerminal: false },
  { ...successEnd, willContinue: true },
]) {
  const parsed = parseEvents([...deadlineToolEvents, deadlineEnd, event]);
  assert.deepEqual(parsed.termination, deadlineTermination, "only a later applicable terminal event may replace the cause");
  assert.equal(parsed.finalMessage, null);
  assert.deepEqual(parsed.errors, ["OMP agent deadline exceeded."]);
}
for (const event of [
  { ...deadlineEnd, isTerminal: false },
  { ...deadlineEnd, willContinue: true },
]) {
  assert.equal(parseEvents([event]).termination, null);
  assert.deepEqual(parseStdoutLine(JSON.stringify(event), transcriptTs), []);
}
for (const termination of [
  undefined, null, { reason: "cancelled", deadlineAt: deadlineTermination.deadlineAt },
  { reason: "deadline" }, { reason: "deadline", deadlineAt: "1792900800000" },
  { reason: "deadline", deadlineAt: null },
]) {
  const event = { ...successEnd, termination };
  assert.equal(parseEvents([event]).termination, null);
  assert.equal(parseStdoutLine(JSON.stringify(event), transcriptTs)[0].isError, false);
}
const cancelledParse = parseEvents([
  { type: "turn_end", message: priorSuccess },
  { type: "agent_end", isTerminal: true, messages: [{ ...failedAssistant, stopReason: "aborted", errorMessage: "User cancelled." }] },
]);
assert.equal(cancelledParse.termination, null);
assert.deepEqual(cancelledParse.errors, ["User cancelled."]);
assert.equal(cancelledParse.finalMessage, null, "an aborted assistant must not reuse a prior success summary");

// Real MCP-shaped image/resource + structured and text receipt output. The
// binary and large body are deliberately before the operation control evidence.
function largeImageEvents() {
  const result = {
    content: [
      { type: "image", mimeType: "image/png", data: "iVBORw0KGgo" + "A".repeat(2 * 1024 * 1024) },
      { type: "resource", resource: { uri: "artifact://partial-render", mimeType: "image/png", blob: "B".repeat(8192) } },
      { type: "text", text: JSON.stringify({ operationId: "operation-text-receipt", status: "indeterminate", warning: "Do not replay this mutation." }) },
      { type: "text", text: "界😀\\\"\n".repeat(8192) },
    ],
    structuredContent: {
      operation_id: "operation-structured-receipt",
      requestId: "request-receipt",
      status: "failed",
      partialMutation: true,
      warning: "Partial mutation; recover through the operation ledger, not replay.",
      artifactPath: "/workspace/partial.glb",
    },
    isError: true,
  };
  const message = {
    role: "assistant", timestamp: 22, stopReason: "toolUse",
    provider: "fake-provider", model: "fake-model",
    content: [{ type: "text", text: "Rendering remains incomplete." }],
    usage: { input: 17, output: 7, cacheRead: 3, cost: { total: 0.005 } },
  };
  return [
    { type: "tool_execution_start", toolCallId: "image-call", toolName: "gr_call_application", args: { requestId: "request-argument", operationId: "operation-argument", code: "render()" } },
    { type: "tool_execution_end", toolCallId: "image-call", toolName: "gr_call_application", result, isError: true },
    { type: "turn_end", message },
    { type: "agent_end", isTerminal: true, termination: { reason: "deadline", deadlineAt: 1792900800000 }, messages: [message] },
  ];
}
function largeImageWire() {
  // Native local process capture decodes each Buffer independently. ASCII JSON
  // escapes avoid testing that upstream split-codepoint behavior here, while
  // JSON.parse still gives the adapter the original multibyte payload.
  return largeImageEvents().map((event) => {
    const json = JSON.stringify(event).replace(/[^\x00-\x7f]/g, (character) =>
      "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"));
    return json + "\n";
  }).join("");
}
const smallMetadata = {
  stdout: "ordinary stdout\n", stderr: "", errors: [], unknownLines: [],
  toolCalls: [{ toolCallId: "small-call", toolName: "read", args: { path: "a.txt" }, result: { content: [{ type: "text", text: "ok" }] }, isError: false }],
  capabilityManifest: { bindings: ["omp-jsonl"], limits: ["one-process-per-heartbeat"] },
};
assert.deepEqual(
  boundOmpResultJson({ runId: "small-run", ...smallMetadata }),
  smallMetadata,
  "small ordinary metadata retains its semantic DTO without truncation fields",
);
const stressMetadata = boundOmpResultJson({
  ...smallMetadata,
  runId: "00000000-0000-4000-8000-000000000998",
  stdout: "界😀\\\"\u0000".repeat(20000),
  stderr: "terminal error: ".repeat(20000),
  errors: ["terminal error: ".repeat(20000)],
  unknownLines: Array.from({ length: 200 }, () => "界😀".repeat(500)),
  staleSessionAttempt: { stdout: "old stdout".repeat(20000), stderr: "old stderr".repeat(20000) },
  executionCancellation: { state: "acknowledged" },
  ompTermination: deadlineTermination,
  toolCalls: Array.from({ length: 200 }, (_, index) => ({
    toolCallId: `stress-${index}`, toolName: "gr_call_application", isError: true,
    args: { operationId: `operation-${index}`, payload: "界😀".repeat(2000) },
    result: { error: "partial mutation", content: [{ type: "text", text: "界😀\\\"\u0000".repeat(2000) }] },
  })),
});
assert.equal(OMP_RESULT_JSON_MAX_BYTES, 48 * 1024);
assert.ok(Buffer.byteLength(JSON.stringify(stressMetadata), "utf8") <= OMP_RESULT_JSON_MAX_BYTES);
assert.equal(stressMetadata.truncated, true);
assert.deepEqual(stressMetadata.ompTermination, deadlineTermination);
assert.deepEqual(stressMetadata.executionCancellation, { state: "acknowledged" });
assert.ok(stressMetadata.toolCallsOmitted > 0);
assert.equal(stressMetadata.toolCallsTotal, 200);
assert.equal(stressMetadata.toolCalls.length + stressMetadata.toolCallsOmitted, 200);
assert.equal(stressMetadata.toolCalls.at(-1).toolCallId, "stress-199", "recent operation identifiers take precedence");
assert.equal(stressMetadata.toolCalls.at(-1).isError, true);
assert.match(stressMetadata.errors[0], /terminal error:.*truncated/s);
assert.ok(stressMetadata.truncatedFields.includes("staleSessionAttempt"));
assert.ok(!JSON.stringify(stressMetadata).includes("\\ud83d"), "UTF-8 truncation does not split surrogate pairs");
const opaqueReceipt = JSON.stringify({ body: "x".repeat(70000), operationId: "recover-only-from-native-log" });
const opaqueCall = {
  toolCallId: "opaque-call", toolName: "gr_operation_status", args: { requestId: "known-request" },
  result: { content: [{ type: "text", text: opaqueReceipt }] }, isError: true,
};
const opaqueMetadata = boundOmpResultJson({ runId: "opaque-run", ...smallMetadata, toolCalls: [opaqueCall] });
assert.equal(opaqueMetadata.toolCalls[0].identifiersComplete, false);
assert.ok(opaqueMetadata.toolCalls[0].identifiers.some((entry) => entry.value === "known-request"));
assert.equal(opaqueMetadata.toolCalls[0].truncated, true);
assert.equal(opaqueCall.result.content[0].text, opaqueReceipt, "presentation projection does not mutate original evidence");

const fakeOmp = path.join(root, "fake-omp.mjs");
await fs.writeFile(fakeOmp, `#!/usr/bin/env node
import nodeFs from "node:fs";
const args = process.argv.slice(2);
if (process.env.FAKE_OMP_ARGV_LOG) {
  nodeFs.appendFileSync(process.env.FAKE_OMP_ARGV_LOG, args.join(" ") + "\\n");
}
if (args[0] === "models") {
  console.log(JSON.stringify({ models: [{ provider: "fake-provider", id: "fake-model", selector: "fake-provider/fake-model", name: "Fake model" }] }));
  process.exit(0);
}
if (args[0] === "usage") {
  console.log(JSON.stringify({ generatedAt: 1, reports: [{ provider: "fake-provider", fetchedAt: 1, limits: [{ id: "5h", label: "Five hour", scope: {}, window: { id: "5h", label: "5 Hour", resetsAt: 1789800000000 }, amount: { used: 25, limit: 100, unit: "percent" }, status: "ok", notes: ["sample"] }] }], accountsWithoutUsage: [], disabledCredentials: [] }));
  process.exit(0);
}
const resumeIndex = args.indexOf("--resume");
const noSession = args.includes("--no-session");
const sessionId = resumeIndex >= 0 ? args[resumeIndex + 1] : "fake-session-1";
const prompt = args.at(-1) ?? "";
if (prompt.includes("BOOTSTRAP_FAIL")) {
  process.stderr.write("omp: provider overloaded, please try again in 30 seconds\\n");
  process.exit(1);
}
if (!noSession) console.log(JSON.stringify({ type: "session", id: sessionId }));
const deadlineCases = ${JSON.stringify(deadlineCases)};
const deadlineScenario = deadlineCases[prompt];
if (deadlineScenario) {
  for (const event of deadlineScenario.events) console.log(JSON.stringify(event));
  if (deadlineScenario.deadline) process.stderr.write("upstream service unavailable; Session 'old' not found.\\n");
  await new Promise((resolve) => { process.stdout.write("", resolve); });
  process.exit(deadlineScenario.exitCode ?? 0);
}
if (prompt === "LARGE_IMAGE_DEADLINE") {
  const largeImageEvents = (${largeImageEvents.toString()});
  process.stdout.write((${largeImageWire.toString()})());
  await new Promise((resolve) => { process.stdout.write("", resolve); });
  process.exit(0);
}
if (prompt.includes("ABRUPT_THINKING")) {
  console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "last thought before the process stops" } }));
  process.exit(0);
}
if (prompt.includes("HUGE_LOG")) {
  const earlyMessage = {
    id: "huge-early",
    role: "assistant",
    provider: "fake-provider",
    model: "fake-model",
    content: [{ type: "text", text: "early turn before the truncation window" }],
    stopReason: "stop",
    usage: { input: 7, output: 3, cacheRead: 1, cost: { total: 0.002 } },
  };
  console.log(JSON.stringify({ type: "turn_end", message: earlyMessage }));
  console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "huge-call-1", toolName: "bash", args: { command: "true" } }));
  console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "huge-call-1", toolName: "bash", result: { content: [] }, isError: false }));
  const filler = "f".repeat(4000);
  for (let index = 0; index < 1400; index += 1) {
    console.log(JSON.stringify({ type: "notice", text: filler + index }));
  }
  if (prompt.includes("HUGE_LOG_ABORT")) {
    console.log(JSON.stringify({ type: "notice", text: "ABORT_MARKER" }));
    setInterval(() => {}, 1000);
  } else {
    const lateMessage = {
      id: "huge-late",
      role: "assistant",
      provider: "fake-provider",
      model: "fake-model",
      content: [{ type: "text", text: "HUGE_LOG_DONE" }],
      stopReason: "stop",
      usage: { input: 100, output: 20, cacheRead: 5, cost: { total: 0.01 } },
    };
    console.log(JSON.stringify({ type: "message_end", message: lateMessage }));
    console.log(JSON.stringify({ type: "turn_end", message: lateMessage }));
    await new Promise((resolve) => { process.stdout.write("", resolve); });
    process.exit(0);
  }
}
for (let thought = 0; thought < 12; thought += 1) {
  console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "step " + thought + " weighing the adapter contract against the durable run events panel; " } }));
}
console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "fake-call-1", toolName: "bash", args: { command: "true" } }));
console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "fake-call-1", toolName: "bash", result: { content: [{ type: "text", text: "ok" }] }, isError: false }));
console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "fake-call-2", toolName: "fabric_exec", args: { code: "return 1;" }, intent: "Inspecting adapter and Paperclip install" }));
console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "fake-call-2", toolName: "fabric_exec", result: { content: [{ type: "text", text: "ok" }] }, isError: false }));
const message = {
  id: "fake-message-1",
  role: "assistant",
  provider: "fake-provider",
  model: "fake-model",
  content: [{
    type: "text",
    text: prompt +
      "|OMP_PROFILE=" + (process.env.OMP_PROFILE ?? "") +
      "|PI_PROFILE=" + (process.env.PI_PROFILE ?? "") +
      "|AGENT_DIR=" + (process.env.PI_CODING_AGENT_DIR ?? "") +
      "|PAPERCLIP_API_KEY=" + (process.env.PAPERCLIP_API_KEY ? "set" : ""),
  }],
  stopReason: "stop",
  usage: { input: 100, output: 20, cacheRead: 5, cost: { total: 0.01 } },
};
console.log(JSON.stringify({ type: "message_end", message }));
console.log(JSON.stringify({ type: "turn_end", message }));
`);
await fs.chmod(fakeOmp, 0o755);
const previousOmpCommand = process.env.PAPERCLIP_OMP_COMMAND;
process.env.PAPERCLIP_OMP_COMMAND = fakeOmp;
const advertisedAdapter = createServerAdapter();
assert.equal((await advertisedAdapter.listModels()).length, 1);
assert.equal(advertisedAdapter.models.length, 1, "dynamic model discovery must update the static model summary");
if (previousOmpCommand === undefined) delete process.env.PAPERCLIP_OMP_COMMAND;
else process.env.PAPERCLIP_OMP_COMMAND = previousOmpCommand;

const executionCwd = path.join(root, "workspace");
await fs.mkdir(executionCwd);
assert.equal(
  rewriteRemoteConfigPaths({ extensions: ["extensions/provider.ts"] }, executionCwd, "/remote/workspace").extensions[0],
  "/remote/workspace/extensions/provider.ts",
);
assert.throws(
  () => rewriteRemoteConfigPaths({ extensions: ["../outside.ts"] }, executionCwd, "/remote/workspace"),
  /must be inside the synchronized workspace/,
);
assert.throws(
  () => rewriteRemoteConfigPaths({ extensions: ["~/.omp/provider.ts"] }, executionCwd, "/remote/workspace"),
  /must be inside the synchronized workspace/,
);
assert.deepEqual(
  rewriteRemoteConfigPaths({ addDirs: [".", "assets", path.join(executionCwd, "tests")] }, executionCwd, "/remote/workspace").addDirs,
  ["/remote/workspace", "/remote/workspace/assets", "/remote/workspace/tests"],
);
assert.throws(
  () => rewriteRemoteConfigPaths({ addDirs: ["../workspace-other"] }, executionCwd, "/remote/workspace"),
  /must be inside the synchronized workspace/,
);
const agent = {
  id: "00000000-0000-4000-8000-000000000001",
  companyId: "00000000-0000-4000-8000-000000000002",
  name: "OMP adapter test",
  adapterType: "omp_local",
  adapterConfig: {},
};
const emptyRuntime = {
  sessionId: null,
  sessionParams: null,
  sessionDisplayId: null,
  taskKey: null,
};
const baseConfig = {
  command: fakeOmp,
  cwd: executionCwd,
  promptTemplate: "{{context.expected}}",
  timeoutSec: 10,
  graceSec: 1,
  noExtensions: true,
  noSkills: true,
  noRules: true,
  noLsp: true,
  noPty: true,
  noTitle: true,
  advisor: false,
  extraArgs: ["--no-tools"],
};
const metas = [];
const run = (runId, runtime, expected, config = baseConfig) => adapter.execute({
  runId,
  agent,
  runtime,
  config,
  context: { expected },
  onLog: async () => {},
  onMeta: async (meta) => metas.push(meta),
});

// Operator policy is checked before any OMP probe, workspace creation, or spawn.
const policyEnvKeys = ["PAPERCLIP_OMP_REQUIRE_REMOTE", "PAPERCLIP_ADAPTER_MODELS", "PAPERCLIP_OMP_COMMAND", "FAKE_OMP_ARGV_LOG"];
const savedPolicyEnv = Object.fromEntries(policyEnvKeys.map((key) => [key, process.env[key]]));
const policyArgvLog = path.join(root, "policy-argv.log");
const deniedCwd = path.join(root, "must-not-be-created");
let policySpawns = 0;
const policyContext = {
  runId: "00000000-0000-4000-8000-000000000020",
  agent,
  runtime: emptyRuntime,
  config: {
    ...baseConfig,
    cwd: deniedCwd,
    requireRemote: false,
    executionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "/runner/workspace" },
    env: { PAPERCLIP_OMP_REQUIRE_REMOTE: "false", FAKE_OMP_ARGV_LOG: policyArgvLog },
  },
  context: {},
  onLog: async () => {},
  onSpawn: async () => { policySpawns += 1; },
};
try {
  process.env.PAPERCLIP_OMP_REQUIRE_REMOTE = "true";
  process.env.PAPERCLIP_OMP_COMMAND = fakeOmp;
  process.env.FAKE_OMP_ARGV_LOG = policyArgvLog;
  delete process.env.PAPERCLIP_ADAPTER_MODELS;
  const remoteOnlyAdapter = createServerAdapter();
  assert.equal(remoteOnlyAdapter.type, "omp_local");

  for (const executionTarget of [
    undefined,
    null,
    { kind: "local" },
    { kind: "remote", transport: "ssh", remoteCwd: "/runner/workspace", spec: {} },
    { kind: "remote", transport: "sandbox", remoteCwd: "/runner/workspace" },
    { kind: "remote", transport: "sandbox", remoteCwd: "/runner/workspace", runner: {} },
    { kind: "remote", transport: "other", remoteCwd: "/runner/workspace" },
  ]) {
    const denied = await remoteOnlyAdapter.execute({ ...policyContext, executionTarget });
    assert.equal(denied.exitCode, 1);
    assert.equal(denied.errorCode, "omp_remote_target_required");
    assert.equal(denied.errorFamily, "configuration");
    const environment = await remoteOnlyAdapter.testEnvironment({
      companyId: agent.companyId,
      adapterType: "omp_local",
      config: policyContext.config,
      executionTarget,
    });
    assert.equal(environment.status, "fail");
    assert.deepEqual(environment.checks.map((check) => check.code), ["omp_remote_target_required"]);
  }
  assert.equal(policySpawns, 0);
  await assert.rejects(fs.access(deniedCwd), { code: "ENOENT" });

  await assert.rejects(remoteOnlyAdapter.listModels(), { code: "omp_explicit_model_required" });
  await assert.rejects(remoteOnlyAdapter.refreshModels(), { code: "omp_explicit_model_required" });
  await assert.rejects(
    discoverOmpModels({ command: fakeOmp, env: { PAPERCLIP_OMP_REQUIRE_REMOTE: "false" } }),
    { code: "omp_explicit_model_required" },
  );
  assert.equal(await remoteOnlyAdapter.detectModel(), null);
  const explicitSchema = await remoteOnlyAdapter.getConfigSchema();
  const explicitModel = explicitSchema.fields.find((field) => field.key === "model");
  assert.equal(explicitModel.type, "combobox");
  assert.deepEqual(explicitModel.options, []);
  assert.equal(explicitModel.default, undefined);
  const quota = await remoteOnlyAdapter.getQuotaWindows();
  assert.equal(quota.ok, false);
  assert.deepEqual(quota.windows, []);

  process.env.PAPERCLIP_ADAPTER_MODELS = JSON.stringify({
    omp_local: [{ id: "operator/model", label: "Operator model" }, { id: "operator/other" }],
  });
  const expectedCatalog = [
    { id: "operator/model", label: "Operator model" },
    { id: "operator/other", label: "operator/other" },
  ];
  assert.deepEqual(createServerAdapter().models, expectedCatalog);
  assert.deepEqual(await remoteOnlyAdapter.listModels(), expectedCatalog);
  assert.deepEqual(await remoteOnlyAdapter.refreshModels(), expectedCatalog);
  assert.deepEqual(remoteOnlyAdapter.models, expectedCatalog);
  const catalogSchema = await remoteOnlyAdapter.getConfigSchema();
  assert.deepEqual(catalogSchema.fields.find((field) => field.key === "model").options.map((option) => option.value), expectedCatalog.map((model) => model.id));
  process.env.PAPERCLIP_ADAPTER_MODELS = '{"omp_local":[]}';
  assert.deepEqual(await remoteOnlyAdapter.listModels(), []);
  for (const invalidCatalog of ["invalid-json", "[]", '{"omp_local":{}}', '{"omp_local":[{}]}']) {
    process.env.PAPERCLIP_ADAPTER_MODELS = invalidCatalog;
    await assert.rejects(remoteOnlyAdapter.listModels(), { code: "omp_model_catalog_invalid" });
    await assert.rejects(remoteOnlyAdapter.getConfigSchema(), { code: "omp_model_catalog_invalid" });
  }
  delete process.env.PAPERCLIP_ADAPTER_MODELS;

  // A real host runner is retained, including its failure: never retry locally.
  const remoteFailure = new Error("test remote transport unavailable");
  const remoteCommands = [];
  const executionTarget = {
    kind: "remote",
    transport: "sandbox",
    remoteCwd: "/runner/workspace",
    runner: {
      async execute(input) {
        remoteCommands.push(input);
        throw remoteFailure;
      },
    },
  };
  await assert.rejects(
    remoteOnlyAdapter.execute({ ...policyContext, config: baseConfig, executionTarget }),
    (error) => error === remoteFailure,
  );
  assert.ok(remoteCommands.length > 0);
  const executionCommandCount = remoteCommands.length;
  const remoteEnvironment = await remoteOnlyAdapter.testEnvironment({
    companyId: agent.companyId,
    adapterType: "omp_local",
    config: baseConfig,
    executionTarget,
  });
  assert.equal(remoteEnvironment.status, "fail");
  assert.ok(remoteEnvironment.checks.some((check) => check.code === "omp_runtime_target_prepare_failed"));
  assert.ok(remoteCommands.length > executionCommandCount);
  assert.equal(policySpawns, 0);
  await assert.rejects(fs.access(policyArgvLog), { code: "ENOENT" });
} finally {
  for (const key of policyEnvKeys) {
    if (savedPolicyEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedPolicyEnv[key];
  }
}

const fresh = await run("00000000-0000-4000-8000-000000000011", emptyRuntime, "FRESH_OK");
assert.equal(fresh.exitCode, 0, fresh.errorMessage ?? "fresh execution failed");
assert.equal(fresh.sessionId, "fake-session-1");
assert.match(fresh.summary ?? "", /FRESH_OK/);
assert.deepEqual(fresh.usage, { inputTokens: 100, outputTokens: 20, cachedInputTokens: 5 });
assert.equal(fresh.usageBasis, "per_run");

const resumed = await run(
  "00000000-0000-4000-8000-000000000012",
  {
    sessionId: fresh.sessionId,
    sessionParams: fresh.sessionParams,
    sessionDisplayId: fresh.sessionDisplayId,
    taskKey: null,
  },
  "RESUME_OK",
);
assert.equal(resumed.exitCode, 0, resumed.errorMessage ?? "resumed execution failed");
assert.equal(resumed.sessionId, fresh.sessionId);
assert.match(resumed.summary ?? "", /RESUME_OK/);
assert.equal(resumed.usageBasis, "per_run");

for (const [index, [name, scenario]] of Object.entries(deadlineCases).entries()) {
  const result = await run(
    `00000000-0000-4000-8000-${(100 + index).toString().padStart(12, "0")}`,
    { sessionId: fresh.sessionId, sessionParams: fresh.sessionParams, sessionDisplayId: fresh.sessionDisplayId, taskKey: null },
    name,
  );
  assert.equal(result.exitCode, scenario.deadline ? scenario.exitCode ?? 1 : 0, name);
  assert.equal(result.timedOut, false, "an inner deadline is not the outer watchdog");
  assert.equal(result.errorCode, scenario.deadline ? "omp_deadline_exceeded" : undefined, name);
  assert.equal(result.errorFamily, undefined, "deadline must not claim an upstream/model failure");
  assert.equal(result.retryNotBefore, undefined, name);
  assert.deepEqual(result.resultJson.ompTermination, scenario.deadline ? deadlineTermination : undefined, name);
  assert.equal(result.resultJson.staleSessionAttempt, undefined, "a deadline must not trigger text-based session replay");
  assert.equal(result.executionRecovery, undefined, "deadline does not assert interruption/session preservation");
  assert.deepEqual(result.usage, { inputTokens: 17, outputTokens: 7, cachedInputTokens: 3 }, name);
  assert.equal(result.costUsd, 0.005, name);
  assert.equal(result.resultJson.toolCalls.length, 1, name);
  assert.deepEqual(result.resultJson.toolCalls[0].result, toolTimeoutResult, name);
  assert.equal(result.resultJson.toolCalls[0].isError, true, name);
  if (scenario.deadline) {
    assert.equal(result.errorMessage, "OMP agent deadline exceeded.", name);
    assert.equal(result.summary, null, "deadline must not reuse a stale success summary");
    assert.deepEqual(result.resultJson.errors, ["OMP agent deadline exceeded."], name);
  } else {
    assert.equal(result.errorMessage, null, name);
    if (name.endsWith("SUCCESS")) assert.match(result.summary, /Later work really succeeded|only quoted tool output/, name);
  }
}

const imageRunId = "00000000-0000-4000-8000-000000000997";
const imageLogs = [];
const imageRun = await adapter.execute({
  runId: imageRunId, agent, runtime: emptyRuntime, config: baseConfig,
  context: { expected: "LARGE_IMAGE_DEADLINE" },
  onLog: async (stream, chunk) => { if (stream === "stdout") imageLogs.push(chunk); },
});
const imageWire = largeImageWire();
const loggedImageWire = imageLogs.join("").slice(-imageWire.length);
let firstImageDifference = 0;
while (firstImageDifference < imageWire.length && loggedImageWire[firstImageDifference] === imageWire[firstImageDifference]) {
  firstImageDifference += 1;
}
assert.ok(
  loggedImageWire === imageWire,
  `native onLog must preserve the full JSONL/image bytes; expected ${imageWire.length} chars, received suffix ${loggedImageWire.length}; first difference ${firstImageDifference}: ${JSON.stringify(loggedImageWire.slice(firstImageDifference, firstImageDifference + 120))}`,
);
assert.equal(imageRun.exitCode, 1);
assert.equal(imageRun.errorCode, "omp_deadline_exceeded");
assert.equal(imageRun.errorMessage, "OMP agent deadline exceeded.");
assert.equal(imageRun.errorFamily, undefined);
assert.equal(imageRun.timedOut, false);
assert.equal(imageRun.summary, null);
assert.equal(imageRun.sessionId, "fake-session-1");
assert.deepEqual(imageRun.usage, { inputTokens: 17, outputTokens: 7, cachedInputTokens: 3 });
assert.equal(imageRun.costUsd, 0.005);
const imageMetadata = imageRun.resultJson;
assert.ok(Buffer.byteLength(JSON.stringify(imageMetadata), "utf8") <= OMP_RESULT_JSON_MAX_BYTES);
assert.deepEqual(imageMetadata.ompTermination, deadlineTermination);
assert.deepEqual(imageMetadata.errors, ["OMP agent deadline exceeded."]);
assert.equal(imageMetadata.stdoutTruncated, true);
assert.deepEqual(imageMetadata.nativeRunLog, { runId: imageRunId, path: `/api/heartbeat-runs/${imageRunId}/log` });
const imageCall = imageMetadata.toolCalls[0];
assert.equal(imageCall.toolCallId, "image-call");
assert.equal(imageCall.toolName, "gr_call_application");
assert.equal(imageCall.isError, true);
assert.equal(imageCall.truncated, true);
assert.equal(imageMetadata.toolCallsOmitted, 0);
assert.equal(imageCall.identifiersComplete, true);
assert.equal(imageCall.result.structuredContent.status, "failed");
assert.equal(imageCall.result.structuredContent.partialMutation, true);
assert.match(imageCall.result.structuredContent.warning, /not replay/);
for (const id of ["operation-argument", "request-argument", "operation-text-receipt", "operation-structured-receipt", "request-receipt"]) {
  assert.ok(imageCall.identifiers.some((entry) => entry.value === id), `retained exact control identifier ${id}`);
}
assert.doesNotMatch(JSON.stringify(imageCall), /A{100}|B{100}/, "embedded image/resource bytes are omitted from tool metadata");
assert.match(JSON.stringify(imageCall), /omitted from result metadata; see native run log/);
assert.ok(imageWire.includes("operation-structured-receipt"));
assert.ok(imageWire.includes("Partial mutation; recover through the operation ledger, not replay."));

const ephemeralRunId = "00000000-0000-4000-8000-000000000013";
const ephemeral = await run(ephemeralRunId, emptyRuntime, "EPHEMERAL_OK", {
  ...baseConfig,
  noSession: true,
  env: {
    OPENROUTER_API_KEY: "unused-openrouter-key",
    PAPERCLIP_API_KEY: "configured-paperclip-key",
    PAPERCLIP_AGENT_ID: "attacker",
    PAPERCLIP_RUN_ID: "attacker",
  },
});
assert.equal(ephemeral.exitCode, 0, ephemeral.errorMessage ?? "ephemeral execution failed");
assert.equal(ephemeral.sessionId, null);
assert.equal(ephemeral.sessionParams, null);
assert.match(ephemeral.summary ?? "", /EPHEMERAL_OK/);
assert.equal(ephemeral.usageBasis, "per_run");
assert.equal(ephemeral.biller, "fake-provider");
assert.match(ephemeral.summary ?? "", /PAPERCLIP_API_KEY=set/);
const ephemeralMeta = metas.at(-1);
assert.equal(ephemeralMeta?.env?.PAPERCLIP_AGENT_ID, agent.id);
assert.equal(ephemeralMeta?.env?.PAPERCLIP_RUN_ID, ephemeralRunId);

const savedOmpProfile = process.env.OMP_PROFILE;
const savedPiProfile = process.env.PI_PROFILE;
process.env.OMP_PROFILE = "host-profile";
process.env.PI_PROFILE = "legacy-host-profile";
try {
  const materialized = await run(
    "00000000-0000-4000-8000-000000000014",
    emptyRuntime,
    "MATERIALIZED_OK",
    {
      ...baseConfig,
      noSession: true,
      modelsYaml: `providers:\n  smoke:\n    api: openai-completions\n    auth: none\n    models:\n      - id: smoke\n        contextWindow: 4096\n        maxTokens: 1024\n`,
    },
  );
  assert.equal(materialized.exitCode, 0, materialized.errorMessage ?? "materialized execution failed");
  assert.match(materialized.summary ?? "", /MATERIALIZED_OK/);
  assert.match(materialized.summary ?? "", /OMP_PROFILE=\|PI_PROFILE=\|/);
  assert.match(materialized.summary ?? "", /AGENT_DIR=.*paperclip-omp-agent-/);
} finally {
  if (savedOmpProfile === undefined) delete process.env.OMP_PROFILE;
  else process.env.OMP_PROFILE = savedOmpProfile;
  if (savedPiProfile === undefined) delete process.env.PI_PROFILE;
  else process.env.PI_PROFILE = savedPiProfile;
}

// Regression test 1: modelProfiles removed in 2026.916.0
assert.equal("modelProfiles" in adapter, false, "modelProfiles must be removed from adapter definition");

// Regression test 2: UI parser handles tool_execution_update with progress
const progressLine = JSON.stringify({
  type: "tool_execution_update",
  timestamp: new Date().toISOString(),
  toolCallId: "call-123",
  toolName: "bash",
  partialResult: { details: { progress: "Building project..." } }
});
const progressEntries = parseStdoutLine(progressLine);
assert.equal(progressEntries.length, 1);
assert.equal(progressEntries[0].kind, "tool_result");
assert.equal(progressEntries[0].toolUseId, "call-123");
assert.equal(progressEntries[0].content, "Building project...");
assert.equal(progressEntries[0].delta, true);

// Regression test 3: UI parser drops empty tool_execution_update
const emptyToolUpdate = JSON.stringify({
  type: "tool_execution_update",
  timestamp: new Date().toISOString(),
  toolCallId: "call-123",
  toolName: "bash",
  partialResult: {}
});
assert.deepEqual(parseStdoutLine(emptyToolUpdate), []);


// Regression test 5: Paperclip log redaction corrupts JSONL; the parsers repair it
const redactedLines = (await fs.readFile(new URL("./fixtures/redacted-lines.txt", import.meta.url), "utf8"))
  .split("\n")
  .filter(Boolean);
assert.equal(redactedLines.length, 3);
for (const [index, redactedLine] of redactedLines.entries()) {
  assert.throws(() => JSON.parse(redactedLine), "fixture must stay corrupted");
  const entries = parseStdoutLine(redactedLine, transcriptTs);
  assert.equal(entries.length, 1, `fixture ${index} must produce one entry`);
  assert.equal(entries[0].kind, "tool_result", `fixture ${index} must be repaired`);
  assert.equal(entries[0].toolName, "bash");
  if (index < 2) assert.match(entries[0].content, /\*\*\*REDACTED\*\*\*/);
}

// Regression test 6: an unrepairable JSON line collapses into one short notice
const truncatedLine = '{"type":"tool_execution_end","toolCallId":"c3","result":{"content":"';
const truncatedEntries = parseStdoutLine(truncatedLine, transcriptTs);
assert.equal(truncatedEntries.length, 1);
assert.equal(truncatedEntries[0].kind, "system");
assert.ok(truncatedEntries[0].text.length < 200);
assert.match(truncatedEntries[0].text, /tool_execution_end/);

// Regression test 7: parseOmpJsonl repairs redacted lines and bounds unknownLines
const repairedStdout = Array.from(
  { length: 120 },
  (_value, index) => redactedLines[0].replace('"toolCallId":"c1"', `"toolCallId":"c1-${index}"`),
).join("\n");
const repairedParse = parseOmpJsonl(repairedStdout);
assert.equal(repairedParse.toolCalls.length, 120);
assert.equal(repairedParse.unknownLines.length, 0);

const unreadableParse = parseOmpJsonl(Array.from({ length: 120 }, () => truncatedLine).join("\n"));
assert.equal(unreadableParse.unknownLines.length, 51);
assert.match(unreadableParse.unknownLines.at(-1), /^… 70 more unparsed lines \(\d+ bytes\)$/);
for (const entry of unreadableParse.unknownLines.slice(0, -1)) {
  assert.ok(entry.length <= 240);
}

// Regression test 8: adapter defaults are applied when the config leaves fields empty
await run(
  "00000000-0000-4000-8000-000000000016",
  emptyRuntime,
  "DEFAULTS_OK",
  { command: fakeOmp, cwd: executionCwd, noSession: true },
);
const defaultsMeta = metas.at(-1);
const defaultArgs = defaultsMeta?.commandArgs ?? [];
assert.ok(defaultArgs.includes("--no-title"), "default commandArgs must include --no-title");
assert.ok(defaultArgs.includes("--print-thoughts"), "default commandArgs must include --print-thoughts");
assert.equal(defaultArgs[defaultArgs.indexOf("--approval-mode") + 1], "yolo");
assert.ok(!defaultArgs.includes("--auto-approve"), "--auto-approve must no longer be emitted");

// Regression test 9: OMP stream drives Paperclip's live run status
const progressEvents = [];
const runEvents = [];
const progressRunId = "00000000-0000-4000-8000-000000000017";
await adapter.execute({
  runId: progressRunId,
  agent,
  runtime: emptyRuntime,
  config: { command: fakeOmp, cwd: executionCwd, noSession: true, promptTemplate: "{{context.expected}}" },
  context: { expected: "PROGRESS_OK" },
  onLog: async () => {},
  onMeta: async () => {},
  onRuntimeProgress: async (update) => { progressEvents.push(update); },
  onEvent: async (event) => { runEvents.push(event); },
});
const toolProgress = progressEvents.find((update) => update.currentToolName === "bash");
assert.ok(toolProgress, "a tool_execution_start must report currentToolName");
assert.equal(toolProgress.message, "Running bash");
const snippetProgress = progressEvents.filter((update) => update.lastAssistantSnippet).at(-1);
assert.ok(snippetProgress, "assistant output must report a snippet");
assert.match(snippetProgress.lastAssistantSnippet, /PROGRESS_OK/);

// Regression test 10: completed tool calls become durable Paperclip run events
const toolEvent = runEvents.find((event) => event.eventType === "omp.tool");
assert.ok(toolEvent, "a finished tool call must publish an omp.tool run event");
assert.equal(toolEvent.stream, "system");
assert.equal(toolEvent.level, "info");
assert.match(toolEvent.message, /^bash ok in \d+\.\ds \u2014 true$/);
const intentEvent = runEvents.find((event) => event.eventType === "omp.tool" && event.message.startsWith("fabric_exec"));
assert.ok(intentEvent, "a fabric_exec tool call must publish an omp.tool run event");
assert.match(
  intentEvent.message,
  /^fabric_exec ok in \d+\.\ds \u2014 Inspecting adapter and Paperclip install$/,
);

const thinkingEvents = runEvents.filter((event) => event.eventType === "omp.thinking");
assert.equal(thinkingEvents.length, 1, "one finished thinking segment must publish exactly one omp.thinking event");
assert.equal(thinkingEvents[0].stream, "system");
assert.equal(thinkingEvents[0].level, "info");
assert.match(thinkingEvents[0].message, /^step 0 weighing the adapter contract/);
assert.equal(thinkingEvents[0].message.length, 501);
assert.ok(thinkingEvents[0].message.endsWith("\u2026"), "a long thinking segment must be cut with an ellipsis");
assert.ok(
  runEvents.indexOf(thinkingEvents[0]) < runEvents.findIndex((event) => event.eventType === "omp.tool"),
  "thinking must be published before the tool call that ended it",
);

// Regression test 10b: a stream that stops right after thinking still publishes the segment
const abruptEvents = [];
await adapter.execute({
  runId: "00000000-0000-4000-8000-000000000018",
  agent,
  runtime: emptyRuntime,
  config: { command: fakeOmp, cwd: executionCwd, noSession: true, promptTemplate: "{{context.expected}}" },
  context: { expected: "ABRUPT_THINKING" },
  onLog: async () => {},
  onMeta: async () => {},
  onEvent: async (event) => { abruptEvents.push(event); },
});
const abruptThinking = abruptEvents.filter((event) => event.eventType === "omp.thinking");
assert.equal(abruptThinking.length, 1, "a stream ending after thinking_delta must still publish its segment");
assert.equal(abruptThinking[0].message, "last thought before the process stops");

// Regression test 10c: one delta larger than the thinking buffer is cut at the buffer, not after it
const oversizedEvents = [];
const oversizedReporter = createOmpProgressReporter(undefined, async (event) => { oversizedEvents.push(event); });
await oversizedReporter.ingest(JSON.stringify({
  type: "message_update",
  assistantMessageEvent: { type: "thinking_delta", delta: "x".repeat(20) + " ".repeat(4000) + "y".repeat(100) },
}));
await oversizedReporter.flush();
assert.equal(oversizedEvents.length, 1, "an oversized delta must publish exactly one thinking event");
assert.equal(
  oversizedEvents[0].message,
  "x".repeat(20) + "\u2026",
  "content past THINKING_BUFFER_CHARS must never reach the published segment",
);

// Regression test 10d: live snippets keep the spaces that separate deltas
const snippetUpdates = [];
const snippetReporter = createOmpProgressReporter(async (update) => { snippetUpdates.push(update); }, undefined);
for (const delta of ["weighing ", "the ", "contract"]) {
  await snippetReporter.ingest(JSON.stringify({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", delta },
  }));
}
await snippetReporter.ingest(JSON.stringify({
  type: "tool_execution_start",
  toolCallId: "snippet-1",
  toolName: "bash",
  args: { command: "true" },
}));
assert.equal(snippetUpdates.at(-1).lastAssistantSnippet, "Thinking: weighing the contract");

const textUpdates = [];
const textReporter = createOmpProgressReporter(async (update) => { textUpdates.push(update); }, undefined);
for (const delta of ["weighing ", "the ", "contract"]) {
  await textReporter.ingest(JSON.stringify({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta },
  }));
}
await textReporter.ingest(JSON.stringify({
  type: "tool_execution_start",
  toolCallId: "snippet-2",
  toolName: "bash",
  args: { command: "true" },
}));
assert.equal(textUpdates.at(-1).lastAssistantSnippet, "weighing the contract");

const cappedEvents = [];
const cappedReporter = createOmpProgressReporter(undefined, async (event) => { cappedEvents.push(event); });
for (let segment = 0; segment < 60; segment += 1) {
  await cappedReporter.ingest(JSON.stringify({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", delta: "reasoning segment " + segment + " " },
  }));
  await cappedReporter.ingest(JSON.stringify({
    type: "tool_execution_start",
    toolCallId: "cap-" + segment,
    toolName: "bash",
    args: { command: "true" },
  }));
}
const cappedThinking = cappedEvents.filter((event) => event.eventType === "omp.thinking");
const capNotices = cappedThinking.filter((event) => event.message.startsWith("Thinking event limit reached"));
assert.equal(capNotices.length, 1, "the thinking cap notice must be published exactly once");
assert.equal(cappedThinking.length, 41, "40 thinking segments plus one cap notice");
assert.equal(cappedThinking.at(-1), capNotices[0]);
for (const event of cappedThinking) assert.ok(event.message.length <= 501, "thinking event content must stay capped");

let brokenSinkCalls = 0;
const brokenReporter = createOmpProgressReporter(undefined, async () => {
  brokenSinkCalls += 1;
  throw new Error("sink down");
});
await brokenReporter.ingest(JSON.stringify({
  type: "message_update",
  assistantMessageEvent: { type: "thinking_delta", delta: "unreported reasoning" },
}));
await brokenReporter.ingest(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }));
for (let i = 0; i < 5; i += 1) {
  await brokenReporter.ingest(JSON.stringify({ type: "tool_execution_end", toolCallId: "broken-" + i, toolName: "bash", isError: false }));
}
assert.equal(brokenSinkCalls, 1, "a failed sink must never be called again");
assert.equal(brokenReporter.sawProviderWork(), true);

// Regression test 11: OMP failures map onto Paperclip's retry vocabulary
const quotaFailure = classifyOmpFailure({
  parsedError: "429 rate limit reached; retry-after: 42",
  stderr: "",
  timedOut: false,
  exitCode: 1,
  signal: null,
});
assert.equal(quotaFailure.errorFamily, "provider_quota");
assert.equal(quotaFailure.errorCode, "omp_provider_quota");
assert.ok(Date.parse(quotaFailure.retryNotBefore) > Date.now());
assert.equal(
  classifyOmpFailure({ parsedError: "", stderr: "upstream service unavailable", timedOut: false, exitCode: 1, signal: null }).errorFamily,
  "transient_upstream",
);
assert.equal(
  classifyOmpFailure({ parsedError: "refresh token has expired", stderr: "", timedOut: false, exitCode: 1, signal: null }).errorFamily,
  "refresh_token_expired",
);
assert.deepEqual(
  classifyOmpFailure({ parsedError: "", stderr: "", timedOut: false, exitCode: 3, signal: null }),
  { errorCode: "omp_exit_3", errorFamily: null, retryNotBefore: null },
);

// Regression test 13: a run that never reached the provider reports bootstrap evidence
const bootstrap = await run(
  "00000000-0000-4000-8000-000000000018",
  emptyRuntime,
  "BOOTSTRAP_FAIL",
  { ...baseConfig, noSession: true, promptTemplate: "{{context.expected}}" },
);
assert.equal(bootstrap.exitCode, 1);
assert.deepEqual(bootstrap.executionRecovery, { kind: "bootstrap", providerWorkStarted: false });
assert.equal(bootstrap.errorFamily, "transient_upstream");
assert.ok(Date.parse(bootstrap.retryNotBefore) > Date.now());

// Regression test 14: provider-billed cost is reported as the cache-adjusted amount
assert.equal(fresh.cacheAdjustedCostUsd, fresh.costUsd);
assert.ok(fresh.costUsd > 0);

// Regression test 15: omp usage --json becomes a Paperclip provider quota result
const previousQuotaCommand = process.env.PAPERCLIP_OMP_COMMAND;
process.env.PAPERCLIP_OMP_COMMAND = fakeOmp;
try {
  const quota = await getOmpQuotaWindows();
  assert.equal(quota.ok, true, quota.error ?? "quota probe failed");
  assert.equal(quota.provider, "fake-provider");
  assert.equal(quota.source, "omp usage --json");
  assert.equal(quota.windows.length, 1);
  assert.equal(quota.windows[0].label, "5 Hour");
  assert.equal(quota.windows[0].usedPercent, 25);
  assert.equal(quota.windows[0].resetsAt, new Date(1789800000000).toISOString());
  assert.equal(quota.windows[0].valueLabel, "25 / 100 percent");
  assert.match(quota.windows[0].detail, /ok/);
} finally {
  if (previousQuotaCommand === undefined) delete process.env.PAPERCLIP_OMP_COMMAND;
  else process.env.PAPERCLIP_OMP_COMMAND = previousQuotaCommand;
}

// Regression test 16: the quota probe never spawns a second OMP process
const argvLog = path.join(root, "fake-omp-argv.log");
const previousArgvLog = process.env.FAKE_OMP_ARGV_LOG;
process.env.FAKE_OMP_ARGV_LOG = argvLog;
const previousQuotaCommand2 = process.env.PAPERCLIP_OMP_COMMAND;
process.env.PAPERCLIP_OMP_COMMAND = fakeOmp;
try {
  const started = Date.now();
  const quota = await getOmpQuotaWindows();
  assert.equal(quota.ok, true, quota.error ?? "quota probe failed");
  assert.ok(Date.now() - started < 20000, "quota probe must settle inside Paperclip's 20s budget");
  const invocations = (await fs.readFile(argvLog, "utf8")).split("\n").filter(Boolean);
  assert.deepEqual(invocations, ["usage --json"], `quota probe spawned: ${invocations.join(" | ")}`);
} finally {
  if (previousQuotaCommand2 === undefined) delete process.env.PAPERCLIP_OMP_COMMAND;
  else process.env.PAPERCLIP_OMP_COMMAND = previousQuotaCommand2;
  if (previousArgvLog === undefined) delete process.env.FAKE_OMP_ARGV_LOG;
  else process.env.FAKE_OMP_ARGV_LOG = previousArgvLog;
}

// Regression test 17: a successful run never claims interruption evidence
assert.equal(fresh.executionRecovery, undefined);
assert.equal(fresh.resultJson.executionCancellation, undefined);

const hugeLogConfig = { ...baseConfig, timeoutSec: 120 };
const huge = await run("00000000-0000-4000-8000-000000000019", emptyRuntime, "HUGE_LOG", hugeLogConfig);
assert.ok(Buffer.byteLength(JSON.stringify(huge.resultJson), "utf8") <= OMP_RESULT_JSON_MAX_BYTES);
assert.equal(huge.resultJson.stdoutTruncated, true);
assert.ok(
  !huge.resultJson.stdout.includes("fake-session-1"),
  "the session header must fall outside the captured stdout window for this fixture",
);
assert.equal(huge.exitCode, 0, huge.errorMessage ?? "huge-log execution failed");
assert.equal(huge.sessionId, "fake-session-1", "sessionId must come from the stream, not truncated stdout");
assert.equal(huge.sessionParams?.sessionId, "fake-session-1", "sessionParams must survive a truncated stdout window");
assert.deepEqual(
  huge.usage,
  { inputTokens: 107, outputTokens: 23, cachedInputTokens: 6 },
  "usage must sum the turn before the truncation window and the turn after it",
);
assert.ok(Math.abs(huge.costUsd - 0.012) < 1e-9, "costUsd must include the turn dropped from captured stdout");
assert.equal(huge.resultJson.toolCalls.length, 1, "tool calls before the truncation window must survive");

const hugeAbortController = new AbortController();
const hugeAborted = await adapter.execute({
  runId: "00000000-0000-4000-8000-00000000001a",
  agent,
  runtime: emptyRuntime,
  config: hugeLogConfig,
  context: { expected: "HUGE_LOG_ABORT" },
  onLog: async (stream, chunk) => {
    if (stream === "stdout" && chunk.includes("ABORT_MARKER")) hugeAbortController.abort();
  },
  onMeta: async () => {},
  signal: hugeAbortController.signal,
});
assert.equal(hugeAborted.sessionId, "fake-session-1", "an aborted huge run must still resolve its session");
assert.deepEqual(hugeAborted.executionRecovery, {
  kind: "interrupted",
  providerStopped: true,
  sessionPreserved: true,
  actionOutcomes: "settled",
});
assert.deepEqual(hugeAborted.resultJson.executionCancellation, { state: "acknowledged" });

await fs.rm(root, { recursive: true, force: true });
console.log("adapter smoke passed");
