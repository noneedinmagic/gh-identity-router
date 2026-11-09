# How much of an unparseable selector an error may repeat

**Status:** accepted (v0.1)

When a selector cannot be parsed, the router fails closed with `Could not parse a GitHub
owner from <label>: <value>`. That message reaches stderr, so it lands in agent
transcripts and CI logs, and the value can hold a credential. A config setting decides
how much of the value the message repeats. The setting is `secretRedaction: "whole-value"
| "detected"`, at the top level only, and with it unset the answer is `whole-value`.

- **`whole-value`** replaces the whole value with `[redacted]`. Nothing the user supplied
  is repeated, whatever its shape.
- **`detected`** replaces only the parts that match a known secret shape and echoes the
  rest: the userinfo of a `scheme://` URL, a query string or fragment, the text before
  the last `@` in a scheme-less value's first `/`-segment, and any run that starts with a
  GitHub token prefix (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`).

Internally the shapes form a table, and each mode is the set of shapes it replaces.
`whole-value` is the shape that matches everything. A new mode is a new entry in that
table, not a new code path.

The setting is a ceiling, not a target: a message may repeat less than the mode allows,
never more. A message that cannot read the config, such as `mint-dispatch-token`'s own
argument check, repeats nothing.

Without the value, the label is what tells the user where to look, so the label names
what the user actually set: `--repo`, `GH_REPO`, `remote URL`, or `Git credential path`.
Each label leads to the value with one command: the user's own command line,
`echo "$GH_REPO"`, `git remote get-url origin`, or `git remote -v`.

## Considered options

- **Always hide the whole value, with no setting.** Rejected: owners who want the
  debugging value of the echoed string, or who want to observe which shapes leak, should
  be able to opt in without a code change.
- **Only extend the shape rules, with no whole-value mode.** Rejected: a value that is
  entirely a token (`GH_REPO=ghp_…`), or a non-GitHub token in a URL path, looks exactly
  like a mistyped owner such as `acme`. No shape rule can tell them apart, so a
  rules-only design always leaks something. `git` (its URL anonymizer copies
  `user:token@host/path` through unchanged) and `gh` (which redacts nothing) show the
  same gap.
- **Accept the gap and document it.** Rejected: the leak reaches logs that outlive the
  session, and a fix is cheap.
- **Expose the shape table in the config, one switch per shape.** Deferred. Each shape's
  name would become public config, and renaming or splitting a shape later would break
  configs. Named modes cover the need, and adding per-shape overrides later breaks
  nobody.
- **`detected` as the default.** Rejected: a leak is noticed only after the secret is
  already in a log, so opting into `whole-value` afterwards comes too late. This matches
  `onMissingCredential` defaulting to `block`.
- **Have the bash wrappers read the setting.** Rejected: that would mean a second config
  parser in another language. Under the ceiling rule they simply repeat nothing.

## Consequences

- **The default hides even harmless values.** A typo such as `--repo acme` reports
  `--repo: [redacted]`, and the user finds the value through the label.
- **`detected` has known holes.** A non-GitHub token that is the whole value, or that sits
  in a URL path, is echoed. Owners who cannot accept that keep `whole-value`.
- **Every new message that repeats user input goes through the same redaction, or
  repeats nothing.** A later change must not restore echoing by default, and must not add
  a shape rule to `whole-value`: that mode's guarantee is that it needs none.
- The value is exact and case-sensitive. Any other value is rejected when the config is
  loaded.
