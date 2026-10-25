// `gh-identity-router setup | uninstall`: installs the wrappers under ~/.local, points
// Git's github.com credential helper at them, and generates the per-owner commit-author
// `includeIf` fragments. Every setup takes a backup first; `uninstall` restores the one
// taken by the first setup, i.e. the state before this tool touched anything.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { checkNodeVersion, loadRawConfig, validateConfig } from "./multi-account-token.mjs";

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUBPROCESS_TIMEOUT_MS = 30_000;
// Live verification makes several GitHub API calls; each already has its own timeout.
const VERIFY_TIMEOUT_MS = 300_000;
const MANIFEST = "gh-identity-router-backup-v1";
const LEGACY_MANIFEST = "gh-multi-account-backup-v1";
const GIT_KEYS = {
  helper: "credential.https://github.com.helper",
  username: "credential.https://github.com.username",
  "use-http-path": "credential.https://github.com.useHttpPath"
};

const USAGE = `Usage: gh-identity-router setup [--dry-run | --verify] [--node PATH]
       gh-identity-router uninstall [--backup DIR]`;

class UsageError extends Error {}

function fail(message) {
  throw new Error(message);
}

function layout(home) {
  const share = path.join(home, ".local", "share", "gh-identity-router");
  return {
    home,
    bin: path.join(home, ".local", "bin"),
    share,
    gitDir: path.join(share, "git"),
    legacyShare: path.join(home, ".local", "share", "gh-multi-account"),
    state: path.join(home, ".local", "state", "gh-identity-router"),
    legacyState: path.join(home, ".local", "state", "gh-multi-account")
  };
}

// `src` is a path inside the package; a target without one is generated (the launcher).
// `legacy` is where a pre-rename backup put the target; `legacyOptional` targets were
// added after backup format v1 shipped, so older backups have no state for them and
// restore treats that as "was absent".
// ponytail: a damaged new backup missing these entries also reads as absent; add a
// per-backup target list to the manifest if that ever matters.
function targets(l) {
  return [
    { name: "bin-gh", path: path.join(l.bin, "gh"), src: "bin/gh", mode: 0o755 },
    { name: "bin-token", path: path.join(l.bin, "multi-account-token"), mode: 0o755 },
    {
      name: "bin-credential",
      path: path.join(l.bin, "git-credential-gh-identity-router"),
      src: "bin/git-credential-gh-identity-router",
      mode: 0o755,
      legacy: path.join(l.bin, "multi-account-git-credential")
    },
    { name: "bin-mint-dispatch-token", path: path.join(l.bin, "mint-dispatch-token"), src: "bin/mint-dispatch-token", mode: 0o755 },
    {
      name: "share-token",
      path: path.join(l.share, "multi-account-token.mjs"),
      src: "src/multi-account-token.mjs",
      mode: 0o755,
      legacy: path.join(l.legacyShare, "multi-account-token.mjs")
    },
    {
      name: "share-example",
      path: path.join(l.share, "config.example.json"),
      src: "config.example.json",
      mode: 0o644,
      legacy: path.join(l.legacyShare, "config.example.json")
    },
    { name: "bin-identity", path: path.join(l.bin, "identity.sh"), src: "bin/identity.sh", mode: 0o755, legacyOptional: true },
    {
      name: "share-identity",
      path: path.join(l.share, "identity.mjs"),
      src: "src/identity.mjs",
      mode: 0o644,
      legacy: path.join(l.legacyShare, "identity.mjs"),
      legacyOptional: true
    }
  ];
}

const exists = (p) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

// Keeps symlinks as symlinks and file modes, like the `cp -a` this replaces.
function copyEntry(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.rmSync(to, { force: true });

  if (fs.lstatSync(from).isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(from), to);
  } else {
    fs.copyFileSync(from, to);
  }
}

// Writes beside the destination and renames, so a reader never sees a half-written wrapper.
function installFile(dest, mode, { from, text }) {
  const tmp = `${dest}.tmp-${process.pid}`;

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (text === undefined) {
    fs.copyFileSync(from, tmp);
  } else {
    fs.writeFileSync(tmp, text);
  }
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, dest);
}

