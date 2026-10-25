import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertPrivateFile,
  checkNodeVersion,
  classifyInstallations,
  createAppJwt,
  listAppInstallations,
  mintInstallationToken,
  parseArguments,
  parsePermissionsArgument,
  parseRepositoriesArgument,
  parseRepositoryOwner,
  readPatToken,
  resolveAccount,
  validateAccountEntry,
  validateAppConfig,
  validateConfig,
  verifyInstallations,
  verifyPatAccount
} from "../src/multi-account-token.mjs";

const appCredential = { type: "app", appId: 123, privateKeyPath: "/private/key.pem" };

const rawConfig = {
  defaultAccount: "example-user",
  accounts: {
    "example-user": {
      accountId: 1,
      targetType: "User",
      credential: { ...appCredential, installationId: 11 }
    },
    "example-org": {
      accountId: 2,
      targetType: "Organization",
      credential: { ...appCredential, installationId: 22 }
    }
  }
};

const config = validateConfig(rawConfig);

test("parses GitHub repository owners from supported forms", () => {
  assert.equal(parseRepositoryOwner("example-org/repo"), "example-org");
  assert.equal(parseRepositoryOwner("github.com/example-org/repo"), "example-org");
  assert.equal(parseRepositoryOwner("https://github.com/example-org/repo.git"), "example-org");
  assert.equal(parseRepositoryOwner("git@github.com:example-org/repo.git"), "example-org");
  assert.equal(parseRepositoryOwner("https://gitlab.com/example-org/repo"), null);
  assert.equal(parseRepositoryOwner("gitlab.com/example-org/repo"), null);
});

test("resolves selectors before the configured default", () => {
  assert.equal(resolveAccount(config, { repository: "example-org/repo" }).name, "example-org");
  assert.equal(resolveAccount(config, { remoteUrl: "https://github.com/example-org/repo.git" }).name, "example-org");
  assert.equal(resolveAccount(config, { environmentAccount: "example-org" }).name, "example-org");
  assert.equal(resolveAccount(config).name, "example-user");
});

test("rejects an owner detected from a repository when it is not allow-listed", () => {
  assert.throws(
    () => resolveAccount(config, { repository: "outsider/repo" }),
    /not allow-listed/
  );
});

test("fails closed on a --repo value missing the /repo segment, naming the string", () => {
  assert.throws(
    () => resolveAccount(config, { repository: "example-org" }),
    /Could not parse a GitHub owner from --repo: example-org/
  );
});

test("fails closed on a non-github.com remote URL, naming the string", () => {
  assert.throws(
    () => resolveAccount(config, { remoteUrl: "https://gitlab.com/example-org/repo" }),
    /Could not parse a GitHub owner from remote URL: https:\/\/gitlab\.com\/example-org\/repo/
  );
});

test("fails closed on a bare HOST/OWNER/REPO selector for a non-github.com host", () => {
  assert.throws(
    () => resolveAccount(config, { repository: "gitlab.com/example-org/repo" }),
    /Could not parse a GitHub owner from --repo: gitlab\.com\/example-org\/repo/
  );
});

test("redacts embedded credentials from an unparseable selector's error message", () => {
  assert.throws(
    () => resolveAccount(config, { remoteUrl: "https://x-access-token:ghp_secret@gitlab.com/example-org/repo" }),
    (error) => {
      assert.match(error.message, /Could not parse a GitHub owner from remote URL: https:\/\/gitlab\.com\/example-org\/repo/);
      assert.doesNotMatch(error.message, /ghp_secret/);
      assert.doesNotMatch(error.message, /x-access-token/);

      return true;
    }
  );
});

test("falls through to the next selector when repository/remoteUrl are simply absent", () => {
  assert.equal(
    resolveAccount(config, { repository: undefined, environmentAccount: "example-org" }).name,
    "example-org"
  );
});

test("validates account configuration", () => {
  assert.throws(
    () => validateConfig({ ...rawConfig, defaultAccount: "missing" }),
    /Default account is not allow-listed/
  );
  assert.throws(
    () => validateConfig({
      ...rawConfig,
      accounts: {
        ...rawConfig.accounts,
        "example-org": { ...rawConfig.accounts["example-org"], targetType: "Enterprise" }
      }
    }),
    /targetType must be User or Organization/
  );
});

