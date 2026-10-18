import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { applyGitHubPatEnvironment, createGitHubPatPlan, materializeGitHubPatLaunchers } from "../dist/server/github-pat.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const issueId = "33333333-3333-4333-8333-333333333333";
const projectId = "44444444-4444-4444-8444-444444444444";
const otherProjectId = "55555555-5555-4555-8555-555555555555";
const secretId = "66666666-6666-4666-8666-666666666666";
const token = "github_pat_test_fixture_never_a_real_credential";
const input = {
  companyId, projectId, agentId, issueId, remote: true, repoUrl: "https://github.com/GenRobo/approved.git",
  workspaceMode: "isolated_workspace", workspaceStrategy: "git_worktree",
  executionWorkspaceId: "88888888-8888-4888-8888-888888888888",
  env: { GR_GITHUB_TOKEN: token, PAPERCLIP_GITHUB_BROKER_URL: "http://127.0.0.1:8443", PAPERCLIP_GITHUB_BROKER_TOKEN: "native-fixture-capability" },
  secretManifest: [{ secretId, bindingId: "77777777-7777-4777-8777-777777777777",
    configPath: "env.GR_GITHUB_TOKEN", envKey: "GR_GITHUB_TOKEN", outcome: "success" }],
};
const posix = process.platform === "win32" ? test.skip : test;
async function fixture(t, projects = { [projectId]: { repository: "GenRobo/approved", secretId, agents: [agentId] } }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-pat-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filename = path.join(root, "policy.json");
  await fs.writeFile(filename, JSON.stringify({ schemaVersion: 2, companies: { [companyId]: { projects } } }), { mode: 0o600 });
  return { root, filename, operatorEnv: { PAPERCLIP_OMP_GITHUB_PAT_POLICY: filename } };
}
function authority(status = "absent") {
  const githubRequests = [];
  return {
    githubRequests,
    request: async (url, options) => {
      const address = String(url);
      if (address.startsWith("http://127.0.0.1:8443/")) return Response.json({ status });
      githubRequests.push({ url: address, authorization: options.headers.Authorization });
      if (address === "https://api.github.com/user") return Response.json({ login: "fixture-owner", id: 42 });
      if (address === "https://api.github.com/repos/GenRobo/approved") return Response.json({ full_name: "GenRobo/approved" });
      throw new Error("Unexpected authority request");
    },
  };
}

posix("repository PAT requires both explicit actor grant and native eligible run before contacting GitHub", async t => {
  const { operatorEnv } = await fixture(t);
  for (const altered of [
    { ...input, agentId: issueId }, { ...input, companyId: issueId },
    { ...input, projectId: otherProjectId }, { ...input, projectId: "" },
    { ...input, repoUrl: "https://github.com/GenRobo/unapproved" },
    { ...input, repoUrl: "https://github.com.evil.invalid/GenRobo/approved" },
    { ...input, repoUrl: "https://credential@github.com/GenRobo/approved" },
    { ...input, repoUrl: "https://github.com/GenRobo/approved?token=unexpected" },
    { ...input, remote: false }, { ...input, issueId: "" },
    { ...input, env: { ...input.env, GR_GITHUB_TOKEN: undefined } },
    { ...input, env: { ...input.env, PAPERCLIP_GITHUB_BROKER_TOKEN: undefined } },
    { ...input, env: { ...input.env, PAPERCLIP_OMP_GITHUB_PAT_POLICY: "/workspace/policy.json" } },
  ]) {
    const auth = authority();
    await assert.rejects(createGitHubPatPlan(altered, operatorEnv, auth.request));
    assert.equal(auth.githubRequests.length, 0);
  }
  for (const status of ["available", "unavailable", "unexpected"]) {
    const auth = authority(status);
    await assert.rejects(createGitHubPatPlan(input, operatorEnv, auth.request), /no fallback/);
    assert.equal(auth.githubRequests.length, 0);
  }
  const auth = authority();
  const plan = await createGitHubPatPlan(input, operatorEnv, auth.request);
  assert.deepEqual(plan, { repository: "GenRobo/approved", login: "fixture-owner", userId: 42 });
  assert.equal(await createGitHubPatPlan({ ...input, agentId: issueId, env: {} }, operatorEnv, auth.request), null);
  await assert.rejects(createGitHubPatPlan(input, {}, auth.request), /operator-owned/);
});

