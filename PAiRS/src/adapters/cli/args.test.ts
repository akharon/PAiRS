import { describe, expect, it } from 'vitest';
import { codeToolSchemas, type CodeToolName } from '../../core/tools/tools';
import { commandList, parseToolArgs, toolFields, toolHelp, wantsHelp } from './args';

const ok = (tool: CodeToolName, argv: string[]): Record<string, unknown> => {
  const r = parseToolArgs(tool, argv);
  if (!r.ok) throw new Error(r.error);
  return r.raw;
};
const err = (tool: CodeToolName, argv: string[]): string => {
  const r = parseToolArgs(tool, argv);
  if (r.ok) throw new Error(`expected error, got ${JSON.stringify(r.raw)}`);
  return r.error;
};

describe('parseToolArgs: flags', () => {
  it('accepts --field value, --field=value and --kebab-case', () => {
    expect(ok('find_symbol', ['X', '--limit', '5'])).toEqual({ name: 'X', limit: 5 });
    expect(ok('find_symbol', ['X', '--limit=5'])).toEqual({ name: 'X', limit: 5 });
    expect(ok('grep_symbols', ['p', '--path-prefix', 'src'])).toEqual({ pattern: 'p', pathPrefix: 'src' });
    expect(ok('grep_symbols', ['p', '--pathPrefix', 'src'])).toEqual({ pattern: 'p', pathPrefix: 'src' });
    expect(ok('rename_symbol', ['A', 'B', '--include-fuzzy'])).toEqual({ name: 'A', newName: 'B', includeFuzzy: true });
  });

  it('every schema field of every tool is reachable as a flag', () => {
    for (const tool of Object.keys(codeToolSchemas) as CodeToolName[]) {
      for (const f of toolFields(tool)) {
        const sample = f.type === 'number' ? ['3'] : f.type === 'enum' ? [f.enumValues![0]!] : f.type === 'boolean' ? [] : ['x'];
        const r = parseToolArgs(tool, [`--${f.name}`, ...sample]);
        // Usually fails zod (other required fields missing), but never as an unknown flag.
        if (!r.ok) expect(r.error).not.toMatch(/Unknown flag/);
      }
    }
  });

  it('boolean: bare, --no-, and explicit value', () => {
    expect(ok('find_symbol', ['X', '--preview']).preview).toBe(true);
    expect(ok('find_symbol', ['--preview', 'X'])).toEqual({ name: 'X', preview: true });
    expect(ok('impact', ['X', '--no-include-tests']).includeTests).toBe(false);
    expect(ok('impact', ['X', '--include-tests', 'false']).includeTests).toBe(false);
    expect(ok('impact', ['X', '--include-tests', '0']).includeTests).toBe(false);
    expect(ok('impact', ['X', '--include-tests=true']).includeTests).toBe(true);
    expect(ok('file_deps', ['a.ts', '--transitive']).transitive).toBe(true);
    expect(ok('get_symbol', ['X', '--no-includeMembers']).includeMembers).toBe(false);
    expect(ok('analyze', ['dead_code', '--include-exported']).includeExported).toBe(true);
  });

  it('numbers are validated', () => {
    expect(err('find_symbol', ['X', '--limit', 'abc'])).toBe('find_symbol: limit must be a number (got "abc")');
    expect(err('find_symbol', ['X', '--limit', '500'])).toBe('find_symbol: limit must be <= 50');
    expect(err('find_symbol', ['X', '--limit'])).toMatch(/--limit needs a value/);
    expect(err('find_symbol', ['X', '--limit', '--preview'])).toMatch(/--limit needs a value/);
  });

  it('arrays: comma-separated, repeatable, enum case-insensitive', () => {
    expect(ok('impact', ['X', '--kinds', 'calls,reads']).kinds).toEqual(['CALLS', 'READS']);
    expect(ok('impact', ['X', '--kinds', 'CALLS', '--kinds', 'WRITES']).kinds).toEqual(['CALLS', 'WRITES']);
    expect(ok('find_symbol', ['X', '--kind', 'Function']).kinds).toEqual(['function']);
    expect(ok('find_symbol', ['X', '--langs', 'TypeScript,go']).langs).toEqual(['typescript', 'go']);
    expect(err('impact', ['X', '--kinds', 'NOPE'])).toMatch(/^impact: kinds must be one of CALLS, .*\(got "NOPE"\)$/);
  });

  it('aliases: --kind, --lang, --regex, plus tool-native names', () => {
    expect(ok('find_symbol', ['X', '--lang', 'go']).langs).toEqual(['go']);
    expect(ok('grep_symbols', ['p', '--regex']).isRegex).toBe(true);
    expect(ok('grep_symbols', ['p', '--kind', 'function']).kinds).toEqual(['function']);
    expect(ok('impact', ['X', '--kind', 'calls']).kinds).toEqual(['CALLS']);
    // analyze has a real `kind` field, so --kind is not the plural alias there.
    expect(ok('analyze', ['--kind', 'fan_out']).kind).toBe('fan_out');
    expect(ok('diff_impact', ['--rev', 'main...HEAD', '--staged'])).toEqual({ rev: 'main...HEAD', staged: true });
    expect(ok('context_pack', ['--path', 'src/a.ts'])).toEqual({ path: 'src/a.ts' });
    expect(ok('find_symbol', ['X', '--preview', '--limit', '2'])).toEqual({ name: 'X', preview: true, limit: 2 });
  });

  it('unknown flag lists the valid ones on one line', () => {
    const e = err('find_symbol', ['X', '--bogus']);
    expect(e).toMatch(/^Unknown flag --bogus for find_symbol\. Flags: --name --kinds --langs --limit/);
    expect(e).not.toContain('\n');
    expect(err('find_symbol', ['X', '--no-limit'])).toMatch(/^Unknown flag --no-limit/);
  });
});

