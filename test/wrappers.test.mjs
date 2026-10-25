import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const toolDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(toolDir, "bin", "gh-identity-router.mjs");

function executable(file, contents) {
  fs.writeFileSync(file, contents, { mode: 0o755 });
}

const fixtureConfig = {
  defaultAccount: "example-org",
  accounts: {
    "example-org": {
      accountId: 1,
      targetType: "Organization",
      identity: {
        login: "example-bot",
        commitName: "example-bot[bot]",
        commitEmail: "1+example-bot[bot]@users.noreply.github.com"
      }
    },
    "plain-org": { accountId: 2, targetType: "Organization", identity: { login: "plain-bot" } }
  }
};

function installerFixture(prefix = "multi-account-install-") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const configDir = path.join(home, ".config", "gh-identity-router");
  const configPath = path.join(configDir, "config.json");
  const verifyCommand = path.join(home, "verify");

  fs.mkdirSync(configDir, { recursive: true });
  // Live verification is faked below, but setup still reads the config for its
  // commit-author includes, so the shape has to be valid.
  fs.writeFileSync(configPath, JSON.stringify(fixtureConfig), { mode: 0o600 });
  executable(verifyCommand, "#!/usr/bin/env bash\nexit 0\n");

  return {
    home,
    configPath,
    verifyCommand,
    env: {
      ...process.env,
      HOME: home,
      IDENTITY_ROUTER_CONFIG: configPath,
      IDENTITY_ROUTER_VERIFY_COMMAND: verifyCommand
    }
  };
}

function gitConfigValues(home, key) {
  const result = spawnSync("git", ["config", "--global", "--null", "--get-all", key], {
    encoding: "buffer",
    env: { ...process.env, HOME: home }
  });

  if (result.status === 1) {
    return [];
  }

  assert.equal(result.status, 0, result.stderr.toString());
  const bytes = result.stdout;
  const values = [];
  let start = 0;

  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0) {
      values.push(bytes.subarray(start, index).toString());
      start = index + 1;
    }
  }

  return values;
}

function backupPathFrom(output) {
  const match = output.match(/backed up to: (.+)$/m);
  assert.ok(match, `Backup path missing from installer output:\n${output}`);
  return match[1];
}

test("gh wrapper selects --repo over the current repository remote", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-account-gh-"));
  const logPath = path.join(tempDir, "log");
  const tokenCommand = path.join(tempDir, "token");
  const ghCommand = path.join(tempDir, "gh-real");

  executable(tokenCommand, `#!/usr/bin/env bash\nprintf 'token:%s\\n' "$*" >>"${logPath}"\nprintf selected-token\n`);
  executable(ghCommand, `#!/usr/bin/env bash\nprintf 'gh-token:%s args:%s\\n' "$GH_TOKEN" "$*" >>"${logPath}"\n`);

  execFileSync(path.join(toolDir, "bin", "gh"), ["pr", "list", "--repo", "example-org/repo"], {
    cwd: tempDir,
    env: {
      ...process.env,
      IDENTITY_ROUTER_REAL_GH: ghCommand,
      IDENTITY_ROUTER_TOKEN_COMMAND: tokenCommand
    }
  });

  const log = fs.readFileSync(logPath, "utf8");
  assert.match(log, /token:--repo example-org\/repo/);
  assert.match(log, /gh-token:selected-token args:pr list --repo example-org\/repo/);
});

test("gh wrapper selects GH_REPO when --repo is absent", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-account-ghrepo-"));
  const logPath = path.join(tempDir, "log");
  const tokenCommand = path.join(tempDir, "token");
  const ghCommand = path.join(tempDir, "gh-real");

  executable(tokenCommand, `#!/usr/bin/env bash\nprintf 'token:%s\\n' "$*" >>"${logPath}"\nprintf selected-token\n`);
  executable(ghCommand, `#!/usr/bin/env bash\nprintf 'gh-token:%s args:%s\\n' "$GH_TOKEN" "$*" >>"${logPath}"\n`);

  execFileSync(path.join(toolDir, "bin", "gh"), ["pr", "list"], {
    cwd: tempDir,
    env: {
      ...process.env,
      IDENTITY_ROUTER_REAL_GH: ghCommand,
      IDENTITY_ROUTER_TOKEN_COMMAND: tokenCommand,
      GH_REPO: "example-org/repo"
    }
  });

  const log = fs.readFileSync(logPath, "utf8");
  assert.match(log, /token:--repo example-org\/repo/);
  assert.match(log, /gh-token:selected-token args:pr list/);
});

