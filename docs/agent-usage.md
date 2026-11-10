## Using gh-identity-router

`gh` and HTTPS Git here are routed by the **owner** of the target repository: that owner
picks the credential, and `identity.sh` picks the identity. Inside a clone nothing needs
doing, because its `origin` decides. The rules below cover everywhere else.

### Selecting the owner

`gh` picks the account from `-R`/`--repo`, then `GH_REPO`, then the clone's `origin`, then
`IDENTITY_ROUTER_ORG`, then the default account. Whenever the target is not this clone's
`origin` (outside a clone, another owner's repo, or an owner that appears only in an API
path), name it yourself, or the call silently uses another account's token and fails with
a confusing 403/404:

```bash
gh pr list --repo other-org/x
GH_REPO=other-org/x gh api repos/other-org/x/issues   # gh api has no -R
```

### The PR footer

Append the output of `identity.sh --footer` to the PR body, verbatim. Never write it by hand.
If the PR's target repository is not this clone's `origin` (a fork clone, or
`gh pr create --repo other-org/x`), pass the target, or the footer is signed with
`origin`'s owner. A refusal prints nothing, so chain with `&&` and never open the PR
without the footer:

```bash
GH_REPO=other-org/x identity.sh --footer >> body.md && gh pr create --repo other-org/x --body-file body.md
```

### Refusals: stop and report, never work around

A refusal is deliberate. Stop, quote it to the user, and let them decide. Exception: for
`Could not parse a GitHub owner from …`, quote only that prefix and which selector it names
(`GH_REPO`, `--repo`, remote URL, Git credential path), never the echoed value, which can
contain a credential (e.g. `user:token@host/org/repo`):

| Message | Meaning |
|---|---|
| `GitHub account is not allow-listed: <owner>` | `gh` exit 5 (4 if the config sets `exitCodes: "gh"`); the real `gh` did not run. `identity.sh` exit 2. The owner is not in the config and `onMissingCredential` is `block`. |
| `Account <owner> has no credential block and onMissingCredential is block; add a credential block or set onMissingCredential: machine` | Same exit codes. The owner has no credential (an identity-only entry counts) and the policy is `block`, so the machine credential may not act for it. |
| `<owner> is blocked (no credential block and onMissingCredential is block)` | `identity.sh --footer` or `--check` exit 2, nothing on stdout. No identity applies. |
| `Could not parse a GitHub owner from …` | `gh` fails, or `identity.sh` exits 2 with nothing on stdout. The `GH_REPO` or `--repo` value, or the remote URL, is malformed. Fix the selector, not the config. |

`identity.sh` also exits 2 with nothing on stdout when the owner has no `identity` block.
Do not paste a footer you made up instead.

Whether to unblock an owner is the user's call. Never work around a refusal: do not edit
the config, call the real `gh` directly (`IDENTITY_ROUTER_REAL_GH`, `/usr/bin/gh`), set
`GH_TOKEN` yourself, or retry under another owner or account.

### Never

- Run `gh auth login`, or create a personal access token.
- Switch a remote to SSH (`git remote set-url origin git@github.com:…`). A blocked `git push`
  says "credential helper … told us to quit", with the reason on the line above: report it.
