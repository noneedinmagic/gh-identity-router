#!/usr/bin/env node
// Resolves this agent's identity by comparing what it CLAIMS to be (the identity file,
// if declared) against what it actually IS (the credential that authenticates git/gh).
// Never state identity as fact — always resolve it. bin/identity.sh is a thin POSIX-sh
// shim that delegates argv/exit code straight to this file.
//
// Usage (via bin/identity.sh, or `node src/identity.mjs` directly):
//   identity.sh                  diagnostic block (for a human, or an agent
//                                 inspecting its own setup)
//   identity.sh --footer [name]  ONLY the PR footer block (hr + italic
//                                 attribution), nothing else. [name] overrides
//                                 runtime auto-detection.
//   identity.sh --check          silent on success; reason on failure. Exit
//                                 code only — used by the pre-push hook.
//   identity.sh --self-check     run built-in fixtures, print pass/fail.
//
// Exit codes: 0 ok, 1 declared identity does not match the derived credential,
// 2 the derived credential is a human account not explicitly opted in. Under
// --footer, 2 is also reused for the opted-in kind: human case — the footer
// is refused, not the identity itself.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { checkNodeVersion } from "./multi-account-token.mjs";

const GH_AUTH_STATUS_TIMEOUT_MS = 10_000;

// --- identity-string normalization -----------------------------------------
// The one place that knows a GitHub App login can be shaped either
// `example-agent[bot]` (git/gh CLI) or `app/example-agent-two` (PR author field).
// Every caller must go through this function — do not re-implement the strip elsewhere.
export function normalizeLogin(raw) {
  let value = raw ?? "";

  if (value.startsWith("app/")) {
    value = value.slice("app/".length);
  }

  if (value.endsWith("[bot]")) {
    value = value.slice(0, -"[bot]".length);
  }

  return value;
}

// Must agree with normalizeLogin, which only strips a LEADING app/ — a broader
// */app/* match here would let a login like `foo/app/bar` take the bot branch without
// ever being normalized to match it.
export function isBotShaped(raw) {
  const value = raw ?? "";

  return value.startsWith("app/") || value.endsWith("[bot]");
}

export function detectRuntime(override, env = process.env) {
  if (override) {
    return override;
  }

  if ((env.AI_AGENT ?? "").startsWith("claude-code")) {
    return "Claude Code";
  }

  if (`${env.CODEX_CLI ?? ""}${env.CODEX_SANDBOX ?? ""}`.trim() !== "") {
    return "Codex CLI";
  }

  return "an unknown runtime";
}

function gitConfigUserName() {
  const result = spawnSync("git", ["config", "user.name"], { encoding: "utf8" });

  return (result.stdout ?? "").trim();
}

function gitCurrentBranch() {
  const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" });

  if (result.error || result.status !== 0) {
    return "";
  }

  return (result.stdout ?? "").trim();
}

// Always tries `gh auth status` first (the only signal that catches a swapped-but-valid
// token belonging to the wrong agent) and falls back to `git config user.name` only if
// `gh` is missing or fails — e.g. no network.
//
// NOTE: `git credential fill` was tried here and dropped. For a GitHub App installation
// token its `username` is always the fixed OAuth sentinel `x-access-token` — it
// identifies the AUTH SCHEME, not the app, so it derives nothing useful. Its `password`
// IS the live token, so querying it at all risks putting a secret in scrollback for zero
// identifying benefit — not worth the risk. `git config user.name` is a static,
// hand-editable fallback, not an independent signal — treat a result that only came
// from it as best-effort.
export function deriveLogin({ ghBin = "gh" } = {}) {
  let derivedLogin = "";
  let derivedSource = "none";

  const ghResult = spawnSync(ghBin, ["auth", "status"], {
    encoding: "utf8",
    timeout: GH_AUTH_STATUS_TIMEOUT_MS
  });

  if (!ghResult.error) {
    const combined = `${ghResult.stdout ?? ""}${ghResult.stderr ?? ""}`;
    const match = /[Ll]ogged in to github\.com account ([^ \r\n]*)/.exec(combined);

    if (match) {
      derivedLogin = match[1];
      derivedSource = "gh auth status";
    }
  }

  if (!derivedLogin) {
    const gitName = gitConfigUserName();

    if (gitName) {
      derivedLogin = gitName;
      derivedSource = "git config user.name";
    }
  }

  return { derivedLogin, derivedSource };
}

