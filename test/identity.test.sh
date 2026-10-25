#!/usr/bin/env bash
# Runnable self-check for identity.sh's derivation path (the mode --self-check
# does NOT cover). Pins the `gh auth status` regex against captured fixture
# lines, and drives `--check` end-to-end through AGENT_IDENTITY_GH_BIN with an
# isolated HOME and a config whose identity block is the declaration under test.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT/bin/identity.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }
assert_contains() { case "$1" in *"$2"*) ;; *) fail "expected to find [$2] in:
$1";; esac; }
assert_eq() { [ "$1" = "$2" ] || fail "expected [$2], got [$1]"; }

BIN="$tmp/bin"
mkdir -p "$BIN"

# --- fixture `gh auth status` output, captured shape (bot and human) --------
stub_calls="$tmp/stub-calls.log"
: >"$stub_calls"

# Every stub logs its own invocation — proves --check actually consulted the
# fixture rather than, say, silently falling through to a real `gh` on PATH
# and coincidentally producing the same result on this machine.
GH_BOT="$BIN/gh-bot"
cat >"$GH_BOT" <<EOF
#!/usr/bin/env bash
echo "gh-bot called" >>"$stub_calls"
cat <<'OUT'
github.com
  ✓ Logged in to github.com account example-agent[bot] (/home/example-host/.config/gh/hosts.yml)
  ✓ Git operations for github.com configured to use https protocol.
  ✓ Token: gho_************************************
  ✓ Token scopes: 'repo', 'read:org', 'workflow'
OUT
EOF
chmod +x "$GH_BOT"

GH_HUMAN="$BIN/gh-human"
cat >"$GH_HUMAN" <<EOF
#!/usr/bin/env bash
echo "gh-human called" >>"$stub_calls"
cat <<'OUT'
github.com
  ✓ Logged in to github.com account example-user (keyring)
  ✓ Git operations for github.com configured to use https protocol.
  ✓ Token: gho_************************************
OUT
EOF
chmod +x "$GH_HUMAN"

# --- regex pin: the sed extraction, run directly against captured lines -----
extract() { sed -n 's/.*[Ll]ogged in to github\.com account \([^ ]*\).*/\1/p' | head -n1; }
assert_eq "$("$GH_BOT" | extract)" "example-agent[bot]"
assert_eq "$("$GH_HUMAN" | extract)" "example-user"
echo "OK: regex pinned against bot and human gh auth status fixtures"

# --- isolated project + HOME for end-to-end --check runs --------------------
# The project's origin remote is what routes identity to the `example-org` account entry.
proj="$tmp/proj"
mkdir -p "$proj"
git -C "$proj" init -q
git -C "$proj" config user.email t@example.com
git -C "$proj" remote add origin https://github.com/example-org/repo.git

fake_home="$tmp/home"
mkdir -p "$fake_home"
export IDENTITY_ROUTER_CONFIG="$tmp/config.json"

# write_config <identity-json-or-empty>: the example-org account, always with a credential
write_config() {
  local identity=""
  [ -n "$1" ] && identity=", \"identity\": $1"
  cat >"$IDENTITY_ROUTER_CONFIG" <<EOF
{
  "defaultAccount": "example-org",
  "accounts": {
    "example-org": {
      "accountId": 1,
      "targetType": "organization",
      "credential": { "type": "pat", "tokenPath": "$tmp/unused.token" }$identity
    }
  }
}
EOF
  chmod 600 "$IDENTITY_ROUTER_CONFIG"
}

run_check() {                  # run_check <gh_bin> -> sets OUT, RC; resets stub_calls
  : >"$stub_calls"
  set +e
  OUT="$(cd "$proj" && HOME="$fake_home" AGENT_IDENTITY_GH_BIN="$1" "$SCRIPT" --check 2>&1)"
  RC=$?
  set -e
}

assert_stub_called() {
  [ -s "$stub_calls" ] || fail "expected the stub gh to be consulted, but $stub_calls is empty — --check did not actually go through the fixture"
}

# --- bot derived, matching declared login -> OK, silent, exit 0 -------------
write_config '{ "login": "example-agent", "displayName": "Example Agent" }'
run_check "$GH_BOT"
assert_eq "$RC" 0
assert_eq "$OUT" ""
assert_stub_called
echo "OK: --check silent success, bot derived via gh auth status"

# --- --footer end-to-end: footerHost overrides/suppresses hostname ---------
footer_out="$(cd "$proj" && HOME="$fake_home" AGENT_IDENTITY_GH_BIN="$GH_BOT" "$SCRIPT" --footer)"
assert_contains "$footer_out" "on \`$(hostname)\`"
echo "OK: --footer with no footerHost uses real hostname"

