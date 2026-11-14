/**
 * CLI argument parsing for the code tools, driven by the zod input schemas in
 * core/tools/tools.ts so every schema field is reachable as `--field value`
 * (also `--kebab-case`, `--field=value`) with no per-tool special cases.
 * Also renders `pairs <tool> --help` from the same schemas. No `vscode` import (G1).
 *
 * Global flags (--json --pretty --naked --root --no-refresh) are stripped by the
 * caller before this runs.
 */

import { codeToolSchemas, type CodeToolName } from '../../core/tools/tools';

/** CLI positionals → tool input fields, per tool, in order. */
export const TOOL_ARG_SPECS: Record<CodeToolName, string[]> = {
  find_symbol: ['name'],
  get_symbol: ['name', 'path'],
  outline: ['path'],
  impact: ['name', 'path', 'depth', 'includeTests'],
  // No positional `rev`: it is optional and every other field is a flag, so a
  // bare `pairs diff_impact` must mean "the working tree", not a missing arg.
  diff_impact: [],
  hierarchy: ['name', 'path', 'depth'],
  who_calls: ['name', 'direction', 'path', 'includeTests'],
  file_deps: ['path', 'direction'],
  module_map: ['boundary'],
  analyze: ['kind', 'pathPrefix'],
  rename_symbol: ['name', 'newName', 'path', 'includeFuzzy'],
  grep_symbols: ['pattern', 'pathPrefix'],
  // No positional `path`: context_pack takes EITHER name or path, and `name`
  // sits first, so a bare file would be resolved as a symbol. Use --path.
  context_pack: ['name', 'limit'],
};

/** Short flag names accepted in addition to the schema field names. */
const FLAG_ALIASES: Record<string, string> = { kind: 'kinds', lang: 'langs', regex: 'isRegex' };

export type ParsedToolArgs = { ok: true; raw: Record<string, unknown> } | { ok: false; error: string };

// -- Schema introspection ---------------------------------------------------------------

type Scalar = 'string' | 'number' | 'boolean' | 'enum';

interface FieldInfo {
  name: string;
  /** Array of `elem`, or a scalar. */
  array: boolean;
  type: Scalar;
  enumValues?: string[];
  description?: string;
  hasDefault: boolean;
  defaultValue?: unknown;
  optional: boolean;
  min?: number;
  max?: number;
  int?: boolean;
}

interface ZodLike {
  description?: string;
  _def: Record<string, unknown> & { typeName?: string };
}

/** Peels Default/Optional/Nullable/Effects wrappers; collects description, default, optionality. */
function unwrap(schema: ZodLike): {
  base: ZodLike;
  description?: string;
  hasDefault: boolean;
  defaultValue?: unknown;
  optional: boolean;
} {
  let cur = schema;
  let description: string | undefined;
  let hasDefault = false;
  let defaultValue: unknown;
  let optional = false;
  for (;;) {
    if (description === undefined && cur.description) description = cur.description;
    const t = cur._def.typeName;
    if (t === 'ZodDefault') {
      hasDefault = true;
      defaultValue = (cur._def.defaultValue as () => unknown)();
      cur = cur._def.innerType as ZodLike;
    } else if (t === 'ZodOptional' || t === 'ZodNullable') {
      optional = true;
      cur = cur._def.innerType as ZodLike;
    } else if (t === 'ZodEffects') {
      cur = cur._def.schema as ZodLike;
    } else {
      return { base: cur, ...(description !== undefined ? { description } : {}), hasDefault, defaultValue, optional };
    }
  }
}

function describeScalar(base: ZodLike, info: Partial<FieldInfo>): void {
  switch (base._def.typeName) {
    case 'ZodNumber': {
      info.type = 'number';
      for (const c of (base._def.checks as { kind: string; value?: number }[]) ?? []) {
        if (c.kind === 'min') info.min = c.value;
        else if (c.kind === 'max') info.max = c.value;
        else if (c.kind === 'int') info.int = true;
      }
      break;
    }
    case 'ZodBoolean':
      info.type = 'boolean';
      break;
    case 'ZodEnum':
      info.type = 'enum';
      info.enumValues = [...(base._def.values as string[])];
      break;
    default:
      info.type = 'string';
  }
}

const fieldCache = new Map<string, FieldInfo[]>();

/** One FieldInfo per key of the tool's zod object, in declaration order. */
export function toolFields(tool: CodeToolName): FieldInfo[] {
  const cached = fieldCache.get(tool);
  if (cached) return cached;
  const shape = (codeToolSchemas[tool].input as unknown as { shape: Record<string, ZodLike> }).shape;
  const out: FieldInfo[] = [];
  for (const [name, schema] of Object.entries(shape)) {
    const u = unwrap(schema);
    const info: Partial<FieldInfo> = { name, array: false, hasDefault: u.hasDefault, optional: u.optional || u.hasDefault };
    if (u.description !== undefined) info.description = u.description;
    if (u.hasDefault) info.defaultValue = u.defaultValue;
    if (u.base._def.typeName === 'ZodArray') {
      info.array = true;
      describeScalar(unwrap(u.base._def.type as ZodLike).base, info);
    } else {
      describeScalar(u.base, info);
    }
    out.push(info as FieldInfo);
  }
  fieldCache.set(tool, out);
  return out;
}

