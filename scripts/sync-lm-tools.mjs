// Generates the package.json `languageModelTools` block from the single
// source of truth in src/core/tools/tools.ts (codeToolSchemas), so the
// modelDescription/inputSchema strings can't drift from the VS Code LM
// registration (tools.ts invariant: one schema per tool).
//
// Run via `npm run sync-lm-tools`; scripts/build-full.sh runs it before
// packaging so package.json always reflects the current tools.ts.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { z } from 'zod';

const scriptsDir = fileURLToPath(new URL('.', import.meta.url));
const root = path.join(scriptsDir, '..');

// Display metadata that isn't derivable from the zod schema (name, blurb,
// reference name) — kept here rather than in tools.ts so that file stays
// transport-agnostic (invariant: tools.ts has no VS Code-specific concepts).
const DISPLAY = {
  find_symbol: { name: 'pairs_find_symbol', displayName: 'PAiRS: find symbol definition', toolReferenceName: 'pairsFindSymbol' },
  get_symbol: { name: 'pairs_get_symbol', displayName: 'PAiRS: get full declaration', toolReferenceName: 'pairsGetSymbol' },
  outline: { name: 'pairs_outline', displayName: 'PAiRS: file outline', toolReferenceName: 'pairsOutline' },
  impact: { name: 'pairs_impact', displayName: 'PAiRS: change impact (blast radius)', toolReferenceName: 'pairsImpact' },
  hierarchy: { name: 'pairs_hierarchy', displayName: 'PAiRS: inheritance hierarchy', toolReferenceName: 'pairsHierarchy' },
  who_calls: { name: 'pairs_who_calls', displayName: 'PAiRS: call graph (callers/callees)', toolReferenceName: 'pairsWhoCalls' },
  file_deps: { name: 'pairs_file_deps', displayName: 'PAiRS: file dependencies', toolReferenceName: 'pairsFileDeps' },
  module_map: { name: 'pairs_module_map', displayName: 'PAiRS: module map (subsystems)', toolReferenceName: 'pairsModuleMap' },
  analyze: { name: 'pairs_analyze', displayName: 'PAiRS: analyze (dead code, cycles, hotspots)', toolReferenceName: 'pairsAnalyze' },
  check_rules: { name: 'pairs_check_rules', displayName: 'PAiRS: check architectural rules', toolReferenceName: 'pairsCheckRules' },
  list_rules: { name: 'pairs_list_rules', displayName: 'PAiRS: list architectural rules', toolReferenceName: 'pairsListRules' },
  explain_rule: { name: 'pairs_explain_rule', displayName: 'PAiRS: explain a rule', toolReferenceName: 'pairsExplainRule' },
  rename_symbol: { name: 'pairs_rename_symbol', displayName: 'PAiRS: rename symbol', toolReferenceName: 'pairsRenameSymbol' },
};

// Minimal zod -> VS Code inputSchema (JSON Schema subset) converter — only
// covers the node types tools.ts actually uses (object/string/number/int/
// boolean/enum/array/optional/default). Not a general zod-to-json-schema
// replacement; extend here if tools.ts starts using another zod type.
function convert(schema) {
  const def = schema._def;
  switch (def.typeName) {
    case 'ZodObject': {
      const shape = def.shape();
      const properties = {};
      const required = [];
      for (const [key, value] of Object.entries(shape)) {
        const { schema: propSchema, optional } = unwrap(value);
        properties[key] = convert(propSchema);
        const desc = describeOf(value);
        if (desc) properties[key].description = desc;
        if (!optional) required.push(key);
      }
      const out = { type: 'object', properties };
      if (required.length) out.required = required;
      return out;
    }
    case 'ZodString':
      return { type: 'string' };
    case 'ZodNumber': {
      const isInt = def.checks?.some((c) => c.kind === 'int');
      const out = { type: isInt ? 'integer' : 'number' };
      for (const c of def.checks ?? []) {
        if (c.kind === 'min') out.minimum = c.value;
        if (c.kind === 'max') out.maximum = c.value;
      }
      return out;
    }
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodEnum':
      return { type: 'string', enum: [...def.values] };
    case 'ZodArray':
      return { type: 'array', items: convert(def.type) };
    default:
      throw new Error(`sync-lm-tools: unhandled zod type ${def.typeName}`);
  }
}

// Peels ZodOptional/ZodDefault to find the base schema + whether the field
// is optional in the *input* (defaults make a field optional to callers).
function unwrap(schema) {
  let s = schema;
  let optional = false;
  while (s._def.typeName === 'ZodOptional' || s._def.typeName === 'ZodDefault') {
    optional = true;
    s = s._def.innerType;
  }
  return { schema: s, optional };
}

function describeOf(schema) {
  let s = schema;
  while (s._def.typeName === 'ZodOptional' || s._def.typeName === 'ZodDefault') {
    if (s.description) return s.description;
    s = s._def.innerType;
  }
  return s.description;
}

async function loadToolsModule() {
  const result = await esbuild.build({
    entryPoints: [path.join(root, 'src/core/tools/tools.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    external: ['vscode'],
  });
  const code = result.outputFiles[0].text;
  const module = { exports: {} };
  const fn = new Function('module', 'exports', 'require', code);
  fn(module, module.exports, (id) => (id === 'zod' ? { z } : require(id)));
  return module.exports;
}

function buildEntry(toolKey, schema) {
  const meta = DISPLAY[toolKey];
  if (!meta) throw new Error(`sync-lm-tools: no DISPLAY entry for ${toolKey}`);
  return {
    name: meta.name,
    displayName: meta.displayName,
    toolReferenceName: meta.toolReferenceName,
    modelDescription: schema.description,
    canBeReferencedInPrompt: true,
    inputSchema: convert(schema.input),
  };
}

async function main() {
  const { codeToolSchemas } = await loadToolsModule();
  const toolNames = Object.keys(codeToolSchemas);
  const missing = toolNames.filter((n) => !DISPLAY[n]);
  const stale = Object.keys(DISPLAY).filter((n) => !toolNames.includes(n));
  if (missing.length) throw new Error(`sync-lm-tools: tools.ts added ${missing.join(', ')} — add DISPLAY entries`);
  if (stale.length) throw new Error(`sync-lm-tools: DISPLAY has stale entries ${stale.join(', ')}`);

  const entries = Object.entries(codeToolSchemas).map(([k, v]) => buildEntry(k, v));

  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
  pkg.contributes.languageModelTools = entries;

  // Keep pairs.disabledTools' enum in lockstep with the tool contract so it
  // can't drift when a tool is added/renamed (wire names, not pairs_-prefixed).
  const disabledTools = pkg.contributes.configuration?.properties?.['pairs.disabledTools'];
  if (disabledTools?.items) disabledTools.items.enum = toolNames;

  await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

  const totalChars = entries.reduce((sum, e) => sum + e.modelDescription.length, 0);
  console.log(`sync-lm-tools: wrote ${entries.length} tools, ${totalChars} modelDescription chars (~${Math.ceil(totalChars / 4)} tokens)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
