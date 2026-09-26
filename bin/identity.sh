#!/usr/bin/env bash
# Resolve this agent's identity by comparing what it CLAIMS to be
# (~/.agent-identity, if declared) against what it actually IS (the credential
# that authenticates git/gh). Never state identity as fact — always resolve it.
#
# See docs/design/ for the design rationale behind resolving identity at
# runtime instead of stating it as fact, and this project's AGENTS.md for the
# rule that requires running this before a push or PR.
#
# Usage:
#   identity.sh                  diagnostic block (for a human, or an agent
#                                 inspecting its own setup)
#   identity.sh --footer [name]  ONLY the PR footer block (hr + italic
#                                 attribution), nothing else. [name] overrides
#                                 runtime auto-detection.
#   identity.sh --check          silent on success; reason on failure. Exit
#                                 code only — used by the pre-push hook. Still
#                                 calls `gh auth status` when available (the
#                                 only signal that catches a swapped-but-valid
#                                 token); ~1s against a multi-second push is
#                                 an acceptable trade for an authoritative answer.
#   identity.sh --self-check     run built-in fixtures, print pass/fail.
#
# Exit codes: 0 ok, 1 declared identity does not match the derived credential,
# 2 the derived credential is a human account not explicitly opted in. Under
# --footer, 2 is also reused for the opted-in kind: human case — the footer
# is refused, not the identity itself (see print_footer's caller in main()).
set -euo pipefail

IDENTITY_FILE="${AGENT_IDENTITY_FILE:-$HOME/.agent-identity}"

# --- identity-string normalization -----------------------------------------
# The one place that knows a GitHub App login can be shaped either
# `example-agent[bot]` (git/gh CLI) or `app/example-agent-two` (PR author field).
# Every caller (this script, the pre-push hook) must go through this function
# — do not re-implement the strip elsewhere.
normalize_login() {
  local s="$1"
  s="${s#app/}"
  s="${s%\[bot\]}"
  printf '%s' "$s"
}

is_bot_shaped() {
  # Must agree with normalize_login, which only strips a LEADING app/ — a
  # broader */app/* match here would let a login like `foo/app/bar` take the
  # bot branch without ever being normalized to match it.
  case "$1" in
    app/*) return 0 ;;
  esac
  case "$1" in
    *'[bot]') return 0 ;;
  esac
  return 1
}

# --- runtime detection -------------------------------------------------------
detect_runtime() {
  local override="${1:-}"
  if [ -n "$override" ]; then
    printf '%s' "$override"
    return
  fi
  case "${AI_AGENT:-}" in
    claude-code*) printf 'Claude Code'; return ;;
  esac
  case "${CODEX_CLI:-}${CODEX_SANDBOX:-}" in
    *[!\ ]*) printf 'Codex CLI'; return ;;
  esac
  printf 'an unknown runtime'
}

# --- derive the acting credential -------------------------------------------
# Always tries `gh auth status` first (the only signal that catches a
# swapped-but-valid token belonging to the wrong agent) and falls back to
# `git config user.name` only if `gh` is missing or fails — e.g. no network.
#
# NOTE: `git credential fill` was tried here and dropped. For a GitHub App
# installation token its `username` is always the fixed OAuth sentinel
# `x-access-token` (confirmed against this environment's credential helper) —
# it identifies the AUTH SCHEME, not the app, so it derives nothing useful.
# Its `password` IS the live token, so querying it at all risks putting a
# secret in scrollback for zero identifying benefit — not worth the risk.
# `git config user.name` is a static, hand-editable fallback, not an
# independent signal — treat a result that only came from it as best-effort.
#
# Sets derived_login and derived_source (not a return value — resolve() reads
# them directly, no subshell, so the source survives to the diagnostics).
# AGENT_IDENTITY_GH_BIN overrides the `gh` binary, mirroring the CLAUDE_BIN /
# CLAUDE_TMUX_TMUX_BIN override pattern elsewhere in this repo — lets tests
# substitute a fixture without touching the real `gh`.
derive_login() {
  local gh_bin="${AGENT_IDENTITY_GH_BIN:-gh}"
  derived_login=""
  derived_source="none"

  if command -v "$gh_bin" >/dev/null 2>&1; then
    derived_login="$("$gh_bin" auth status 2>&1 | sed -n 's/.*[Ll]ogged in to github\.com account \([^ ]*\).*/\1/p' | head -n1 || true)"
    [ -n "$derived_login" ] && derived_source="gh auth status"
  fi

  if [ -z "$derived_login" ]; then
    derived_login="$(git config user.name 2>/dev/null || true)"
    [ -n "$derived_login" ] && derived_source="git config user.name"
  fi
}

