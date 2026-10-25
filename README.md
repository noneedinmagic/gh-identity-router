# gh-identity-router

> **Pre-release.** v0.1 is not yet published. The `bin`/`src` layout, config schema,
> and environment variable names described here reflect this repo's *current*
> behavior (extracted from an earlier, private tool) and are expected to change
> before the first npm release. See open issues for what's planned. APIs and schema
> may change without notice until v0.1 ships.
>
> Upgrading from the earlier `gh-multi-account` names: env vars are now
> `IDENTITY_ROUTER_*`, state lives under `gh-identity-router/` directories
> (`~/.config`, `~/.local/share`, `~/.local/state`), and the Git credential helper is
> `git-credential-gh-identity-router`. Move your old config directory over, then
> update the absolute `privateKeyPath` and any PAT `tokenPath` values in its
> `config.json` (they still point under `~/.config/gh-multi-account`), e.g.
> `sed -i 's#/gh-multi-account/#/gh-identity-router/#g' ~/.config/gh-identity-router/config.json`.
> Then re-run `gh-identity-router setup`; remove the stale `~/.local/bin/multi-account-git-credential`
> by hand.
>
> The account entry schema also changed: App/PAT settings now live in a per-entry
> `credential` block (no top-level `appId`/`privateKeyPath`, no flat `type`,
> `installationId`, or `tokenPath`), and the per-`$HOME` `~/.agent-identity` file is
> retired in favor of an optional per-entry `identity` block. A config in the old shape
> is rejected with a message naming what to move. See [Configuration](#configuration)
> and `config.example.json`.

Any coding-agent identity can be backed by its own GitHub App, with a distinct
installation on each GitHub account it needs to act on. Each installation has its own
short-lived token and repository boundary. The helpers here select the installation
from the target repository owner.

Two identities on one machine can both need to reach the same accounts — say, a
personal installation on `your-user` and an organization installation on `your-org`.
Each identity runs its own copy of this tool, with its own App, private key, and
`~/.config/gh-identity-router/config.json`. Configuration and credentials are per-home,
uncommitted, and never belong in this repository. If two identities share one Unix
home instead, they must provide distinct config paths with `IDENTITY_ROUTER_CONFIG`.

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

Copy `config.example.json` to:

```text
~/.config/gh-identity-router/config.json
```

Each `accounts.<owner>` entry (keys must be lowercase GitHub logins — a mixed-case key is
rejected with an error, not normalized) has `accountId`,
`targetType` (`user` or `organization`; case-insensitive, stored lowercase), an optional
`host` (only `github.com` is supported; the field exists so GitHub Enterprise Server can be added later without a
breaking change), and two independent, optional blocks — at least one is required:

- `credential` — how to get a token for this owner. `type: "app"` takes `appId`,
  `privateKeyPath`, and `installationId`; `type: "pat"` takes `tokenPath`. Every entry is
  self-contained: two owners can use two different Apps, and there is no top-level App
  pair to fall back to. An App has one `privateKeyPath`, repeated on each of its entries.
- `identity` — who the agent is when acting on this owner: `login` (required), and
  optional `displayName`, `footerHost`, `kind` (`agent`, the default, or `human`),
  `commitName`, and `commitEmail`. See [Identity and the PR footer](#identity-and-the-pr-footer).

`defaultAccount` names the entry used for **token routing only**, when no owner can be
resolved for a `gh` call. It never supplies an identity.

To find the installation IDs for an App, run discovery against a small bootstrap config
that holds just the App pair (`{"appId": ..., "privateKeyPath": ...}`) — the only place
the flat pair is still read, since discovery runs before any account entry exists. Nothing
installs it: copy [`bootstrap.example.json`](bootstrap.example.json) from this repository
and fill in your App's values:

```bash
cp bootstrap.example.json ~/.config/gh-identity-router/bootstrap.json
chmod 600 ~/.config/gh-identity-router/bootstrap.json
IDENTITY_ROUTER_CONFIG=~/.config/gh-identity-router/bootstrap.json \
  ./src/multi-account-token.mjs --discover-installations
```

The command prints login, numeric account and installation IDs, target type,
repository selection, and active/suspended state, without minting or printing a token.
Populate each entry's `credential` block with the discovered IDs. Keep account keys
lowercase and set private permissions on both config and key files:

```bash
chmod 600 ~/.config/gh-identity-router/config.json
chmod 600 /path/from/privateKeyPath
```

No access token is stored in this file. The helper creates a new installation token
for each command.

## Identity and the PR footer

`identity.sh` compares the `identity.login` an owner declares against the login that
actually authenticates `gh` (`gh auth status`, falling back to `git config user.name`),
and renders the PR footer from the same block. The owner is resolved like a token's, from
`GH_REPO`, then the current repository's `origin`, then `IDENTITY_ROUTER_ORG` — but never
`defaultAccount`.

| `credential` | `identity` | Token minted? | Footer printed? |
|---|---|---|---|
| yes | yes | yes | yes |
| yes | no | yes | no (exit 2) |
| no | yes | no (exit 3; `gh` and Git use their own credential) | yes, if the derived login matches `identity.login` |
| no | no | — | — (the config is invalid) |

An owner that is absent from `accounts`, or cannot be resolved at all, gets no token and
no footer. `identity.sh` exits 0 when the declaration holds, 1 on a login mismatch, and 2
when it refuses: no identity applies, the owner has no `identity` block (so no signer is
declared), or the derived login is a person's account the declaration doesn't vouch for.
This holds for `--check` as well as `--footer`, so a pre-push hook that calls
`identity.sh --check` blocks pushes to a credential-only owner until it declares an
`identity`. Nothing is printed to stdout on a refusal.

A login that is not a GitHub App (`name[bot]`) is accepted only when `identity.login`
names exactly that login **and** either `kind` is `human` (the machine's owner acting
directly — never given an agent footer) or the entry's credential is a PAT (a purpose-made
machine user). `footerHost` omitted means "use this machine's hostname"; an empty string
omits the host from the footer.

When `multi-account-token` finds an identity-only owner it exits 3 with nothing on
stdout. The `gh` wrapper then runs the real `gh` unchanged, so `gh` uses its own login.
This is intentional: an identity-only owner means "use this machine's own `gh`
credential", and `identity.login` only gates `identity.sh` and the footer — it does not
stop `gh` from acting as whatever account is logged in. Add a `credential` block if you
want the router to supply the token instead. The Git credential helper answers nothing,
but `setup` clears the other github.com helpers, so HTTPS Git for an identity-only
owner has no credential unless you configure another helper after this one.

**The footer follows the owner it resolves, not the pull request's target.** In a fork
clone (`origin` is your fork, the PR goes to another owner) or with
`gh pr create --repo other-org/x`, `identity.sh --footer` would use `origin`'s identity
block. Run it with the same `GH_REPO` the PR is created against, e.g.
`GH_REPO=other-org/x identity.sh --footer`.

## PAT-typed accounts

An account entry can be backed by a fine-grained personal access token instead of a
GitHub App installation — give its `credential` block `"type": "pat"` and a `tokenPath`,
as `contractor-org` does in `config.example.json`.

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
  install -m 600 /dev/stdin ~/.config/gh-identity-router/tokens/contractor-org.token <<<"github_pat_..."
  ```

- **`defaultAccount` must not hold a PAT credential whenever the config also has an
  App-typed account.** A PAT default is only allowed in a config with no App entries at
  all (a pure-PAT host); an identity-only default mints nothing and is always fine. This bounds the damage of an unresolved selector that falls
  through to the default: a wrong-owner App token is dead within the hour, while a
  wrong-owner PAT default is a long-lived static secret that a misconfigured
  `credential.helper` can persist in plaintext.
- **One owner, one credential.** An entry has a single `credential` block, so an owner
  cannot hold both an App and a PAT.
- **A PAT acts as whoever owns it, and that must be a machine user.** A fine-grained
  PAT's acting login is the account that created it, independent of the owner it is
  scoped to. Declare that login as the entry's `identity.login`; `--verify` then checks
  `GET /user` against it. Use a purpose-made machine user, never a third party's token:
  it would attribute commits and comments to a real person who did not write them. The
  tool cannot tell a machine user from someone else's account by login alone, so this is
  a rule the declaration attests to, not one it can prove.
- **`--verify` for a PAT entry is weaker than for an App entry, and cannot prove
  scope.** It checks that `tokenPath` is 0600, that the token is live
  (`GET /rate_limit` returns 200), and that the configured `accountId`/`targetType`
  match the real owner (and, if the entry declares an `identity`, that the token acts
  as `identity.login`). It cannot prove the token is actually *scoped* to that
  owner — fine-grained PATs carry implicit public read, so a PAT filed under the
  wrong owner verifies clean and only fails at use time (a 404).
- **Fine-grained PATs expire silently.** GitHub's default organization policy caps
  them at 366 days, and nothing local re-mints one — unlike an App installation
  token, which self-heals every hour. Re-run `--verify` periodically to catch an
  expired PAT before it fails a real command.

## Validate and install

```bash
npm test
node bin/gh-identity-router.mjs setup --dry-run
```

Review the dry-run and run a live verification from the source tree before
installing:

```bash
./src/multi-account-token.mjs --verify
node bin/gh-identity-router.mjs setup
```

(`bin/gh-identity-router.mjs` is the package's `gh-identity-router` executable.) `setup`
checks that the Node.js it is running under works and is `>=20`, repeats live
verification before any mutation, backs up replaced files and the exact targeted Git
credential settings, installs the helpers, and verifies again. A post-mutation failure
triggers automatic restoration. Backups live under
`~/.local/state/gh-identity-router/backups/<timestamp>-<pid>/`. Setup never creates,
overwrites, or backs up the live config or private key.

The installed `multi-account-token` is a small launcher with the absolute path of that
Node.js baked in at setup time, so a later shell with no `node` on `PATH` (or a version
manager that has not activated one) still works. Pass `--node /abs/path/to/node` to
bake a different Node.js. Re-run `setup` after moving or removing the one it baked.

Check an existing install at any time, without changing anything:

```bash
gh-identity-router setup --verify
```

It confirms the installed files, the baked Node.js, the Git credential settings, the
commit-author includes (below), and live credentials, and that `command -v gh` resolves
to the installed wrapper (`~/.local/bin/gh`) rather than a `gh` earlier on `PATH`.
Plain `setup` only warns about that last one, since `~/.local/bin` is often not on
`PATH` yet at first install.

It also installs `identity.sh` into `~/.local/bin` and its Node implementation,
`identity.mjs`, into `~/.local/share/gh-identity-router/`, so `identity.sh --footer`
works without a checkout. A backup taken by an earlier installer has no record of those
two files; restoring it treats them as absent and removes them. (`identity.sh` itself
still runs whichever `node` is first on `PATH`.)

It installs the credential helper as `~/.local/bin/git-credential-gh-identity-router`
and registers it by absolute path, so Git finds it without `~/.local/bin` on `PATH`. It
also configures Git to include the repository path in
credential-helper requests:

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
4. `IDENTITY_ROUTER_ORG`
5. `defaultAccount`

Examples:

```bash
gh pr list --repo your-org/example
GH_REPO=your-org/example gh pr list
cd /path/to/a/your-org/clone && gh repo view
IDENTITY_ROUTER_ORG=your-org gh api /orgs/your-org
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
Git's native `includeIf` (Git 2.36+).

`gh-identity-router setup` generates this for every account whose `identity` sets
`commitName` and `commitEmail` (both or neither; setup refuses half an author). For each
owner it writes `~/.local/share/gh-identity-router/git/<owner>.gitconfig` (a `[user]`
section only) and adds this to `~/.gitconfig`, after your existing `[user]` section:

```ini
[includeIf "hasconfig:remote.*.url:https://github.com/<owner>/**"]
    path = ~/.local/share/gh-identity-router/git/<owner>.gitconfig
```

Re-running `setup` rewrites its own entries; `uninstall` removes them. Includes that
point anywhere else are never touched. To do it by hand instead, put the same two
pieces in place yourself, keeping the `includeIf` below the global `[user]` section:
git parses the file top-to-bottom and the last value for a key wins, so an include
placed before `[user]` gets its org-specific name/email silently overwritten.

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
has higher selection precedence than `IDENTITY_ROUTER_ORG` by design.

```bash
(
  cd /tmp
  IDENTITY_ROUTER_ORG=your-user \
    gh api --paginate '/installation/repositories?per_page=100' \
    --jq '.repositories[].full_name'
)

(
  cd /tmp
  IDENTITY_ROUTER_ORG=your-org \
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

```bash
gh-identity-router uninstall
```

restores the state from before the **first** `setup` (so running `setup` twice and then
`uninstall` still undoes everything): the prior files at every installed path, the exact
prior values (including absent and empty Git settings) for
`credential.https://github.com.{helper,username,useHttpPath}`, and the prior commit-author
includes. It removes the generated fragments. (If you installed with the old `install.sh`,
the first `setup` records *that* install as its baseline; to get back to the state before
it, run `uninstall --backup` with your oldest backup under
`~/.local/state/gh-identity-router/backups/`.) `uninstall --backup DIR` restores a specific
backup instead (for example the one `setup` printed).

Restore accepts only a valid manifest below the current home's managed backup root.
Backups taken before the rename (under `~/.local/state/gh-multi-account/backups`) are
also accepted and restore the old helper and share-directory paths. It does not change
the live config or private key. npm has no uninstall hook, so removing the package does
not undo `setup`; run `uninstall` first.

## Contributing

External contributions aren't accepted yet — this repo is pre-release and the
license/CLA policy is still settling. Feel free to open an issue.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
