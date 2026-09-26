import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const toolDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function executable(file, contents) {
  fs.writeFileSync(file, contents, { mode: 0o755 });
}

function installerFixture(prefix = "multi-account-install-") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const configDir = path.join(home, ".config", "gh-multi-account");
  const configPath = path.join(configDir, "config.json");
  const verifyCommand = path.join(home, "verify");

  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, "{}\n", { mode: 0o600 });
  executable(verifyCommand, "#!/usr/bin/env bash\nexit 0\n");

  return {
    home,
    configPath,
    verifyCommand,
    env: {
      ...process.env,
      HOME: home,
      MULTI_ACCOUNT_CONFIG: configPath,
      MULTI_ACCOUNT_VERIFY_COMMAND: verifyCommand
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
      MULTI_ACCOUNT_REAL_GH: ghCommand,
      MULTI_ACCOUNT_TOKEN_COMMAND: tokenCommand
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
      MULTI_ACCOUNT_REAL_GH: ghCommand,
      MULTI_ACCOUNT_TOKEN_COMMAND: tokenCommand,
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
      MULTI_ACCOUNT_REAL_GH: ghCommand,
      MULTI_ACCOUNT_TOKEN_COMMAND: tokenCommand,
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
      MULTI_ACCOUNT_REAL_GH: ghCommand,
      MULTI_ACCOUNT_TOKEN_COMMAND: tokenCommand
    }
  });

  assert.equal(
    fs.readFileSync(logPath, "utf8").trim(),
    "--remote-url https://github.com/example-org/repo.git"
  );
});

test("Git credential helper uses the owner from the credential path", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-account-credential-"));
  const logPath = path.join(tempDir, "log");
  const tokenCommand = path.join(tempDir, "token");

  executable(tokenCommand, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >"${logPath}"\nprintf selected-token\n`);
  const result = spawnSync(path.join(toolDir, "bin", "multi-account-git-credential"), ["get"], {
    input: "protocol=https\nhost=github.com\npath=example-org/repo.git\n\n",
    encoding: "utf8",
    env: {
      ...process.env,
      MULTI_ACCOUNT_TOKEN_COMMAND: tokenCommand
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
  const result = spawnSync(path.join(toolDir, "bin", "multi-account-git-credential"), ["get"], {
    input: "protocol=https\nhost=github.com\npath=example-org/repo.git\n\n",
    encoding: "utf8",
    env: {
      ...process.env,
      MULTI_ACCOUNT_TOKEN_COMMAND: tokenCommand
    }
  });

  assert.notEqual(result.status, 0);
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
      MULTI_ACCOUNT_TOKEN_COMMAND: tokenCommand
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
      MULTI_ACCOUNT_TOKEN_COMMAND: tokenCommand
    }
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /empty token/);
});

test("installer resets inherited credential helpers for github.com", () => {
  const fixture = installerFixture("multi-account-install-reset-");

  execFileSync("git", ["config", "--global", "credential.helper", "store"], { env: fixture.env });
  execFileSync(path.join(toolDir, "install.sh"), [], { env: fixture.env });

  assert.deepEqual(
    gitConfigValues(fixture.home, "credential.https://github.com.helper"),
    ["", `${fixture.home}/.local/bin/multi-account-git-credential`]
  );
  assert.deepEqual(gitConfigValues(fixture.home, "credential.helper"), ["store"]);
});

test("installer installs mint-dispatch-token alongside the other wrappers", () => {
  const fixture = installerFixture("multi-account-install-mint-dispatch-");

  execFileSync(path.join(toolDir, "install.sh"), [], { env: fixture.env });

  const installedPath = path.join(fixture.home, ".local", "bin", "mint-dispatch-token");
  assert.equal(fs.existsSync(installedPath), true);
  assert.equal(fs.statSync(installedPath).mode & 0o111, 0o111);
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

  const output = execFileSync(path.join(toolDir, "install.sh"), [], {
    encoding: "utf8",
    env: fixture.env
  });
  const backupDir = backupPathFrom(output);

  execFileSync(path.join(toolDir, "install.sh"), ["--restore", backupDir], { env: fixture.env });

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

  const result = spawnSync(path.join(toolDir, "install.sh"), [], {
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
  const result = spawnSync(path.join(toolDir, "install.sh"), [], {
    encoding: "utf8",
    env: { ...process.env, HOME: home }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Config file does not exist/);
  assert.equal(fs.readFileSync(oldGh, "utf8"), "#!/usr/bin/env bash\necho old-gh\n");
  assert.equal(fs.existsSync(path.join(home, ".local", "state", "gh-multi-account")), false);
});

test("restore validates the whole backup before changing live state", () => {
  const fixture = installerFixture("multi-account-install-corrupt-");
  const output = execFileSync(path.join(toolDir, "install.sh"), [], {
    encoding: "utf8",
    env: fixture.env
  });
  const backupDir = backupPathFrom(output);
  const installedGh = path.join(fixture.home, ".local", "bin", "gh");

  fs.unlinkSync(path.join(backupDir, "files", "share-example.absent"));
  const result = spawnSync(path.join(toolDir, "install.sh"), ["--restore", backupDir], {
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
  const result = spawnSync(path.join(toolDir, "install.sh"), ["--restore", outside], {
    encoding: "utf8",
    env: fixture.env
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing backup outside/);
});

test("installer dry-run does not write to HOME", () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "multi-account-install-dry-"));
  const result = execFileSync(path.join(toolDir, "install.sh"), ["--dry-run"], {
    encoding: "utf8",
    env: { ...process.env, HOME: tempHome }
  });

  assert.match(result, /Would require a successful live verification/);
  assert.match(result, /Would support rollback/);
  assert.deepEqual(fs.readdirSync(tempHome), []);
});