test("creates a signed app JWT with the expected claims", () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwt = createAppJwt("123", privateKey, 1_000);
  const [header, payload, signature] = jwt.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());

  assert.equal(JSON.parse(Buffer.from(header, "base64url").toString()).alg, "RS256");
  assert.deepEqual(claims, { iat: 940, exp: 1540, iss: "123" });
  assert.equal(
    crypto.verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url")),
    true
  );
});

test("validates installation metadata before minting a token", async () => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const requests = [];
  const responses = [
    {
      id: 22,
      account: { id: 2, login: "example-org" },
      target_type: "Organization",
      suspended_at: null
    },
    { token: "installation-token" }
  ];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    const body = responses.shift();
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  const token = await mintInstallationToken({
    account: resolveAccount(config, { account: "example-org" }),
    privateKey,
    fetchImpl,
    apiUrl: "https://example.test"
  });

  assert.equal(token, "installation-token");
  assert.equal(requests[0].url, "https://example.test/app/installations/22");
  assert.equal(requests[1].options.method, "POST");
  assert.match(requests[0].options.headers.Authorization, /^Bearer /);
});

test("mints an unscoped token by default, with no request body", async () => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const requests = [];
  const responses = [
    {
      id: 22,
      account: { id: 2, login: "example-org" },
      target_type: "Organization",
      suspended_at: null
    },
    { token: "installation-token" }
  ];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    const body = responses.shift();
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  await mintInstallationToken({
    account: resolveAccount(config, { account: "example-org" }),
    privateKey,
    fetchImpl,
    apiUrl: "https://example.test"
  });

  assert.equal(requests[1].options.body, undefined);
});

test("mints a token scoped to repositories and permissions when requested", async () => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const requests = [];
  const responses = [
    {
      id: 22,
      account: { id: 2, login: "example-org" },
      target_type: "Organization",
      suspended_at: null
    },
    { token: "installation-token" }
  ];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    const body = responses.shift();
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  await mintInstallationToken({
    account: resolveAccount(config, { account: "example-org" }),
    privateKey,
    fetchImpl,
    apiUrl: "https://example.test",
    repositories: ["repo-a", "repo-b"],
    permissions: { contents: "write", pull_requests: "write" }
  });

  assert.deepEqual(JSON.parse(requests[1].options.body), {
    repositories: ["repo-a", "repo-b"],
    permissions: { contents: "write", pull_requests: "write" }
  });
  assert.equal(requests[1].options.headers["Content-Type"], "application/json");
});

test("parseRepositoriesArgument splits and trims a comma-separated list", () => {
  assert.deepEqual(parseRepositoriesArgument("repo-a, repo-b ,repo-c"), ["repo-a", "repo-b", "repo-c"]);
});

test("parseRepositoriesArgument rejects a value with no repository names", () => {
  assert.throws(() => parseRepositoriesArgument(" , "), /must list at least one repository name/);
});

test("parsePermissionsArgument splits key=value pairs and rejects malformed entries", () => {
  assert.deepEqual(
    parsePermissionsArgument("contents=write, pull_requests = write"),
    { contents: "write", pull_requests: "write" }
  );
  assert.throws(() => parsePermissionsArgument("contents"), /Invalid --permissions entry/);
  assert.throws(() => parsePermissionsArgument("=write"), /Invalid --permissions entry/);
});

test("parsePermissionsArgument rejects a value with no pairs", () => {
  assert.throws(() => parsePermissionsArgument(" , "), /must list at least one key=value pair/);
});

test("parseArguments wires --repositories and --permissions into the parsed result", () => {
  assert.deepEqual(
    parseArguments(["--repositories", "repo-a,repo-b", "--permissions", "contents=write"]),
    {
      verify: false,
      discoverInstallations: false,
      repositories: ["repo-a", "repo-b"],
      permissions: { contents: "write" }
    }
  );
});

test("parseArguments rejects an unknown flag rather than ignoring a typo", () => {
  assert.throws(() => parseArguments(["--repositorys", "repo-a"]), /Unknown argument: --repositorys/);
});