function git(args, okStatuses = [0]) {
  const result = spawnSync("git", args, { encoding: "utf8", timeout: SUBPROCESS_TIMEOUT_MS });

  if (result.error || !okStatuses.includes(result.status)) {
    fail(`git ${args.join(" ")} failed: ${result.error?.message ?? result.stderr.trim()}`);
  }

  return result.stdout;
}

const gitGlobal = (args, okStatuses) => git(["config", "--global", ...args], okStatuses);
const splitNul = (text) => text.split("\0").slice(0, -1);
const escapeRegex = (text) => text.replace(/[.[\]{}()*+?^$|\\]/g, "\\$&");

// ---- node ---------------------------------------------------------------------

// The launcher bakes this path in, so check it here, up front, instead of letting a
// missing or old node surface later as an `env: node: ...` error from inside a wrapper.
export function checkNode(nodePath) {
  const hint = "pass --node with the absolute path of a working Node.js >=20";

  if (!path.isAbsolute(nodePath)) {
    fail(`Node path must be absolute, got: ${nodePath}`);
  }

  const result = spawnSync(nodePath, ["-p", "process.versions.node"], {
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT_MS
  });

  if (result.error) {
    fail(`Cannot run Node.js at ${nodePath}: ${result.error.message}; ${hint}`);
  }

  if (result.status !== 0) {
    fail(`Node.js at ${nodePath} exited with status ${result.status}: ${result.stderr.trim()}; ${hint}`);
  }

  const versionError = checkNodeVersion(result.stdout.trim());

  if (versionError) {
    fail(`${versionError} (at ${nodePath}); ${hint}`);
  }
}

const shellQuote = (text) => `'${text.replaceAll("'", "'\\''")}'`;

function launcherText(nodePath, script) {
  return `#!/bin/sh\nexec ${shellQuote(nodePath)} ${shellQuote(script)} "$@"\n`;
}

function bakedNode(launcherPath) {
  const match = /^exec '((?:[^']|'\\'')*)' /m.exec(fs.readFileSync(launcherPath, "utf8"));

  if (!match) {
    fail(`${launcherPath} was not generated by setup; no node path found in it`);
  }

  return match[1].replaceAll("'\\''", "'");
}

// ---- gh on PATH ---------------------------------------------------------------

// Returns null when the first `gh` on PATH is the installed wrapper, else why not.
export function checkGhOnPath(wrapper, pathVar = process.env.PATH ?? "") {
  for (const dir of pathVar.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, "gh");

    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (!fs.statSync(candidate).isFile()) {
        continue;
      }
    } catch {
      continue;
    }

    return fs.realpathSync(candidate) === fs.realpathSync(wrapper)
      ? null
      : `\`gh\` on PATH resolves to ${candidate}, not the installed wrapper ${wrapper}; put ${path.dirname(wrapper)} before ${dir} in PATH`;
  }

  return `no \`gh\` on PATH; add ${path.dirname(wrapper)} to PATH`;
}

// ---- per-owner commit-author includeIf ------------------------------------------

const includeKey = (owner) => `includeIf.hasconfig:remote.*.url:https://github.com/${owner}/**.path`;

// ponytail: Git matches the remote URL case-sensitively but config owner keys are
// lowercased, so a clone whose remote spells the owner differently silently falls back
// to the global author. Add a pattern per spelling if that bites.
export function planIncludes(config, gitDir) {
  const plan = [];

  for (const [owner, { identity }] of Object.entries(config.accounts)) {
    const { commitName: name, commitEmail: email } = identity ?? {};

    if (name === undefined && email === undefined) {
      continue;
    }

    // Half an author would let Git fill the other half from the global identity.
    if (!name?.trim() || !email?.trim()) {
      fail(`Account ${owner} identity must set both commitName and commitEmail, or neither`);
    }

    if (!/^[a-z0-9-]+$/.test(owner)) {
      fail(`Account ${owner} cannot get a commit-author include: owner is not a plain GitHub login`);
    }

    plan.push({ owner, name, email, fragment: path.join(gitDir, `${owner}.gitconfig`) });
  }

  return plan;
}

// Include entries this tool owns: any whose path lives in its own fragment directory.
function managedIncludes(l) {
  const out = gitGlobal(["--null", "--get-regexp", "^includeif\\..*\\.path$"], [0, 1]);

  return splitNul(out)
    .map((entry) => ({ key: entry.slice(0, entry.indexOf("\n")), value: entry.slice(entry.indexOf("\n") + 1) }))
    .filter(({ value }) => value.startsWith(`${l.gitDir}${path.sep}`));
}

