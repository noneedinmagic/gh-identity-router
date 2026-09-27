#!/bin/sh
# Thin shim: all identity-comparison and footer-rendering logic lives in
# src/identity.mjs now (ported from this script's earlier bash implementation). This
# file only resolves the sibling Node script's path and delegates argv/exit code to it.
#
# Usage, exit codes: see src/identity.mjs's own header comment — unchanged from before
# the port.
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$script_dir/../src/identity.mjs" "$@"
