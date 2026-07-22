/**
 * KuzuDB DDL for the derived code graph (subsystem_graph_store_spec.md).
 * Schema versioning: a mismatched SCHEMA_VERSION means an old index —
 * DROP and recreate (the index is disposable derived data, never migrated).
 */

export const SCHEMA_VERSION = 3;

export const SCHEMA_DDL: readonly string[] = [
  `CREATE NODE TABLE File(
     id INT64,
     path STRING,
     lang STRING,
     mtimeMs DOUBLE,
     size INT64,
     hash STRING,
     indexedAt INT64,
     crate STRING,
     parseError BOOLEAN,
     PRIMARY KEY(id)
   )`,
  `CREATE NODE TABLE Symbol(
     id INT64,
     fileId INT64,
     file STRING,
     name STRING,
     qualified STRING,
     kind STRING,
     lang STRING,
     startLine INT64,
     endLine INT64,
     signature STRING,
     doc STRING,
     parentId INT64,
     exported BOOLEAN,
     PRIMARY KEY(id)
   )`,
  // Structural edges (Pass 1 DECLARE) — always resolved.
  `CREATE REL TABLE DECLARES(FROM File TO Symbol)`,
  `CREATE REL TABLE OWNS(FROM Symbol TO Symbol)`,
  `CREATE REL TABLE PARAM(FROM Symbol TO Symbol)`,
  `CREATE REL TABLE OF_TYPE(FROM Symbol TO Symbol)`,
  `CREATE REL TABLE RETURNS(FROM Symbol TO Symbol)`,
  // Reference edges (Pass 2 RESOLVE) — carry line + confidence + test
  // (true when the reference site is inside a #[cfg(test)] mod / #[test] fn;
  // architectural rules exclude these edges — R1).
  `CREATE REL TABLE CALLS(FROM Symbol TO Symbol, line INT64, confidence STRING, test BOOLEAN)`,
  `CREATE REL TABLE READS(FROM Symbol TO Symbol, line INT64, confidence STRING, test BOOLEAN)`,
  `CREATE REL TABLE WRITES(FROM Symbol TO Symbol, line INT64, confidence STRING, test BOOLEAN)`,
  `CREATE REL TABLE DEPENDS_ON(FROM Symbol TO Symbol, line INT64, confidence STRING, test BOOLEAN)`,
  `CREATE REL TABLE IMPLEMENTS(FROM Symbol TO Symbol, line INT64, confidence STRING, test BOOLEAN)`,
  `CREATE REL TABLE EXTENDS(FROM Symbol TO Symbol, line INT64, confidence STRING, test BOOLEAN)`,
  `CREATE REL TABLE REFERENCES(FROM Symbol TO Symbol, line INT64, confidence STRING, test BOOLEAN)`,
  `CREATE REL TABLE IMPORTS(FROM Symbol TO Symbol, line INT64, confidence STRING, test BOOLEAN)`,
  // Unresolved references, retried by resolvePending as new files arrive.
  // qualifiedName: the ref as written when it carried a `::` qualifier
  // (`Foo::new`), else ''. Persisted so a retry resolves with the same
  // information the first attempt had — see resolveOneRef's qualified-first ladder.
  `CREATE NODE TABLE PendingRef(
     id INT64,
     fileId INT64,
     fromSymbolId INT64,
     name STRING,
     qualifiedName STRING,
     kind STRING,
     line INT64,
     methodCall BOOLEAN,
     inTest BOOLEAN,
     PRIMARY KEY(id)
   )`,
  `CREATE NODE TABLE Meta(key STRING, value STRING, PRIMARY KEY(key))`,
];

export const REFERENCE_EDGE_TABLES: readonly string[] = ['CALLS', 'READS', 'WRITES', 'DEPENDS_ON', 'IMPLEMENTS', 'EXTENDS', 'REFERENCES', 'IMPORTS'];
export const STRUCTURAL_EDGE_TABLES: readonly string[] = ['DECLARES', 'OWNS', 'PARAM', 'OF_TYPE', 'RETURNS'];
