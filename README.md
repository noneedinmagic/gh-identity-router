# gh-identity-router

> **Pre-release.** v0.1 is not yet published. The `bin`/`src` layout, config schema,
> and environment variable names described here reflect this repo's *current*
> behavior (extracted from an earlier, private tool) and are expected to change
> before the first npm release — in particular the `MULTI_ACCOUNT_*` env vars and
> `~/.config/gh-multi-account/` paths below will be renamed. See open issues for
> what's planned. APIs and schema may change without notice until v0.1 ships.

Any coding-agent identity can be backed by its own GitHub App, with a distinct
installation on each GitHub account it needs to act on. Each installation has its own
short-lived token and repository boundary. The helpers here select the installation
from the target repository owner.

Two identities on one machine can both need to reach the same accounts — say, a
personal installation on `your-user` and an organization installation on `your-org`.
Each identity runs its own copy of this tool, with its own App, private key, and
`~/.config/gh-multi-account/config.json`. Configuration and credentials are per-home,
uncommitted, and never belong in this repository. If two identities share one Unix
home instead, they must provide distinct config paths with `MULTI_ACCOUNT_CONFIG`.

## Identity isolation: what this tool does and doesn't cover

Per-owner routing (below) isolates the **token**, the **commit author** (with the
`includeIf` setup described later in this doc), and the **PR footer**. It does
**not** isolate anything in an agent's own `$HOME` — shared agent memory, global
instructions, prompt history, or session transcripts all still leak across every
identity that shares an OS user. If an identity must not share another identity's
agent context at all, give it its own OS user, not just its own account entry.

## Security model

- The local config is an allow-list. The helper never mints a token for an account
  that is not present in `accounts`.
- Before minting, it confirms that GitHub reports the configured numeric account ID,
  login, target type, installation ID, and active status.
- `multi-account-token --verify` reports missing, suspended, mismatched, and
  unexpected public installations. Unexpected installations make verification fail
  but are not accessed.
- Tokens are written only to standard output for the calling credential process.
  They are not cached or logged by this tool — but a *separately configured* generic
  `credential.helper` (added before or after install) can still capture and persist
  a token, since it also receives Git's `store` call. Don't add one after installing;
  check with `git config --global --get-all credential.helper`.
- The App private key can mint tokens for every installation, so keep it readable
  only by the local user and rotate it if the machine is compromised.
