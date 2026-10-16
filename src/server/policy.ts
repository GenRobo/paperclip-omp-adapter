import type { AdapterEnvironmentCheck } from "@paperclipai/adapter-utils";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { parseSshRemoteExecutionSpec } from "@paperclipai/adapter-utils/ssh";

/** Operator-owned: never consult adapter config or the child invocation environment. */
export function requireRemoteOmpExecution(): boolean {
  return process.env.PAPERCLIP_OMP_REQUIRE_REMOTE?.trim().toLowerCase() === "true";
}

export function remoteOmpTargetPolicyCheck(
  target: AdapterExecutionTarget | null | undefined,
): AdapterEnvironmentCheck | null {
  if (!requireRemoteOmpExecution()) return null;
  if (target?.kind === "remote" && typeof target.remoteCwd === "string" && target.remoteCwd.trim()) {
    if (target.transport === "ssh" && parseSshRemoteExecutionSpec(target.spec)) return null;
    if (target.transport === "sandbox" && typeof target.runner?.execute === "function") return null;
  }
  return {
    code: "omp_remote_target_required",
    level: "error",
    message: "OMP requires a host-provided SSH or sandbox execution target; hub execution is disabled by PAPERCLIP_OMP_REQUIRE_REMOTE=true.",
    hint: "Assign a remote Paperclip execution environment with a valid SSH connection or live sandbox provider runner. Agent configuration and config.env cannot override this operator policy.",
  };
}
