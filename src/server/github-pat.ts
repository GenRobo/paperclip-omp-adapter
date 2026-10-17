import fs, { constants } from "node:fs/promises";
import path from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/;
const DIRECTORY = "github-pat";
const TOKEN_VARIABLE = "GR_GITHUB_TOKEN";
type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GitHub PAT policy requires objects.");
  return value as RecordValue;
}

export interface GitHubPatPlan {
  repository: string;
  login: string;
  userId: number;
}

async function readPolicy(filename: string): Promise<RecordValue> {
  if (!path.isAbsolute(filename)) throw new Error("GitHub PAT policy must be an absolute operator-owned path.");
  const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 65_536 || (stat.mode & 0o022) !== 0 ||
        (process.getuid && stat.uid !== 0 && stat.uid !== process.getuid())) {
      throw new Error("GitHub PAT policy must be a bounded, trusted file without group/other write permission.");
    }
    const policy = record(JSON.parse(await file.readFile("utf8")));
    if (policy.schemaVersion !== 2) throw new Error("Unsupported GitHub PAT policy version.");
    const companies = record(policy.companies);
    for (const [companyId, company] of Object.entries(companies)) {
      if (!UUID.test(companyId)) throw new Error("GitHub PAT policy requires canonical company UUIDs.");
      for (const [projectId, value] of Object.entries(record(record(company).projects))) {
        const grant = record(value);
        if (!UUID.test(projectId) || typeof grant.repository !== "string" ||
            !REPOSITORY.test(grant.repository) || grant.repository.endsWith(".git") ||
            typeof grant.secretId !== "string" || !UUID.test(grant.secretId) ||
            !Array.isArray(grant.agents) || !grant.agents.length ||
            grant.agents.some(agentId => typeof agentId !== "string" || !UUID.test(agentId))) {
          throw new Error("GitHub PAT grants require an explicit project UUID, owner/repository, secret UUID and authorized agent UUIDs, never wildcards.");
        }
      }
    }
    return companies;
  } finally { await file.close(); }
}

function workspaceRepository(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("GitHub PAT execution requires a native HTTPS GitHub workspace repository."); }
  const repository = url.pathname.replace(/^\//, "").replace(/\.git$/, "");
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password ||
      url.search || url.hash || !REPOSITORY.test(repository)) {
    throw new Error("GitHub PAT execution requires an unambiguous HTTPS github.com repository URL.");
  }
  return repository;
}