test("surfaces a GitHub API timeout through fail() with the URL named", async () => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const fetchImpl = async () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  };

  await assert.rejects(
    mintInstallationToken({
      account: resolveAccount(config, { account: "example-org" }),
      privateKey,
      fetchImpl,
      apiUrl: "https://example.test"
    }),
    /GitHub API request timed out after \d+ms: https:\/\/example\.test\/app\/installations\/22/
  );
});

test("reports configured problems and unexpected public installations", () => {
  const result = classifyInstallations(config, [
    {
      id: 11,
      account: { id: 1, login: "example-user" },
      target_type: "User",
      suspended_at: null
    },
    {
      id: 99,
      account: { id: 99, login: "outsider" },
      target_type: "Organization",
      suspended_at: null
    }
  ]);

  assert.deepEqual(result.valid, ["example-user"]);
  assert.deepEqual(result.problems, [
    { name: "example-org", reason: "configured installation was not returned by GitHub" }
  ]);
  assert.equal(result.unexpected[0].account.login, "outsider");
});

test("validates legacy app config for installation discovery", () => {
  assert.deepEqual(
    validateAppConfig({
      appId: 123,
      installationId: 11,
      privateKeyPath: "/private/key.pem"
    }),
    { appId: "123", privateKeyPath: "/private/key.pem" }
  );
});

test("requires private permissions for config and key files", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-account-private-"));
  const privateFile = path.join(tempDir, "private");

  fs.writeFileSync(privateFile, "fixture", { mode: 0o600 });
  assert.doesNotThrow(() => assertPrivateFile(privateFile, "Fixture"));
  fs.chmodSync(privateFile, 0o640);
  assert.throws(
    () => assertPrivateFile(privateFile, "Fixture"),
    /must not be readable or writable by group or others/
  );
});

test("lists all app installations for config discovery", async () => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    account: { id: index + 1, login: `account-${index + 1}` }
  }));
  const pages = [firstPage, [{ id: 101, account: { id: 101, login: "example-org" } }]];
  const requestedUrls = [];
  const fetchImpl = async (url) => {
    requestedUrls.push(url);
    return new Response(JSON.stringify(pages.shift()), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  const installations = await listAppInstallations({
    appConfig: { appId: "123", privateKeyPath: "/private/key.pem" },
    privateKey,
    fetchImpl,
    apiUrl: "https://example.test"
  });

  assert.equal(installations.length, 101);
  assert.equal(installations.at(-1).account.login, "example-org");
  assert.deepEqual(requestedUrls, [
    "https://example.test/app/installations?per_page=100&page=1",
    "https://example.test/app/installations?per_page=100&page=2"
  ]);
});

const patAccountEntry = {
  accountId: 3,
  targetType: "Organization",
  credential: { type: "pat", tokenPath: "/private/example-org-two.token" }
};

function patEntryAt(tokenPath, extra = {}) {
  return { ...patAccountEntry, credential: { type: "pat", tokenPath }, ...extra };
}

const exampleIdentity = { login: "example-agent", displayName: "Example Agent", kind: "agent" };

test("validateAccountEntry accepts a credential only, an identity only, or both", () => {
  const credentialOnly = validateAccountEntry("example-org", rawConfig.accounts["example-org"]);
  assert.deepEqual(credentialOnly, {
    accountId: 2,
    targetType: "Organization",
    host: "github.com",
    credential: { type: "app", appId: "123", privateKeyPath: "/private/key.pem", installationId: 22 }
  });

  const identityOnly = validateAccountEntry("example-org", { accountId: 2, targetType: "Organization", identity: exampleIdentity });
  assert.equal(identityOnly.credential, undefined);
  assert.deepEqual(identityOnly.identity, exampleIdentity);

  const both = validateAccountEntry("example-org", { ...rawConfig.accounts["example-org"], identity: exampleIdentity });
  assert.equal(both.credential.installationId, 22);
  assert.equal(both.identity.login, "example-agent");

  assert.deepEqual(validateAccountEntry("example-org-two", patAccountEntry).credential, patAccountEntry.credential);
});

test("validateAccountEntry rejects an entry with neither block", () => {
  assert.throws(
    () => validateAccountEntry("example-org", { accountId: 2, targetType: "Organization" }),
    /Account example-org needs a credential block, an identity block, or both/
  );
});