function pruneIncludes(l) {
  for (const { key, value } of managedIncludes(l)) {
    gitGlobal(["--unset-all", key, `^${escapeRegex(value)}$`], [0, 5]);
  }

  fs.rmSync(l.gitDir, { recursive: true, force: true });
}

function applyIncludes(l, plan) {
  pruneIncludes(l);
  fs.mkdirSync(l.gitDir, { recursive: true });

  for (const { owner, name, email, fragment } of plan) {
    // `git config --file` does the quoting; a name is never spliced into config text.
    git(["config", "--file", fragment, "user.name", name]);
    git(["config", "--file", fragment, "user.email", email]);
    gitGlobal(["--add", includeKey(owner), fragment]);
  }
}

// ---- backup and restore ----------------------------------------------------------

function createBackup(l) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const dir = path.join(l.state, "backups", `${stamp}-${process.pid}`);

  fs.mkdirSync(path.join(dir, "files"), { recursive: true });
  fs.mkdirSync(path.join(dir, "git-config"), { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.version"), `${MANIFEST}\n`);
  fs.writeFileSync(path.join(dir, "home.path"), `${l.home}\n`);

  for (const target of targets(l)) {
    if (exists(target.path)) {
      copyEntry(target.path, path.join(dir, "files", target.name));
    } else {
      fs.writeFileSync(path.join(dir, "files", `${target.name}.absent`), "");
    }
  }

  for (const [name, key] of Object.entries(GIT_KEYS)) {
    fs.writeFileSync(path.join(dir, "git-config", `${name}.values`), gitGlobal(["--null", "--get-all", key], [0, 1]));
  }

  fs.writeFileSync(path.join(dir, "include-entries.json"), JSON.stringify(managedIncludes(l)));
  if (exists(l.gitDir)) {
    fs.cpSync(l.gitDir, path.join(dir, "include-fragments"), { recursive: true });
  }

  return dir;
}

// Both sides go through realpath so a symlinked HOME (macOS /var -> /private/var) still
// compares equal.
function resolveBackupDir(l, selected) {
  if (!fs.statSync(selected, { throwIfNoEntry: false })?.isDirectory()) {
    fail(`Backup directory does not exist: ${selected}`);
  }

  const resolved = fs.realpathSync(selected);
  const roots = [path.join(l.state, "backups"), path.join(l.legacyState, "backups")]
    .filter(exists)
    .map((root) => fs.realpathSync(root));

  if (!roots.some((root) => resolved.startsWith(`${root}${path.sep}`))) {
    fail(`Refusing backup outside ${path.join(l.state, "backups")}`);
  }

  return resolved;
}

function restoreBackup(l, selected) {
  const dir = resolveBackupDir(l, selected);
  const manifestPath = path.join(dir, "manifest.version");
  const manifest = exists(manifestPath) ? fs.readFileSync(manifestPath, "utf8").trim() : "";

  if (manifest !== MANIFEST && manifest !== LEGACY_MANIFEST) {
    fail(`Invalid gh-identity-router backup: ${dir}`);
  }

  const homePath = path.join(dir, "home.path");

  if (!exists(homePath) || fs.readFileSync(homePath, "utf8").trim() !== l.home) {
    fail(`Backup belongs to a different HOME: ${dir}`);
  }

  // Validate the complete snapshot before changing any live file or Git setting.
  const plan = targets(l).map((target) => {
    const stored = path.join(dir, "files", target.name);
    const present = exists(stored);

    if (!present && !exists(`${stored}.absent`) && !target.legacyOptional) {
      fail(`Backup is missing file state for ${target.name}`);
    }

    // A pre-rename backup kept the renamed targets at their old paths.
    const dest = manifest === LEGACY_MANIFEST ? (target.legacy ?? target.path) : target.path;

    return { stored, present, dest };
  });

  for (const name of Object.keys(GIT_KEYS)) {
    if (!exists(path.join(dir, "git-config", `${name}.values`))) {
      fail(`Backup is missing Git config state for ${name}`);
    }
  }

  // Backups from before the include feature have neither file: restore as "none".
  const includesPath = path.join(dir, "include-entries.json");
  const includes = exists(includesPath) ? JSON.parse(fs.readFileSync(includesPath, "utf8")) : [];

  for (const { stored, present, dest } of plan) {
    if (present) {
      copyEntry(stored, dest);
    } else {
      fs.rmSync(dest, { force: true });
    }
  }

  for (const [name, key] of Object.entries(GIT_KEYS)) {
    gitGlobal(["--unset-all", key], [0, 5]);
    for (const value of splitNul(fs.readFileSync(path.join(dir, "git-config", `${name}.values`), "utf8"))) {
      gitGlobal(["--add", key, value]);
    }
  }

  pruneIncludes(l);
  if (exists(path.join(dir, "include-fragments"))) {
    fs.cpSync(path.join(dir, "include-fragments"), l.gitDir, { recursive: true });
  }
  for (const { key, value } of includes) {
    gitGlobal(["--add", key, value]);
  }

  return dir;
}

// ---- commands ----------------------------------------------------------------

function liveVerify(command, args, configPath) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: { ...process.env, IDENTITY_ROUTER_CONFIG: configPath },
    timeout: VERIFY_TIMEOUT_MS
  });

  if (result.error || result.status !== 0) {
    fail(`Live verification failed (${command}): ${result.error?.message ?? `exit ${result.status ?? result.signal}`}`);
  }
}

