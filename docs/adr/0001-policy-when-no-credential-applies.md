# What happens when the router has no credential for an owner

**Status:** accepted (v0.1)

When the router has no credential for the target owner, a config setting decides
whether `gh` and Git use the **machine credential** or are **blocked**. Until now the
config's shape decided this implicitly. The setting is `onMissingCredential:
"machine" | "block"`, accepted on an account entry and at the top level. An entry's value
overrides the top-level value, and with neither set the answer is `block`.

- **(a) An entry with no `credential` block** follows its own `onMissingCredential`, then
  the top-level one, then `block`.
- **(b) An owner not listed in `accounts`** follows the top-level `onMissingCredential`,
  then `block`. A bare entry (`accountId`, `targetType`, `onMissingCredential: "block"`)
  blocks one owner even when the top level says `machine`.
- **(c) When no owner can be resolved**, `defaultAccount` routes as before, and the entry
  it names follows its own rule. `identity.sh` never consults `defaultAccount`.

A blocked owner makes the token command exit 5. Under the top-level `exitCodes: "gh"` it
exits 4 instead, the code `gh` documents as "requires authentication". The `gh` wrapper
passes the code through without running the real `gh`. The Git credential helper answers
`quit=1`, which stops Git from asking a later helper or prompting. The helper also does
this when a configured credential fails to mint. `machine` keeps exit 3: the wrapper runs
the real `gh` unchanged, and the Git helper answers nothing. `identity.sh` refuses
`--footer` and `--check` for a blocked owner. For a `machine` owner it still requires the
derived login to match `identity.login`, since that match is the only check left when the
router supplies no credential.

## Considered options

- **Two booleans (`transient`, `blocked`) instead of one enum.** Rejected: they allow a
  contradictory both-true state, and absence has no single meaning.
- **`fallback` as the key name.** Rejected as too generic: next to `defaultAccount` it
  reads like "the fallback account", and it would collide with any later kind of
  fallback. `onMissingCredential` says when it applies.
- **A separate top-level key for unlisted owners.** Rejected: one setting is easier to
  learn, and per-entry values cover the exceptions.
- **An optional `defaultAccount` that, when absent, makes (c) follow the top-level
  setting.** Deferred. "No owner resolved means use the machine credential" can already
  be spelled as a `defaultAccount` entry set to `machine`, and making the key optional
  later breaks nobody.
- **Covering a broken configured credential (expired, mismatched, network) too.**
  Rejected: falling back would attribute work to the machine's own login. Per-owner
  routing exists to prevent exactly that. Some mint failures are deliberate checks, such
  as a mismatched installation account. A broken credential always fails. If a separate
  `onCredentialFailure` is ever wanted, adding it breaks nobody.
- **Ignoring `onMissingCredential` next to a `credential` block.** Rejected in favour of
  rejecting it at config load. An inert key misleads, and rejecting keeps the option to
  give it a meaning later without silently changing existing configs.
- **Reusing `gh`'s exit 4 for "blocked" unconditionally.** Rejected as the default,
  because scripts then cannot tell the router's refusal from `gh`'s own. It stays
  available under `exitCodes: "gh"`.

## Consequences

- **Deliberate break.** An identity-only entry with no `onMissingCredential` used to mean
  "use the machine credential" and now means `block`. Setting
  `"onMissingCredential": "machine"` restores the old behaviour. If `defaultAccount` names
  such an entry, every `gh` call with no owner is blocked, including `gh --version` and
  `gh auth status`.
- **A top-level `machine` gives up the allow-list for unlisted owners.** A typo'd owner
  or `--account` then quietly uses the machine credential instead of failing.
- **`block` is a guardrail, not a security boundary.** Anything that runs the real `gh`
  directly, an SSH remote, or a later Git config that resets the helper list (an empty
  `credential.helper` in a repository's config, or `-c credential.helper=`) and names
  another helper bypasses it. A helper configured after this one does not, because
  `quit=1` stops Git first.
- Values are exact and case-sensitive. Any other value, at either level, is rejected when
  the config is loaded.