test("validateAccountEntry defaults identity.kind to agent and keeps footerHost absent vs empty distinct", () => {
  const absent = validateAccountEntry("example-org", { accountId: 2, targetType: "Organization", identity: { login: "a" } });
  const empty = validateAccountEntry("example-org", { accountId: 2, targetType: "Organization", identity: { login: "a", footerHost: "" } });

  assert.equal(absent.identity.kind, "agent");
  assert.equal("footerHost" in absent.identity, false);
  assert.equal(empty.identity.footerHost, "");
});

test("validateAccountEntry rejects bad identity fields", () => {
  const entry = (identity) => ({ accountId: 2, targetType: "Organization", identity });

  assert.throws(() => validateAccountEntry("o", entry({})), /identity field login must be a non-empty string/);
  assert.throws(() => validateAccountEntry("o", entry({ login: "a", kind: "robot" })), /identity kind must be agent or human/);
  assert.throws(() => validateAccountEntry("o", entry({ login: "a", footerhost: "x" })), /identity has unknown field: footerhost/);
  assert.throws(() => validateAccountEntry("o", entry({ login: "a", commitEmail: 5 })), /field commitEmail must be a string/);
});

test("validateAccountEntry rejects an unknown or mismatched credential type, naming the account", () => {
  const entry = (credential) => ({ accountId: 2, targetType: "Organization", credential });

  assert.throws(() => validateAccountEntry("example-org", entry({ type: "ssh" })), /Account example-org credential type must be app or pat, got: ssh/);
  assert.throws(() => validateAccountEntry("example-org", entry({})), /credential type must be app or pat/);
  assert.throws(
    () => validateAccountEntry("example-org", entry({ ...rawConfig.accounts["example-org"].credential, tokenPath: "/x" })),
    /credential \(type app\) has unknown field: tokenPath/
  );
  assert.throws(
    () => validateAccountEntry("example-org-two", entry({ ...patAccountEntry.credential, installationId: 99 })),
    /credential \(type pat\) has unknown field: installationId/
  );
  assert.throws(
    () => validateAccountEntry("example-org", entry({ type: "app", appId: 1, privateKeyPath: "/k" })),
    /credential field installationId must be a positive numeric ID/
  );
});

test("validateAccountEntry names the move for a pre-v0.1 flat entry rather than reporting no blocks", () => {
  assert.throws(
    () => validateAccountEntry("example-org", { type: "pat", accountId: 3, targetType: "Organization", tokenPath: "/x" }),
    /sets type, tokenPath directly on the entry; move them under a "credential" block/
  );
  assert.throws(
    () => validateConfig({ ...rawConfig, appId: 123, privateKeyPath: "/k" }),
    /top level; move them under each App account's credential block/
  );
});

test("validateAccountEntry accepts host github.com and rejects any other host", () => {
  assert.equal(validateAccountEntry("o", { ...patAccountEntry, host: "github.com" }).host, "github.com");
  assert.throws(() => validateAccountEntry("o", { ...patAccountEntry, host: "ghe.example.test" }), /host must be github\.com/);
});

test("validateConfig accepts a config with no App-typed account", () => {
  const purePatConfig = validateConfig({
    defaultAccount: "example-org-two",
    accounts: { "example-org-two": patAccountEntry }
  });

  assert.equal(purePatConfig.accounts["example-org-two"].credential.type, "pat");
});

test("validateConfig rejects a PAT-typed defaultAccount when an App-typed account exists", () => {
  assert.throws(
    () => validateConfig({
      ...rawConfig,
      defaultAccount: "example-org-two",
      accounts: { ...rawConfig.accounts, "example-org-two": patAccountEntry }
    }),
    /Default account must be app-typed/
  );
});

test("validateConfig accepts a mixed config with an App-typed defaultAccount", () => {
  const mixedConfig = validateConfig({
    ...rawConfig,
    accounts: { ...rawConfig.accounts, "example-org-two": patAccountEntry }
  });

  assert.equal(mixedConfig.defaultAccount, "example-user");
  assert.equal(mixedConfig.accounts["example-org-two"].credential.type, "pat");
});