function setup({ dryRun, verify, node }) {
  const home = process.env.HOME || fail("HOME is not set");
  const l = layout(home);
  const configPath = process.env.IDENTITY_ROUTER_CONFIG ?? path.join(home, ".config", "gh-identity-router", "config.json");
  const verifyCommand = process.env.IDENTITY_ROUTER_VERIFY_COMMAND;
  const launcher = path.join(l.bin, "multi-account-token");
  const baselinePointer = path.join(l.state, "baseline-backup");

  if (dryRun) {
    console.log(`Would back up existing files to: ${path.join(l.state, "backups")}/<timestamp>-<pid>`);
    for (const target of targets(l)) {
      console.log(`Would install: ${target.path}`);
    }
    console.log(`Would require a successful live verification using: ${configPath}`);
    console.log("Would configure Git credential helper with per-repository paths");
    console.log(`Would write commit-author include fragments under: ${l.gitDir}`);
    console.log("Would support rollback with: gh-identity-router uninstall");
    return;
  }

  if (!fs.existsSync(configPath)) {
    fail(`Config file does not exist: ${configPath}`);
  }

  const config = validateConfig(loadRawConfig(process.env));
  const includes = planIncludes(config, l.gitDir);

  if (verify) {
    return verifyInstall({ l, launcher, configPath, verifyCommand, includes });
  }

  const nodePath = node ?? process.execPath;

  checkNode(nodePath);
  if (verifyCommand) {
    liveVerify(verifyCommand, ["--verify"], configPath);
  } else {
    liveVerify(nodePath, [path.join(PKG_DIR, "src", "multi-account-token.mjs"), "--verify"], configPath);
  }

  const backupDir = createBackup(l);

  try {
    for (const target of targets(l)) {
      if (target.src) {
        installFile(target.path, target.mode, { from: path.join(PKG_DIR, target.src) });
      }
    }
    installFile(launcher, 0o755, { text: launcherText(nodePath, path.join(l.share, "multi-account-token.mjs")) });

    const helper = path.join(l.bin, "git-credential-gh-identity-router");

    gitGlobal(["--unset-all", GIT_KEYS.helper], [0, 5]);
    gitGlobal(["--add", GIT_KEYS.helper, ""]);
    gitGlobal(["--add", GIT_KEYS.helper, helper]);
    gitGlobal([GIT_KEYS.username, "x-access-token"]);
    gitGlobal([GIT_KEYS["use-http-path"], "true"]);
    applyIncludes(l, includes);

    liveVerify(verifyCommand ?? launcher, ["--verify"], configPath);
  } catch (error) {
    process.stderr.write("Installation failed; restoring previous credential state.\n");
    try {
      restoreBackup(l, backupDir);
    } catch (restoreError) {
      process.stderr.write(`Automatic restore failed (${restoreError.message}); use: gh-identity-router uninstall --backup ${backupDir}\n`);
    }
    throw error;
  }

  // Only the first setup's backup is the pre-install state `uninstall` should return to.
  if (!exists(baselinePointer) || !exists(fs.readFileSync(baselinePointer, "utf8").trim())) {
    fs.writeFileSync(baselinePointer, `${backupDir}\n`);
  }

  console.log("Installed gh-identity-router helpers.");
  console.log(`Existing files and Git credential settings were backed up to: ${backupDir}`);
  console.log("Undo with: gh-identity-router uninstall");
  for (const { owner } of includes) {
    console.log(`Commit author for ${owner} set via ${l.gitDir}/${owner}.gitconfig (matches the lowercase owner in remote URLs only)`);
  }

  const shadow = checkGhOnPath(path.join(l.bin, "gh"));

  if (shadow) {
    console.warn(`Warning: ${shadow}`);
  }
}