// --- the security-relevant decision, isolated for testing -------------------
// derivedRaw: the raw (unnormalized) derived login. declaredApp: from the identity
// file, "" if absent. declaredKind: "human" or "" (unset). Returns 0/1/2 — the same
// values used as bin/identity.sh's exit code.
export function decideStatus(derivedRaw, declaredApp, declaredKind) {
  const derived = normalizeLogin(derivedRaw);

  if (!isBotShaped(derivedRaw)) {
    // Not bot-shaped (including "nothing could be derived at all" — fail closed rather
    // than assume a safe default): refuse unless explicitly opted in via kind: human
    // with a matching declared app.
    if (declaredKind !== "human" || declaredApp !== derived) {
      return 2;
    }
  }

  if (declaredApp && declaredApp !== derived) {
    return 1;
  }

  return 0;
}

function readIdentityFile(identityFile) {
  if (!identityFile) {
    return null;
  }

  try {
    return fs.readFileSync(identityFile, "utf8");
  } catch {
    return null;
  }
}

export function readDeclared(key, identityFile) {
  const content = readIdentityFile(identityFile);

  if (content === null) {
    return "";
  }

  const match = new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(content);

  return match ? match[1] : "";
}

// host is the one declared field where "absent" and "present but empty" mean different
// things (fall back to `os.hostname()` vs. suppress the host from the footer entirely),
// so it can't share readDeclared's plain-string return.
export function readDeclaredHost(identityFile) {
  const content = readIdentityFile(identityFile);

  if (content === null || !/^host:/m.test(content)) {
    return { declared: false, value: "" };
  }

  const match = /^host:[ \t]*(.*)$/m.exec(content);

  return { declared: true, value: match ? match[1] : "" };
}

// A copied-but-unedited example config or doc often leaves a placeholder like
// `<your GitHub login>` in place. If one was copied unedited, say so instead of a
// confusing "not opted in".
export function looksLikeUnfilledTemplate(value) {
  return /<[^>]*>/.test(value ?? "");
}

export function resolve({ runtimeOverride = "", env = process.env, identityFile, ghBin } = {}) {
  const hostDeclared = readDeclaredHost(identityFile);
  const host = hostDeclared.declared ? hostDeclared.value : os.hostname();
  const runtime = detectRuntime(runtimeOverride, env);

  const { derivedLogin: derivedRaw, derivedSource } = deriveLogin({ ghBin });
  const derived = normalizeLogin(derivedRaw);

  const gitUserRaw = gitConfigUserName();
  const gitUser = normalizeLogin(gitUserRaw);
  let crossCheckWarning = "";

  if (derivedRaw && gitUserRaw && derived !== gitUser) {
    crossCheckWarning = `warning: gh account (${derived}) differs from git config user.name (${gitUser}) — commits and the push may be attributed to different identities.`;
  }

  let declaredApp = readDeclared("app", identityFile);
  let declaredName = readDeclared("display_name", identityFile);
  const declaredKind = readDeclared("kind", identityFile);
  let templateWarning = "";

  if (looksLikeUnfilledTemplate(declaredApp) || looksLikeUnfilledTemplate(declaredName)) {
    templateWarning = `warning: ${identityFile} still has an unfilled <placeholder> — replace every <...> before it counts as a declaration. See this project's README for the file's format, or ask the human owner to fill in app/display_name/kind by hand.`;
    declaredApp = "";
    declaredName = "";
  }

  const status = decideStatus(derivedRaw, declaredApp, declaredKind);

  return {
    host,
    runtime,
    derivedRaw,
    derived,
    derivedSource,
    gitUserRaw,
    gitUser,
    crossCheckWarning,
    declaredApp,
    declaredName,
    declaredKind,
    templateWarning,
    status
  };
}

export function printBlock(state, identityFile) {
  const lines = [];

  if (state.declaredApp) {
    lines.push(`declared: ${state.declaredApp}  (${state.declaredName})`);
  } else if (state.templateWarning) {
    lines.push("declared: (unfilled template — see warning below)");
  } else {
    lines.push(`declared: (none — status UNVERIFIED, no ${identityFile})`);
  }

  lines.push(`derived:  ${state.derivedRaw}`);

  if (state.host) {
    lines.push(`host:     ${state.host}`);
  } else {
    lines.push(`host:     (suppressed — host: declared empty in ${identityFile})`);
  }

  lines.push(`runtime:  ${state.runtime}`);

  if (state.crossCheckWarning) {
    lines.push(state.crossCheckWarning);
  }

  if (state.templateWarning) {
    lines.push(state.templateWarning);
  }

  if (state.status === 0) {
    lines.push(state.declaredApp ? "OK" : `UNVERIFIED (no ${identityFile} — derived identity used as-is)`);
  } else if (state.status === 1) {
    lines.push(`MISMATCH: declared app '${state.declaredApp}' != derived '${state.derived}' (derived via ${state.derivedSource})`);
  } else {
    lines.push(`REFUSED: derived credential '${state.derivedRaw}' (derived via ${state.derivedSource}) is a human account and is not explicitly declared as kind: human in ${identityFile}`);
  }

  return `${lines.join("\n")}\n`;
}

