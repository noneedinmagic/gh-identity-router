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

const rawConfig = {
  appId: 123,
  privateKeyPath: "/private/key.pem",
  defaultAccount: "example-user",
  accounts: {
    "example-user": {
      accountId: 1,
      installationId: 11,
      targetType: "User"
    },
    "example-org": {
      accountId: 2,
      installationId: 22,
      targetType: "Organization"
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
    config,
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
    config,
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
    config,
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
      config,
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
  type: "pat",
  accountId: 3,
  targetType: "Organization",
  tokenPath: "/private/example-org-two.token"
};

test("validateAccountEntry defaults absent type to app and accepts a PAT entry", () => {
  assert.deepEqual(validateAccountEntry("example-org", rawConfig.accounts["example-org"]), {
    type: "app",
    accountId: 2,
    installationId: 22,
    targetType: "Organization"
  });
  assert.deepEqual(validateAccountEntry("example-org-two", patAccountEntry), patAccountEntry);
});

test("validateAccountEntry rejects an unknown type, naming the account", () => {
  assert.throws(
    () => validateAccountEntry("example-org", { ...rawConfig.accounts["example-org"], type: "ssh" }),
    /Account example-org has unknown type: ssh/
  );
});

test("validateAccountEntry rejects an entry carrying the other type's fields", () => {
  assert.throws(
    () => validateAccountEntry("example-org", { ...rawConfig.accounts["example-org"], tokenPath: "/x" }),
    /Account example-org is app-typed and must not set tokenPath/
  );
  assert.throws(
    () => validateAccountEntry("example-org-two", { ...patAccountEntry, installationId: 99 }),
    /Account example-org-two is pat-typed and must not set installationId/
  );
});

test("validateConfig accepts a config with no App-typed account and no appId/privateKeyPath", () => {
  const purePatConfig = validateConfig({
    defaultAccount: "example-org-two",
    accounts: { "example-org-two": patAccountEntry }
  });

  assert.equal(purePatConfig.appId, undefined);
  assert.equal(purePatConfig.privateKeyPath, undefined);
  assert.equal(purePatConfig.accounts["example-org-two"].type, "pat");
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
  assert.equal(mixedConfig.accounts["example-org-two"].type, "pat");
  assert.equal(mixedConfig.appId, "123");
});

test("resolveAccount carries the type through for a PAT-typed account", () => {
  const mixedConfig = validateConfig({
    ...rawConfig,
    accounts: { ...rawConfig.accounts, "example-org-two": patAccountEntry }
  });

  assert.equal(resolveAccount(mixedConfig, { account: "example-org-two" }).type, "pat");
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
    { ...patAccountEntry, tokenPath },
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
    { ...patAccountEntry, tokenPath },
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
    { ...patAccountEntry, tokenPath },
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
    accounts: { "example-org-two": { ...patAccountEntry, tokenPath } }
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
    accounts: { "example-org-two": { ...patAccountEntry, tokenPath } }
  }), { mode: 0o600 });

  const result = spawnSync(process.execPath, [scriptPath, "--discover-installations"], {
    env: { ...process.env, MULTI_ACCOUNT_CONFIG: configPath },
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
    accounts: { "example-org-two": { ...patAccountEntry, tokenPath } }
  }), { mode: 0o600 });

  const result = spawnSync(
    process.execPath,
    [scriptPath, "--account", "example-org-two", "--repositories", "repo-a"],
    { env: { ...process.env, MULTI_ACCOUNT_CONFIG: configPath }, encoding: "utf8" }
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
