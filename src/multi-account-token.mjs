#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API_VERSION = "2022-11-28";
const DEFAULT_API_URL = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 10_000;
const MIN_NODE_MAJOR = 20;

export function checkNodeVersion(nodeVersion, minMajor = MIN_NODE_MAJOR) {
  const major = Number.parseInt(String(nodeVersion).split(".")[0], 10);

  if (Number.isNaN(major) || major < minMajor) {
    return `gh-identity-router requires Node.js >=${minMajor}, found ${nodeVersion}`;
  }

  return null;
}

function fail(message) {
  throw new Error(message);
}

function normalizeAccount(value) {
  if (typeof value !== "string" || !value.trim()) {
    fail("Account name must be a non-empty string");
  }

  return value.trim().toLowerCase();
}

export function parseRepositoryOwner(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  let candidate = value.trim();

  if (candidate.startsWith("git@github.com:")) {
    candidate = candidate.slice("git@github.com:".length);
  } else {
    try {
      const url = new URL(candidate);

      if (url.hostname.toLowerCase() !== "github.com") {
        return null;
      }

      candidate = url.pathname;
    } catch {
      // gh accepts OWNER/REPO and HOST/OWNER/REPO in addition to URLs.
    }
  }

  const parts = candidate
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "")
    .split("/")
    .filter(Boolean);

  if (parts.length < 2) {
    return null;
  }

  return normalizeAccount(parts.at(-2));
}

export function validateAppConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    fail("Config must be a JSON object");
  }

  if (!config.appId || !String(config.appId).match(/^\d+$/)) {
    fail("Config field appId must be a positive numeric ID");
  }

  if (typeof config.privateKeyPath !== "string" || !config.privateKeyPath) {
    fail("Config field privateKeyPath must be a non-empty path");
  }

  return {
    appId: String(config.appId),
    privateKeyPath: config.privateKeyPath
  };
}

export function assertPrivateFile(filePath, label) {
  let stat;

  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    fail(`Failed to inspect ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!stat.isFile()) {
    fail(`${label} must be a regular file`);
  }

  if ((stat.mode & 0o077) !== 0) {
    fail(`${label} must not be readable or writable by group or others`);
  }
}

const ACCOUNT_TYPES = ["app", "pat"];

export function validateAccountEntry(name, rawEntry) {
  if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
    fail(`Account ${name} must be an object`);
  }

  const type = rawEntry.type === undefined ? "app" : rawEntry.type;

  if (!ACCOUNT_TYPES.includes(type)) {
    fail(`Account ${name} has unknown type: ${rawEntry.type}`);
  }

  if (!rawEntry.accountId || !String(rawEntry.accountId).match(/^\d+$/)) {
    fail(`Account ${name} field accountId must be a positive numeric ID`);
  }

  if (!["User", "Organization"].includes(rawEntry.targetType)) {
    fail(`Account ${name} targetType must be User or Organization`);
  }

  if (type === "app") {
    if (rawEntry.tokenPath !== undefined) {
      fail(`Account ${name} is app-typed and must not set tokenPath`);
    }

    if (!rawEntry.installationId || !String(rawEntry.installationId).match(/^\d+$/)) {
      fail(`Account ${name} field installationId must be a positive numeric ID`);
    }

    return {
      type,
      accountId: Number(rawEntry.accountId),
      installationId: Number(rawEntry.installationId),
      targetType: rawEntry.targetType
    };
  }

  if (rawEntry.installationId !== undefined) {
    fail(`Account ${name} is pat-typed and must not set installationId`);
  }

  if (typeof rawEntry.tokenPath !== "string" || !rawEntry.tokenPath) {
    fail(`Account ${name} field tokenPath must be a non-empty path`);
  }

  return {
    type,
    accountId: Number(rawEntry.accountId),
    targetType: rawEntry.targetType,
    tokenPath: rawEntry.tokenPath
  };
}

export function validateConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    fail("Config must be a JSON object");
  }

  if (!config.accounts || typeof config.accounts !== "object" || Array.isArray(config.accounts)) {
    fail("Config field accounts must be an object");
  }

  const accounts = {};

  for (const [rawName, rawEntry] of Object.entries(config.accounts)) {
    const name = normalizeAccount(rawName);

    if (name !== rawName) {
      fail(`Account key must be normalized to lowercase: ${rawName}`);
    }

    accounts[name] = validateAccountEntry(name, rawEntry);
  }

  const hasAppAccount = Object.values(accounts).some((entry) => entry.type === "app");
  const appConfig = hasAppAccount ? validateAppConfig(config) : {};
  const defaultAccount = normalizeAccount(config.defaultAccount);

  if (!accounts[defaultAccount]) {
    fail(`Default account is not allow-listed: ${defaultAccount}`);
  }

  if (hasAppAccount && accounts[defaultAccount].type !== "app") {
    fail(`Default account must be app-typed while the config also has an app-typed account: ${defaultAccount}`);
  }

  return {
    ...appConfig,
    defaultAccount,
    accounts
  };
}

export function readPatToken(account) {
  const label = account.name ? `PAT token for ${account.name}` : "PAT token";

  assertPrivateFile(account.tokenPath, label);

  const token = fs.readFileSync(account.tokenPath, "utf8").trim();

  if (!token.startsWith("github_pat_")) {
    fail(`${label} must be a fine-grained PAT (github_pat_...); classic and other token types are not supported`);
  }

  return token;
}

export function resolveAccount(config, selectors = {}) {
  const explicitAccount = selectors.account ? normalizeAccount(selectors.account) : null;
  const repositoryOwner = parseRepositoryOwner(selectors.repository);
  const remoteOwner = parseRepositoryOwner(selectors.remoteUrl);
  const environmentAccount = selectors.environmentAccount
    ? normalizeAccount(selectors.environmentAccount)
    : null;
  const selected = explicitAccount
    ?? repositoryOwner
    ?? remoteOwner
    ?? environmentAccount
    ?? config.defaultAccount;

  if (!config.accounts[selected]) {
    fail(`GitHub account is not allow-listed: ${selected}`);
  }

  return { name: selected, ...config.accounts[selected] };
}

export function createAppJwt(appId, privateKey, now = Math.floor(Date.now() / 1000)) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = [
    encode({ alg: "RS256", typ: "JWT" }),
    encode({ iat: now - 60, exp: now + (9 * 60), iss: String(appId) })
  ].join(".");
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), privateKey);

  return `${unsigned}.${signature.toString("base64url")}`;
}

async function timedFetch(fetchImpl, url, bearerToken, options = {}) {
  try {
    return await fetchImpl(url, {
      ...options,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${bearerToken}`,
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": "gh-multi-account-credentials",
        ...options.headers
      }
    });
  } catch (error) {
    if (error.name === "TimeoutError") {
      fail(`GitHub API request timed out after ${REQUEST_TIMEOUT_MS}ms: ${url}`);
    }
    throw error;
  }
}