/** Opt-in authority: a host-owned project/repository grant AND its native secret binding. Never inherit an operator token. */
export async function createGitHubPatPlan(input: {
  companyId: string; projectId: string; agentId: string; issueId: string; repoUrl: string; remote: boolean;
  env: RecordValue; secretManifest?: unknown;
}, operatorEnv: NodeJS.ProcessEnv = process.env, request: typeof fetch = fetch): Promise<GitHubPatPlan | null> {
  if (Object.keys(input.env).some(key => key.startsWith("PAPERCLIP_OMP_GITHUB_"))) {
    throw new Error("GitHub PAT policy and launcher authority are operator-owned, not agent environment settings.");
  }
  const token = input.env[TOKEN_VARIABLE];
  const filename = operatorEnv.PAPERCLIP_OMP_GITHUB_PAT_POLICY?.trim();
  if (!filename) {
    if (token) throw new Error("A GitHub PAT binding requires an explicit operator-owned repository grant.");
    return null;
  }
  const companies = await readPolicy(filename);
  const company = companies[input.companyId];
  const grant = company ? record(record(company).projects)[input.projectId] : undefined;
  if (!grant || !(record(grant).agents as string[]).includes(input.agentId)) {
    if (token) throw new Error("This company/project/agent has no explicit GitHub PAT grant.");
    return null;
  }
  if (!input.remote || !UUID.test(input.issueId)) throw new Error("GitHub PAT execution requires an isolated remote native issue run.");
  if (typeof token !== "string" || !/^github_pat_[A-Za-z0-9_]{20,500}$/.test(token)) {
    throw new Error("GitHub PAT execution requires the project's resolved fine-grained GR_GITHUB_TOKEN secret binding.");
  }
  const repository = workspaceRepository(input.repoUrl);
  if ((record(grant).repository as string).toLowerCase() !== repository.toLowerCase()) {
    throw new Error("The native workspace repository does not match this project's GitHub PAT grant.");
  }
  // Pin native secret provenance, not just its variable name: project/routine
  // configuration can reference another company secret. Never accept inline or
  // ambiguous bindings merely because their value looks like a valid PAT.
  const bindings = Array.isArray(input.secretManifest)
    ? input.secretManifest.filter(value => value && typeof value === "object" &&
        !Array.isArray(value) && value.envKey === TOKEN_VARIABLE)
    : [];
  if (bindings.length !== 1 || bindings[0].configPath !== `env.${TOKEN_VARIABLE}` ||
      bindings[0].secretId !== record(grant).secretId || bindings[0].outcome !== "success" ||
      typeof bindings[0].bindingId !== "string" || !UUID.test(bindings[0].bindingId)) {
    throw new Error("GitHub PAT execution requires the operator-approved native secret binding.");
  }
  const brokerUrl = input.env.PAPERCLIP_GITHUB_BROKER_URL;
  const capability = input.env.PAPERCLIP_GITHUB_BROKER_TOKEN;
  if (typeof brokerUrl !== "string" || typeof capability !== "string" || !capability) {
    throw new Error("GitHub PAT execution requires the native run's GitHub policy capability.");
  }
  // Native authority is checked before exporting the explicit PAT. In particular,
  // low-trust/revoked/unhealthy managed identities must not fall back to this mode.
  let policyResponse: Response;
  try {
    policyResponse = await request(new URL("/runtime-tools/github/credentials", brokerUrl), {
      method: "POST", headers: { Authorization: `Bearer ${capability}` },
      redirect: "error", signal: AbortSignal.timeout(15_000),
    });
  } catch { throw new Error("Native GitHub policy could not be verified; the repository PAT was not exported."); }
  if (!policyResponse.ok) throw new Error("Native GitHub policy rejected the run; the repository PAT was not exported.");
  const policy = record(await policyResponse.json());
  if (policy.status !== "absent") {
    throw new Error("Explicit repository PAT mode requires an eligible run without a managed GitHub identity; no fallback is permitted.");
  }
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  let userResponse: Response;
  let repoResponse: Response;
  try {
    userResponse = await request("https://api.github.com/user", { headers, redirect: "error", signal: AbortSignal.timeout(15_000) });
    repoResponse = await request(`https://api.github.com/repos/${repository}`, { headers, redirect: "error", signal: AbortSignal.timeout(15_000) });
  } catch { throw new Error("GitHub could not validate the explicit repository token."); }
  if (!userResponse.ok || !repoResponse.ok) throw new Error("The GitHub PAT is invalid, expired, awaiting approval, or cannot read the approved repository.");
  const user = record(await userResponse.json());
  const repo = record(await repoResponse.json());
  if (typeof user.login !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(user.login) ||
      !Number.isSafeInteger(user.id) || (user.id as number) <= 0 ||
      typeof repo.full_name !== "string" || repo.full_name.toLowerCase() !== repository.toLowerCase()) {
    throw new Error("GitHub returned an unexpected identity or repository; the PAT was not exported.");
  }
  return { repository, login: user.login, userId: user.id as number };
}