// Non-mutating: reports OK/ERROR per check and exits non-zero if any failed.
function verifyInstall({ l, launcher, configPath, verifyCommand, includes }) {
  let failed = false;
  const check = (label, fn) => {
    try {
      const problem = fn();

      if (problem) {
        throw new Error(problem);
      }
      console.log(`OK ${label}`);
    } catch (error) {
      failed = true;
      console.log(`ERROR ${label}: ${error.message}`);
    }
  };

  check("installed files", () => {
    const missing = targets(l).filter((t) => !exists(t.path)).map((t) => t.path);

    return missing.length ? `missing ${missing.join(", ")}` : null;
  });
  check("node baked into multi-account-token", () => checkNode(bakedNode(launcher)));
  check("gh on PATH is the installed wrapper", () => checkGhOnPath(path.join(l.bin, "gh")));
  check("git credential settings", () => {
    const helper = path.join(l.bin, "git-credential-gh-identity-router");
    const values = (key) => splitNul(gitGlobal(["--null", "--get-all", key], [0, 1]));
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    return same(values(GIT_KEYS.helper), ["", helper])
      && same(values(GIT_KEYS.username), ["x-access-token"])
      && same(values(GIT_KEYS["use-http-path"]), ["true"])
      ? null
      : `credential.https://github.com.* is not the setup configuration (re-run setup)`;
  });
  check("commit-author includes", () => {
    const managed = managedIncludes(l);
    const stale = includes.filter(({ owner, name, email, fragment }) => {
      const wanted = includeKey(owner).toLowerCase();
      const live = ["user.name", "user.email"].map((key) => git(["config", "--file", fragment, "--get", key], [0, 1, 128]).trim());

      return !managed.some((e) => e.value === fragment && e.key.toLowerCase() === wanted)
        || live[0] !== name
        || live[1] !== email;
    });

    return stale.length ? `missing or out of date for ${stale.map((s) => s.owner).join(", ")} (re-run setup)` : null;
  });
  check("live credential verification", () => liveVerify(verifyCommand ?? launcher, ["--verify"], configPath));

  if (failed) {
    process.exitCode = 1;
  }
}

function uninstall({ backup }) {
  const home = process.env.HOME || fail("HOME is not set");
  const l = layout(home);
  const baselinePointer = path.join(l.state, "baseline-backup");
  const dir = backup
    ?? (exists(baselinePointer) ? fs.readFileSync(baselinePointer, "utf8").trim() : fail("No recorded setup to undo; pass --backup DIR"));

  console.log(`Restored gh-identity-router state from: ${restoreBackup(l, dir)}`);
  fs.rmSync(baselinePointer, { force: true });
}

export function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const parse = (options) => {
    try {
      return parseArgs({ args: rest, options, allowPositionals: false }).values;
    } catch (error) {
      throw new UsageError(error.message);
    }
  };

  if (command === "setup") {
    const values = parse({ "dry-run": { type: "boolean" }, verify: { type: "boolean" }, node: { type: "string" } });

    if (values["dry-run"] && values.verify) {
      throw new UsageError("--dry-run and --verify are mutually exclusive");
    }

    return setup({ dryRun: values["dry-run"], verify: values.verify, node: values.node });
  }

  if (command === "uninstall") {
    return uninstall({ backup: parse({ backup: { type: "string" } }).backup });
  }

  if (command === "-h" || command === "--help") {
    console.log(USAGE);
    return;
  }

  throw new UsageError(command ? `Unknown command: ${command}` : "Missing command");
}

export function run(argv) {
  try {
    main(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    if (error instanceof UsageError) {
      process.stderr.write(`${USAGE}\n`);
    }
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}