posix("shared or unproven task workspaces cannot receive repository credentials", async t => {
  const { operatorEnv } = await fixture(t);
  for (const changed of [
    { workspaceMode: "shared_workspace", workspaceStrategy: "project_primary" },
    { workspaceMode: "isolated_workspace", workspaceStrategy: "project_primary" },
    { workspaceMode: undefined },
    { executionWorkspaceId: "" },
    { executionWorkspaceId: "not-a-native-workspace" },
  ]) {
    const auth = authority();
    await assert.rejects(
      createGitHubPatPlan({ ...input, ...changed }, operatorEnv, auth.request),
      /per-issue native Git worktree/,
    );
    assert.equal(auth.githubRequests.length, 0);
  }
});

posix("one engineer's admission is bound independently to each project's repository", async t => {
  const { operatorEnv } = await fixture(t, {
    [projectId]: { repository: "GenRobo/approved", secretId, agents: [agentId] },
    [otherProjectId]: { repository: "GenRobo/second", secretId, agents: [agentId] },
  });
  for (const altered of [
    { ...input, projectId: otherProjectId },
    { ...input, repoUrl: "https://github.com/GenRobo/second" },
  ]) {
    const auth = authority();
    await assert.rejects(createGitHubPatPlan(altered, operatorEnv, auth.request), /does not match/);
    assert.equal(auth.githubRequests.length, 0);
  }
  const auth = authority();
  assert.equal((await createGitHubPatPlan(input, operatorEnv, auth.request)).repository, "GenRobo/approved");
  await assert.rejects(createGitHubPatPlan({
    ...input, projectId: otherProjectId, repoUrl: "https://github.com/GenRobo/second",
    env: { ...input.env, GR_GITHUB_TOKEN: undefined },
  }, operatorEnv, auth.request), /project's resolved/);
});

posix("secret substitution and missing or ambiguous native provenance cannot export a PAT", async t => {
  const { operatorEnv } = await fixture(t);
  const binding = input.secretManifest[0];
  for (const secretManifest of [
    undefined, [], [{ ...binding, secretId: otherProjectId }],
    [{ ...binding, outcome: "failure" }], [{ ...binding, bindingId: undefined }],
    [{ ...binding, configPath: "env.OTHER_TOKEN" }],
    [binding, { ...binding, secretId: otherProjectId }],
  ]) {
    const auth = authority();
    await assert.rejects(createGitHubPatPlan({ ...input, secretManifest }, operatorEnv, auth.request), /operator-approved native secret/);
    assert.equal(auth.githubRequests.length, 0);
  }
});

posix("legacy agent-wide policy and ambiguous project grants fail closed", async t => {
  const { filename, operatorEnv } = await fixture(t);
  for (const policy of [
    { schemaVersion: 1, companies: { [companyId]: { agents: { [agentId]: { repositories: ["GenRobo/approved"] } } } } },
    { schemaVersion: 2, companies: { [companyId]: { projects: { [projectId]: { repository: "*", secretId, agents: [agentId] } } } } },
    { schemaVersion: 2, companies: { [companyId]: { projects: { [projectId]: { repository: "GenRobo/approved", secretId, agents: ["*"] } } } } },
    { schemaVersion: 2, companies: { [companyId]: { projects: { [projectId]: { repositories: ["GenRobo/approved", "GenRobo/second"], secretId, agents: [agentId] } } } } },
    { schemaVersion: 2, companies: { [companyId]: { projects: { [projectId]: { repository: "GenRobo/approved", agents: [agentId] } } } } },
  ]) {
    await fs.writeFile(filename, JSON.stringify(policy));
    const auth = authority();
    await assert.rejects(createGitHubPatPlan(input, operatorEnv, auth.request));
    assert.equal(auth.githubRequests.length, 0);
  }
});

posix("policy symlinks and writable authority cannot grant repository access", async t => {
  const { root, filename, operatorEnv } = await fixture(t);
  const link = path.join(root, "untrusted-link");
  await fs.symlink(filename, link);
  const auth = authority();
  await assert.rejects(createGitHubPatPlan(input, { PAPERCLIP_OMP_GITHUB_PAT_POLICY: link }, auth.request));
  await fs.chmod(filename, 0o666);
  await assert.rejects(createGitHubPatPlan(input, operatorEnv, auth.request), /trusted file/);
  assert.equal(auth.githubRequests.length, 0);
});

posix("GitHub failure or renamed repository cannot silently establish a PAT identity", async t => {
  const { operatorEnv } = await fixture(t);
  for (const failure of ["expired", "renamed", "network"]) {
    const request = async url => {
      const address = String(url);
      if (address.startsWith("http://127.0.0.1:8443/")) return Response.json({ status: "absent" });
      if (failure === "network") throw new Error("unreachable");
      if (failure === "expired") return new Response("denied", { status: 401 });
      return address.endsWith("/user") ? Response.json({ login: "fixture-owner", id: 42 }) : Response.json({ full_name: "GenRobo/renamed" });
    };
    await assert.rejects(createGitHubPatPlan(input, operatorEnv, request));
  }
});

posix("real Git uses verified identity, never ambient credentials, and anonymous source export still works", async t => {
  const { root } = await fixture(t);
  await materializeGitHubPatLaunchers(root);
  const cwd = path.join(root, "repo");
  await fs.mkdir(cwd);
  const ambientConfig = path.join(root, "ambient.gitconfig");
  await fs.writeFile(ambientConfig, '[credential]\n helper = "!printf \'username=ambient\\npassword=wrong-token\\n\'"\n[user]\n name = Ambient User\n email = ambient@example.invalid\n');
  const env = { PATH: process.env.PATH, HOME: root, GR_GITHUB_TOKEN: token,
    GH_TOKEN: "wrong-token", GITHUB_TOKEN: "wrong-token", GIT_CONFIG_GLOBAL: ambientConfig,
    GIT_AUTHOR_NAME: "Ambient", GIT_AUTHOR_EMAIL: "ambient@example.invalid",
    PAPERCLIP_GITHUB_LAUNCHER_DIR: "/wrong/native-launcher", BASH_ENV: "/wrong/native-profile" };
  applyGitHubPatEnvironment(env, root, { repository: "GenRobo/approved", login: "fixture-owner", userId: 42 });
  const run = (args, options = {}) => spawnSync("git", args, { cwd, env, encoding: "utf8", timeout: 10_000, ...options });
  assert.equal(run(["init", "-q"]).status, 0);
  await fs.writeFile(path.join(cwd, "source.txt"), "committed source\n");
  assert.equal(run(["add", "source.txt"]).status, 0);
  const commit = run(["commit", "-qm", "isolated identity"]);
  assert.equal(commit.status, 0, commit.stderr);
  assert.equal(run(["log", "-1", "--format=%an|%ae|%cn|%ce"]).stdout.trim(), "fixture-owner|42+fixture-owner@users.noreply.github.com|fixture-owner|42+fixture-owner@users.noreply.github.com");
  const approved = run(["credential", "fill"], { input: "protocol=https\nhost=github.com\n\n" });
  assert.equal(approved.status, 0, approved.stderr);
  assert.match(approved.stdout, new RegExp(`password=${token}`));
  const otherHost = run(["credential", "fill"], { input: "protocol=https\nhost=example.invalid\n\n" });
  assert.notEqual(otherHost.status, 0);
  assert.equal(otherHost.stdout.includes(token), false);
  assert.equal(otherHost.stdout.includes("wrong-token"), false);
  const noToken = { PATH: env.PATH, HOME: root };
  const archive = run(["archive", "--format=tar", "HEAD"], { env: noToken, encoding: null });
  assert.equal(archive.status, 0, archive.stderr.toString());
  assert.ok(archive.stdout.includes(Buffer.from("committed source\n")));
  const shell = spawnSync("bash", ["-lc", "git log -1 --format=%ae"], { cwd, env, encoding: "utf8", timeout: 10_000 });
  assert.equal(shell.status, 0, shell.stderr);
  assert.equal(shell.stdout.trim(), "42+fixture-owner@users.noreply.github.com");
});
