import type { MemoryQuery, ScoredMemory } from '../core/types';
import type { MemoryStore } from '../core/store';
import type { CodeStore } from '../index/codeStore';
import type { CodeSearch } from '../index/codeSearch';
import type { GitOps } from '../index/codeIndexer';
import type { IndexProvenanceService, IndexFreshness } from '../index/provenance';
import { MemoryToolExecutorImpl } from './toolExecutor';
import { CodeToolExecutorImpl } from './codeToolExecutor';
import { createMemoryAnchors } from './memoryAnchors';
import {
  AnchorSuggesterImpl,
  AnchorMigratorImpl,
  TaskBriefingComposerImpl,
  createCommitStamp,
  codeSearchTextAdapter,
} from '../intelligence/memoryCodeBridgeImpl';
import type { AnchorMigrator, AnchorSuggester, TaskBriefingComposer } from '../intelligence/memoryCodeBridge';

export interface CreateExecutorsDeps {
  store: MemoryStore;
  /** Defaults to `store.search.bind(store)`; extension.ts passes `ranker.recall` for semantic fusion. */
  search?: (query: MemoryQuery) => Promise<ScoredMemory[]>;
  contextTokenBudget?: number;
  /**
   * Optional: enables commit-stamped memories (§F2) even when `code` is
   * omitted — a git workspace with code indexing disabled still benefits.
   */
  git?: GitOps;
  /** Omit to skip constructing a CodeToolExecutor (e.g. code indexing disabled). */
  code?: {
    store: CodeStore;
    search: CodeSearch;
    /** Enables generation stamps + freshness footers (§F1); omit for `open()`-only CodeStores. */
    provenance?: IndexProvenanceService;
    /** Live freshness including queue depth; falls back to provenance.freshness() without a queue if absent. */
    freshness?: () => Promise<IndexFreshness | null>;
  };
}

export interface Executors {
  memory: MemoryToolExecutorImpl;
  code?: CodeToolExecutorImpl;
  /** Present whenever `code` is supplied (§F3). */
  anchorSuggester?: AnchorSuggester;
  anchorMigrator?: AnchorMigrator;
  /** Present whenever `code` is supplied (§F4); folded into memory_context automatically. */
  briefingComposer?: TaskBriefingComposer;
}

/**
 * Single factory for the memory + code tool executors, used by all three
 * composition roots (extension.ts, mcp/server.ts, daemon/workspaceRegistry.ts)
 * so wiring a new executor dependency is one edit instead of three
 * (invariant #6: one behavior, all transports).
 */
export function createExecutors(deps: CreateExecutorsDeps): Executors {
  const search = deps.search;
  const commitStamp = deps.git ? createCommitStamp(deps.git) : undefined;

  let briefingComposer: TaskBriefingComposer | undefined;
  let anchorSuggester: AnchorSuggester | undefined;
  let anchorMigrator: AnchorMigrator | undefined;

  if (deps.code) {
    anchorSuggester = new AnchorSuggesterImpl(deps.code.store);
    anchorMigrator = new AnchorMigratorImpl(deps.store, deps.code.store);
    briefingComposer = new TaskBriefingComposerImpl({
      memoryStore: deps.store,
      memorySearch: search ?? ((q) => deps.store.search(q)),
      codeStore: deps.code.store,
      codeSearchText: codeSearchTextAdapter((text, limit) => deps.code!.search.search({ text, limit })),
      freshness: deps.code.freshness,
      defaultTokenBudget: deps.contextTokenBudget,
    });
  }

  const memory = new MemoryToolExecutorImpl({
    store: deps.store,
    search,
    contextTokenBudget: deps.contextTokenBudget,
    commitStamp,
    briefingComposer,
  });

  if (!deps.code) {
    return { memory };
  }

  const code = new CodeToolExecutorImpl({
    store: deps.code.store,
    search: deps.code.search,
    contextTokenBudget: deps.contextTokenBudget,
    memoryAnchors: createMemoryAnchors(deps.store),
    freshness: deps.code.freshness,
  });

  return { memory, code, anchorSuggester, anchorMigrator, briefingComposer };
}