test("gh wrapper prefers --repo over GH_REPO", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-account-ghrepo-override-"));
  const logPath = path.join(tempDir, "log");
  const tokenCommand = path.join(tempDir, "token");
  const ghCommand = path.join(tempDir, "gh-real");

  executable(tokenCommand, `#!/usr/bin/env bash\nprintf 'token:%s\\n' "$*" >>"${logPath}"\nprintf selected-token\n`);
  executable(ghCommand, "#!/usr/bin/env bash\nexit 0\n");

  execFileSync(path.join(toolDir, "bin", "gh"), ["pr", "list", "--repo", "example-user/other"], {
    cwd: tempDir,
    env: {
      ...process.env,
      IDENTITY_ROUTER_REAL_GH: ghCommand,
      IDENTITY_ROUTER_TOKEN_COMMAND: tokenCommand,
      GH_REPO: "example-org/repo"
    }
  });

  assert.match(fs.readFileSync(logPath, "utf8"), /token:--repo example-user\/other/);
});

test("gh wrapper selects the current origin when --repo is absent", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-account-origin-"));
  const logPath = path.join(tempDir, "log");
  const tokenCommand = path.join(tempDir, "token");
  const ghCommand = path.join(tempDir, "gh-real");

  execFileSync("git", ["init", "-q"], { cwd: tempDir });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/example-org/repo.git"], { cwd: tempDir });
  executable(tokenCommand, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >"${logPath}"\nprintf selected-token\n`);
  executable(ghCommand, "#!/usr/bin/env bash\nexit 0\n");

  execFileSync(path.join(toolDir, "bin", "gh"), ["repo", "view"], {
    cwd: tempDir,
    env: {
      ...process.env,
      IDENTITY_ROUTER_REAL_GH: ghCommand,
      IDENTITY_ROUTER_TOKEN_COMMAND: tokenCommand
    }
  });

  assert.equal(
    fs.readFileSync(logPath, "utf8").trim(),
    "--remote-url https://github.com/example-org/repo.git"
  );
});

function realTokenCommandConfig(prefix) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const configPath = path.join(tempDir, "config.json");
  const tokenPath = path.join(tempDir, "token");

  fs.writeFileSync(tokenPath, "github_pat_example", { mode: 0o600 });
  fs.writeFileSync(configPath, JSON.stringify({
    defaultAccount: "example-org",
    accounts: {
      "example-org": { accountId: 1, targetType: "Organization", credential: { type: "pat", tokenPath } }
    }
  }), { mode: 0o600 });

  return {
    tokenCommand: path.resolve(toolDir, "src", "multi-account-token.mjs"),
    env: { ...process.env, IDENTITY_ROUTER_CONFIG: configPath }
  };
}

test("gh wrapper fails closed on a --repo value that cannot be parsed", () => {
  const { tokenCommand, env } = realTokenCommandConfig("multi-account-gh-unparseable-");
  const ghCommand = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "multi-account-gh-real-")), "gh-real");
  executable(ghCommand, "#!/usr/bin/env bash\nexit 0\n");

  const result = spawnSync(path.join(toolDir, "bin", "gh"), ["pr", "list", "--repo", "not-a-full-repo"], {
    encoding: "utf8",
    env: { ...env, IDENTITY_ROUTER_REAL_GH: ghCommand, IDENTITY_ROUTER_TOKEN_COMMAND: tokenCommand }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Could not parse a GitHub owner from --repo: not-a-full-repo/);
});

test("Git credential helper fails closed on an unparseable credential path", () => {
  const { tokenCommand, env } = realTokenCommandConfig("multi-account-cred-unparseable-");

  const result = spawnSync(path.join(toolDir, "bin", "git-credential-gh-identity-router"), ["get"], {
    input: "protocol=https\nhost=github.com\npath=not-a-full-repo\n\n",
    encoding: "utf8",
    env: { ...env, IDENTITY_ROUTER_TOKEN_COMMAND: tokenCommand }
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Could not parse a GitHub owner from --repo: not-a-full-repo/);
});

test("Git credential helper uses the owner from the credential path", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-account-credential-"));
  const logPath = path.join(tempDir, "log");
  const tokenCommand = path.join(tempDir, "token");

  executable(tokenCommand, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >"${logPath}"\nprintf selected-token\n`);
  const result = spawnSync(path.join(toolDir, "bin", "git-credential-gh-identity-router"), ["get"], {
    input: "protocol=https\nhost=github.com\npath=example-org/repo.git\n\n",
    encoding: "utf8",
    env: {
      ...process.env,
      IDENTITY_ROUTER_TOKEN_COMMAND: tokenCommand
    }
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "username=x-access-token\npassword=selected-token\n");
  assert.equal(fs.readFileSync(logPath, "utf8").trim(), "--repo example-org/repo.git");
});