async function githubRequest(fetchImpl, apiUrl, appJwt, pathname, options = {}) {
  const url = `${apiUrl}${pathname}`;
  const response = await timedFetch(fetchImpl, url, appJwt, options);

  if (!response.ok) {
    const body = await response.text();
    fail(`GitHub API request failed: ${response.status} ${response.statusText}${body ? `: ${body}` : ""}`);
  }

  return response;
}

export async function verifyPatAccount(name, account, { fetchImpl = fetch, apiUrl = DEFAULT_API_URL } = {}) {
  try {
    const token = readPatToken({ ...account, name });
    const rateLimitResponse = await timedFetch(fetchImpl, `${apiUrl}/rate_limit`, token);

    if (!rateLimitResponse.ok) {
      return {
        name,
        ok: false,
        reason: rateLimitResponse.status === 401
          ? "token is invalid or expired"
          : `token liveness check failed: ${rateLimitResponse.status} ${rateLimitResponse.statusText}`
      };
    }

    const ownerPath = account.targetType === "Organization" ? `/orgs/${name}` : `/users/${name}`;
    const ownerResponse = await timedFetch(fetchImpl, `${apiUrl}${ownerPath}`, token);

    if (!ownerResponse.ok) {
      return {
        name,
        ok: false,
        reason: `owner lookup failed: ${ownerResponse.status} ${ownerResponse.statusText}`
      };
    }

    const owner = await ownerResponse.json();

    if (Number(owner.id) !== account.accountId || owner.type !== account.targetType) {
      return { name, ok: false, reason: `owner metadata does not match ${name}` };
    }

    return { name, ok: true };
  } catch (error) {
    return { name, ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function mintInstallationToken({
  config,
  account,
  privateKey,
  fetchImpl = fetch,
  apiUrl = DEFAULT_API_URL,
  repositories,
  permissions
}) {
  const appJwt = createAppJwt(config.appId, privateKey);
  const installationResponse = await githubRequest(
    fetchImpl,
    apiUrl,
    appJwt,
    `/app/installations/${account.installationId}`
  );
  const installation = await installationResponse.json();
  const actualLogin = normalizeAccount(installation.account?.login ?? "");

  if (Number(installation.account?.id) !== account.accountId) {
    fail(`Installation ${account.installationId} account ID does not match ${account.name}`);
  }

  if (actualLogin !== account.name) {
    fail(`Installation ${account.installationId} belongs to ${actualLogin}, not ${account.name}`);
  }

  if (installation.target_type !== account.targetType) {
    fail(`Installation ${account.installationId} target type does not match ${account.name}`);
  }

  if (installation.suspended_at) {
    fail(`Installation ${account.installationId} for ${account.name} is suspended`);
  }

  const scope = {};

  if (repositories) {
    scope.repositories = repositories;
  }

  if (permissions) {
    scope.permissions = permissions;
  }

  const tokenResponse = await githubRequest(
    fetchImpl,
    apiUrl,
    appJwt,
    `/app/installations/${account.installationId}/access_tokens`,
    Object.keys(scope).length
      ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(scope) }
      : { method: "POST" }
  );
  const tokenData = await tokenResponse.json();

  if (!tokenData.token) {
    fail("GitHub response did not contain an installation token");
  }

  return tokenData.token;
}

export function classifyInstallations(config, installations) {
  const appAccounts = Object.entries(config.accounts).filter(([, entry]) => entry.type === "app");
  const configuredById = new Map(
    appAccounts.map(([name, entry]) => [entry.installationId, { name, ...entry }])
  );
  const seen = new Set();
  const valid = [];
  const problems = [];
  const unexpected = [];

  for (const installation of installations) {
    const configured = configuredById.get(Number(installation.id));

    if (!configured) {
      unexpected.push(installation);
      continue;
    }

    seen.add(configured.name);
    const login = String(installation.account?.login ?? "").toLowerCase();
    const mismatch = Number(installation.account?.id) !== configured.accountId
      || login !== configured.name
      || installation.target_type !== configured.targetType;

    if (mismatch) {
      problems.push({ name: configured.name, reason: "installation metadata mismatch" });
    } else if (installation.suspended_at) {
      problems.push({ name: configured.name, reason: "installation is suspended" });
    } else {
      valid.push(configured.name);
    }
  }

  for (const [name] of appAccounts) {
    if (!seen.has(name)) {
      problems.push({ name, reason: "configured installation was not returned by GitHub" });
    }
  }

  return { valid, problems, unexpected };
}

export async function listAppInstallations({
  appConfig,
  privateKey,
  fetchImpl = fetch,
  apiUrl = DEFAULT_API_URL
}) {
  const appJwt = createAppJwt(appConfig.appId, privateKey);
  const installations = [];

  for (let page = 1; ; page += 1) {
    const response = await githubRequest(
      fetchImpl,
      apiUrl,
      appJwt,
      `/app/installations?per_page=100&page=${page}`
    );
    const pageItems = await response.json();

    if (!Array.isArray(pageItems)) {
      fail("GitHub installations response was not an array");
    }

    installations.push(...pageItems);

    if (pageItems.length < 100) {
      break;
    }
  }

  return installations;
}

export async function verifyInstallations({ config, privateKey, fetchImpl = fetch, apiUrl = DEFAULT_API_URL }) {
  const hasAppAccount = Object.values(config.accounts).some((entry) => entry.type === "app");
  const classification = hasAppAccount
    ? classifyInstallations(
      config,
      await listAppInstallations({ appConfig: config, privateKey, fetchImpl, apiUrl })
    )
    : { valid: [], problems: [], unexpected: [] };

  const patAccounts = Object.entries(config.accounts).filter(([, entry]) => entry.type === "pat");
  const patResults = await Promise.all(
    patAccounts.map(([name, entry]) => verifyPatAccount(name, entry, { fetchImpl, apiUrl }))
  );

  const valid = [...classification.valid];
  const problems = [...classification.problems];

  for (const result of patResults) {
    if (result.ok) {
      valid.push(result.name);
    } else {
      problems.push({ name: result.name, reason: result.reason });
    }
  }

  return { valid, problems, unexpected: classification.unexpected };
}

export function parseRepositoriesArgument(value) {
  const repositories = value.split(",").map((entry) => entry.trim()).filter(Boolean);

  if (repositories.length === 0) {
    fail(`--repositories must list at least one repository name: ${value}`);
  }

  return repositories;
}

export function parsePermissionsArgument(value) {
  const permissions = {};
  const entries = value.split(",").map((item) => item.trim()).filter(Boolean);

  if (entries.length === 0) {
    fail(`--permissions must list at least one key=value pair: ${value}`);
  }

  for (const entry of entries) {
    const separatorIndex = entry.indexOf("=");
    const key = separatorIndex > 0 ? entry.slice(0, separatorIndex).trim() : "";
    const permissionValue = separatorIndex > 0 ? entry.slice(separatorIndex + 1).trim() : "";

    if (!key || !permissionValue) {
      fail(`Invalid --permissions entry (expected key=value): ${entry}`);
    }

    permissions[key] = permissionValue;
  }

  return permissions;
}

export function parseArguments(argv) {
  const result = { verify: false, discoverInstallations: false };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--verify") {
      result.verify = true;
    } else if (argument === "--discover-installations") {
      result.discoverInstallations = true;
    } else if (argument === "--repositories") {
      const value = argv[index + 1];

      if (!value) {
        fail(`Missing value for ${argument}`);
      }

      result.repositories = parseRepositoriesArgument(value);
      index += 1;
    } else if (argument === "--permissions") {
      const value = argv[index + 1];

      if (!value) {
        fail(`Missing value for ${argument}`);
      }

      result.permissions = parsePermissionsArgument(value);
      index += 1;
    } else if (["--org", "--account", "--repo", "--remote-url"].includes(argument)) {
      const value = argv[index + 1];

      if (!value) {
        fail(`Missing value for ${argument}`);
      }

      const key = {
        "--org": "account",
        "--account": "account",
        "--repo": "repository",
        "--remote-url": "remoteUrl"
      }[argument];
      result[key] = value;
      index += 1;
    } else {
      fail(`Unknown argument: ${argument}`);
    }
  }

  return result;
}