// --- session-id / RC fragments, isolated for testing -------------------
// $CLAUDE_CODE_SESSION_ID lets a PR footer be resumed later (claude --resume). Never
// read $CLAUDE_CODE_SESSION_ACCESS_TOKEN — a live credential, not an id.
export function sessionFragment(env = process.env) {
  const id = env.CLAUDE_CODE_SESSION_ID;

  return id ? `<br>\nSession ID: \`${id}\`` : "";
}

// ponytail: reverse-engineered from one harness mechanism's (EnterWorktree's) own
// directory/branch naming, not a documented contract — a match here is a guess, never a
// confirmed id. Upgrade path: drop this the day Claude Code ships a documented env var
// that carries the id in a plain (non-RC-gated) bridged session (anthropics/claude-code
// issue tracker is the place to check/file that ask).
export function extractCseId(value) {
  const match = /cse_([A-Za-z0-9]+)/.exec(value ?? "");

  return match ? match[1] : null;
}

export function guessBridgeSessionId(branch, pwd) {
  if (branch) {
    const id = extractCseId(branch);

    if (id) {
      return id;
    }
  }

  return extractCseId(pwd);
}

// $CLAUDE_CODE_BRIDGE_SESSION_ID is set only while this session has an active Remote
// Control connection and already in the `session_...` form the claude.ai/code URL takes
// — the documented, non-inherited signal for "is this session RC-driven right now".
//
// When that's unset, a generic bridge/child signal ($CLAUDE_CODE_CHILD_SESSION or either
// $CLAUDE_CODE_BRIDGE_OWNER_*_UUID) still means this is *some* kind of nested/bridged
// session — these get blanket-inherited by any child of an already-bridged session, so
// they're deliberately worded "bridged", never "Remote Control", and never turned into a
// confident link. In that case, try the best-effort worktree-name guess; otherwise say
// so plainly rather than going silent.
export function rcFragment(env = process.env, ctx = {}) {
  if (env.CLAUDE_CODE_BRIDGE_SESSION_ID) {
    return `<br>\nRC: https://claude.ai/code/${env.CLAUDE_CODE_BRIDGE_SESSION_ID}`;
  }

  const bridgeSignal = env.CLAUDE_CODE_CHILD_SESSION
    || env.CLAUDE_CODE_BRIDGE_OWNER_ACCOUNT_UUID
    || env.CLAUDE_CODE_BRIDGE_OWNER_ORG_UUID;

  if (!bridgeSignal) {
    return "";
  }

  const guessed = guessBridgeSessionId(ctx.branch ?? "", ctx.pwd ?? "");

  if (guessed) {
    return `<br>\nRC (**guessed**, **unverified**): https://claude.ai/code/session_${guessed}`;
  }

  return "<br>\nRC: bridged session, no URL available";
}

// `***` rather than `---`: a `---` line right after non-blank text with no blank line
// between (a lost trailing newline upstream) is read by CommonMark as a setext heading
// underline for the previous line, not a rule — `***` has no such reading. The leading
// blank lines are a second, independent guard against that same lost-newline case.
export function printFooter(state, env = process.env, ctx = {}) {
  const name = state.declaredName || state.derived;
  const hostClause = state.host ? ` on \`${state.host}\`` : "";
  const line = `Generated by ${name} via ${state.runtime}${hostClause}.${sessionFragment(env)}${rcFragment(env, ctx)}`;

  return `\n\n***\n\n_${line}_\n`;
}

// --- footer emission decision, isolated for testing -------------------
// A kind: human declaration means the PR is human-authored — attaching an agent footer
// to it would misattribute it.
export function footerAllowed(status, declaredKind) {
  if (status !== 0 || declaredKind === "human") {
    return 0;
  }

  return 1;
}

function tempFixtureFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "identity-self-check-"));
  const file = path.join(dir, "fixture");

  fs.writeFileSync(file, content);

  return file;
}

