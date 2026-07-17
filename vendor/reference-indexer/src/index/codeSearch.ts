/**
 * Hybrid ranking over the code index — same recipe as the memory
 * RecallRanker: BM25 (always) fused with embedding cosine (when the flag is
 * on), plus code-specific boosts.
 *
 * Fusion contract (implemented in codeSearchImpl.ts, mirrors recallRankerImpl.ts conventions):
 *   ftsScore      = normalize bm25 to 0..1 across the candidate set
 *   semanticScore = cosine (0 when embeddings off/missing)
 *   exactName     = 1 when query (case-insensitive) equals symbol name or
 *                   qualified name, else fraction of query terms present in
 *                   splitIdentifier(name)
 *   exported      = 1 if exported else 0
 *   score = 0.45*fts + 0.25*semantic + 0.25*exactName + 0.05*exported
 *   (renormalize weights when semantic is unavailable)
 *
 * Candidate set: union of top-50 FTS and top-50 semantic before fusion, then
 * filters (kinds/langs/pathPrefix/exportedOnly) applied in SQL where possible
 * (FTS side) and post-hoc on the semantic side.
 */

import type { CodeStore } from './codeStore';
import type { CodeQuery, ScoredSymbol } from './types';

export interface CodeSearch {
  search(query: CodeQuery): Promise<ScoredSymbol[]>;
}

export interface CodeSearchDeps {
  store: CodeStore;
  /** Query-text embedder; absent → BM25 + boosts only. */
  embed?: (text: string) => Promise<Float32Array>;
}