describe('parseToolArgs: positionals', () => {
  it('follow TOOL_ARG_SPECS', () => {
    expect(ok('impact', ['X', 'src/a.ts', '2', 'false'])).toEqual({ name: 'X', path: 'src/a.ts', depth: 2, includeTests: false });
    expect(ok('hierarchy', ['T', 'a.ts', '4'])).toEqual({ name: 'T', path: 'a.ts', depth: 4 });
    expect(ok('file_deps', ['a.ts', 'imports'])).toEqual({ path: 'a.ts', direction: 'imports' });
    expect(ok('diff_impact', [])).toEqual({});
  });

  it('an enum word fills its enum field (who_calls X callees)', () => {
    expect(ok('who_calls', ['X', 'callees']).direction).toBe('callees');
    expect(ok('who_calls', ['X', 'CALLEES']).direction).toBe('callees');
    expect(ok('who_calls', ['X', 'src/a.ts', 'callees'])).toEqual({ name: 'X', path: 'src/a.ts', direction: 'callees' });
    // First-slot positional is never hijacked: a file named like an enum value stays a path.
    expect(ok('file_deps', ['imports'])).toEqual({ path: 'imports' });
  });

  it('flags take the place of positionals', () => {
    expect(ok('who_calls', ['X', '--direction', 'callees'])).toEqual({ name: 'X', direction: 'callees' });
    expect(ok('who_calls', ['--direction=callees', 'X', 'src/a.ts'])).toEqual({ name: 'X', direction: 'callees', path: 'src/a.ts' });
    expect(ok('find_symbol', ['--name', 'X'])).toEqual({ name: 'X' });
  });

  it('module_map boundary may be unquoted; extra positionals elsewhere are an error', () => {
    expect(ok('module_map', ['src/a', '->', 'src/b']).boundary).toBe('src/a -> src/b');
    expect(err('find_symbol', ['a', 'b'])).toMatch(/^find_symbol: unexpected argument "b" \(takes <name>/);
  });
});

describe('parseToolArgs: validation errors are one line', () => {
  it('missing required', () => {
    expect(err('find_symbol', [])).toBe('find_symbol: name is required');
    expect(err('rename_symbol', ['A'])).toBe('rename_symbol: newName is required');
  });

  it('bad enum', () => {
    expect(err('who_calls', ['X', '--direction', 'x'])).toBe('who_calls: direction must be one of callers, callees (got "x")');
    expect(err('who_calls', ['X', 'sideways'])).toBe('who_calls: direction must be one of callers, callees (got "sideways")');
  });

  it('bad boolean', () => {
    expect(err('impact', ['X', '--include-tests=maybe'])).toBe('impact: includeTests must be true or false (got "maybe")');
  });

  it('empty string', () => {
    expect(err('find_symbol', [''])).toBe('find_symbol: name must not be empty');
  });
});

describe('help', () => {
  it('wantsHelp', () => {
    expect(wantsHelp(['--help'])).toBe(true);
    expect(wantsHelp(['X', '-h'])).toBe(true);
    expect(wantsHelp(['X'])).toBe(false);
  });

  it('toolHelp: synopsis, description, one line per flag', () => {
    const h = toolHelp('find_symbol');
    const lines = h.split('\n');
    expect(lines[0]).toBe('Usage: pairs find_symbol <name> [--flag value ...] [--json|--pretty]');
    expect(lines[1]).toBe(codeToolSchemas.find_symbol.description);
    expect(h).toContain('--limit  int 1-50  - default 20');
    expect(h).toContain('--preview  bool  - default false; Include doc and first body lines per hit.');
    expect(h).toContain('--kinds  list<');
    expect(h).toContain('alias --kind');
    for (const f of toolFields('find_symbol')) expect(h).toContain(`--${f.name}`);
  });

  it('every tool has help mentioning each of its fields', () => {
    for (const tool of Object.keys(codeToolSchemas) as CodeToolName[]) {
      const h = toolHelp(tool);
      for (const f of toolFields(tool)) expect(h).toContain(`--${f.name}`);
    }
  });

  it('commandList: one line per tool with the first sentence', () => {
    const l = commandList();
    for (const tool of Object.keys(codeToolSchemas)) expect(l).toContain(`  ${tool}`);
    expect(l).toContain('Locate a symbol definition by bare or qualified name, workspace-wide (file:line, kind, signature).');
    expect(l).not.toContain('Ambiguous names list candidates');
  });
});
