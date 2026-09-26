#!/usr/bin/env node
// Fails if the tree contains a reference to the private repo this project was
// extracted from, or to identities specific to that repo's own machine setup.
// None of the words below are sensitive on their own (public character names,
// GitHub org names, a numeric account ID, an English word) — the point is
// catching an accidental leftover reference during the extraction, not
// protecting a secret. Run via `npm test` (see package.json) and before every
// push. This file is deliberately excluded from its own scan below; a
// self-matching pattern can never pass.
//
// `noneedinmagic` is deliberately NOT in the pattern: it's this repo's own
// public owner, not a leak from the private repo it was extracted from — it's
// supposed to appear in package.json's repository field, NOTICE, and the
// README's install lines. The bots (`normandy-tali[bot]`,
// `normandy-garrus[bot]`) are a separate, sanctioned exception that DOES need
// the pattern below (they match `normandy`/`tali`/`garrus`); their one
// allowed home is .github/ai-policy.yml, excluded explicitly.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const EXCLUDE_DIRS = new Set([".git", "node_modules"]);
const EXCLUDE_FILES = new Set([SELF, join(ROOT, ".github", "ai-policy.yml")]);

const PATTERN = /\b(normandy|tali|garrus|af24x|best-time(-biz)?|318730449|constitution)\b/i;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (EXCLUDE_DIRS.has(entry)) continue;
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

let violations = 0;
for (const file of walk(ROOT)) {
  if (EXCLUDE_FILES.has(file)) continue;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // binary or unreadable — not a text leak
  }
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const m = line.match(PATTERN);
    if (m) {
      violations++;
      console.error(`${relative(ROOT, file)}:${i + 1}: ${m[0]} — ${line.trim()}`);
    }
  });
}

if (violations > 0) {
  console.error(`\nscrub-check: ${violations} violation(s). See .github/ai-policy.yml for sanctioned exceptions.`);
  process.exit(1);
}
console.log("scrub-check: clean");
