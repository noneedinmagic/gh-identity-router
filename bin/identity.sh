#!/bin/sh
# Thin shim: all identity-comparison and footer-rendering logic lives in
# src/identity.mjs now (ported from this script's earlier bash implementation). This
# file only resolves the Node script's path and delegates argv/exit code to it.
#
# Two layouts: a checkout (bin/identity.sh + src/identity.mjs) and the installed one
# (~/.local/bin/identity.sh + ~/.local/share/gh-multi-account/identity.mjs, which sits
# beside multi-account-token.mjs so its relative import resolves).
#
# Usage, exit codes: see src/identity.mjs's own header comment — unchanged from before
# the port.
set -eu

# Follow symlinks so a linked invocation resolves src/ relative to the real script.
self=$0
while [ -L "$self" ]; do
  target=$(readlink -- "$self")
  case $target in
    /*) self=$target ;;
    *) self=$(dirname -- "$self")/$target ;;
  esac
done
script_dir=$(CDPATH= cd -- "$(dirname -- "$self")" && pwd)
script=$script_dir/../src/identity.mjs
[ -f "$script" ] || script=$script_dir/../share/gh-multi-account/identity.mjs
exec node "$script" "$@"