test("Git credential helper exits non-zero with empty stdout when token minting fails", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-account-credential-fail-"));
  const tokenCommand = path.join(tempDir, "token");

  executable(tokenCommand, "#!/usr/bin/env bash\necho 'mint failed' >&2\nexit 1\n");
  const result = spawnSync(path.join(toolDir, "bin", "git-credential-gh-identity-router"), ["get"], {
    input: "protocol=https\nhost=github.com\npath=example-org/repo.git\n\n",
    encoding: "utf8",
    env: {
      ...process.env,
      IDENTITY_ROUTER_TOKEN_COMMAND: tokenCommand
    }
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
});

test("gh wrapper runs the real gh without GH_TOKEN when the token command reports an identity-only owner", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-account-gh-identity-only-"));
  const logPath = path.join(tempDir, "log");
  const tokenCommand = path.join(tempDir, "token");
  const ghCommand = path.join(tempDir, "gh-real");

  executable(tokenCommand, "#!/usr/bin/env bash\nexit 3\n");
  executable(ghCommand, `#!/usr/bin/env bash\nprintf 'gh-token:[%s] args:%s\\n' "\${GH_TOKEN-unset}" "$*" >>"${logPath}"\n`);

  const result = spawnSync(path.join(toolDir, "bin", "gh"), ["pr", "list", "--repo", "example-org/repo"], {
    encoding: "utf8",
    env: { ...process.env, GH_TOKEN: undefined, IDENTITY_ROUTER_REAL_GH: ghCommand, IDENTITY_ROUTER_TOKEN_COMMAND: tokenCommand }
  });

  assert.equal(result.status, 0);
  assert.equal(fs.readFileSync(logPath, "utf8").trim(), "gh-token:[unset] args:pr list --repo example-org/repo");
});

test("gh wrapper still fails closed on any other token command failure", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-account-gh-token-fail-"));
  const logPath = path.join(tempDir, "log");
  const tokenCommand = path.join(tempDir, "token");
  const ghCommand = path.join(tempDir, "gh-real");

  executable(tokenCommand, "#!/usr/bin/env bash\nexit 1\n");
  executable(ghCommand, `#!/usr/bin/env bash\necho ran >>"${logPath}"\n`);

  const result = spawnSync(path.join(toolDir, "bin", "gh"), ["pr", "list", "--repo", "example-org/repo"], {
    encoding: "utf8",
    env: { ...process.env, IDENTITY_ROUTER_REAL_GH: ghCommand, IDENTITY_ROUTER_TOKEN_COMMAND: tokenCommand }
  });

  assert.equal(result.status, 1);
  assert.equal(fs.existsSync(logPath), false);
});

