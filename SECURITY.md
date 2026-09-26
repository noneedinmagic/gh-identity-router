# Security policy

This tool mints and handles live GitHub credentials (App installation tokens and
fine-grained PATs). Please report vulnerabilities privately rather than opening a
public issue.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository (Security tab →
"Report a vulnerability"), rather than a public issue or pull request. This lets us
assess and fix the issue before it's disclosed publicly.

Please include:

- A description of the vulnerability and its potential impact.
- Steps to reproduce, or a minimal proof of concept.
- The affected version/commit, if known.

## Scope

In scope: credential minting and scoping logic (`src/`), the `gh`/credential-helper
wrappers (`bin/`), the installer (`install.sh`), and the identity-resolution logic
(`bin/identity.sh`).

Out of scope: vulnerabilities in GitHub's own API or Apps platform (report those to
GitHub directly), and issues that require the attacker to already have local code
execution as the same user running this tool (that user already controls the
private key and any minted token).
