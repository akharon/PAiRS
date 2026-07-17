// Generates the package.json `languageModelTools` block from the single
// source of truth in src/mcp/tools.ts (toolSchemas + codeToolSchemas), so
// the modelDescription/inputSchema strings can't drift between the MCP
// contract and the VS Code LM registration (docs/OptimizationPlan.md T2).
//
// Run via `npm run sync-lm-tools`; `npm run build` runs it automatically so
// package.json always reflects the current tools.ts before packaging.
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
  memory_save: { name: 'pairs_save', displayName: 'Save workspace memory', toolReferenceName: 'memorySave' },
  memory_search: { name: 'pairs_search', displayName: 'Search workspace memory', toolReferenceName: 'memorySearch' },
  memory_list: { name: 'pairs_list', displayName: 'List workspace memories', toolReferenceName: 'memoryList' },
  memory_forget: { name: 'pairs_forget', displayName: 'Forget workspace memory', toolReferenceName: 'memoryForget' },
  memory_context: { name: 'pairs_context', displayName: 'Workspace memory briefing', toolReferenceName: 'memoryContext' },
  code_search: { name: 'pairs_code_search', displayName: 'Search code index', toolReferenceName: 'codeSearch' },
  who_calls: { name: 'pairs_who_calls', displayName: 'Who calls (call graph)', toolReferenceName: 'whoCalls' },
  find_implementations: { name: 'pairs_find_implementations', displayName: 'Find implementations', toolReferenceName: 'findImplementations' },
  code_outline: { name: 'pairs_code_outline', displayName: 'Code outline', toolReferenceName: 'codeOutline' },
  find_dead_code: { name: 'pairs_find_dead_code', displayName: 'Find dead code', toolReferenceName: 'findDeadCode' },
  file_deps: { name: 'pairs_file_deps', displayName: 'File dependencies', toolReferenceName: 'fileDeps' },
  code_hotspots: { name: 'pairs_code_hotspots', displayName: 'Code complexity hotspots', toolReferenceName: 'codeHotspots' },
  find_duplicates: { name: 'pairs_find_duplicates', displayName: 'Find similar code', toolReferenceName: 'findDuplicates' },
  get_declaration: { name: 'pairs_get_declaration', displayName: 'Get full declaration', toolReferenceName: 'getDeclaration' },
  change_impact: { name: 'pairs_change_impact', displayName: 'Change impact analysis', toolReferenceName: 'changeImpact' },
  who_tests: { name: 'pairs_who_tests', displayName: 'Find tests exercising a symbol', toolReferenceName: 'whoTests' },
  find_untested: { name: 'pairs_find_untested', displayName: 'Find untested exported symbols', toolReferenceName: 'findUntested' },
  dependency_cycle: { name: 'pairs_dependency_cycle', displayName: 'Find circular import dependencies', toolReferenceName: 'dependencyCycle' },
  index_status: { name: 'pairs_index_status', displayName: 'Code index status', toolReferenceName: 'indexStatus' },
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
    s = s._def.typeName === 'ZodOptional' ? s._def.innerType : s._def.innerType;
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
    entryPoints: [path.join(root, 'src/mcp/tools.ts')],
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
  const { toolSchemas, codeToolSchemas } = await loadToolsModule();
  const entries = [
    ...Object.entries(toolSchemas).map(([k, v]) => buildEntry(k, v)),
    ...Object.entries(codeToolSchemas).map(([k, v]) => buildEntry(k, v)),
  ];

  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
  pkg.contributes.languageModelTools = entries;

  // Keep the pairs.disabledTools enum in lockstep with the tool contract so it
  // can't drift when a tool is added/renamed (it lists wire names, not the
  // pairs_-prefixed display names).
  const toolNames = [...Object.keys(toolSchemas), ...Object.keys(codeToolSchemas)];
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