test("resolveAccount carries the type through for a PAT-typed account", () => {
  const mixedConfig = validateConfig({
    ...rawConfig,
    accounts: { ...rawConfig.accounts, "example-org-two": patAccountEntry }
  });

  assert.equal(resolveAccount(mixedConfig, { account: "example-org-two" }).credential.type, "pat");
});

test("readPatToken reads and trims the token file, refusing a group-readable file", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-account-pat-"));
  const tokenPath = path.join(tempDir, "token");

  fs.writeFileSync(tokenPath, "github_pat_example\n", { mode: 0o600 });
  assert.equal(readPatToken({ tokenPath }), "github_pat_example");

  fs.chmodSync(tokenPath, 0o644);
  assert.throws(
    () => readPatToken({ tokenPath }),
    /must not be readable or writable by group or others/
  );
});

test("readPatToken rejects a classic PAT", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-account-pat-"));
  const tokenPath = path.join(tempDir, "token");

  fs.writeFileSync(tokenPath, "ghp_classicexample\n", { mode: 0o600 });

  assert.throws(
    () => readPatToken({ tokenPath }),
    /must be a fine-grained PAT/
  );
});

test("classifyInstallations does not report a PAT-typed account as a missing installation", () => {
  const mixedConfig = validateConfig({
    ...rawConfig,
    accounts: { ...rawConfig.accounts, "example-org-two": patAccountEntry }
  });

  const result = classifyInstallations(mixedConfig, []);

  assert.equal(result.problems.some((problem) => problem.name === "example-org-two"), false);
});

test("verifyPatAccount uses /rate_limit for liveness and cross-checks owner metadata", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-account-pat-"));
  const tokenPath = path.join(tempDir, "token");
  fs.writeFileSync(tokenPath, "github_pat_example", { mode: 0o600 });

  const requestedUrls = [];
  const fetchImpl = async (url) => {
    requestedUrls.push(url);
    if (url.endsWith("/rate_limit")) {
      return new Response("{}", { status: 200 });
    }
    return new Response(JSON.stringify({ id: 3, type: "Organization" }), { status: 200 });
  };

  const result = await verifyPatAccount(
    "example-org-two",
    patEntryAt(tokenPath),
    { fetchImpl, apiUrl: "https://example.test" }
  );

  assert.deepEqual(result, { name: "example-org-two", ok: true });
  assert.deepEqual(requestedUrls, [
    "https://example.test/rate_limit",
    "https://example.test/orgs/example-org-two"
  ]);
});

test("verifyPatAccount reports a dead token as invalid rather than falling through", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-account-pat-"));
  const tokenPath = path.join(tempDir, "token");
  fs.writeFileSync(tokenPath, "github_pat_example", { mode: 0o600 });

  const fetchImpl = async () => new Response("{}", { status: 401 });

  const result = await verifyPatAccount(
    "example-org-two",
    patEntryAt(tokenPath),
    { fetchImpl, apiUrl: "https://example.test" }
  );

  assert.deepEqual(result, { name: "example-org-two", ok: false, reason: "token is invalid or expired" });
});

test("verifyPatAccount reports an owner metadata mismatch", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-account-pat-"));
  const tokenPath = path.join(tempDir, "token");
  fs.writeFileSync(tokenPath, "github_pat_example", { mode: 0o600 });

  const fetchImpl = async (url) => {
    if (url.endsWith("/rate_limit")) {
      return new Response("{}", { status: 200 });
    }
    return new Response(JSON.stringify({ id: 999, type: "Organization" }), { status: 200 });
  };

  const result = await verifyPatAccount(
    "example-org-two",
    patEntryAt(tokenPath),
    { fetchImpl, apiUrl: "https://example.test" }
  );

  assert.deepEqual(result, {
    name: "example-org-two",
    ok: false,
    reason: "owner metadata does not match example-org-two"
  });
});