test("Git credential helper answers nothing, successfully, for an identity-only owner", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-account-credential-identity-only-"));
  const tokenCommand = path.join(tempDir, "token");

  executable(tokenCommand, "#!/usr/bin/env bash\nexit 3\n");
  const result = spawnSync(path.join(toolDir, "bin", "git-credential-gh-identity-router"), ["get"], {
    input: "protocol=https\nhost=github.com\npath=example-org/repo.git\n\n",
    encoding: "utf8",
    env: { ...process.env, IDENTITY_ROUTER_TOKEN_COMMAND: tokenCommand }
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
});

test("mint-dispatch-token requests a repo-scoped, minimal-permission token", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-account-mint-dispatch-"));
  const logPath = path.join(tempDir, "log");
  const tokenCommand = path.join(tempDir, "token");

  executable(tokenCommand, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >"${logPath}"\nprintf minted-token\n`);

  const result = spawnSync(path.join(toolDir, "bin", "mint-dispatch-token"), ["example-org/repo"], {
    encoding: "utf8",
    env: {
      ...process.env,
      IDENTITY_ROUTER_TOKEN_COMMAND: tokenCommand
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "DISPATCH_GH_TOKEN=minted-token\n");
  assert.equal(
    fs.readFileSync(logPath, "utf8").trim(),
    "--repo example-org/repo --repositories repo --permissions contents=write,pull_requests=write"
  );
});

test("mint-dispatch-token requires a repository argument", () => {
  const result = spawnSync(path.join(toolDir, "bin", "mint-dispatch-token"), [], { encoding: "utf8" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage: mint-dispatch-token/);
});

test("mint-dispatch-token rejects a repo argument with no owner", () => {
  const result = spawnSync(path.join(toolDir, "bin", "mint-dispatch-token"), ["repo"], { encoding: "utf8" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /repo must be OWNER\/REPO/);
});

test("mint-dispatch-token rejects a repo argument with an empty owner segment", () => {
  const result = spawnSync(path.join(toolDir, "bin", "mint-dispatch-token"), ["/repo"], { encoding: "utf8" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /repo must be OWNER\/REPO/);
});

test("mint-dispatch-token rejects a repo argument with an empty repo segment", () => {
  const result = spawnSync(path.join(toolDir, "bin", "mint-dispatch-token"), ["example-org/"], { encoding: "utf8" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /repo must be OWNER\/REPO/);
});

test("mint-dispatch-token fails rather than emitting an empty token", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-account-mint-dispatch-empty-"));
  const tokenCommand = path.join(tempDir, "token");

  executable(tokenCommand, "#!/usr/bin/env bash\nprintf ''\n");

  const result = spawnSync(path.join(toolDir, "bin", "mint-dispatch-token"), ["example-org/repo"], {
    encoding: "utf8",
    env: {
      ...process.env,
      IDENTITY_ROUTER_TOKEN_COMMAND: tokenCommand
    }
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /empty token/);
});

test("installer resets inherited credential helpers for github.com", () => {
  const fixture = installerFixture("multi-account-install-reset-");

  execFileSync("git", ["config", "--global", "credential.helper", "store"], { env: fixture.env });
  execFileSync(cli, ["setup"], { env: fixture.env });

  assert.deepEqual(
    gitConfigValues(fixture.home, "credential.https://github.com.helper"),
    ["", path.join(fixture.home, ".local", "bin", "git-credential-gh-identity-router")]
  );
  assert.deepEqual(gitConfigValues(fixture.home, "credential.helper"), ["store"]);
});

test("restore accepts a pre-rename backup and puts the old paths back", () => {
  const fixture = installerFixture("multi-account-install-prerename-restore-");
  const output = execFileSync(cli, ["setup"], {
    encoding: "utf8",
    env: fixture.env
  });
  const backupDir = backupPathFrom(output);
  const stateRoot = path.join(fixture.home, ".local", "state");
  const legacyBackup = path.join(stateRoot, "gh-multi-account", "backups", path.basename(backupDir));

  // Rebuild the backup as the pre-rename installer would have written it.
  fs.mkdirSync(path.dirname(legacyBackup), { recursive: true });
  fs.renameSync(backupDir, legacyBackup);
  fs.writeFileSync(path.join(legacyBackup, "manifest.version"), "gh-multi-account-backup-v1\n");
  fs.writeFileSync(path.join(legacyBackup, "files", "bin-credential"), "old helper\n");
  fs.unlinkSync(path.join(legacyBackup, "files", "bin-credential.absent"));
  fs.writeFileSync(path.join(legacyBackup, "files", "share-identity"), "old identity module\n");
  fs.rmSync(path.join(legacyBackup, "files", "share-identity.absent"), { force: true });

  execFileSync(cli, ["uninstall", "--backup", legacyBackup], { env: fixture.env });

  assert.equal(
    fs.readFileSync(path.join(fixture.home, ".local", "share", "gh-multi-account", "identity.mjs"), "utf8"),
    "old identity module\n"
  );

  assert.equal(
    fs.readFileSync(path.join(fixture.home, ".local", "bin", "multi-account-git-credential"), "utf8"),
    "old helper\n"
  );
});

test("installer installs mint-dispatch-token alongside the other wrappers", () => {
  const fixture = installerFixture("multi-account-install-mint-dispatch-");

  execFileSync(cli, ["setup"], { env: fixture.env });

  const installedPath = path.join(fixture.home, ".local", "bin", "mint-dispatch-token");
  assert.equal(fs.existsSync(installedPath), true);
  assert.equal(fs.statSync(installedPath).mode & 0o111, 0o111);
});

test("installed identity.sh runs from the installed layout, not just a checkout", () => {
  const fixture = installerFixture("multi-account-install-identity-");

  execFileSync(cli, ["setup"], { env: fixture.env });

  // Run the installed copy only: no checkout path is reachable from it.
  const installed = path.join(fixture.home, ".local", "bin", "identity.sh");
  const result = spawnSync(installed, ["--self-check"], { encoding: "utf8", env: fixture.env });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(
    fs.existsSync(path.join(fixture.home, ".local", "share", "gh-identity-router", "identity.mjs")),
    true
  );
});

test("restoring a backup from before identity was installed removes it and still succeeds", () => {
  const fixture = installerFixture("multi-account-install-legacy-restore-");
  const output = execFileSync(cli, ["setup"], {
    encoding: "utf8",
    env: fixture.env
  });
  const backupDir = backupPathFrom(output);
  const installedIdentity = [
    path.join(fixture.home, ".local", "bin", "identity.sh"),
    path.join(fixture.home, ".local", "share", "gh-identity-router", "identity.mjs")
  ];

  // Simulate the previous installer's backup: no file state for the identity targets.
  fs.unlinkSync(path.join(backupDir, "files", "bin-identity.absent"));
  fs.unlinkSync(path.join(backupDir, "files", "share-identity.absent"));
  for (const file of installedIdentity) {
    assert.equal(fs.existsSync(file), true);
  }

  execFileSync(cli, ["uninstall", "--backup", backupDir], { env: fixture.env });

  for (const file of installedIdentity) {
    assert.equal(fs.existsSync(file), false);
  }
  assert.equal(fs.existsSync(path.join(fixture.home, ".local", "bin", "gh")), false);
});

test("installer restores exact files and targeted Git config", () => {
  const fixture = installerFixture("multi-account-install-restore-");
  const oldGh = path.join(fixture.home, ".local", "bin", "gh");

  fs.mkdirSync(path.dirname(oldGh), { recursive: true });
  executable(oldGh, "#!/usr/bin/env bash\necho old-gh\n");
  execFileSync("git", ["config", "--global", "--add", "credential.https://github.com.helper", "old-one"], {
    env: fixture.env
  });
  execFileSync("git", ["config", "--global", "--add", "credential.https://github.com.helper", ""], {
    env: fixture.env
  });
  execFileSync("git", ["config", "--global", "--add", "credential.https://github.com.helper", "old two"], {
    env: fixture.env
  });
  execFileSync("git", ["config", "--global", "credential.https://github.com.username", "old-user"], {
    env: fixture.env
  });

  const output = execFileSync(cli, ["setup"], {
    encoding: "utf8",
    env: fixture.env
  });
  const backupDir = backupPathFrom(output);

  execFileSync(cli, ["uninstall", "--backup", backupDir], { env: fixture.env });

  assert.equal(fs.readFileSync(oldGh, "utf8"), "#!/usr/bin/env bash\necho old-gh\n");
  assert.equal(fs.existsSync(path.join(fixture.home, ".local", "bin", "multi-account-token")), false);
  assert.deepEqual(
    gitConfigValues(fixture.home, "credential.https://github.com.helper"),
    ["old-one", "", "old two"]
  );
  assert.deepEqual(
    gitConfigValues(fixture.home, "credential.https://github.com.username"),
    ["old-user"]
  );
  assert.deepEqual(
    gitConfigValues(fixture.home, "credential.https://github.com.useHttpPath"),
    []
  );
});

test("installer automatically restores state after post-install verification fails", () => {
  const fixture = installerFixture("multi-account-install-failure-");
  const oldGh = path.join(fixture.home, ".local", "bin", "gh");
  const counter = path.join(fixture.home, "verify-count");

  fs.mkdirSync(path.dirname(oldGh), { recursive: true });
  executable(oldGh, "#!/usr/bin/env bash\necho old-gh\n");
  executable(
    fixture.verifyCommand,
    [
      "#!/usr/bin/env bash",
      "count=0",
      `[[ -f "${counter}" ]] && count="$(<"${counter}")"`,
      "count=$((count + 1))",
      `printf '%s\\n' "$count" >"${counter}"`,
      '[[ "$count" -eq 1 ]]',
      ""
    ].join("\n")
  );
  execFileSync("git", ["config", "--global", "credential.https://github.com.helper", "old-helper"], {
    env: fixture.env
  });

  const result = spawnSync(cli, ["setup"], {
    encoding: "utf8",
    env: fixture.env
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /restoring previous credential state/);
  assert.equal(fs.readFileSync(oldGh, "utf8"), "#!/usr/bin/env bash\necho old-gh\n");
  assert.equal(fs.existsSync(path.join(fixture.home, ".local", "bin", "multi-account-token")), false);
  assert.deepEqual(
    gitConfigValues(fixture.home, "credential.https://github.com.helper"),
    ["old-helper"]
  );
});

test("missing config fails before any installer mutation", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "multi-account-install-preflight-"));
  const oldGh = path.join(home, ".local", "bin", "gh");

  fs.mkdirSync(path.dirname(oldGh), { recursive: true });
  executable(oldGh, "#!/usr/bin/env bash\necho old-gh\n");
  const result = spawnSync(cli, ["setup"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Config file does not exist/);
  assert.equal(fs.readFileSync(oldGh, "utf8"), "#!/usr/bin/env bash\necho old-gh\n");
  assert.equal(fs.existsSync(path.join(home, ".local", "state", "gh-identity-router")), false);
});

test("restore validates the whole backup before changing live state", () => {
  const fixture = installerFixture("multi-account-install-corrupt-");
  const output = execFileSync(cli, ["setup"], {
    encoding: "utf8",
    env: fixture.env
  });
  const backupDir = backupPathFrom(output);
  const installedGh = path.join(fixture.home, ".local", "bin", "gh");

  fs.unlinkSync(path.join(backupDir, "files", "share-example.absent"));
  const result = spawnSync(cli, ["uninstall", "--backup", backupDir], {
    encoding: "utf8",
    env: fixture.env
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing file state for share-example/);
  assert.equal(fs.existsSync(installedGh), true);
});

test("restore rejects a directory outside the managed backup root", () => {
  const fixture = installerFixture("multi-account-install-path-");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "multi-account-outside-"));
  const result = spawnSync(cli, ["uninstall", "--backup", outside], {
    encoding: "utf8",
    env: fixture.env
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing backup outside/);
});

test("installer dry-run does not write to HOME", () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "multi-account-install-dry-"));
  const result = execFileSync(cli, ["setup", "--dry-run"], {
    encoding: "utf8",
    env: { ...process.env, HOME: tempHome }
  });

  assert.match(result, /Would require a successful live verification/);
  assert.match(result, /Would support rollback/);
  assert.deepEqual(fs.readdirSync(tempHome), []);
});

function runCli(args, env, extra = {}) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env, ...extra });
}

function git(home, cwd, ...args) {
  return spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, HOME: home } });
}

test("setup --verify passes only when the first gh on PATH is the installed wrapper", () => {
  const fixture = installerFixture("multi-account-setup-verify-gh-");
  const binDir = path.join(fixture.home, ".local", "bin");
  const systemDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-account-system-gh-"));
  const nodeDir = path.dirname(process.execPath);

  executable(path.join(systemDir, "gh"), "#!/bin/sh\necho system-gh\n");
  execFileSync(cli, ["setup"], { env: fixture.env });

  const onPath = runCli(["setup", "--verify"], { ...fixture.env, PATH: [binDir, systemDir, nodeDir, "/usr/bin", "/bin"].join(path.delimiter) });
  assert.equal(onPath.status, 0, onPath.stdout + onPath.stderr);
  assert.match(onPath.stdout, /OK gh on PATH is the installed wrapper/);

  const shadowed = runCli(["setup", "--verify"], { ...fixture.env, PATH: [systemDir, binDir, nodeDir, "/usr/bin", "/bin"].join(path.delimiter) });
  assert.equal(shadowed.status, 1);
  assert.match(shadowed.stdout, new RegExp(`ERROR gh on PATH.*resolves to ${systemDir}/gh`));

  // Setup shells out to git, so keep git (alone) on this PATH; the host's own gh must not be.
  const gitOnly = fs.mkdtempSync(path.join(os.tmpdir(), "multi-account-git-only-"));
  fs.symlinkSync(spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim(), path.join(gitOnly, "git"));
  const absent = runCli(["setup", "--verify"], { ...fixture.env, PATH: gitOnly });
  assert.equal(absent.status, 1);
  assert.match(absent.stdout, /ERROR gh on PATH.*add .*\.local\/bin to PATH/);
});

test("setup generates a commit-author includeIf fragment that Git actually applies", () => {
  const fixture = installerFixture("multi-account-setup-include-");
  const clone = (owner) => {
    const dir = fs.mkdtempSync(path.join(fixture.home, `${owner}-`));

    git(fixture.home, dir, "init", "-q");
    git(fixture.home, dir, "remote", "add", "origin", `https://github.com/${owner}/repo`);
    return dir;
  };

  execFileSync(cli, ["setup"], { env: fixture.env });

  const author = (owner, key) => git(fixture.home, clone(owner), "config", key);
  assert.equal(author("example-org", "user.name").stdout.trim(), "example-bot[bot]");
  assert.equal(author("example-org", "user.email").stdout.trim(), "1+example-bot[bot]@users.noreply.github.com");
  // An owner without commit fields gets no include, so Git has no author to fall back on.
  assert.equal(author("plain-org", "user.name").status, 1);
});

