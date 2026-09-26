# Working on this repo

This is a **public** repository. Rules for any agent (human-dispatched or
autonomous) working here:

- **Don't reference other repositories' issues, private tooling, or host names.**
  No `#NNN`-shaped issue references to a private tracker, no paths or naming
  conventions specific to some other private repo's setup, no machine/host names. If
  a design decision came from somewhere else, restate the reasoning here in
  self-contained prose instead of citing a private source a reader can't see.
- **The bots and the repo owner's GitHub login are fine to reference** — they're
  public and intentional (see NOTICE, `.github/ai-policy.yml`).
- **Before every commit or PR:** run `npm test` (includes a scrub check —
  `scripts/scrub-check.mjs` — that fails the build if a leftover private reference
  slips back in) and re-read the diff for the same class of leak the automated check
  can't catch (a host path, a private issue number, a personal name).
- **Branch and commit conventions:** conventional branch prefixes
  (`feat/`, `fix/`, `docs/`, `chore/`); don't commit directly to `main`.
- **License:** Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). External
  contributions aren't accepted yet (README's Contributing section) — the CLA
  question hasn't been settled.

See [README.md](README.md) for what this tool does and how it's configured.
