// Generates src/adapters/vscode/skillContent.ts from the authored skill at
// .claude/skills/pairs/SKILL.md, so the markdown this repo dogfoods and the
// markdown the extension writes into a user's workspace are the same bytes.
//
// Needed because skills.ts overwrites the workspace copy on every activation:
// with two hand-maintained copies, editing the markdown looked like it worked
// and was silently reverted on the next window reload, and the embedded copy
// drifted away from the shipped tool schemas. Same rationale as
// sync-lm-tools.mjs, which keeps package.json from drifting off tools.ts.
//
// Run via `npm run sync-skill`; scripts/build-full.sh runs it before packaging.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(fileURLToPath(new URL('.', import.meta.url)), '..');
const source = path.join(root, '.claude', 'skills', 'pairs', 'SKILL.md');
const target = path.join(root, 'src', 'adapters', 'vscode', 'skillContent.ts');

const md = await fs.readFile(source, 'utf8');
// Escape only what breaks a template literal; the markdown is otherwise
// reproduced verbatim so the two copies compare byte-for-byte.
const escaped = md.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

const out = `/**
 * GENERATED FILE — do not edit.
 *
 * Source: .claude/skills/pairs/SKILL.md
 * Regenerate: npm run sync-skill
 *
 * Edit the markdown, not this file. See scripts/sync-skill.mjs for why the
 * skill has a generated twin rather than one hand-written copy.
 */

export const SKILL_MD = \`${escaped}\`;
`;

await fs.writeFile(target, out, 'utf8');
console.log(`sync-skill: wrote ${path.relative(root, target)} (${md.length} chars)`);