# --- the security-relevant decision, isolated for --self-check -------------
# derived_raw: the raw (unnormalized) derived login. declared_app: from
# ~/.agent-identity, "" if absent. declared_kind: "human" or "" (unset).
# Prints 0/1/2 on stdout — the same values used as this script's exit code.
decide_status() {
  local derived_raw="$1" declared_app="$2" declared_kind="$3"
  local derived
  derived="$(normalize_login "$derived_raw")"

  if ! is_bot_shaped "$derived_raw"; then
    # Not bot-shaped (including "nothing could be derived at all" — fail
    # closed rather than assume a safe default): refuse unless explicitly
    # opted in via kind: human with a matching declared app.
    if [ "$declared_kind" != "human" ] || [ "$declared_app" != "$derived" ]; then
      echo 2
      return
    fi
  fi

  if [ -n "$declared_app" ] && [ "$declared_app" != "$derived" ]; then
    echo 1
    return
  fi

  echo 0
}

# --- read the declared identity ---------------------------------------------
read_declared() {
  local key="$1"
  [ -r "$IDENTITY_FILE" ] || return 0
  sed -n "s/^${key}:[[:space:]]*//p" "$IDENTITY_FILE" | head -n1
}

# host is the one declared field where "absent" and "present but empty" mean
# different things (fall back to `hostname` vs. suppress the host from the
# footer entirely), so it can't share read_declared's plain-string return —
# grep for the line first, then read its value only if the line exists.
# Sets host_value; returns 1 (value unused) when no `host:` line is present.
read_declared_host() {
  host_value=""
  [ -r "$IDENTITY_FILE" ] || return 1
  grep -q "^host:" "$IDENTITY_FILE" || return 1
  host_value="$(sed -n 's/^host:[[:space:]]*//p' "$IDENTITY_FILE" | head -n1)"
  return 0
}

# A copied-but-unedited example config or doc often leaves a placeholder like
# `<your GitHub login>` in place. If one was copied unedited, say so instead of
# a confusing "not opted in".
looks_like_unfilled_template() {
  case "$1" in
    *'<'*'>'*) return 0 ;;
  esac
  return 1
}

resolve() {
  local runtime_override="$1"

  if read_declared_host; then
    host="$host_value"
  else
    host="$(hostname)"
  fi
  runtime="$(detect_runtime "$runtime_override")"

  derive_login
  derived_raw="$derived_login"
  derived="$(normalize_login "$derived_raw")"

  git_user_raw="$(git config user.name 2>/dev/null || true)"
  git_user="$(normalize_login "$git_user_raw")"
  cross_check_warning=""
  if [ -n "$derived_raw" ] && [ -n "$git_user_raw" ] && [ "$derived" != "$git_user" ]; then
    cross_check_warning="warning: gh account ($derived) differs from git config user.name ($git_user) — commits and the push may be attributed to different identities."
  fi

  declared_app="$(read_declared app)"
  declared_name="$(read_declared display_name)"
  declared_kind="$(read_declared kind)"

  template_warning=""
  if looks_like_unfilled_template "$declared_app" || looks_like_unfilled_template "$declared_name"; then
    template_warning="warning: $IDENTITY_FILE still has an unfilled <placeholder> — replace every <...> before it counts as a declaration. See this project's README for the file's format, or ask the human owner to fill in app/display_name/kind by hand."
    declared_app=""
    declared_name=""
  fi

  status="$(decide_status "$derived_raw" "$declared_app" "$declared_kind")"
}

