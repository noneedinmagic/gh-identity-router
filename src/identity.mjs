#!/usr/bin/env node
// Resolves this agent's identity by comparing what it CLAIMS to be (the `identity` block
// of the target owner's account entry in the router config) against what it actually IS
// (the credential that authenticates git/gh). Never state identity as fact — always
// resolve it. bin/identity.sh is a thin POSIX-sh shim that delegates argv/exit code
// straight to this file.
//
// The target owner comes from the same selectors the token helper uses — GH_REPO, then
// the current repository's origin URL, then IDENTITY_ROUTER_ORG — except that
// `defaultAccount` is never consulted: it routes tokens, it never supplies an identity.
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
// 2 refused: the owner cannot be resolved or is not allow-listed, or the derived
// credential is a human account not explicitly opted in. Under --footer, 2 is also
// used when the owner has no identity block (credential only) and for kind: human —
// the footer is refused, not the identity itself.

import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { checkNodeVersion, loadRawConfig, resolveAccount, validateConfig } from "./multi-account-token.mjs";

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

function gitOriginUrl() {
  const result = spawnSync("git", ["config", "--get", "remote.origin.url"], { encoding: "utf8" });

  return result.error || result.status !== 0 ? "" : (result.stdout ?? "").trim();
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
// derivedRaw: the raw (unnormalized) derived login. declaredLogin: identity.login, ""
// if the owner declares none. declaredKind: identity.kind, "" if none. credentialType:
// the entry's credential.type, "" if none. Returns 0/1/2 — the same values used as
// bin/identity.sh's exit code.
//
// A login that is not bot-shaped is a person's account, and is accepted only when the
// declaration names exactly that login AND vouches for it: kind: human (the owner acting
// directly) or a PAT credential (a purpose-made machine user). Nothing else opts a
// non-bot login in — in particular no declaration can bless a login it does not name.
export function decideStatus(derivedRaw, declaredLogin, declaredKind, credentialType = "") {
  const derived = normalizeLogin(derivedRaw).toLowerCase();
  const declared = declaredLogin.toLowerCase();

  if (!isBotShaped(derivedRaw)) {
    // Includes "nothing could be derived at all" — fail closed rather than assume a
    // safe default.
    if (!declared || declared !== derived || (declaredKind !== "human" && credentialType !== "pat")) {
      return 2;
    }
  }

  if (declared && declared !== derived) {
    return 1;
  }

  return 0;
}

// Finds the account whose identity block applies. Never throws: an unreadable or invalid
// config, an unresolvable owner, and an owner outside the allow-list are all the same
// answer to the caller — no identity applies, so nothing may be signed with one.
export function resolveIdentityAccount(env = process.env) {
  try {
    const config = validateConfig(loadRawConfig(env));
    const account = resolveAccount(
      config,
      {
        repository: env.GH_REPO,
        remoteUrl: env.GH_REPO ? undefined : gitOriginUrl(),
        environmentAccount: env.IDENTITY_ROUTER_ORG
      },
      { allowDefault: false }
    );

    return { account, refusal: "" };
  } catch (error) {
    return { account: null, refusal: error instanceof Error ? error.message : String(error) };
  }
}

// footerHost is the one identity field where "absent" and "present but empty" mean
// different things (fall back to `os.hostname()` vs. suppress the host from the footer
// entirely).
function footerHostOf(identity) {
  return identity?.footerHost === undefined ? os.hostname() : identity.footerHost;
}

export function resolve({ runtimeOverride = "", env = process.env, ghBin } = {}) {
  const { account, refusal } = resolveIdentityAccount(env);
  const identity = account?.identity ?? null;
  const runtime = detectRuntime(runtimeOverride, env);

  const { derivedLogin: derivedRaw, derivedSource } = deriveLogin({ ghBin });
  const derived = normalizeLogin(derivedRaw);

  const gitUserRaw = gitConfigUserName();
  const gitUser = normalizeLogin(gitUserRaw);
  let crossCheckWarning = "";

  if (derivedRaw && gitUserRaw && derived !== gitUser) {
    crossCheckWarning = `warning: gh account (${derived}) differs from git config user.name (${gitUser}) — commits and the push may be attributed to different identities.`;
  }

  // No identity block means no declared signer: refuse before decideStatus, which would
  // accept any bot-shaped login against an empty declaration.
  const status = account && identity
    ? decideStatus(derivedRaw, identity?.login ?? "", identity?.kind ?? "", account.credential?.type)
    : 2;

  return {
    owner: account?.name ?? "",
    refusal,
    identity,
    host: footerHostOf(identity),
    runtime,
    derivedRaw,
    derived,
    derivedSource,
    gitUserRaw,
    gitUser,
    crossCheckWarning,
    declaredLogin: identity?.login ?? "",
    declaredName: identity?.displayName ?? "",
    declaredKind: identity?.kind ?? "",
    status
  };
}

export function printBlock(state) {
  const lines = [];

  if (state.identity) {
    lines.push(`declared: ${state.declaredLogin}  (${state.declaredName || state.declaredLogin})`);
  } else if (state.owner) {
    lines.push(`declared: (none — REFUSED, no identity block for ${state.owner})`);
  } else {
    lines.push("declared: (none — no owner resolved)");
  }

  lines.push(`derived:  ${state.derivedRaw}`);

  if (state.host) {
    lines.push(`host:     ${state.host}`);
  } else {
    lines.push("host:     (suppressed — footerHost is empty)");
  }

  lines.push(`runtime:  ${state.runtime}`);

  if (state.crossCheckWarning) {
    lines.push(state.crossCheckWarning);
  }

  if (!state.owner) {
    lines.push(`REFUSED: no identity applies — ${state.refusal}`);
  } else if (state.status === 0) {
    lines.push("OK");
  } else if (state.status === 1) {
    lines.push(`MISMATCH: declared login '${state.declaredLogin}' != derived '${state.derived}' (derived via ${state.derivedSource})`);
  } else {
    lines.push(`REFUSED: derived credential '${state.derivedRaw}' (derived via ${state.derivedSource}) ${state.identity ? `is a human account and is not explicitly declared as kind: human or a PAT credential for ${state.owner}` : `cannot be verified: ${state.owner} has no identity block, so no signer is declared`}`);
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
// to it would misattribute it. An owner with no identity block (credential only) has
// nothing to sign with.
export function footerAllowed(status, declaredKind, hasIdentity) {
  if (status !== 0 || declaredKind === "human" || !hasIdentity) {
    return 0;
  }

  return 1;
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
  check("decide_status: bot, declaration differs only by case -> OK", String(decideStatus("Example-Agent[bot]", "example-agent", "")), "0");
  check("decide_status: bot, mismatched declaration -> MISMATCH", String(decideStatus("example-agent[bot]", "example-agent-two", "")), "1");
  check("decide_status: app-prefixed bot, matching declaration -> OK", String(decideStatus("app/example-agent-two", "example-agent-two", "")), "0");
  check("decide_status: human login, not opted in -> REFUSED", String(decideStatus("example-user", "", "")), "2");
  check("decide_status: human login, declared but kind agent -> REFUSED", String(decideStatus("example-user", "example-user", "agent")), "2");
  check("decide_status: human login, opted in and matching -> OK", String(decideStatus("example-user", "example-user", "human")), "0");
  check("decide_status: human login, opted in but wrong login -> REFUSED", String(decideStatus("example-user", "someoneelse", "human")), "2");
  check("decide_status: PAT machine user, matching login -> OK", String(decideStatus("example-machine", "example-machine", "agent", "pat")), "0");
  check("decide_status: PAT machine user, other login -> REFUSED", String(decideStatus("example-user", "example-machine", "agent", "pat")), "2");
  check("decide_status: app credential never vouches for a plain login", String(decideStatus("example-user", "example-user", "agent", "app")), "2");
  check("decide_status: nothing derivable -> REFUSED (fail closed)", String(decideStatus("", "", "")), "2");

  check("footer_allowed: OK, identity declared -> allowed", String(footerAllowed(0, "agent", true)), "1");
  check("footer_allowed: OK, kind human -> suppressed", String(footerAllowed(0, "human", true)), "0");
  check("footer_allowed: OK, credential only -> suppressed", String(footerAllowed(0, "", false)), "0");
  check("footer_allowed: MISMATCH -> suppressed", String(footerAllowed(1, "agent", true)), "0");
  check("footer_allowed: REFUSED -> suppressed", String(footerAllowed(2, "agent", true)), "0");

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

  const ghBin = env.AGENT_IDENTITY_GH_BIN || "gh";
  const state = resolve({ runtimeOverride, env, ghBin });
  // Prefer the shell's logical $PWD (what bash's own guess_bridge_session_id read) over
  // the physical cwd, since a worktree path can be reached through a symlink whose
  // name carries the cse_ id that the resolved physical path does not.
  const ctx = { branch: gitCurrentBranch(), pwd: env.PWD || process.cwd() };

  if (mode === "block") {
    process.stdout.write(printBlock(state));
  } else if (mode === "footer") {
    if (footerAllowed(state.status, state.declaredKind, Boolean(state.identity)) === 1) {
      process.stdout.write(printFooter(state, env, ctx));
    } else if (state.status !== 0) {
      process.stderr.write(printBlock(state));
    } else {
      process.stderr.write(
        state.identity
          ? "REFUSED: kind: human is declared — do not attach an agent footer to a human-authored PR (see this project's AGENTS.md \"## Identity\" section, or your own consuming project's equivalent).\n"
          : `REFUSED: ${state.owner} has no identity block — a credential-only owner gets no footer.\n`
      );
      state.status = 2;
    }
  } else if (mode === "check" && state.status !== 0) {
    process.stderr.write(printBlock(state));
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