// These launchers contain no credentials. Git's helper reads the bound secret only
// for HTTPS github.com, never from argv, credential files or controller auth state.
const CREDENTIAL_HELPER = String.raw`!f() { if [ "$1" = get ]; then printf 'username=x-access-token\npassword=%s\n' "$GR_GITHUB_TOKEN"; fi; }; f`;
const LAUNCHER = `#!/usr/bin/env node
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const tool = path.basename(process.argv[1]);
if (tool !== 'git' && tool !== 'gh') process.exit(126);
const env = { ...process.env };
const token = env.GR_GITHUB_TOKEN;
for (const key of Object.keys(env)) {
  if (/^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|PAPERCLIP_GIT_TOKEN|GIT_ASKPASS|SSH_ASKPASS|SSH_AUTH_SOCK|GIT_SSH|GIT_SSH_COMMAND|GIT_CONFIG|GIT_CONFIG_.*|GIT_AUTHOR_.*|GIT_COMMITTER_.*)$/.test(key)) delete env[key];
}
env.GIT_CONFIG_NOSYSTEM = '1';
env.GIT_CONFIG_SYSTEM = '/dev/null';
env.GIT_CONFIG_GLOBAL = '/dev/null';
env.GIT_TERMINAL_PROMPT = '0';
env.GCM_INTERACTIVE = 'never';
env.GIT_SSH_COMMAND = 'ssh -F /dev/null -o IdentityAgent=none -o IdentitiesOnly=yes -o IdentityFile=none -o BatchMode=yes';
env.GH_HOST = 'github.com';
env.BASH_ENV = '/dev/null';
if (env.PAPERCLIP_OMP_GITHUB_PAT_BIN) {
  env.GH_CONFIG_DIR = path.join(env.PAPERCLIP_OMP_GITHUB_PAT_BIN, 'gh-config');
  env.ZDOTDIR = env.GH_CONFIG_DIR;
}
const configs = [['credential.helper', '']];
if (token) {
  env.GH_TOKEN = token;
  const login = env.PAPERCLIP_OMP_GITHUB_LOGIN;
  const id = env.PAPERCLIP_OMP_GITHUB_USER_ID;
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(login || '') || !/^[1-9][0-9]*$/.test(id || '')) {
    process.stderr.write('GitHub PAT identity is missing.\\n'); process.exit(126);
  }
  env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = login;
  env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = id + '+' + login + '@users.noreply.github.com';
  configs.push(['credential.https://github.com.helper', ${JSON.stringify(CREDENTIAL_HELPER)}]);
}
env.GIT_CONFIG_COUNT = String(configs.length);
configs.forEach(([key, value], index) => { env['GIT_CONFIG_KEY_' + index] = key; env['GIT_CONFIG_VALUE_' + index] = value; });
const child = spawn('/usr/bin/' + tool, process.argv.slice(2), { env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.on('error', () => { process.stderr.write('GitHub executable unavailable.\\n'); process.exit(126); });
child.on('exit', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exit(code ?? 1); });
`;

export async function materializeGitHubPatLaunchers(agentDir: string): Promise<void> {
  const directory = path.join(agentDir, DIRECTORY);
  await fs.mkdir(path.join(directory, "gh-config"), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(directory, "package.json"), '{"type":"commonjs"}\n', { mode: 0o600, flag: "wx" });
  for (const tool of ["git", "gh"]) await fs.writeFile(path.join(directory, tool), LAUNCHER, { mode: 0o700, flag: "wx" });
  const profile = 'export PATH="$PAPERCLIP_OMP_GITHUB_PAT_BIN:$PATH"\n';
  for (const filename of [".bashrc", ".zshenv", ".zprofile", ".zshrc"]) {
    await fs.writeFile(path.join(directory, filename), profile, { mode: 0o600, flag: "wx" });
  }
}

export function applyGitHubPatEnvironment(env: Record<string, string>, agentDir: string, plan: GitHubPatPlan): void {
  const directory = path.posix.join(agentDir, DIRECTORY);
  const oldLauncher = env.PAPERCLIP_GITHUB_LAUNCHER_DIR;
  env.PATH = [directory, ...(env.PATH ?? "/usr/local/bin:/usr/bin:/bin").split(":").filter(value => value && value !== oldLauncher && value !== directory)].join(":");
  env.BASH_ENV = path.posix.join(directory, ".bashrc");
  env.ZDOTDIR = directory;
  env.GH_CONFIG_DIR = path.posix.join(directory, "gh-config");
  env.PAPERCLIP_OMP_GITHUB_PAT_BIN = directory;
  env.PAPERCLIP_OMP_GITHUB_LOGIN = plan.login;
  env.PAPERCLIP_OMP_GITHUB_USER_ID = String(plan.userId);
  delete env.PAPERCLIP_GITHUB_LAUNCHER_DIR;
}