print_block() {
  if [ -n "$declared_app" ]; then
    echo "declared: $declared_app  ($declared_name)"
  elif [ -n "$template_warning" ]; then
    echo "declared: (unfilled template — see warning below)"
  else
    echo "declared: (none — status UNVERIFIED, no $IDENTITY_FILE)"
  fi
  echo "derived:  $derived_raw"
  if [ -n "$host" ]; then
    echo "host:     $host"
  else
    echo "host:     (suppressed — host: declared empty in $IDENTITY_FILE)"
  fi
  echo "runtime:  $runtime"
  [ -n "$cross_check_warning" ] && echo "$cross_check_warning"
  [ -n "$template_warning" ] && echo "$template_warning"
  case "$status" in
    0) [ -n "$declared_app" ] && echo "OK" || echo "UNVERIFIED (no $IDENTITY_FILE — derived identity used as-is)" ;;
    1) echo "MISMATCH: declared app '$declared_app' != derived '$derived' (derived via $derived_source)" ;;
    2) echo "REFUSED: derived credential '$derived_raw' (derived via $derived_source) is a human account and is not explicitly declared as kind: human in $IDENTITY_FILE" ;;
  esac
}

# --- session-id fragment, isolated for --self-check -------------------
# $CLAUDE_CODE_SESSION_ID lets a PR footer be resumed later (claude --resume).
# Never read $CLAUDE_CODE_SESSION_ACCESS_TOKEN — a live credential, not an id.
session_fragment() {
  [ -n "${CLAUDE_CODE_SESSION_ID:-}" ] && printf '<br>\nSession ID: `%s`' "$CLAUDE_CODE_SESSION_ID"
  return 0
}

