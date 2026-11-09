// Keeps docs/agent-usage.md, the snippet users paste into their agent's instruction file,
// in sync with the code it describes: env vars, commands and flags, refusal messages,
// exit codes. It is pasted outside this checkout, so it must also stand alone.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { EXIT_BLOCKED, EXIT_BLOCKED_GH } from "../src/multi-account-token.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

// Same list as test/env-vars.test.mjs: everything that ships and could define a name.
const SOURCE_FILES = [
  "src/multi-account-token.mjs",
  "src/identity.mjs",
  "bin/gh",
  "bin/identity.sh",
  "bin/mint-dispatch-token",
  "bin/git-credential-gh-identity-router",
  "src/setup.mjs",
];

const snippet = read("docs/agent-usage.md");
const sources = SOURCE_FILES.map(read).join("\n");

test("the snippet stays short and stands alone", () => {
  assert.ok(snippet.trimEnd().split("\n").length <= 60, "snippet is over 60 lines");
  // Anything that only exists in this checkout is meaningless once pasted elsewhere.
  assert.doesNotMatch(snippet, /(?<![\w/])(?:src|bin|docs|test)\/|\.mjs\b|README/);
});

test("every env var the snippet names is documented in docs/env-vars.md", () => {
  const named = new Set(snippet.match(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g));
  const documented = new Set([...read("docs/env-vars.md").matchAll(/\| `([A-Z][A-Z0-9_]+)` \|/g)].map((m) => m[1]));

  assert.ok(named.size > 0);
  assert.deepEqual([...named].filter((v) => !documented.has(v)), []);
});

test("every flag the snippet names exists in the shipped CLI", () => {
  const flags = new Set(snippet.match(/(?<![\w-])(?:--[a-z][a-z-]*|-R)(?![\w-])/g));

  assert.ok(flags.has("--footer") && flags.has("-R"));
  // Flags that belong to the real gh, not to this tool, have no source to find them in.
  const ghNative = new Set(["--body-file"]);
  assert.deepEqual([...flags].filter((f) => !ghNative.has(f) && !sources.includes(f)), []);
});

test("every command of this tool the snippet names is shipped", () => {
  const shipped = new Set([
    ...fs.readdirSync(path.join(ROOT, "bin")),
    ...Object.keys(JSON.parse(read("package.json")).bin),
  ]);
  const named = new Set(snippet.match(/\b(?:[\w-]+\.sh|gh-identity-router|multi-account-token)\b/g));

  assert.ok(named.has("identity.sh"));
  assert.deepEqual([...named].filter((c) => !shipped.has(c)), []);
});

test("the exit codes the snippet gives for a blocked owner are the real ones", () => {
  assert.match(snippet, new RegExp(`exit ${EXIT_BLOCKED} \\(${EXIT_BLOCKED_GH} if`));
});

test("every refusal message the snippet quotes still appears in src/", () => {
  const section = snippet.split(/^### /m).find((s) => s.startsWith("Refusals"));
  const messages = [...section.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]);

  assert.ok(messages.length >= 4, "found too few quoted refusals");
  for (const message of messages) {
    // `<owner>` and `…` stand for text the code fills in; the rest must still be there.
    for (const fragment of message.split(/<[a-z]+>|…/).filter(Boolean)) {
      assert.ok(sources.includes(fragment), `refusal text not in src/: ${fragment}`);
    }
  }
});