function readJsonConfig(configPath) {
  let rawConfig;

  try {
    rawConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    fail(`Failed to read config ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  return rawConfig;
}

function readPrivateKey(privateKeyPath) {
  try {
    return fs.readFileSync(privateKeyPath, "utf8");
  } catch (error) {
    fail(`Failed to read private key: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const configPath = process.env.MULTI_ACCOUNT_CONFIG
    ?? path.join(os.homedir(), ".config", "gh-multi-account", "config.json");
  const rawConfig = readJsonConfig(configPath);
  assertPrivateFile(configPath, "Config file");

  if (args.discoverInstallations) {
    const appConfig = validateAppConfig(rawConfig);
    assertPrivateFile(appConfig.privateKeyPath, "Private key");
    const privateKey = readPrivateKey(appConfig.privateKeyPath);
    const installations = await listAppInstallations({ appConfig, privateKey });
    const header = [
      "LOGIN",
      "ACCOUNT_ID",
      "INSTALLATION_ID",
      "TARGET_TYPE",
      "REPOSITORY_SELECTION",
      "STATE"
    ];
    process.stdout.write(`${header.join("\t")}\n`);

    for (const installation of installations.sort((left, right) => {
      return String(left.account?.login ?? "").localeCompare(String(right.account?.login ?? ""));
    })) {
      const row = [
        installation.account?.login ?? "unknown",
        installation.account?.id ?? "unknown",
        installation.id ?? "unknown",
        installation.target_type ?? "unknown",
        installation.repository_selection ?? "unknown",
        installation.suspended_at ? "suspended" : "active"
      ];
      process.stdout.write(`${row.join("\t")}\n`);
    }

    return;
  }

  const config = validateConfig(rawConfig);
  const hasAppAccount = Object.values(config.accounts).some((entry) => entry.type === "app");
  let privateKey;

  if (hasAppAccount) {
    assertPrivateFile(config.privateKeyPath, "Private key");
    privateKey = readPrivateKey(config.privateKeyPath);
  }

  if (args.verify) {
    const result = await verifyInstallations({ config, privateKey });

    for (const name of result.valid.sort()) {
      process.stdout.write(`OK ${name}\n`);
    }

    for (const problem of result.problems) {
      process.stdout.write(`ERROR ${problem.name}: ${problem.reason}\n`);
    }

    for (const installation of result.unexpected) {
      const login = installation.account?.login ?? "unknown";
      process.stdout.write(`ERROR unexpected installation: ${login} (${installation.id})\n`);
    }

    if (result.problems.length || result.unexpected.length) {
      process.exitCode = 1;
    }

    return;
  }

  const account = resolveAccount(config, {
    ...args,
    environmentAccount: process.env.MULTI_ACCOUNT_ORG
  });

  if (account.type === "pat" && (args.repositories || args.permissions)) {
    fail(`Account ${account.name} is pat-typed; --repositories/--permissions only narrow an App installation token`);
  }

  const token = account.type === "pat"
    ? readPatToken(account)
    : await mintInstallationToken({
      config,
      account,
      privateKey,
      repositories: args.repositories,
      permissions: args.permissions
    });
  process.stdout.write(token);
}

const isEntrypoint = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isEntrypoint) {
  const nodeVersionError = checkNodeVersion(process.versions.node);

  if (nodeVersionError) {
    process.stderr.write(`${nodeVersionError}\n`);
    process.exit(1);
  }

  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
