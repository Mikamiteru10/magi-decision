#!/usr/bin/env node
// Blocks commits that contain an API key or a secrets file.
//   node scripts/check-secrets.mjs          -> checks files staged for commit (used by the pre-commit hook)
//   node scripts/check-secrets.mjs --all    -> checks every tracked/untracked file outside .gitignore
import { execSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';

const PATTERNS = [
  { name: 'Google API key', re: /AIza[0-9A-Za-z_\-]{35}/ },
  { name: 'Generic secret assignment', re: /(api[_-]?key|secret|token)\s*[:=]\s*["']?[A-Za-z0-9_\-]{24,}/i },
];
const FORBIDDEN_FILES = [/(^|\/)\.dev\.vars$/, /(^|\/)\.env(\..+)?$/, /\.key$/];
const TEMPLATES = [/\.dev\.vars\.example$/, /\.env\.example$/];   // allowed to exist, still scanned for keys
const SELF = /^scripts\/check-secrets\.mjs$/;

const all = process.argv.includes('--all');
let files = [];
try {
  files = execSync(all ? 'git ls-files --cached --others --exclude-standard' : 'git diff --cached --name-only --diff-filter=ACM',
    { encoding: 'utf8' }).split('\n').filter(Boolean);
} catch {
  console.error('check-secrets: not a git repository yet, nothing to check.');
  process.exit(0);
}

const problems = [];
for (const f of files) {
  if (SELF.test(f)) continue;
  if (!TEMPLATES.some(r => r.test(f)) && FORBIDDEN_FILES.some(r => r.test(f))) {
    problems.push(`${f}: secrets file must never be committed`); continue;
  }
  if (!existsSync(f) || statSync(f).size > 2_000_000) continue;
  let text;
  try { text = readFileSync(f, 'utf8'); } catch { continue; }
  for (const { name, re } of PATTERNS) if (re.test(text)) problems.push(`${f}: looks like it contains a ${name}`);
}

if (problems.length) {
  console.error('\n✖ check-secrets blocked this commit:\n  ' + problems.join('\n  '));
  console.error('\nRemove the secret (keep it in .dev.vars or a Worker secret) and try again.\n');
  process.exit(1);
}
console.log(`check-secrets: ${files.length} file(s) clean.`);