function runSelfCheck() {
  const lines = [];
  let failures = 0;

  function check(desc, got, want) {
    if (got !== want) {
      lines.push(`FAIL: ${desc} — got '${got}' want '${want}'`);
      failures += 1;
    } else {
      lines.push(`pass: ${desc}`);
    }
  }

  check("normalize bot suffix", normalizeLogin("example-agent[bot]"), "example-agent");
  check("normalize app prefix", normalizeLogin("app/example-agent-two"), "example-agent-two");
  check("normalize human login", normalizeLogin("example-user"), "example-user");
  check("normalize empty", normalizeLogin(""), "");

  check("is_bot_shaped bot suffix", isBotShaped("example-agent[bot]") ? "yes" : "no", "yes");
  check("is_bot_shaped app prefix", isBotShaped("app/example-agent-two") ? "yes" : "no", "yes");
  check("is_bot_shaped human", isBotShaped("example-user") ? "yes" : "no", "no");
  check("is_bot_shaped non-leading app/ is NOT bot", isBotShaped("foo/app/bar") ? "yes" : "no", "no");

  check("decide_status: bot, no declaration -> unverified OK", String(decideStatus("example-agent[bot]", "", "")), "0");
  check("decide_status: bot, matching declaration -> OK", String(decideStatus("example-agent[bot]", "example-agent", "")), "0");
  check("decide_status: bot, mismatched declaration -> MISMATCH", String(decideStatus("example-agent[bot]", "example-agent-two", "")), "1");
  check("decide_status: app-prefixed bot, matching declaration -> OK", String(decideStatus("app/example-agent-two", "example-agent-two", "")), "0");
  check("decide_status: human login, not opted in -> REFUSED", String(decideStatus("example-user", "", "")), "2");
  check("decide_status: human login, opted in and matching -> OK", String(decideStatus("example-user", "example-user", "human")), "0");
  check("decide_status: human login, opted in but wrong app -> REFUSED", String(decideStatus("example-user", "someoneelse", "human")), "2");
  check("decide_status: nothing derivable -> REFUSED (fail closed)", String(decideStatus("", "", "")), "2");

  check("footer_allowed: OK, no kind -> allowed", String(footerAllowed(0, "")), "1");
  check("footer_allowed: OK, kind human -> suppressed", String(footerAllowed(0, "human")), "0");
  check("footer_allowed: MISMATCH -> suppressed", String(footerAllowed(1, "")), "0");
  check("footer_allowed: REFUSED -> suppressed", String(footerAllowed(2, "")), "0");

  check("session_fragment: set", sessionFragment({ CLAUDE_CODE_SESSION_ID: "abc-123" }), "<br>\nSession ID: `abc-123`");
  check("session_fragment: unset", sessionFragment({}), "");

  check(
    "rc_fragment: confirmed RC id",
    rcFragment({ CLAUDE_CODE_BRIDGE_SESSION_ID: "session_abc" }, {}),
    "<br>\nRC: https://claude.ai/code/session_abc"
  );
  check("rc_fragment: no bridge signal at all", rcFragment({}, {}), "");

  check("extract_cse_id: worktree branch shape", extractCseId("worktree-bridge-cse_01B7sPkkAYoLP5RFCqD7KNFC") ?? "", "01B7sPkkAYoLP5RFCqD7KNFC");
  check("extract_cse_id: bare worktree dir shape", extractCseId("bridge-cse_abc123") ?? "", "abc123");
  check("extract_cse_id: no match", extractCseId("main") ?? "", "");

  check(
    "rc_fragment: bridged signal, guessable worktree name -> guessed link",
    rcFragment({ CLAUDE_CODE_CHILD_SESSION: "1" }, { branch: "", pwd: "/home/x/.claude/worktrees/bridge-cse_ABC123" }),
    "<br>\nRC (**guessed**, **unverified**): https://claude.ai/code/session_ABC123"
  );
  check(
    "rc_fragment: bridged signal, no guessable name -> fallback text",
    rcFragment({ CLAUDE_CODE_CHILD_SESSION: "1" }, { branch: "", pwd: "/home/x/plainrepo" }),
    "<br>\nRC: bridged session, no URL available"
  );

  const footerState = { declaredName: "", derived: "Example Agent", runtime: "Claude Code", host: "example-host" };

  check(
    "print_footer: no session id, no RC",
    printFooter(footerState, {}, {}),
    "\n\n***\n\n_Generated by Example Agent via Claude Code on `example-host`._\n"
  );
  check(
    "print_footer: with session id, no RC",
    printFooter(footerState, { CLAUDE_CODE_SESSION_ID: "abc-123" }, {}),
    "\n\n***\n\n_Generated by Example Agent via Claude Code on `example-host`.<br>\nSession ID: `abc-123`_\n"
  );
  check(
    "print_footer: with session id and RC",
    printFooter(footerState, { CLAUDE_CODE_SESSION_ID: "abc-123", CLAUDE_CODE_BRIDGE_SESSION_ID: "session_abc" }, {}),
    "\n\n***\n\n_Generated by Example Agent via Claude Code on `example-host`.<br>\nSession ID: `abc-123`<br>\nRC: https://claude.ai/code/session_abc_\n"
  );
  check(
    "print_footer: host declared empty -> host clause omitted",
    printFooter({ ...footerState, host: "" }, {}, {}),
    "\n\n***\n\n_Generated by Example Agent via Claude Code._\n"
  );

  const hostFixture = tempFixtureFile("display_name: Example Agent\napp: example-agent\n");
  let hostResult = readDeclaredHost(hostFixture);
  check(
    "read_declared_host: no host: line -> not declared",
    hostResult.declared ? "declared" : "not-declared",
    "not-declared"
  );

  fs.appendFileSync(hostFixture, "host: example\n");
  hostResult = readDeclaredHost(hostFixture);
  check(
    "read_declared_host: declared with value",
    hostResult.declared ? `declared:${hostResult.value}` : "not-declared",
    "declared:example"
  );

  fs.writeFileSync(hostFixture, "display_name: Example Agent\nhost:\n");
  hostResult = readDeclaredHost(hostFixture);
  check(
    "read_declared_host: declared empty",
    hostResult.declared ? `declared:${hostResult.value}` : "not-declared",
    "declared:"
  );
  fs.rmSync(path.dirname(hostFixture), { recursive: true, force: true });

  check("unfilled template detected", looksLikeUnfilledTemplate("<your GitHub login>") ? "yes" : "no", "yes");
  check("filled value not flagged", looksLikeUnfilledTemplate("example-agent") ? "yes" : "no", "no");

  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }

  if (failures === 0) {
    process.stdout.write("self-check: all passed\n");
    return 0;
  }

  process.stdout.write(`self-check: ${failures} failure(s)\n`);
  return 1;
}