- By default a minted App-installation token carries its installation's full
  repository set at full permission. Pass `--repositories <name>[,<name>...]` and/or
  `--permissions <key=value>[,...]` to request a narrower token instead — both are
  forwarded to GitHub's `POST /app/installations/{id}/access_tokens`, which does the
  actual narrowing. Neither flag applies to a PAT-typed account (a PAT's scope is
  fixed when it's created, not per-request).
- Tokens are scoped to the **owner** an App installation covers, not to a specific
  repository within it. If that installation is configured for "all repositories"
  rather than "selected repositories," any git operation against that owner —
  including one triggered by an unrelated checkout in the same session — silently
  receives a token scoped to the whole installation. Use "selected repositories"
  installations for anything you don't want broadly scoped.

## Configuration

A legacy single-installation config already contains the App ID and private-key path.
Use it to discover every installation without minting or printing a token:

```bash
MULTI_ACCOUNT_CONFIG=~/.config/gh-multi-account/config-alt.json \
  ./src/multi-account-token.mjs --discover-installations
```

The command prints login, numeric account and installation IDs, target type,
repository selection, and active/suspended state. Copy `config.example.json` to:

```text
~/.config/gh-multi-account/config.json
```

Populate it with the discovered IDs. Reuse the existing private-key path; do not copy
the key. `your-user` is a `User`; `your-org` is an `Organization`. Keep account keys
lowercase and set private permissions on both config and key files:

```bash
chmod 600 ~/.config/gh-multi-account/config.json
chmod 600 /path/from/privateKeyPath
```

No access token is stored in this file. The helper creates a new installation token
for each command.

## PAT-typed accounts

An account entry can be backed by a fine-grained personal access token instead of a
GitHub App installation — set `"type": "pat"` and a `tokenPath` instead of
`installationId`, as `contractor-org` does in `config.example.json`. An entry with no
`type` field is treated as App-typed for backward compatibility; a new PAT entry
should always set `"type": "pat"` explicitly.

- **Fine-grained only.** Classic PATs are not supported: one classic token can span
  every organization its underlying user can reach, which has no single account entry
  to sit under. A fine-grained PAT is locked to one resource owner at creation,
  matching the owner-keyed `accounts` map. `readPatToken` rejects any file whose
  contents don't start with the `github_pat_` prefix, so a classic token in
  `tokenPath` fails closed instead of silently spanning more owners than its entry
  implies.
- **The token lives in `tokenPath`, not in `config.json`.** Create it with
  `chmod 600` (or equivalent), same as the private key:

  ```bash
  install -m 600 /dev/stdin ~/.config/gh-multi-account/tokens/contractor-org.token <<<"github_pat_..."
  ```

- **`defaultAccount` must stay App-typed whenever the config also has an App-typed
  account.** A PAT-typed default is only allowed in a config with no App entries at
  all (a pure-PAT host). This bounds the damage of an unresolved selector that falls
  through to the default: a wrong-owner App token is dead within the hour, while a
  wrong-owner PAT default is a long-lived static secret that a misconfigured
  `credential.helper` can persist in plaintext.
- **One owner, one credential.** An owner cannot hold both an App and a PAT entry.
- **`--verify` for a PAT entry is weaker than for an App entry, and cannot prove
  scope.** It checks that `tokenPath` is 0600, that the token is live
  (`GET /rate_limit` returns 200), and that the configured `accountId`/`targetType`
  match the real owner. It cannot prove the token is actually *scoped* to that
  owner — fine-grained PATs carry implicit public read, so a PAT filed under the
  wrong owner verifies clean and only fails at use time (a 404).
- **Fine-grained PATs expire silently.** GitHub's default organization policy caps
  them at 366 days, and nothing local re-mints one — unlike an App installation
  token, which self-heals every hour. Re-run `--verify` periodically to catch an
  expired PAT before it fails a real command.

## Validate and install

```bash
npm test
./install.sh --dry-run
```

Review the dry-run and run a live verification from the source tree before
installing:

```bash
./src/multi-account-token.mjs --verify
./install.sh
```

The installer repeats live verification before any mutation, backs up replaced files
and the exact targeted Git credential settings, installs the helpers, and verifies
again. A post-mutation failure triggers automatic restoration. Backups live under
`~/.local/state/gh-multi-account/backups/<timestamp>-<pid>/`. The installer never
creates, overwrites, or backs up the live config or private key.

It configures Git to include the repository path in credential-helper requests:

```ini
credential.https://github.com.useHttpPath=true
```

That setting allows `your-org/repository.git` and `your-user/repository.git` to
select different installations.

## Selection behavior

For `gh`, selection order is:

1. `-R` or `--repo`
2. `GH_REPO`
3. the current repository's `origin` URL
4. `MULTI_ACCOUNT_ORG`
5. `defaultAccount`

Examples:

```bash
gh pr list --repo your-org/example
GH_REPO=your-org/example gh pr list
cd /path/to/a/your-org/clone && gh repo view
MULTI_ACCOUNT_ORG=your-org gh api /orgs/your-org
```

If a repository owner is detected but is not allow-listed, the command fails. It does
not fall back to the default account. A selector that was *supplied but cannot be
parsed* — a `--repo owner` missing the `/repo` segment, a non-`github.com` host, an
unparseable remote URL — is treated the same way: it fails with the offending string
named, rather than silently falling through to `defaultAccount`.

For HTTPS Git operations, the credential helper reads the owner from the credential
path. Continue using HTTPS remotes; commit `user.name` and `user.email` settings are
independent of authentication and can remain the identity's own bot login.

## Per-org commit author

That independence cuts both ways: selecting a different token per owner never changes
who a commit says it's from. With one global `user.name`/`user.email`, every commit
on the machine is authored and committed as that identity, in every org's repo,
whichever App or PAT later pushes it. An org that must not see this home's identity
(a separate bot for an external org) needs its own author, routed by remote URL with
Git's native `includeIf` (Git 2.36+):

```ini
# ~/.gitconfig
[user]
    name = <home-identity>
    email = <home-identity-email>

# Must come after the [user] section above: git parses the file top-to-bottom and the
# last value for a key wins, so an includeIf placed before [user] gets its org-specific
# name/email silently overwritten by the block below it.
[includeIf "hasconfig:remote.*.url:https://github.com/<org>/**"]
    path = ~/.config/git/<org>.gitconfig

# ~/.config/git/<org>.gitconfig — [user] only
[user]
    name = <org-bot>[bot]
    email = <id>+<org-bot>[bot]@users.noreply.github.com
```

Verify from inside a clone: `git config --show-origin --get user.name` must name the
per-org file. Worktrees of that clone inherit it.

A miss is silent: git falls back to the global identity, which is exactly the leak
this prevents. Checked on Git 2.53 against the pattern above, each of these fell back:

- different case in the owner (`https://github.com/<Org>/repo`) — the match is
  case-sensitive even though GitHub URLs aren't;
- a username in the URL (`https://user@github.com/<org>/repo`);
- an SSH remote (`git@github.com:<org>/repo.git`) — not used here anyway (HTTPS only,
  see above).

The opposite mistake is silent too: `hasconfig:remote.*.url` matches *any* configured
remote, not just `origin`. A home-org clone with `origin` pointing home but a second
remote (`upstream`, a fork) under `<org>` still matches the pattern and picks up
`<org>`'s identity, misattributing commits pushed to the home-org `origin`.

So check every remote — `git remote -v`, not just `git remote get-url origin` — in
every existing clone of the org's repos, and keep the per-org file to
`[user]`-style settings: git refuses a `[remote]` section in any file included
through `hasconfig:remote.*.url`.

## Failure modes

The credential helper mints the token before printing anything; if minting fails, the
helper exits non-zero with nothing on stdout, so Git surfaces the real auth failure
instead of sending an empty password. Every GitHub API request made while minting a
token times out after 10 seconds rather than hanging on a stalled connection.

## Inventory across accounts

An installation token is scoped to one GitHub App installation. Consequently, neither
`gh repo list` nor a single `/installation/repositories` request can produce the
complete repository inventory across configured users and organizations.

When the requested scope is "all accessible repositories", read the account names
from the `accounts` object in the local allow-list and query each one explicitly. Run
account-selected commands outside a Git worktree — the current repository's `origin`
has higher selection precedence than `MULTI_ACCOUNT_ORG` by design.

```bash
(
  cd /tmp
  MULTI_ACCOUNT_ORG=your-user \
    gh api --paginate '/installation/repositories?per_page=100' \
    --jq '.repositories[].full_name'
)

(
  cd /tmp
  MULTI_ACCOUNT_ORG=your-org \
    gh api --paginate '/installation/repositories?per_page=100' \
    --jq '.repositories[].full_name'
)
```

Aggregate and de-duplicate the output. If any account cannot be queried, identify that
account and describe the inventory as incomplete. Do not fall back to
`defaultAccount` and present its result as exhaustive.

## Repository migration between accounts

1. Make the App public and install it on the destination account, granting only the
   repositories and permissions it needs.
2. Add the verified account and installation IDs to the local config.
3. Run `multi-account-token --verify`; resolve every error before moving
   repositories.
4. Transfer the selected repository on GitHub.
5. Update every local clone instead of relying on GitHub's redirect:

   ```bash
   git remote set-url origin https://github.com/DESTINATION/REPOSITORY.git
   ```

6. Confirm the correct remote and credentials:

   ```bash
   git remote -v
   git fetch origin
   git push --dry-run origin HEAD
   gh repo view
   ```

7. Remove the old installation's access to a transferred repository only after all
   clones and automation use the new owner.

## Rollback

The successful installer prints the exact restore command:

```bash
./install.sh --restore ~/.local/state/gh-multi-account/backups/TIMESTAMP-PID
```

Restore accepts only a valid manifest below the current home's managed backup root.
It restores the exact prior files and values (including absent and empty Git
settings) for `credential.https://github.com.{helper,username,useHttpPath}`. It does
not change the live config or private key.

## Contributing

External contributions aren't accepted yet — this repo is pre-release and the
license/CLA policy is still settling. Feel free to open an issue.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