test("verifyInstallations combines App classification and PAT checks without crashing on a pure-PAT config", async () => {
  const tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-account-pat-"));
  const tokenPath = path.join(tokenDir, "token");
  fs.writeFileSync(tokenPath, "github_pat_example", { mode: 0o600 });

  const purePatConfig = validateConfig({
    defaultAccount: "example-org-two",
    accounts: { "example-org-two": patEntryAt(tokenPath) }
  });

  const fetchImpl = async (url) => {
    if (url.endsWith("/rate_limit")) {
      return new Response("{}", { status: 200 });
    }
    return new Response(JSON.stringify({ id: 3, type: "Organization" }), { status: 200 });
  };

  const result = await verifyInstallations({
    config: purePatConfig,
    privateKey: undefined,
    fetchImpl,
    apiUrl: "https://example.test"
  });

  assert.deepEqual(result, { valid: ["example-org-two"], problems: [], unexpected: [] });
});

test("--discover-installations fails cleanly on a config with no App", () => {
  const scriptPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../src/multi-account-token.mjs"
  );
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-account-discover-"));
  const configPath = path.join(tempDir, "config.json");
  const tokenPath = path.join(tempDir, "example-org-two.token");

  fs.writeFileSync(tokenPath, "github_pat_example", { mode: 0o600 });
  fs.writeFileSync(configPath, JSON.stringify({
    defaultAccount: "example-org-two",
    accounts: { "example-org-two": patEntryAt(tokenPath) }
  }), { mode: 0o600 });

  const result = spawnSync(process.execPath, [scriptPath, "--discover-installations"], {
    env: { ...process.env, IDENTITY_ROUTER_CONFIG: configPath },
    encoding: "utf8"
  });

  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /appId must be a positive numeric ID/);
});

test("--repositories/--permissions on a PAT-typed account fails rather than minting unscoped", () => {
  const scriptPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../src/multi-account-token.mjs"
  );
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-account-pat-cli-"));
  const configPath = path.join(tempDir, "config.json");
  const tokenPath = path.join(tempDir, "example-org-two.token");

  fs.writeFileSync(tokenPath, "github_pat_example", { mode: 0o600 });
  fs.writeFileSync(configPath, JSON.stringify({
    defaultAccount: "example-org-two",
    accounts: { "example-org-two": patEntryAt(tokenPath) }
  }), { mode: 0o600 });

  const result = spawnSync(
    process.execPath,
    [scriptPath, "--account", "example-org-two", "--repositories", "repo-a"],
    { env: { ...process.env, IDENTITY_ROUTER_CONFIG: configPath }, encoding: "utf8" }
  );

  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /pat-typed; --repositories\/--permissions only narrow/);
});

test("checkNodeVersion accepts versions at or above the minimum", () => {
  assert.equal(checkNodeVersion("20.0.0", 20), null);
  assert.equal(checkNodeVersion("22.5.1", 20), null);
});

test("checkNodeVersion rejects unsupported major versions with a clear message", () => {
  const message = checkNodeVersion("18.19.0", 20);

  assert.match(message, /requires Node\.js >=20/);
  assert.match(message, /18\.19\.0/);
});

test("resolveAccount with allowDefault: false refuses to fall back to defaultAccount", () => {
  assert.throws(
    () => resolveAccount(config, {}, { allowDefault: false }),
    /No GitHub owner could be resolved/
  );
  assert.equal(resolveAccount(config, { repository: "example-org/repo" }, { allowDefault: false }).name, "example-org");
});

test("validateConfig accepts an identity-only default account", () => {
  const identityOnlyDefault = {
    defaultAccount: "example-org-two",
    accounts: { ...rawConfig.accounts, "example-org-two": { accountId: 3, targetType: "Organization", identity: exampleIdentity } }
  };

  assert.equal(validateConfig(identityOnlyDefault).defaultAccount, "example-org-two");
});

test("mints with the App of the account's own credential block, not a shared one", async () => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const otherApp = validateConfig({
    defaultAccount: "example-org",
    accounts: {
      "example-org": {
        accountId: 2,
        targetType: "Organization",
        credential: { type: "app", appId: 777, privateKeyPath: "/other/key.pem", installationId: 22 }
      }
    }
  });
  const jwts = [];
  const responses = [
    { id: 22, account: { id: 2, login: "example-org" }, target_type: "Organization", suspended_at: null },
    { token: "installation-token" }
  ];
  const fetchImpl = async (url, options) => {
    jwts.push(options.headers.Authorization.replace("Bearer ", ""));
    return new Response(JSON.stringify(responses.shift()), { status: 200 });
  };

  await mintInstallationToken({
    account: resolveAccount(otherApp, { account: "example-org" }),
    privateKey,
    fetchImpl,
    apiUrl: "https://example.test"
  });

  assert.equal(JSON.parse(Buffer.from(jwts[0].split(".")[1], "base64url").toString()).iss, "777");
});