test("setup refuses a half-set commit author before changing anything", () => {
  const fixture = installerFixture("multi-account-setup-half-author-");
  const config = structuredClone(fixtureConfig);

  delete config.accounts["example-org"].identity.commitEmail;
  fs.writeFileSync(fixture.configPath, JSON.stringify(config));

  const result = runCli(["setup"], fixture.env);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /example-org identity must set both commitName and commitEmail/);
  assert.equal(fs.existsSync(path.join(fixture.home, ".local")), false);
});

test("uninstall after two setups returns to the state before the first", () => {
  const fixture = installerFixture("multi-account-uninstall-");
  const oldGh = path.join(fixture.home, ".local", "bin", "gh");

  fs.mkdirSync(path.dirname(oldGh), { recursive: true });
  executable(oldGh, "#!/usr/bin/env bash\necho old-gh\n");
  execFileSync("git", ["config", "--global", "credential.https://github.com.helper", "old-helper"], { env: fixture.env });

  execFileSync(cli, ["setup"], { env: fixture.env });
  execFileSync(cli, ["setup"], { env: fixture.env });
  assert.deepEqual(gitConfigValues(fixture.home, "includeIf.hasconfig:remote.*.url:https://github.com/example-org/**.path").length, 1);

  const result = runCli(["uninstall"], fixture.env);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(oldGh, "utf8"), "#!/usr/bin/env bash\necho old-gh\n");
  assert.equal(fs.statSync(oldGh).mode & 0o111, 0o111);
  assert.deepEqual(gitConfigValues(fixture.home, "credential.https://github.com.helper"), ["old-helper"]);
  assert.deepEqual(gitConfigValues(fixture.home, "includeIf.hasconfig:remote.*.url:https://github.com/example-org/**.path"), []);
  assert.equal(fs.existsSync(path.join(fixture.home, ".local", "share", "gh-identity-router", "git")), false);
  assert.equal(fs.existsSync(path.join(fixture.home, ".local", "bin", "multi-account-token")), false);

  // The baseline is spent; a second uninstall has nothing recorded to undo.
  assert.match(runCli(["uninstall"], fixture.env).stderr, /No recorded setup to undo/);
});

