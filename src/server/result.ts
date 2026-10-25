import type { ParsedOmpToolCall } from "./parse.js";

/** Bounds adapter-owned metadata, not the native log or native-added receipts. */
export const OMP_RESULT_JSON_MAX_BYTES = 48 * 1024;
const SECTION_BYTES = 3 * 1024;
const TOOL_BYTES = 24 * 1024;
const OMITTED = "[omitted from result metadata; see native run log]";
const TRUNCATED = "… [truncated; see native run log]";

type JsonRecord = Record<string, unknown>;
type Projection = { value: unknown; truncated: boolean };

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
}

// Never stringify the original unbounded tree merely to discover its size.
function boundedString(value: string, budget: number): Projection {
  if (value.length <= budget && bytes(value) <= budget) return { value, truncated: false };
  let low = 0;
  let high = Math.min(value.length, budget);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (bytes(value.slice(0, middle) + TRUNCATED) <= budget) low = middle;
    else high = middle - 1;
  }
  // Do not introduce a lone UTF-16 surrogate at the cut.
  if (low > 0 && /[\uD800-\uDBFF]/.test(value[low - 1]!)) low -= 1;
  return { value: value.slice(0, low) + TRUNCATED, truncated: true };
}

/** A presentation sample, never a replacement operation receipt. */
function project(value: unknown, budget: number, depth = 0): Projection {
  if (typeof value === "string") return boundedString(value, Math.min(budget, SECTION_BYTES));
  if (value === null || typeof value !== "object") return { value: value ?? null, truncated: false };
  if (depth >= 12 || budget < 128) return { value: OMITTED, truncated: true };
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    let size = 2;
    let truncated = false;
    for (const item of value) {
      if (output.length >= 128 || budget - size < 128) { truncated = true; break; }
      const child = project(item, budget - size - 1, depth + 1);
      const added = bytes(child.value) + (output.length ? 1 : 0);
      if (size + added > budget) { truncated = true; break; }
      output.push(child.value);
      size += added;
      truncated ||= child.truncated;
    }
    return { value: output, truncated };
  }
  const record = value as JsonRecord;
  const output: JsonRecord = {};
  let size = 2;
  let count = 0;
  let truncated = false;
  // Keep control fields before bulky content even when they occur after it on the wire.
  const keys = Object.keys(record);
  keys.sort((a, b) => Number(/(?:id|ids|name|status|state|error|reason|warning|path|uri|structuredContent|details|metadata|partialMutation)$/i.test(b))
    - Number(/(?:id|ids|name|status|state|error|reason|warning|path|uri|structuredContent|details|metadata|partialMutation)$/i.test(a)));
  for (const key of keys) {
    if (record[key] === undefined) continue;
    if (key.length > 256 || count >= 128) { truncated = true; continue; }
    const overhead = bytes(key) + 2;
    if (budget - size - overhead < 128) { truncated = true; continue; }
    // Embedded MCP image/resource bytes belong only in the canonical log.
    const binary = (key === "data" && record.type === "image") || key === "blob"
      || ((key === "url" || key === "data") && typeof record[key] === "string" && /^data:[^,]*;base64,/.test(record[key] as string));
    const child = binary
      ? { value: OMITTED, truncated: true }
      : project(record[key], budget - size - overhead, depth + 1);
    const added = overhead + bytes(child.value);
    if (size + added > budget) { truncated = true; continue; }
    Object.defineProperty(output, key, { value: child.value, enumerable: true, configurable: true });
    size += added;
    count += 1;
    truncated ||= child.truncated;
  }
  return { value: output, truncated };
}

function identifiers(call: ParsedOmpToolCall): { values: JsonRecord[]; complete: boolean } {
  const values: JsonRecord[] = [];
  const seen = new Set<string>();
  let complete = true;
  let visited = 0;
  let size = 2;
  const visit = (value: unknown, depth: number): void => {
    if (++visited > 4096 || depth > 12) { complete = false; return; }
    if (typeof value === "string") {
      // MCP text blocks often carry a JSON receipt. Never claim opaque/oversized
      // textual receipts were fully indexed; the log/operation ledger is authoritative.
      const text = value.trimStart();
      if (text.startsWith("{") || text.startsWith("[")) {
        if (value.length > 64 * 1024) { complete = false; return; }
        try { visit(JSON.parse(value), depth + 1); } catch { complete = false; }
      }
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (visited >= 4096) { complete = false; break; }
      if (/^(?:operation|request|tool_?call|resource|artifact|session)[_-]?id$/i.test(key) && typeof child === "string") {
        const identity = `${key}:${child}`;
        if (child.length > 256) { complete = false; continue; }
        if (seen.has(identity)) continue;
        const entry = { key, value: child };
        const added = bytes(entry) + 1;
        if (size + added > 2048) { complete = false; continue; }
        values.push(entry);
        seen.add(identity);
        size += added;
      } else {
        visit(child, depth + 1);
      }
    }
  };
  visit(call.args, 0);
  visit(call.result, 0);
  return { values, complete };
}

export function boundOmpResultJson(input: {
  runId: string;
  stdout: string;
  stderr: string;
  errors: string[];
  toolCalls: ParsedOmpToolCall[];
  unknownLines: string[];
  ompTermination?: { reason: "deadline"; deadlineAt: number };
  executionCancellation?: { state: "acknowledged" };
  progressReporterFailed?: boolean;
  capabilityManifest: unknown;
  staleSessionAttempt?: { stdout: string; stderr: string };
}): JsonRecord {
  const { runId, toolCalls, ...fields } = input;
  const output: JsonRecord = {};
  const truncatedFields: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    const projected = project(value, SECTION_BYTES);
    output[key] = projected.value;
    if (projected.truncated) truncatedFields.push(key);
  }
  const kept: JsonRecord[] = [];
  let toolBytes = 2;
  let omitted = 0;
  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const call = toolCalls[index]!;
    const projected = project(call, 6 * 1024);
    let sample = projected.value as JsonRecord;
    if (projected.truncated) {
      const index = identifiers(call);
      sample = {
        ...sample,
        // These are identifiers, not synthesized success/failure receipts.
        identifiers: index.values,
        identifiersComplete: index.complete,
        truncated: true,
        truncationReason: "bounded_tool_metadata",
      };
    }
    const added = bytes(sample) + 1;
    if (toolBytes + added > TOOL_BYTES) { omitted += 1; continue; }
    kept.push(sample);
    toolBytes += added;
    if (projected.truncated && !truncatedFields.includes("toolCalls")) truncatedFields.push("toolCalls");
  }
  output.toolCalls = kept.reverse();
  if (omitted > 0 && !truncatedFields.includes("toolCalls")) truncatedFields.push("toolCalls");
  if (truncatedFields.length > 0) {
    output.truncated = true;
    output.truncationReason = "bounded_adapter_result_metadata";
    output.truncatedFields = truncatedFields;
    output.resultJsonMaxBytes = OMP_RESULT_JSON_MAX_BYTES;
    output.nativeRunLog = { runId, path: `/api/heartbeat-runs/${encodeURIComponent(runId)}/log` };
    output.toolCallsOmitted = omitted;
    output.toolCallsTotal = toolCalls.length;
    if (truncatedFields.includes("stdout")) output.stdoutTruncated = true;
    if (truncatedFields.includes("stderr")) output.stderrTruncated = true;
  }
  // Fixed section budgets leave room for this envelope. Enforce the contract
  // even if a future caller supplies additional fields or an invalid run ID.
  if (bytes(output) > OMP_RESULT_JSON_MAX_BYTES) {
    throw new Error("OMP result metadata exceeded its persistence bound");
  }
  return output;
}