# ponytail: reverse-engineered from one harness mechanism's (EnterWorktree's)
# own directory/branch naming, not a documented contract — a match here is a
# guess, never a confirmed id. Upgrade path: drop this the day Claude Code
# ships a documented env var that carries the id in a plain (non-RC-gated)
# bridged session (anthropics/claude-code issue tracker is the place to
# check/file that ask). Isolated as a pure string->id function for
# --self-check; guess_bridge_session_id below decides which strings to try
# it against.
extract_cse_id() {
  if [[ "$1" =~ cse_([A-Za-z0-9]+) ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
    return 0
  fi
  return 1
}

guess_bridge_session_id() {
  local branch
  branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  { [ -n "$branch" ] && extract_cse_id "$branch"; } || extract_cse_id "$PWD"
}

# $CLAUDE_CODE_BRIDGE_SESSION_ID is set only while this session has an active
# Remote Control connection (Claude Code v2.1.199+) and already in the
# `session_...` form the claude.ai/code URL takes — the documented,
# non-inherited signal for "is this session RC-driven right now".
#
# When that's unset, a generic bridge/child signal
# ($CLAUDE_CODE_CHILD_SESSION or either $CLAUDE_CODE_BRIDGE_OWNER_*_UUID)
# still means this is *some* kind of nested/bridged session — testing found
# these get blanket-inherited by any child of an already-bridged session, so
# they're deliberately worded "bridged", never "Remote Control", and never
# turned into a confident link.
# In that case, try the best-effort worktree-name guess; otherwise say so
# plainly rather than going silent, so a PR footer at least tells a reader
# there was a session behind it even when it can't point at one.
rc_fragment() {
  local guessed
  if [ -n "${CLAUDE_CODE_BRIDGE_SESSION_ID:-}" ]; then
    printf '<br>\nRC: https://claude.ai/code/%s' "$CLAUDE_CODE_BRIDGE_SESSION_ID"
    return 0
  fi
  if [ -z "${CLAUDE_CODE_CHILD_SESSION:-}${CLAUDE_CODE_BRIDGE_OWNER_ACCOUNT_UUID:-}${CLAUDE_CODE_BRIDGE_OWNER_ORG_UUID:-}" ]; then
    return 0
  fi
  if guessed="$(guess_bridge_session_id)"; then
    printf '<br>\nRC (**guessed**, **unverified**): https://claude.ai/code/session_%s' "$guessed"
  else
    printf '<br>\nRC: bridged session, no URL available'
  fi
  return 0
}

# `***` rather than `---`: a `---` line right after non-blank text with no
# blank line between (a lost trailing newline upstream) is read by CommonMark
# as a setext heading underline for the previous line, not a rule — `***` has
# no such reading. The leading blank lines are a second, independent guard
# against that same lost-newline case.
print_footer() {
  local name="$declared_name" line host_clause=""
  [ -z "$name" ] && name="$derived"
  [ -n "$host" ] && host_clause=" on \`$host\`"
  line="Generated by $name via $runtime$host_clause.$(session_fragment)$(rc_fragment)"
  printf '\n\n***\n\n_%s_\n' "$line"
}

# --- footer emission decision, isolated for --self-check -------------------
# status: 0/1/2 from decide_status. declared_kind: "human" or "" (unset).
# Prints 1 if the footer may be emitted, 0 if it must be suppressed. A
# kind: human declaration means the PR is human-authored — attaching an
# agent footer to it would misattribute it (see this project's AGENTS.md
# "## Identity" section, or your own consuming project's equivalent).
footer_allowed() {
  local status="$1" declared_kind="$2"
  if [ "$status" != "0" ] || [ "$declared_kind" = "human" ]; then
    echo 0
    return
  fi
  echo 1
}

self_check() {
  local failures=0
  check() {
    local desc="$1" got="$2" want="$3"
    if [ "$got" != "$want" ]; then
      echo "FAIL: $desc — got '$got' want '$want'"
      failures=$((failures + 1))
    else
      echo "pass: $desc"
    fi
  }

  check "normalize bot suffix"   "$(normalize_login 'example-agent[bot]')"   "example-agent"
  check "normalize app prefix"   "$(normalize_login 'app/example-agent-two')"  "example-agent-two"
  check "normalize human login"  "$(normalize_login 'example-user')"       "example-user"
  check "normalize empty"        "$(normalize_login '')"                    ""

  is_bot_shaped 'example-agent[bot]' && check "is_bot_shaped bot suffix" yes yes || check "is_bot_shaped bot suffix" no yes
  is_bot_shaped 'app/example-agent-two' && check "is_bot_shaped app prefix" yes yes || check "is_bot_shaped app prefix" no yes
  is_bot_shaped 'example-user' && check "is_bot_shaped human" yes no || check "is_bot_shaped human" no no
  is_bot_shaped 'foo/app/bar' && check "is_bot_shaped non-leading app/ is NOT bot" yes no || check "is_bot_shaped non-leading app/ is NOT bot" no no

  # decide_status(derived_raw, declared_app, declared_kind) -> 0/1/2 — the
  # security-relevant branch. Fixtures cover every path without touching the
  # real environment's credential.
  check "decide_status: bot, no declaration -> unverified OK" \
    "$(decide_status 'example-agent[bot]' '' '')" "0"
  check "decide_status: bot, matching declaration -> OK" \
    "$(decide_status 'example-agent[bot]' 'example-agent' '')" "0"
  check "decide_status: bot, mismatched declaration -> MISMATCH" \
    "$(decide_status 'example-agent[bot]' 'example-agent-two' '')" "1"
  check "decide_status: app-prefixed bot, matching declaration -> OK" \
    "$(decide_status 'app/example-agent-two' 'example-agent-two' '')" "0"
  check "decide_status: human login, not opted in -> REFUSED" \
    "$(decide_status 'example-user' '' '')" "2"
  check "decide_status: human login, opted in and matching -> OK" \
    "$(decide_status 'example-user' 'example-user' 'human')" "0"
  check "decide_status: human login, opted in but wrong app -> REFUSED" \
    "$(decide_status 'example-user' 'someoneelse' 'human')" "2"
  check "decide_status: nothing derivable -> REFUSED (fail closed)" \
    "$(decide_status '' '' '')" "2"

  # footer_allowed(status, declared_kind) -> 1/0 — must suppress the agent
  # footer for kind: human even though decide_status reports OK for it.
  check "footer_allowed: OK, no kind -> allowed" \
    "$(footer_allowed 0 '')" "1"
  check "footer_allowed: OK, kind human -> suppressed" \
    "$(footer_allowed 0 'human')" "0"
  check "footer_allowed: MISMATCH -> suppressed" \
    "$(footer_allowed 1 '')" "0"
  check "footer_allowed: REFUSED -> suppressed" \
    "$(footer_allowed 2 '')" "0"

  check "session_fragment: set" \
    "$(CLAUDE_CODE_SESSION_ID='abc-123' session_fragment)" '<br>
Session ID: `abc-123`'
  check "session_fragment: unset" "$(unset CLAUDE_CODE_SESSION_ID; session_fragment)" ""

  # Bridge-signal vars ($CLAUDE_CODE_CHILD_SESSION and the two
  # $CLAUDE_CODE_BRIDGE_OWNER_*_UUID) are genuinely set in this repo's own
  # dev sessions (they run inside a bridged worktree) — every fixture below
  # that isn't specifically testing the bridged-fallback path must unset all
  # three, or it silently inherits real ambient state instead of the fixture.
  check "rc_fragment: confirmed RC id" \
    "$(unset CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_BRIDGE_OWNER_ACCOUNT_UUID CLAUDE_CODE_BRIDGE_OWNER_ORG_UUID; CLAUDE_CODE_BRIDGE_SESSION_ID='session_abc' rc_fragment)" '<br>
RC: https://claude.ai/code/session_abc'
  check "rc_fragment: no bridge signal at all" \
    "$(unset CLAUDE_CODE_BRIDGE_SESSION_ID CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_BRIDGE_OWNER_ACCOUNT_UUID CLAUDE_CODE_BRIDGE_OWNER_ORG_UUID; rc_fragment)" ""

  check "extract_cse_id: worktree branch shape" \
    "$(extract_cse_id 'worktree-bridge-cse_01B7sPkkAYoLP5RFCqD7KNFC')" "01B7sPkkAYoLP5RFCqD7KNFC"
  check "extract_cse_id: bare worktree dir shape" \
    "$(extract_cse_id 'bridge-cse_abc123')" "abc123"
  check "extract_cse_id: no match" "$(extract_cse_id 'main')" ""

  check "rc_fragment: bridged signal, guessable worktree name -> guessed link" \
    "$(unset CLAUDE_CODE_BRIDGE_SESSION_ID; CLAUDE_CODE_CHILD_SESSION=1 PWD='/home/x/.claude/worktrees/bridge-cse_ABC123' rc_fragment)" '<br>
RC (**guessed**, **unverified**): https://claude.ai/code/session_ABC123'
  check "rc_fragment: bridged signal, no guessable name -> fallback text" \
    "$(unset CLAUDE_CODE_BRIDGE_SESSION_ID; CLAUDE_CODE_CHILD_SESSION=1 PWD='/home/x/plainrepo' rc_fragment)" '<br>
RC: bridged session, no URL available'

  declared_name="" derived="Example Agent" runtime="Claude Code" host="example-host"
  check "print_footer: no session id, no RC" \
    "$(unset CLAUDE_CODE_SESSION_ID CLAUDE_CODE_BRIDGE_SESSION_ID CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_BRIDGE_OWNER_ACCOUNT_UUID CLAUDE_CODE_BRIDGE_OWNER_ORG_UUID; print_footer)" '

***

_Generated by Example Agent via Claude Code on `example-host`._'
  check "print_footer: with session id, no RC" \
    "$(unset CLAUDE_CODE_BRIDGE_SESSION_ID CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_BRIDGE_OWNER_ACCOUNT_UUID CLAUDE_CODE_BRIDGE_OWNER_ORG_UUID; CLAUDE_CODE_SESSION_ID='abc-123' print_footer)" '

***

_Generated by Example Agent via Claude Code on `example-host`.<br>
Session ID: `abc-123`_'
  check "print_footer: with session id and RC" \
    "$(unset CLAUDE_CODE_SESSION_ID CLAUDE_CODE_BRIDGE_SESSION_ID CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_BRIDGE_OWNER_ACCOUNT_UUID CLAUDE_CODE_BRIDGE_OWNER_ORG_UUID; CLAUDE_CODE_SESSION_ID='abc-123' CLAUDE_CODE_BRIDGE_SESSION_ID='session_abc' print_footer)" '

***

_Generated by Example Agent via Claude Code on `example-host`.<br>
Session ID: `abc-123`<br>
RC: https://claude.ai/code/session_abc_'

  # host: "" (declared empty, distinct from unset) suppresses the " on
  # `host`" clause entirely rather than printing "on ``."
  host=""
  check "print_footer: host declared empty -> host clause omitted" \
    "$(unset CLAUDE_CODE_SESSION_ID CLAUDE_CODE_BRIDGE_SESSION_ID CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_BRIDGE_OWNER_ACCOUNT_UUID CLAUDE_CODE_BRIDGE_OWNER_ORG_UUID; print_footer)" '

***

_Generated by Example Agent via Claude Code._'
  host="example-host"

  # read_declared_host: distinguishes "no host: line at all" (caller falls
  # back to `hostname`) from "host: <value-or-empty>" (caller uses it as-is,
  # including suppressing it when the value is empty). Each call is guarded
  # by `if` — under `set -e` a bare nonzero return here would abort the
  # whole self-check, not just fail this one assertion.
  _host_fixture="$(mktemp)"
  printf 'display_name: Example Agent\napp: example-agent\n' >"$_host_fixture"
  if IDENTITY_FILE="$_host_fixture" read_declared_host; then
    check "read_declared_host: no host: line -> not declared" "declared" "not-declared"
  else
    check "read_declared_host: no host: line -> not declared" "not-declared" "not-declared"
  fi
  printf 'host: example\n' >>"$_host_fixture"
  if IDENTITY_FILE="$_host_fixture" read_declared_host; then
    check "read_declared_host: declared with value" "declared:$host_value" "declared:example"
  else
    check "read_declared_host: declared with value" "not-declared" "declared:example"
  fi
  printf 'display_name: Example Agent\nhost:\n' >"$_host_fixture"
  if IDENTITY_FILE="$_host_fixture" read_declared_host; then
    check "read_declared_host: declared empty" "declared:$host_value" "declared:"
  else
    check "read_declared_host: declared empty" "not-declared" "declared:"
  fi
  rm -f "$_host_fixture"

  looks_like_unfilled_template '<your GitHub login>' && check "unfilled template detected" yes yes || check "unfilled template detected" no yes
  looks_like_unfilled_template 'example-agent' && check "filled value not flagged" yes no || check "filled value not flagged" no no

  if [ "$failures" -eq 0 ]; then
    echo "self-check: all passed"
    return 0
  else
    echo "self-check: $failures failure(s)"
    return 1
  fi
}

main() {
  local mode="block" runtime_override=""

  case "${1:-}" in
    --footer)
      mode="footer"
      runtime_override="${2:-}"
      ;;
    --check)
      mode="check"
      ;;
    --self-check)
      self_check
      exit $?
      ;;
    "" ) : ;;
    *)
      echo "unknown argument: $1 (expected --footer [runtime], --check, or --self-check)" >&2
      exit 64
      ;;
  esac

  resolve "$runtime_override"

  case "$mode" in
    block)
      print_block
      ;;
    footer)
      if [ "$(footer_allowed "$status" "$declared_kind")" = "1" ]; then
        print_footer
      elif [ "$status" = "0" ]; then
        echo "REFUSED: kind: human is declared — do not attach an agent footer to a human-authored PR (see this project's AGENTS.md \"## Identity\" section, or your own consuming project's equivalent)." >&2
        status=2
      else
        print_block >&2
      fi
      ;;
    check)
      if [ "$status" != "0" ]; then
        print_block >&2
      fi
      ;;
  esac

  exit "$status"
}

main "$@"