test("the installed multi-account-token launcher works with no node on PATH", () => {
  const fixture = installerFixture("multi-account-launcher-nopath-");
  const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), "multi-account-empty-path-"));

  execFileSync(cli, ["setup"], { env: fixture.env });

  const launcher = path.join(fixture.home, ".local", "bin", "multi-account-token");
  const text = fs.readFileSync(launcher, "utf8");
  assert.ok(text.includes(`exec '${process.execPath}' `), text);
  assert.doesNotMatch(text, /env node/);

  const env = { ...fixture.env, PATH: emptyPath };
  assert.notEqual(spawnSync("sh", ["-c", "command -v node"], { env }).status, 0, "control: PATH really has no node");

  // plain-org is identity-only: exit 3 and this message can only come from the script
  // running under node.
  const result = spawnSync(launcher, ["--repo", "plain-org/x"], { encoding: "utf8", env });
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.match(result.stderr, /has no credential block/);
});

test("setup bakes a node path that needs shell quoting", () => {
  const fixture = installerFixture("multi-account-launcher-quote-");
  const dir = path.join(fixture.home, "it's a dir");
  const link = path.join(dir, "node");

  fs.mkdirSync(dir);
  fs.symlinkSync(process.execPath, link);
  execFileSync(cli, ["setup", "--node", link], { env: fixture.env });

  const result = spawnSync(path.join(fixture.home, ".local", "bin", "multi-account-token"), ["--repo", "plain-org/x"], {
    encoding: "utf8",
    env: { ...fixture.env, PATH: "" }
  });
  assert.equal(result.status, 3, result.stderr);
});