const norm = (s: string): string => s.replace(/[-_]/g, '').toLowerCase();

function findField(fields: FieldInfo[], flag: string): FieldInfo | undefined {
  const n = norm(flag);
  const exact = fields.find((f) => norm(f.name) === n);
  if (exact) return exact;
  const alias = FLAG_ALIASES[flag] ?? Object.entries(FLAG_ALIASES).find(([k]) => norm(k) === n)?.[1];
  return alias === undefined ? undefined : fields.find((f) => f.name === alias);
}

// -- Value coercion --------------------------------------------------------------------------

function parseBool(v: string): boolean | undefined {
  const l = v.toLowerCase();
  if (l === 'true' || l === '1') return true;
  if (l === 'false' || l === '0') return false;
  return undefined;
}

/** Coerces one string to the field's scalar type; returns an error string on failure. */
function coerce(f: FieldInfo, v: string): { value: unknown } | { error: string } {
  switch (f.type) {
    case 'number': {
      const n = v.trim() === '' ? NaN : Number(v);
      if (!Number.isFinite(n)) return { error: `${f.name} must be a number (got "${v}")` };
      return { value: n };
    }
    case 'boolean': {
      const b = parseBool(v);
      if (b === undefined) return { error: `${f.name} must be true or false (got "${v}")` };
      return { value: b };
    }
    case 'enum': {
      const values = f.enumValues!;
      // Case-insensitive match, except where two values differ only by case.
      const hit = values.find((e) => e === v) ?? values.find((e) => e.toLowerCase() === v.toLowerCase());
      if (hit === undefined) return { error: `${f.name} must be one of ${values.join(', ')} (got "${v}")` };
      return { value: hit };
    }
    default:
      return { value: v };
  }
}

// -- Parsing ---------------------------------------------------------------------------------

const flagList = (fields: FieldInfo[]): string => fields.map((f) => `--${f.name}`).join(' ');

/** True when the args ask for help rather than a tool call. */
export function wantsHelp(argv: readonly string[]): boolean {
  return argv.includes('--help') || argv.includes('-h');
}

export function parseToolArgs(tool: CodeToolName, argv: readonly string[]): ParsedToolArgs {
  const fields = toolFields(tool);
  const spec = TOOL_ARG_SPECS[tool];
  const raw: Record<string, unknown> = {};
  const positionals: string[] = [];

  const assign = (f: FieldInfo, value: string): string | undefined => {
    const c = coerce(f, value);
    if ('error' in c) return c.error;
    if (f.array) {
      const prev = (raw[f.name] as unknown[] | undefined) ?? [];
      raw[f.name] = [...prev, c.value];
    } else raw[f.name] = c.value;
    return undefined;
  };
  const fail = (msg: string): ParsedToolArgs => ({ ok: false, error: `${tool}: ${msg}` });

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!tok.startsWith('--')) {
      positionals.push(tok);
      continue;
    }
    const eq = tok.indexOf('=');
    const flag = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
    const inline = eq === -1 ? undefined : tok.slice(eq + 1);
    let f = findField(fields, flag);
    let negated = false;
    if (!f && /^no[-_]?./i.test(flag)) {
      const cand = findField(fields, flag.replace(/^no[-_]?/i, ''));
      if (cand && cand.type === 'boolean' && !cand.array) {
        f = cand;
        negated = true;
      }
    }
    if (!f) return { ok: false, error: `Unknown flag --${flag} for ${tool}. Flags: ${flagList(fields)}` };

    if (f.type === 'boolean' && !f.array) {
      if (negated) {
        if (inline !== undefined) return fail(`--${flag} takes no value`);
        raw[f.name] = false;
      } else if (inline !== undefined) {
        const err = assign(f, inline);
        if (err) return fail(err);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && parseBool(next) !== undefined) {
          raw[f.name] = parseBool(next);
          i++;
        } else raw[f.name] = true;
      }
      continue;
    }

    let value = inline;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        const hint = f.type === 'number' ? ' (a number)' : f.array ? ' (comma-separated)' : f.type === 'enum' ? ` (${f.enumValues!.join('|')})` : '';
        return fail(`--${flag} needs a value${hint}`);
      }
      value = next;
      i++;
    }
    const parts = f.array ? value.split(',').map((s) => s.trim()).filter(Boolean) : [value];
    if (parts.length === 0) return fail(`--${flag} needs a value`);
    for (const p of parts) {
      const err = assign(f, p);
      if (err) return fail(err);
    }
  }

  // Positionals: an enum value at or after its field's slot claims that field
  // (`who_calls X src/a.ts callees`); the rest fill unset fields in order.
  const claimed = new Set<number>();
  positionals.forEach((p, i) => {
    for (let j = 0; j <= i && j < spec.length; j++) {
      const f = fields.find((x) => x.name === spec[j])!;
      if (f.type !== 'enum' || f.array || f.name in raw) continue;
      if (f.enumValues!.some((e) => e.toLowerCase() === p.toLowerCase())) {
        const err = assign(f, p);
        if (err) return;
        claimed.add(i);
        return;
      }
    }
  });
  const slots = spec.filter((name) => !(name in raw));
  const rest = positionals.filter((_, i) => !claimed.has(i));
  // module_map's boundary is "<from> -> <to>": accept it unquoted.
  if (tool === 'module_map' && rest.length > 1) rest.splice(0, rest.length, rest.join(' '));
  for (let i = 0; i < rest.length; i++) {
    const name = slots[i];
    if (name === undefined) {
      const takes = spec.length > 0 ? spec.map((n) => `<${n}>`).join(' ') : 'no positional arguments';
      return fail(`unexpected argument "${rest[i]}" (takes ${takes}; other fields are flags, see pairs ${tool} --help)`);
    }
    const err = assign(fields.find((x) => x.name === name)!, rest[i]!);
    if (err) return fail(err);
  }

  const parsed = codeToolSchemas[tool].input.safeParse(raw);
  if (!parsed.success) {
    const msgs = parsed.error.issues.map((is) => {
      const p = is.path.join('.') || 'input';
      if (is.code === 'invalid_type' && (is as { received?: string }).received === 'undefined') return `${p} is required`;
      if (is.code === 'invalid_enum_value') {
        return `${p} must be one of ${(is.options as unknown[]).join(', ')} (got "${String(is.received)}")`;
      }
      if (is.code === 'too_small') {
        return is.type === 'string' ? `${p} must not be empty` : `${p} must be >= ${String(is.minimum)}`;
      }
      if (is.code === 'too_big') return `${p} must be <= ${String(is.maximum)}`;
      return `${p}: ${is.message}`;
    });
    return fail(msgs.join('; '));
  }
  return { ok: true, raw };
}