export function main(argv = process.argv.slice(2), env = process.env) {
  let mode = "block";
  let runtimeOverride = "";
  const arg0 = argv[0];

  if (arg0 === "--footer") {
    mode = "footer";
    runtimeOverride = argv[1] ?? "";
  } else if (arg0 === "--check") {
    mode = "check";
  } else if (arg0 === "--self-check") {
    return runSelfCheck();
  } else if (arg0 !== undefined && arg0 !== "") {
    process.stderr.write(`unknown argument: ${arg0} (expected --footer [runtime], --check, or --self-check)\n`);
    return 64;
  }

  const identityFile = env.AGENT_IDENTITY_FILE || path.join(os.homedir(), ".agent-identity");
  const ghBin = env.AGENT_IDENTITY_GH_BIN || "gh";
  const state = resolve({ runtimeOverride, env, identityFile, ghBin });
  // Prefer the shell's logical $PWD (what bash's own guess_bridge_session_id read) over
  // the physical cwd, since a worktree path can be reached through a symlink whose
  // name carries the cse_ id that the resolved physical path does not.
  const ctx = { branch: gitCurrentBranch(), pwd: env.PWD || process.cwd() };

  if (mode === "block") {
    process.stdout.write(printBlock(state, identityFile));
  } else if (mode === "footer") {
    if (footerAllowed(state.status, state.declaredKind) === 1) {
      process.stdout.write(printFooter(state, env, ctx));
    } else if (state.status === 0) {
      process.stderr.write(
        "REFUSED: kind: human is declared — do not attach an agent footer to a human-authored PR (see this project's AGENTS.md \"## Identity\" section, or your own consuming project's equivalent).\n"
      );
      state.status = 2;
    } else {
      process.stderr.write(printBlock(state, identityFile));
    }
  } else if (mode === "check" && state.status !== 0) {
    process.stderr.write(printBlock(state, identityFile));
  }

  return state.status;
}

const isEntrypoint = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isEntrypoint) {
  const nodeVersionError = checkNodeVersion(process.versions.node);

  if (nodeVersionError) {
    process.stderr.write(`${nodeVersionError}\n`);
    process.exit(1);
  }

  process.exitCode = main();
}
