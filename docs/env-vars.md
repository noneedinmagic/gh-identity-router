# Environment variables

Every variable the code actually reads or sets, with a one-line purpose. A test
(`test/env-vars.test.mjs`) asserts this table stays in sync with the source.

## Read as input

| Variable | Read in | Purpose |
|---|---|---|
| `AGENT_IDENTITY_FILE` | `bin/identity.sh` | Overrides the declared-identity file path (default `$HOME/.agent-identity`). |
| `AGENT_IDENTITY_GH_BIN` | `bin/identity.sh` | Overrides the `gh` binary used to derive the acting credential — lets tests substitute a fixture without touching the real `gh`. |
| `GH_REPO` | `bin/gh` | Selects the target repository owner when `--repo`/`-R` isn't passed explicitly. |
| `MULTI_ACCOUNT_CONFIG` | `src/multi-account-token.mjs`, `install.sh` | Overrides the config file path (default `~/.config/gh-multi-account/config.json`). |
| `MULTI_ACCOUNT_ORG` | `src/multi-account-token.mjs` | Selects the target account when no `--repo`/`GH_REPO`/git-remote owner can be resolved. |
| `MULTI_ACCOUNT_REAL_GH` | `bin/gh` | Overrides the path to the real `gh` binary this wrapper delegates to (default `/usr/bin/gh`). |
| `MULTI_ACCOUNT_TOKEN_COMMAND` | `bin/gh`, `bin/multi-account-git-credential`, `bin/mint-dispatch-token` | Overrides the token-minting command each wrapper shells out to (default `$HOME/.local/bin/multi-account-token`). |
| `MULTI_ACCOUNT_VERIFY_COMMAND` | `install.sh` | Overrides the command `install.sh` runs to verify the config before and after installing. |

## Set as output (not read by this tool)

| Variable | Set in | Purpose |
|---|---|---|
| `GH_TOKEN` | `bin/gh` | Passed to the real `gh` binary so it authenticates as the resolved installation/PAT. |
| `DISPATCH_GH_TOKEN` | `bin/mint-dispatch-token` | Printed for a separate consuming process to pick up and authenticate with. |

**Never** `GH_*`-prefixed for this tool's own config (avoids colliding with `gh` CLI's
own reserved namespace — `GH_TOKEN`, `GH_HOST`, `GH_ENTERPRISE_TOKEN`, etc.). The two
exceptions above (`GH_REPO`, `GH_TOKEN`) are `gh`'s own variables, which this tool
reads/sets deliberately to integrate with it.