// -- Help --------------------------------------------------------------------------------------

function typeLabel(f: FieldInfo): string {
  let t: string;
  if (f.type === 'enum') t = f.enumValues!.join('|');
  else if (f.type === 'boolean') t = 'bool';
  else if (f.type === 'number') {
    const range = f.min !== undefined && f.max !== undefined ? ` ${f.min}-${f.max}` : f.min !== undefined ? ` >=${f.min}` : f.max !== undefined ? ` <=${f.max}` : '';
    t = `${f.int ? 'int' : 'num'}${range}`;
  } else t = 'string';
  return f.array ? `list<${t}>` : t;
}

/** Compact `pairs <tool> --help`: synopsis, description, one line per flag. */
export function toolHelp(tool: CodeToolName): string {
  const fields = toolFields(tool);
  const spec = TOOL_ARG_SPECS[tool];
  const synopsis = spec
    .map((n) => {
      const f = fields.find((x) => x.name === n)!;
      return f.optional ? `[${n}]` : `<${n}>`;
    })
    .join(' ');
  const lines = [`Usage: pairs ${tool}${synopsis ? ` ${synopsis}` : ''} [--flag value ...] [--json|--pretty]`, codeToolSchemas[tool].description, 'Flags:'];
  const aliasOf = (f: FieldInfo): string[] =>
    Object.entries(FLAG_ALIASES)
      .filter(([k, v]) => v === f.name && !fields.some((x) => x.name === k))
      .map(([k]) => `--${k}`);
  for (const f of fields) {
    const parts = [`  --${f.name}`, typeLabel(f)];
    const meta: string[] = [];
    if (f.hasDefault) meta.push(`default ${JSON.stringify(f.defaultValue)}`);
    else if (!f.optional) meta.push('required');
    const al = aliasOf(f);
    if (al.length > 0) meta.push(`alias ${al.join(' ')}`);
    if (f.description) meta.push(f.description);
    lines.push(`${parts.join('  ')}${meta.length > 0 ? `  - ${meta.join('; ')}` : ''}`);
  }
  lines.push('Flags also work as --kebab-case and --flag=value; bools: --flag, --no-flag, --flag false; lists: comma-separated.');
  return lines.join('\n');
}

const firstSentence = (s: string): string => /^.*?[.!?](?=\s|$)/.exec(s)?.[0] ?? s;

/** `pairs --help`: every command with a one-line description. */
export function commandList(): string {
  const names = Object.keys(codeToolSchemas) as CodeToolName[];
  const w = Math.max(...names.map((n) => n.length), 12);
  const lines = ['Usage: pairs <command> [args] [--flags] [--json|--pretty] [--root <dir>] [--no-refresh]', '', 'Code tools:'];
  for (const n of names) lines.push(`  ${n.padEnd(w)}  ${firstSentence(codeToolSchemas[n].description)}`);
  lines.push(
    '',
    'Other: index [--rebuild], watch, stats, query <sql>, files [pattern] [--paths], read <path> [start] [end]',
    'Run `pairs <command> --help` for a tool\'s flags (every input field is a --flag).'
  );
  return lines.join('\n');
}
