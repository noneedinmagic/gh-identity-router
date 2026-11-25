# Environment variables

Every variable the code actually reads or sets, with a one-line purpose. A test
(`test/env-vars.test.mjs`) asserts this table stays in sync with the source.

## Read as input

| Variable | Read in | Purpose |
|---|---|---|
| `AGENT_IDENTITY_GH_BIN` | `src/identity.mjs` | Overrides the `gh` binary used to derive the acting credential — lets tests substitute a fixture without touching the real `gh`. |
| `GH_REPO` | `bin/gh`, `src/identity.mjs` | Selects the target repository owner when `--repo`/`-R` isn't passed explicitly (for `identity.sh`, the owner whose `identity` block applies). |
| `IDENTITY_ROUTER_CONFIG` | `src/multi-account-token.mjs` (also read by `src/identity.mjs`), `src/setup.mjs` | Overrides the config file path (default `~/.config/gh-identity-router/config.json`). |
| `IDENTITY_ROUTER_ORG` | `src/multi-account-token.mjs`, `src/identity.mjs` | Selects the target account when no `--repo`/`GH_REPO`/git-remote owner can be resolved. |
| `IDENTITY_ROUTER_REAL_GH` | `bin/gh` | Overrides the path to the real `gh` binary this wrapper delegates to (default `/usr/bin/gh`). |
| `IDENTITY_ROUTER_TOKEN_COMMAND` | `bin/gh`, `bin/git-credential-gh-identity-router`, `bin/mint-dispatch-token` | Overrides the token-minting command each wrapper shells out to (default `$HOME/.local/bin/multi-account-token`). |
| `IDENTITY_ROUTER_VERIFY_COMMAND` | `src/setup.mjs` | Overrides the command `setup` runs (with `--verify`) to verify the config before and after installing, in place of the source tree's and the installed `multi-account-token`. |

## Read from the agent runtime

Set by the coding agent hosting this tool, not by the user; `src/identity.mjs` reads them
to name the runtime and build the PR footer's session lines.

| Variable | Read in | Purpose |
|---|---|---|
| `AI_AGENT` | `src/identity.mjs` | A value starting `claude-code` identifies the runtime as Claude Code. |
| `CODEX_CLI` | `src/identity.mjs` | Non-empty (alone or with `CODEX_SANDBOX`) identifies the runtime as Codex CLI. |
| `CODEX_SANDBOX` | `src/identity.mjs` | Same as `CODEX_CLI`: non-empty identifies the runtime as Codex CLI. |
| `CLAUDE_CODE_SESSION_ID` | `src/identity.mjs` | The session id printed in the footer's `Session ID` line, so the chat can be resumed. |
| `CLAUDE_CODE_BRIDGE_SESSION_ID` | `src/identity.mjs` | Set only while a Remote Control connection is active; becomes the footer's `RC:` link. |
| `CLAUDE_CODE_CHILD_SESSION` | `src/identity.mjs` | One of three signals that this is a nested/bridged session, which switches the footer to a best-effort guess. |
| `CLAUDE_CODE_BRIDGE_OWNER_ACCOUNT_UUID` | `src/identity.mjs` | Second of the same three bridged-session signals. |
| `CLAUDE_CODE_BRIDGE_OWNER_ORG_UUID` | `src/identity.mjs` | Third of the same three bridged-session signals. |

## Deliberately never read

| Variable | Named in | Why |
|---|---|---|
| `CLAUDE_CODE_SESSION_ACCESS_TOKEN` | `src/identity.mjs` (comment only) | A live credential that sits beside the session id; the code must never read or print it. |

## Not tabled: shell-provided variables

`HOME`, `PWD` and `PATH` are set by the shell on every POSIX system, not by this tool's
environment or its agent runtime, so they're left out of the tables above and excluded in
`test/env-vars.test.mjs` rather than listed. (`PWD` is read by `src/identity.mjs` to prefer
the shell's logical working directory; `HOME` and `PATH` by `src/setup.mjs` and the `bin/`
wrappers.)

## Set as output (not read by this tool)

| Variable | Set in | Purpose |
|---|---|---|
| `GH_TOKEN` | `bin/gh` | Passed to the real `gh` binary so it authenticates as the resolved installation/PAT. |
| `DISPATCH_GH_TOKEN` | `bin/mint-dispatch-token` | Printed for a separate consuming process to pick up and authenticate with. |

**Never** `GH_*`-prefixed for this tool's own config (avoids colliding with `gh` CLI's
own reserved namespace — `GH_TOKEN`, `GH_HOST`, `GH_ENTERPRISE_TOKEN`, etc.). The two
exceptions above (`GH_REPO`, `GH_TOKEN`) are `gh`'s own variables, which this tool
reads/sets deliberately to integrate with it.