write_config '{ "login": "example-agent", "displayName": "Example Agent", "footerHost": "example" }'
footer_out="$(cd "$proj" && HOME="$fake_home" AGENT_IDENTITY_GH_BIN="$GH_BOT" "$SCRIPT" --footer)"
assert_contains "$footer_out" "on \`example\`"
echo "OK: --footer with footerHost: example overrides hostname"

write_config '{ "login": "example-agent", "displayName": "Example Agent", "footerHost": "" }'
footer_out="$(cd "$proj" && HOME="$fake_home" AGENT_IDENTITY_GH_BIN="$GH_BOT" "$SCRIPT" --footer)"
case "$footer_out" in
  *' on `'*) fail "expected the host clause to be omitted, got:
$footer_out" ;;
esac
echo "OK: --footer with footerHost: \"\" suppresses the host clause"

# --- bot derived, mismatched declared login -> MISMATCH, names the path ------
write_config '{ "login": "example-agent-two", "displayName": "Example Agent Two" }'
run_check "$GH_BOT"
assert_eq "$RC" 1
assert_contains "$OUT" "MISMATCH"
assert_contains "$OUT" "derived via gh auth status"
assert_stub_called
echo "OK: --check MISMATCH names gh auth status as the derivation path"

# --- same mismatch, through the bare (no-args) block-printing path, which
# shares the derived_source global with --check but is otherwise unexercised
set +e
bare_out="$(cd "$proj" && HOME="$fake_home" AGENT_IDENTITY_GH_BIN="$GH_BOT" "$SCRIPT" 2>&1)"
bare_rc=$?
set -e
assert_eq "$bare_rc" 1
assert_contains "$bare_out" "MISMATCH"
assert_contains "$bare_out" "derived via gh auth status"
echo "OK: bare identity.sh block also names the derivation path"

# --- human derived via gh, credential-only owner -> REFUSED, names the path --
write_config ''
run_check "$GH_HUMAN"
assert_eq "$RC" 2
assert_contains "$OUT" "REFUSED"
assert_contains "$OUT" "derived via gh auth status"
assert_stub_called
echo "OK: --check REFUSED names gh auth status as the derivation path"

# --- gh unavailable -> falls back to git config user.name, names that path --
git -C "$proj" config user.name example-user
run_check "$tmp/no-such-gh-binary"
assert_eq "$RC" 2
assert_contains "$OUT" "REFUSED"
assert_contains "$OUT" "derived via git config user.name"
[ ! -s "$stub_calls" ] || fail "expected no gh stub to be reachable, but $stub_calls is non-empty"
echo "OK: --check falls back to git config user.name and says so"

# --- kind: human declared and matching -> --check OK, but --footer refuses --
write_config '{ "login": "example-user", "displayName": "A Human", "kind": "human" }'
run_check "$GH_HUMAN"
assert_eq "$RC" 0
assert_eq "$OUT" ""
assert_stub_called
echo "OK: --check allows a declared kind: human account matching the derived login"

set +e
footer_out="$(cd "$proj" && HOME="$fake_home" AGENT_IDENTITY_GH_BIN="$GH_HUMAN" "$SCRIPT" --footer 2>&1)"
footer_rc=$?
set -e
assert_eq "$footer_rc" 2
assert_contains "$footer_out" "REFUSED: kind: human is declared"
echo "OK: --footer refuses to attach an agent footer to a kind: human PR"

# --- an owner that is not allow-listed gets no identity, not the default's ---
write_config '{ "login": "example-agent" }'
git -C "$proj" remote set-url origin https://github.com/outsider/repo.git
run_check "$GH_BOT"
assert_eq "$RC" 2
assert_contains "$OUT" "not allow-listed: outsider"
echo "OK: --check refuses an owner outside the allow-list instead of using defaultAccount"
git -C "$proj" remote set-url origin https://github.com/example-org/repo.git

# Note: a pre-push git hook that calls identity.sh --check is not part of
# this package's snapshot — that's a per-consuming-project integration, wired
# up separately for each project's own config path.

# Invoked through a symlink (relative, chained), the shim must still find src/identity.mjs.
mkdir -p "$tmp/link-a" "$tmp/link-b"
ln -s "$SCRIPT" "$tmp/link-a/identity.sh"
ln -s ../link-a/identity.sh "$tmp/link-b/identity.sh"
link_out="$("$tmp/link-b/identity.sh" --self-check 2>&1)" || fail "symlinked identity.sh failed: $link_out"
echo "OK: shim resolves src/identity.mjs through a chained symlink"

echo "all identity.sh / pre-push checks passed"
