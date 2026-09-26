# Design: an account entry holds an identity block and a credential block, each optional

**Status: planned for v0.1, not yet implemented.** This document describes the target
schema; the current code (`src/multi-account-token.mjs`, `bin/identity.sh`) still uses
the older shape described in the rest of this repo's docs (a single top-level App pair,
and a separate per-`$HOME` `~/.agent-identity` file). See the open issues for the
concrete work items that will implement this.

## Motivation

Today, identity resolution (comparing a declared identity against the derived
credential) and credential routing (selecting a token per target repository owner) are
two separate mechanisms: identity lives in one per-`$HOME` file
(`~/.agent-identity`), credential routing lives in the owner-keyed `accounts` map.

The motivating case for merging them: an external organization served by its own bot
identity, which must never emit the home identity's signatures in that org's commits,
PRs, or footers. Once identity has to vary *per target owner* rather than per `$HOME`,
both mechanisms need to route on the same key — the target repository owner — so they
belong in the same config, not two separate ones.

## The shape

`accounts.<owner>` gains `accountId`, `targetType`, and `host` (default `github.com`,
for future GitHub Enterprise Server support — not built yet, but the field exists so
adding it later isn't a breaking schema change), plus two independent, optional
blocks:

- `credential` — `type: app` (`appId`, `privateKeyPath`, `installationId`) or
  `type: pat` (`tokenPath`). Self-contained per entry; no top-level App pair to fall
  back to.
- `identity` — `login`, `displayName`, `footerHost` (empty omits the host from the PR
  footer), `kind: agent|human`, `commitName`, `commitEmail`.

At least one block must be present; an entry with neither is invalid. Behavior by
which blocks exist:

| `credential` | `identity` | Token minted? | Footer printed? |
|---|---|---|---|
| yes | yes | yes | yes |
| yes | no | yes | no (exit ≠ 0) |
| no | yes | no (a normal `gh auth` credential must apply) | yes, if `gh auth status` matches `identity.login` |
| no | no | — | — (entry invalid) |

`defaultAccount` is retained for token routing only, when no owner can be resolved for
a `gh` call; it never supplies a fallback identity. An owner absent from `accounts`,
or with neither block, gets no footer and no token — never a fallback to
`defaultAccount`'s identity or any other entry's.

## Why two independent blocks, not one combined structure

A combined per-owner object (`type`, `appId`, `login`, `displayName` all flat) would
force every account entry to declare an identity to get a credential, or vice versa.
Two optional blocks let an owner opt into routing, identity, or both independently: an
org whose commits and footer should stay silent about the local machine can hold a
`credential` block with no `identity`, and get a working token with nothing written
about who obtained it.

## Why `identity.login` on a PAT entry matters

A fine-grained PAT's acting login is the account that owns the token — independent of
the entry's `accountId` (the resource owner the token is scoped to). `identity.login`
declares which login a PAT entry is expected to act as: a purpose-made machine user,
not the human owner and not a third party's account. The declared-vs-derived identity
check validates the derived `gh auth status` login against this field exactly as it
does today for an App-typed entry's bot login — no second declaration mechanism.

A third party's PAT is refused outright, never accepted under any declaration: using
someone else's credential attributes commits, PRs, and comments to a real person who
did not author them, and shifts accountability onto them with no consent. The intended
answer for a read-write identity that isn't a GitHub App is a **machine user** — a
purpose-made account holding a PAT scoped to the target owner, declared via
`identity.login` as above. The machine's own owner may also act directly, but that
case is explicitly a human-authored action (see `kind: human` below), not an agent
identity, and never gets an agent footer attached to it.

## Why the per-`$HOME` identity file is retired, with no legacy reader

Keeping a per-`$HOME` identity file as a fallback when an entry has no `identity`
block would mean any allow-listed owner with only a `credential` block silently
inherits the home's identity — precisely the leak this design exists to close, and
the opposite of the explicit opt-in intended here. So the retirement is a clean
break, not a migration path: once this ships, there is no code path that reads a
per-`$HOME` identity file. An existing host migrates its declared identity into its
account entries' `identity` blocks once, at cutover.

The identity comparison and footer-rendering logic move into the same module that
already resolves accounts, since both now read the same per-owner config.
`bin/identity.sh` becomes a thin POSIX-sh shim that calls the installed package and
keeps its own flags (`--footer`, `--check`, `--self-check`) working for existing
callers.

## What this deliberately does not do

It does not decide *where* an identity that must not share the home identity's agent
memory, global instructions, or prompt history runs — that's a machine-level choice (a
separate OS user), documented as a recommendation in the README's "Identity isolation"
section, not encoded in this schema. Config routing alone cannot close that leak path.

It does not build a doctor/wizard that would verify an entry's `identity` block
against the actual `includeIf` commit-author routing on disk — that's deferred to
post-v0.1 work. `identity.commitName`/`commitEmail` exist in the schema so the `setup`
command can *generate* the routing fragment; verifying pre-existing clones against it
is a separate, later feature.
