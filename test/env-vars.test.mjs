// Asserts docs/env-vars.md's tables stay in sync with the variables the code actually
// reads/sets — engineering default: "Env vars are documented or don't exist."
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SOURCE_FILES = [
  "src/multi-account-token.mjs",
  "src/identity.mjs",
  "bin/gh",
  "bin/identity.sh",
  "bin/mint-dispatch-token",
  "bin/multi-account-git-credential",
  "install.sh",
];

// Vars this tool deliberately reads/sets from gh's own reserved namespace, plus other
// known-shaped output vars not under this tool's own MULTI_ACCOUNT_/AGENT_IDENTITY_
// prefixes — expected to appear in source without being this tool's "own" config
// surface, so they need naming here rather than being caught by the prefix check.
const KNOWN_VARS = new Set(["GH_REPO", "GH_TOKEN", "DISPATCH_GH_TOKEN"]);

function varsReferencedIn(file) {
  const text = fs.readFileSync(path.join(ROOT, file), "utf8");
  const found = new Set();
  for (const m of text.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)) {
    const name = m[1];
    if (name.startsWith("MULTI_ACCOUNT_") || name.startsWith("AGENT_IDENTITY_") || KNOWN_VARS.has(name)) {
      found.add(name);
    }
  }
  return found;
}

function varsDocumentedIn(mdFile) {
  const text = fs.readFileSync(path.join(ROOT, mdFile), "utf8");
  const found = new Set();
  for (const m of text.matchAll(/\| `([A-Z][A-Z0-9_]+)` \|/g)) {
    found.add(m[1]);
  }
  return found;
}

test("every env var referenced in source is documented in docs/env-vars.md", () => {
  const referenced = new Set();
  for (const f of SOURCE_FILES) {
    for (const v of varsReferencedIn(f)) referenced.add(v);
  }
  const documented = varsDocumentedIn("docs/env-vars.md");

  const undocumented = [...referenced].filter((v) => !documented.has(v));
  assert.deepEqual(undocumented, [], `undocumented env var(s): ${undocumented.join(", ")}`);
});

test("every env var documented in docs/env-vars.md is actually referenced somewhere", () => {
  const referenced = new Set();
  for (const f of SOURCE_FILES) {
    for (const v of varsReferencedIn(f)) referenced.add(v);
  }
  const documented = varsDocumentedIn("docs/env-vars.md");

  const stale = [...documented].filter((v) => !referenced.has(v));
  assert.deepEqual(stale, [], `documented but unused env var(s): ${stale.join(", ")}`);
});
