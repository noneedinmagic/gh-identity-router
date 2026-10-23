#!/usr/bin/env bash
# Manual verification tool, not wired into `npm test`: runs two versions of
# bin/identity.sh side by side across a battery of modes and identity-file states, and
# fails loudly on any stdout/stderr/exit-code difference between them.
#
# Built to verify the bash -> Node port of bin/identity.sh's logic (see the PR that
# introduced src/identity.mjs) byte-for-byte before merging. Useful again for any future
# change that's meant to be behavior-preserving — a refactor, a second port, a dependency
# bump that touches this script's output format.
#
# Usage:
#   scripts/identity-differential-check.sh <repo-root> <old-script-path>
#
# <repo-root>/bin/identity.sh is treated as the "new" script. <old-script-path> is
# whatever you're diffing against — e.g. a prior revision checked out to a temp file:
#   git show <old-ref>:bin/identity.sh > /tmp/old-identity.sh && chmod +x /tmp/old-identity.sh
#   scripts/identity-differential-check.sh "$PWD" /tmp/old-identity.sh
set -euo pipefail

REPO="$1"
OLD_SCRIPT="$2"
NEW_SCRIPT="$REPO/bin/identity.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

BIN="$tmp/bin"
mkdir -p "$BIN"

GH_BOT="$BIN/gh-bot"
cat >"$GH_BOT" <<'EOF'
#!/usr/bin/env bash
cat <<'OUT'
github.com
  ✓ Logged in to github.com account example-agent[bot] (/home/example-host/.config/gh/hosts.yml)
  ✓ Git operations for github.com configured to use https protocol.
OUT
EOF
chmod +x "$GH_BOT"

GH_HUMAN="$BIN/gh-human"
cat >"$GH_HUMAN" <<'EOF'
#!/usr/bin/env bash
cat <<'OUT'
github.com
  ✓ Logged in to github.com account example-user (keyring)
OUT
EOF
chmod +x "$GH_HUMAN"

proj="$tmp/proj"
mkdir -p "$proj"
git -C "$proj" init -q
git -C "$proj" config user.email t@example.com
git -C "$proj" config user.name example-user

fake_home="$tmp/home"
mkdir -p "$fake_home"

total=0
failed=0

write_identity() {
  cat >"$fake_home/.agent-identity"
}

run_both() {  # run_both <label> <gh_bin> <extra_args...>
  local label="$1" gh_bin="$2"
  shift 2
  total=$((total + 1))

  local old_out old_rc new_out new_rc
  set +e
  old_out="$(cd "$proj" && HOME="$fake_home" AGENT_IDENTITY_GH_BIN="$gh_bin" "$OLD_SCRIPT" "$@" 2>&1)"
  old_rc=$?
  new_out="$(cd "$proj" && HOME="$fake_home" AGENT_IDENTITY_GH_BIN="$gh_bin" "$NEW_SCRIPT" "$@" 2>&1)"
  new_rc=$?
  set -e

  if [[ "$old_out" != "$new_out" || "$old_rc" != "$new_rc" ]]; then
    failed=$((failed + 1))
    echo "DIFF: $label"
    echo "  old (rc=$old_rc): $old_out"
    echo "  new (rc=$new_rc): $new_out"
  else
    echo "match: $label (rc=$old_rc)"
  fi
}

# --- matching identity, bot-shaped derivation --------------------------------
write_identity <<'EOF'
display_name: Example Agent
app:          example-agent
EOF
run_both "matching, bare" "$GH_BOT"
run_both "matching, --footer" "$GH_BOT" --footer
run_both "matching, --footer Custom Runtime" "$GH_BOT" --footer "Custom Runtime"
run_both "matching, --check" "$GH_BOT" --check
run_both "matching, --self-check" "$GH_BOT" --self-check
run_both "matching, bogus arg" "$GH_BOT" --bogus

# --- mismatched declared app --------------------------------------------------
write_identity <<'EOF'
display_name: Someone Else
app:          someone-else
EOF
run_both "mismatched, bare" "$GH_BOT"
run_both "mismatched, --footer" "$GH_BOT" --footer
run_both "mismatched, --check" "$GH_BOT" --check

# --- kind: human, matching ----------------------------------------------------
write_identity <<'EOF'
display_name: A Human
app:          example-user
kind:         human
EOF
run_both "kind human matching, bare" "$GH_HUMAN"
run_both "kind human matching, --footer" "$GH_HUMAN" --footer
run_both "kind human matching, --check" "$GH_HUMAN" --check

# --- unfilled <placeholder> ---------------------------------------------------
write_identity <<'EOF'
display_name: <your display name>
app:          <your GitHub login>
EOF
run_both "unfilled template, bare" "$GH_BOT"
run_both "unfilled template, --check" "$GH_BOT" --check

# --- empty host: --------------------------------------------------------------
write_identity <<'EOF'
display_name: Example Agent
app:          example-agent
host:
EOF
run_both "empty host, --footer" "$GH_BOT" --footer

# --- no identity file at all --------------------------------------------------
rm -f "$fake_home/.agent-identity"
run_both "no identity file, bot, bare" "$GH_BOT"
run_both "no identity file, human, --check" "$GH_HUMAN" --check

# --- gh unreachable, git config fallback --------------------------------------
run_both "gh unreachable, --check" "$tmp/no-such-gh"

# --- bridged session guess, inside a bridge-cse_ directory --------------------
bridge_dir="$tmp/.claude/worktrees/bridge-cse_ABC123"
mkdir -p "$bridge_dir"
git -C "$bridge_dir" init -q
git -C "$bridge_dir" config user.email t@example.com
git -C "$bridge_dir" config user.name example-user
write_identity <<'EOF'
display_name: Example Agent
app:          example-agent
EOF

old_out="$(cd "$bridge_dir" && HOME="$fake_home" AGENT_IDENTITY_GH_BIN="$GH_BOT" CLAUDE_CODE_CHILD_SESSION=1 "$OLD_SCRIPT" --footer 2>&1)"
new_out="$(cd "$bridge_dir" && HOME="$fake_home" AGENT_IDENTITY_GH_BIN="$GH_BOT" CLAUDE_CODE_CHILD_SESSION=1 "$NEW_SCRIPT" --footer 2>&1)"
total=$((total + 1))
if [[ "$old_out" != "$new_out" ]]; then
  failed=$((failed + 1))
  echo "DIFF: bridged session guess"
  echo "  old: $old_out"
  echo "  new: $new_out"
else
  echo "match: bridged session guess"
fi

echo "---"
echo "$total scenarios, $failed diffs"
[[ "$failed" -eq 0 ]]