test("validateConfig rejects one App configured with two different key paths", () => {
  const entry = (installationId, privateKeyPath) => ({
    accountId: installationId,
    targetType: "Organization",
    credential: { type: "app", appId: 100, privateKeyPath, installationId }
  });

  assert.throws(
    () => validateConfig({
      defaultAccount: "example-user",
      accounts: { "example-user": entry(11, "/keys/a.pem"), "example-org": entry(22, "/keys/copy-of-a.pem") }
    }),
    /App 100 has two privateKeyPath values/
  );
});

test("verifyInstallations lists and classifies installations once per distinct App", async () => {
  const twoApps = validateConfig({
    defaultAccount: "example-user",
    accounts: {
      "example-user": {
        accountId: 1,
        targetType: "User",
        credential: { type: "app", appId: 100, privateKeyPath: "/keys/a.pem", installationId: 11 }
      },
      "example-org": {
        accountId: 2,
        targetType: "Organization",
        credential: { type: "app", appId: 200, privateKeyPath: "/keys/b.pem", installationId: 22 }
      }
    }
  });
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const loadedKeys = [];
  const installationsByApp = {
    100: [
      { id: 11, account: { id: 1, login: "example-user" }, target_type: "User", suspended_at: null },
      { id: 55, account: { id: 5, login: "stranger" }, target_type: "User", suspended_at: null }
    ],
    200: [{ id: 22, account: { id: 2, login: "example-org" }, target_type: "Organization", suspended_at: null }]
  };
  const fetchImpl = async (url, options) => {
    const iss = JSON.parse(Buffer.from(options.headers.Authorization.split(".")[1], "base64url").toString()).iss;

    return new Response(JSON.stringify(installationsByApp[iss]), { status: 200 });
  };

  const result = await verifyInstallations({
    config: twoApps,
    fetchImpl,
    apiUrl: "https://example.test",
    loadKey: (keyPath) => {
      loadedKeys.push(keyPath);

      return privateKey;
    }
  });

  assert.deepEqual(loadedKeys.sort(), ["/keys/a.pem", "/keys/b.pem"]);
  assert.deepEqual(result.valid.sort(), ["example-org", "example-user"]);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.unexpected.map((installation) => installation.id), [55]);
});

test("verifyPatAccount checks the token acts as the declared identity.login", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-account-pat-"));
  const tokenPath = path.join(tempDir, "token");
  fs.writeFileSync(tokenPath, "github_pat_example", { mode: 0o600 });

  const entry = patEntryAt(tokenPath, { identity: { login: "example-machine", kind: "agent" } });
  const fetchFor = (actingLogin) => async (url) => {
    if (url.endsWith("/user")) {
      return new Response(JSON.stringify({ login: actingLogin }), { status: 200 });
    }

    return new Response(JSON.stringify({ id: 3, type: "Organization" }), { status: 200 });
  };

  assert.deepEqual(
    await verifyPatAccount("example-org-two", entry, { fetchImpl: fetchFor("Example-Machine"), apiUrl: "https://example.test" }),
    { name: "example-org-two", ok: true }
  );
  assert.deepEqual(
    await verifyPatAccount("example-org-two", entry, { fetchImpl: fetchFor("someone-else"), apiUrl: "https://example.test" }),
    {
      name: "example-org-two",
      ok: false,
      reason: "token acts as someone-else, not the declared identity.login example-machine"
    }
  );
});

test("config.example.json validates, covering credential-only, identity-only, and both", () => {
  const examplePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../config.example.json");
  const example = validateConfig(JSON.parse(fs.readFileSync(examplePath, "utf8")));

  assert.ok(example.accounts["your-user"].credential && example.accounts["your-user"].identity);
  assert.equal(example.accounts["your-org"].identity, undefined);
  assert.equal(example.accounts["identity-only-org"].credential, undefined);
  assert.equal(example.accounts["contractor-org"].identity.footerHost, "");
});
