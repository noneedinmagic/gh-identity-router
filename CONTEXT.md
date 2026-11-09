# gh-identity-router

Routes each `gh` and Git operation to the credential and identity configured for the
GitHub account that owns the target repository.

## Language

### Owners

**Owner**:
The GitHub user or organization that owns the repository an operation targets; the key
everything is routed on.
_Avoid_: org (when a user is meant), account (ambiguous with the acting login)

**Unlisted owner**:
An owner with no entry in the config's `accounts` — situation (b).
_Avoid_: unknown account, non-allow-listed account

**Unresolved owner**:
The case where no owner can be determined for an operation (no repository, remote or
override names one) — situation (c).
_Avoid_: missing owner, default owner

### Credentials

**Routed credential**:
The credential an account entry configures for its owner (a GitHub App installation or a
fine-grained PAT), which the router supplies in place of the machine's own.
_Avoid_: router token, minted credential (a PAT is read, not minted)

**Machine credential**:
Whatever `gh` and Git would authenticate with if this tool were not installed — the
machine's own login, a separately configured helper, or nothing.
_Avoid_: ambient credential, transient, the user's credential

**Uncredentialed entry**:
An account entry with no routed credential — situation (a).

**Identity-only entry**:
An uncredentialed entry that declares an identity.

**Bare entry**:
An uncredentialed entry that also declares no identity and exists only to state a
no-credential policy for its owner.

### Policy

**No-credential policy**:
The rule deciding what happens when the router has no routed credential for an owner:
`machine` or `block`.
_Avoid_: fallback, transient mode

**machine**:
The no-credential policy that lets the machine credential act for the owner.
_Avoid_: transient, pass-through, ambient

**block**:
The no-credential policy that refuses to act for the owner at all; the default.
_Avoid_: deny, fail-closed (as a value name)

**Guardrail**:
A refusal this tool enforces on the paths it controls, which a direct `gh`, an SSH remote
or another credential helper can still bypass — not a security boundary.
_Avoid_: lockout, enforcement
