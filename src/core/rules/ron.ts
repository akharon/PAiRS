/**
 * Minimal RON (Rusty Object Notation) reader — just the subset `.pairs/rules.ron`
 * uses (spec §3.1): structs `(field: value, …)`, maps `{ "k": v }`, lists,
 * enum variants `Name` / `Name(args…)` (positional or named), strings with
 * escapes, numbers, booleans, `Some(x)`/`None`, line and block comments,
 * trailing commas.
 *
 * Hand-rolled on purpose: no maintained RON parser exists on npm, and the
 * config grammar is small enough that a dependency would cost more than these
 * ~150 lines. Errors carry line:col so a bad rules.ron is fixable from the
 * message alone.
 */

export type RonValue =
  | string
  | number
  | boolean
  | null
  | RonValue[]
  | { [key: string]: RonValue }
  | RonVariant;

/** `Layering(direction: DownOnly)` → { variant: 'Layering', named: {...} }. */
export interface RonVariant {
  variant: string;
  /** Positional args, in order (e.g. `Cypher("MATCH …")`). */
  args: RonValue[];
  /** Named args (e.g. `Layering(direction: DownOnly, max_skip: 0)`). */
  named: Record<string, RonValue>;
}

export function isVariant(v: RonValue): v is RonVariant {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && 'variant' in v && 'args' in v;
}

export class RonError extends Error {
  constructor(message: string, line: number, col: number) {
    super(`rules.ron:${line}:${col}: ${message}`);
  }
}

export function parseRon(src: string): RonValue {
  const p = new Parser(src);
  p.skipWs();
  const v = p.value();
  p.skipWs();
  if (!p.eof()) p.fail('trailing content after document');
  return v;
}

class Parser {
  private i = 0;
  constructor(private readonly src: string) {}

  eof(): boolean {
    return this.i >= this.src.length;
  }

  fail(msg: string): never {
    let line = 1;
    let col = 1;
    for (let j = 0; j < this.i && j < this.src.length; j++) {
      if (this.src[j] === '\n') { line++; col = 1; } else col++;
    }
    throw new RonError(msg, line, col);
  }

  skipWs(): void {
    for (;;) {
      while (this.i < this.src.length && /\s/.test(this.src[this.i]!)) this.i++;
      if (this.src.startsWith('//', this.i)) {
        const nl = this.src.indexOf('\n', this.i);
        this.i = nl === -1 ? this.src.length : nl + 1;
      } else if (this.src.startsWith('/*', this.i)) {
        const end = this.src.indexOf('*/', this.i + 2);
        if (end === -1) this.fail('unterminated block comment');
        this.i = end + 2;
      } else return;
    }
  }

  private peek(): string {
    return this.src[this.i] ?? '';
  }

  private expect(ch: string): void {
    if (this.peek() !== ch) this.fail(`expected '${ch}', found '${this.peek() || 'EOF'}'`);
    this.i++;
  }

  value(): RonValue {
    this.skipWs();
    const c = this.peek();
    if (c === '"') return this.string();
    if (c === '(') return this.struct();
    if (c === '{') return this.map();
    if (c === '[') return this.list();
    if (c === '-' || (c >= '0' && c <= '9')) return this.number();
    if (/[A-Za-z_]/.test(c)) return this.identOrVariant();
    this.fail(`unexpected character '${c || 'EOF'}'`);
  }

  private string(): string {
    this.expect('"');
    let out = '';
    while (this.i < this.src.length) {
      const c = this.src[this.i++]!;
      if (c === '"') return out;
      if (c === '\\') {
        const e = this.src[this.i++];
        if (e === 'n') out += '\n';
        else if (e === 't') out += '\t';
        else if (e === '"') out += '"';
        else if (e === '\\') out += '\\';
        else this.fail(`unknown escape \\${e ?? 'EOF'}`);
      } else out += c;
    }
    this.fail('unterminated string');
  }

  private number(): number {
    const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(this.src.slice(this.i));
    if (!m) this.fail('invalid number');
    this.i += m[0].length;
    return Number(m[0]);
  }

  private ident(): string {
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.i));
    if (!m) this.fail('expected identifier');
    this.i += m[0].length;
    return m[0];
  }

  /** true/false/None → literals; Some(x) unwraps; else enum variant. */
  private identOrVariant(): RonValue {
    const name = this.ident();
    if (name === 'true') return true;
    if (name === 'false') return false;
    if (name === 'None') return null;
    this.skipWs();
    if (this.peek() !== '(') return { variant: name, args: [], named: {} };
    if (name === 'Some') {
      this.expect('(');
      const v = this.value();
      this.skipWs();
      this.expect(')');
      return v;
    }
    const { args, named } = this.parenBody();
    return { variant: name, args, named };
  }

  /** A top-level `( … )` struct — named fields only → plain object. */
  private struct(): RonValue {
    const { args, named } = this.parenBody();
    if (args.length > 0) this.fail('anonymous struct with positional fields is not supported here');
    return named;
  }

  /** Shared for structs and variant bodies: `( a: 1, "x", b: 2, )`. */
  private parenBody(): { args: RonValue[]; named: Record<string, RonValue> } {
    this.expect('(');
    const args: RonValue[] = [];
    const named: Record<string, RonValue> = {};
    for (;;) {
      this.skipWs();
      if (this.peek() === ')') { this.i++; return { args, named }; }
      // Lookahead: `ident:` → named field; anything else → positional value.
      const save = this.i;
      if (/[A-Za-z_]/.test(this.peek())) {
        const key = this.ident();
        this.skipWs();
        if (this.peek() === ':') {
          this.i++;
          named[key] = this.value();
        } else {
          this.i = save;
          args.push(this.value());
        }
      } else {
        args.push(this.value());
      }
      this.skipWs();
      if (this.peek() === ',') { this.i++; continue; }
      if (this.peek() === ')') { this.i++; return { args, named }; }
      this.fail(`expected ',' or ')' in struct, found '${this.peek() || 'EOF'}'`);
    }
  }

  private map(): Record<string, RonValue> {
    this.expect('{');
    const out: Record<string, RonValue> = {};
    for (;;) {
      this.skipWs();
      if (this.peek() === '}') { this.i++; return out; }
      const key = this.peek() === '"' ? this.string() : this.ident();
      this.skipWs();
      this.expect(':');
      out[key] = this.value();
      this.skipWs();
      if (this.peek() === ',') { this.i++; continue; }
      if (this.peek() === '}') { this.i++; return out; }
      this.fail(`expected ',' or '}' in map, found '${this.peek() || 'EOF'}'`);
    }
  }

  private list(): RonValue[] {
    this.expect('[');
    const out: RonValue[] = [];
    for (;;) {
      this.skipWs();
      if (this.peek() === ']') { this.i++; return out; }
      out.push(this.value());
      this.skipWs();
      if (this.peek() === ',') { this.i++; continue; }
      if (this.peek() === ']') { this.i++; return out; }
      this.fail(`expected ',' or ']' in list, found '${this.peek() || 'EOF'}'`);
    }
  }
}