test("setup fails clearly, before any change, when the node to bake is unusable", () => {
  const fixture = installerFixture("multi-account-setup-bad-node-");
  const oldNode = path.join(fixture.home, "node18");

  executable(oldNode, "#!/bin/sh\necho 18.19.0\n");

  for (const [node, expected] of [
    [path.join(fixture.home, "missing", "node"), /Cannot run Node\.js at .*missing\/node.*--node/],
    [oldNode, /requires Node\.js >=20, found 18\.19\.0 \(at .*node18\)/],
    ["node", /Node path must be absolute, got: node/]
  ]) {
    const result = runCli(["setup", "--node", node], fixture.env);

    assert.equal(result.status, 1);
    assert.match(result.stderr, expected);
    assert.doesNotMatch(result.stderr, /env: .*node/);
    assert.equal(fs.existsSync(path.join(fixture.home, ".local")), false);
  }
});

test("a failed re-setup rolls the commit-author includes back to the previous setup's", () => {
  const fixture = installerFixture("multi-account-setup-include-rollback-");
  const key = "includeIf.hasconfig:remote.*.url:https://github.com/example-org/**.path";
  const fragment = path.join(fixture.home, ".local", "share", "gh-identity-router", "git", "example-org.gitconfig");

  execFileSync(cli, ["setup"], { env: fixture.env });

  // Config now has no commit author; the post-install verification (2nd call) fails.
  const config = structuredClone(fixtureConfig);
  delete config.accounts["example-org"].identity.commitName;
  delete config.accounts["example-org"].identity.commitEmail;
  fs.writeFileSync(fixture.configPath, JSON.stringify(config));
  const counter = path.join(fixture.home, "verify-count");
  executable(
    fixture.verifyCommand,
    `#!/bin/sh\nprintf x >>"${counter}"\n[ "$(wc -c <"${counter}")" -lt 2 ]\n`
  );

  const result = runCli(["setup"], fixture.env);

  assert.equal(result.status, 1);
  assert.deepEqual(gitConfigValues(fixture.home, key), [fragment]);
  assert.match(fs.readFileSync(fragment, "utf8"), /example-bot\[bot\]/);
});
