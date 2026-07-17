/**
 * CodeSearch implementation: BM25 (always) fused with embedding cosine (when
 * available) plus code-specific boosts. Fusion weights per codeSearch.ts.
 */

import { splitIdentifier } from './extractors';
import type { CodeSearch, CodeSearchDeps } from './codeSearch';
import type { CodeQuery, ScoredSymbol, SymbolRecord } from './types';

function normalize(values: number[]): number[] {
  if (values.length === 0) return [];
  if (values.length === 1) return [1];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  return values.map((v) => (v - min) / range);
}

function exactNameScore(query: string, symbol: SymbolRecord): number {
  const q = query.trim().toLowerCase();
  if (q === symbol.name.toLowerCase() || q === symbol.qualified.toLowerCase()) return 1;
  const terms = new Set(splitIdentifier(symbol.name).split(' ').filter(Boolean));
  const qTerms = q.split(/\s+/).filter(Boolean);
  if (!qTerms.length) return 0;
  const hits = qTerms.filter((t) => terms.has(t)).length;
  return hits / qTerms.length;
}

export class CodeSearchImpl implements CodeSearch {
  constructor(private readonly deps: CodeSearchDeps) {}

  async search(query: CodeQuery): Promise<ScoredSymbol[]> {
    const limit = query.limit ?? 10;
    const offset = query.offset ?? 0;
    // Over-fetch enough candidates to cover the requested page after fusion —
    // scaled to the requested limit (docs/OptimizationPlan.md S2) rather than
    // a flat 50, so small-limit calls (the common case) do less FTS/cosine work.
    const candidateCount = Math.min(Math.max(limit * 3, 20) + offset, 200);
    const ftsCandidates = await this.deps.store.ftsSearch({ ...query, offset: 0, limit: candidateCount });

    // bm25() returns lower-is-better scores; flip sign before normalizing.
    const ftsFlipped = ftsCandidates.map((c) => -c.bm25);
    const ftsNorm = normalize(ftsFlipped);
    const ftsById = new Map<number, number>();
    ftsCandidates.forEach((c, i) => ftsById.set(c.symbol.id, ftsNorm[i]!));

    const bySymbolId = new Map<number, SymbolRecord>();
    for (const c of ftsCandidates) bySymbolId.set(c.symbol.id, c.symbol);

    const semanticById = new Map<number, number>();
    if (this.deps.embed) {
      try {
        const vector = await this.deps.embed(query.text);
        const semanticCandidates = await this.deps.store.semanticSearch(vector, candidateCount);
        for (const c of semanticCandidates) {
          if (!passesFilters(c.symbol, query)) continue;
          bySymbolId.set(c.symbol.id, c.symbol);
          semanticById.set(c.symbol.id, c.cosine);
        }
      } catch (err) {
        // Embedding provider is unavailable (e.g. onnxruntime native binding
        // can't load, model not downloaded yet) — degrade to BM25 + boosts
        // only rather than crashing the whole tool call. The agent still
        // gets useful FTS results.
      }
    }

    const hasSemantic = semanticById.size > 0;
    const weights = hasSemantic
      ? { fts: 0.45, semantic: 0.25, exactName: 0.25, exported: 0.05 }
      : { fts: 0.7, semantic: 0, exactName: 0.25, exported: 0.05 };

    const scored: ScoredSymbol[] = [...bySymbolId.values()].map((symbol) => {
      const fts = ftsById.get(symbol.id) ?? 0;
      const semantic = semanticById.get(symbol.id) ?? 0;
      const exactName = exactNameScore(query.text, symbol);
      const exported = symbol.exported ? 1 : 0;
      const score = weights.fts * fts + weights.semantic * semantic + weights.exactName * exactName + weights.exported * exported;
      return { symbol, score, signals: { fts, semantic, exactName, exported } };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(offset, offset + limit);
  }
}

function passesFilters(symbol: SymbolRecord, query: CodeQuery): boolean {
  if (query.kinds?.length && !query.kinds.includes(symbol.kind)) return false;
  if (query.langs?.length && !query.langs.includes(symbol.lang)) return false;
  if (query.pathPrefix && !symbol.file.startsWith(query.pathPrefix)) return false;
  if (query.excludePath && symbol.file.startsWith(query.excludePath)) return false;
  if (query.exportedOnly && !symbol.exported) return false;
  return true;
}

