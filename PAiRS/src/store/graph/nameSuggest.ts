/**
 * Pure ranking helpers behind `CodeStore.suggestNames` / `resolveFilePath`.
 * The SQL side fetches a small, bounded candidate set; this module only orders
 * it, so it stays testable without a database.
 */

/** Edit distance, bailing out as soon as the row minimum exceeds `max` (returns max + 1). */
export function levenshtein(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/** The part of a possibly-qualified name a person would have typo'd: `Foo::bar` / `Foo.bar` / `Foo#bar` → `bar`. */
export function bareName(name: string): string {
  const parts = name.split(/::|[.#\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : name;
}

/** Max edit distance tolerated for a query: short names tolerate only one slip, or everything matches. */
export const maxTypoDistance = (len: number): number => (len <= 4 ? 1 : 2);

/**
 * Order candidate symbol names: case-insensitive equal, prefix, substring, then
 * small edit distance. The exact query itself is dropped (a miss on it is
 * already known). Deterministic: ties break by length then alphabetically.
 */
export function rankNameSuggestions(query: string, candidates: Iterable<string>, limit: number): string[] {
  const q = bareName(query).toLowerCase();
  if (!q) return [];
  const maxD = maxTypoDistance(q.length);
  const scored: Array<{ name: string; tier: number; d: number }> = [];
  const seen = new Set<string>();
  for (const name of candidates) {
    if (seen.has(name) || name === query) continue;
    seen.add(name);
    const n = name.toLowerCase();
    if (n === q) scored.push({ name, tier: 0, d: 0 });
    else if (n.startsWith(q)) scored.push({ name, tier: 1, d: n.length - q.length });
    else if (q.length >= 3 && n.includes(q)) scored.push({ name, tier: 2, d: n.length - q.length });
    else {
      const d = levenshtein(q, n, maxD);
      if (d <= maxD) scored.push({ name, tier: 3, d });
    }
  }
  scored.sort((a, b) => a.tier - b.tier || a.d - b.d || a.name.length - b.name.length || (a.name < b.name ? -1 : 1));
  return scored.slice(0, limit).map((s) => s.name);
}

/** Basename of a `/`-separated path. */
export const baseOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

/** Up to `limit` paths whose basename is closest to the missing path's basename. */
export function rankClosestPaths(missing: string, candidates: Iterable<string>, limit: number): string[] {
  const base = baseOf(missing).toLowerCase();
  const stem = base.replace(/\.[^.]*$/, '');
  const scored: Array<{ p: string; d: number }> = [];
  for (const p of candidates) {
    const b = baseOf(p).toLowerCase();
    const bStem = b.replace(/\.[^.]*$/, '');
    const sub = stem.length >= 2 && (bStem.includes(stem) || stem.includes(bStem));
    const d = levenshtein(base, b, 3);
    if (!sub && d > 3) continue;
    scored.push({ p, d: sub ? Math.min(d, Math.abs(b.length - base.length)) : d });
  }
  scored.sort((a, b) => a.d - b.d || a.p.length - b.p.length || (a.p < b.p ? -1 : 1));
  return scored.slice(0, limit).map((s) => s.p);
}
