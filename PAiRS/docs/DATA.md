# Data Files & Fixtures

Guide to test data, golden values, fixtures, and reference data in PAiRS.

---

## Test Fixtures

| File | Purpose | Format | Usage |
|------|---------|--------|-------|
| `src/test/fixtures/*/` | Mini codebases | TS, Python, Rust, etc. | Parser unit tests |
| `src/test/fixtures/*/expected_symbols.json` | Expected symbol extraction | JSON | Comparison tests |
| `src/test/fixtures/*/expected_edges.json` | Expected relationship edges | JSON | Dependency extraction tests |

---

## Data Files

| File | Purpose | Format | When Used |
|------|---------|--------|-----------|
| `.pairs/index.db` | Code graph index | SQLite | Queried by tools/CLI/extension |
| `dist/cli.js` | CLI binary (generated) | JavaScript | Installed to `~/.local/bin/pairs` |

---

## Golden Values

**Symbol Extraction Accuracy:**
- **Function definitions**: 99%+ accuracy (caught by tree-sitter)
- **Class definitions**: 99%+ accuracy
- **Import statements**: 98%+ (some edge cases with dynamic imports)
- **Type hierarchies**: 95%+ (inheritance, interfaces)

**Confidence Levels:**
- **Resolved** (AST-verified): Safe for automated refactoring
- **Fuzzy** (name-only match): Lower confidence; requires explicit opt-in for risky operations like rename
- **Unresolved**: Could not verify; excluded from refactoring

**Edge Types & Meanings:**
- `CALLS`: Function/method call
- `READS`: Variable/field read
- `WRITES`: Variable/field write
- `IMPLEMENTS`: Class implements interface
- `EXTENDS`: Class extends another class
- `REFERENCES`: Generic reference (used when edge type unclear)

---

## How to Use Test Fixtures

### Run Integration Tests
```bash
npm test -- src/test/indexProject.test.ts

# Uses fixtures/* to verify:
# - Parsing accuracy
# - Symbol extraction
# - Edge detection
# - Query correctness
```

### Add New Language Fixture
```bash
# 1. Create fixture directory
mkdir src/test/fixtures/go_project

# 2. Add sample Go files
# 3. Create expected_symbols.json
cat > expected_symbols.json <<EOF
[
  { "name": "HelloWorld", "kind": "function", "file": "main.go", "line": 5 },
  { "name": "greeting", "kind": "variable", "file": "main.go", "line": 8 }
]
EOF

# 4. Create expected_edges.json
cat > expected_edges.json <<EOF
[
  { "from": "main", "to": "HelloWorld", "kind": "CALLS", "file": "main.go", "line": 12 }
]
EOF

# 5. Run test
npm test -- src/test/fixtures/go_project/
```

### Test Rename Safety
```typescript
// Uses resolved/fuzzy confidence labels
const renameResult = await renameSymbol('OldName', 'NewName', {
  includeFuzzy: false  // Default: only safe (resolved) edges
});

// Verify: All renamed sites are correct
expect(renameResult.safeRenames).toBeGreaterThan(0);
expect(renameResult.unsafeSkipped).toBe(0);
```

---

## Database Schema

**Core Tables:**
- `File`: workspace-relative path, language, last indexed
- `Symbol`: name, kind (function/class/var), file, line range, signature, doc
- `Edge`: source → target, kind (CALLS/READS/WRITES/etc), file, line, confidence (resolved/fuzzy)
- `PendingRef`: unresolved references (name-only, lower confidence)

**Example Queries:**
```sql
-- Find all callers of a function
SELECT DISTINCT e.source_symbol
FROM Edge e
WHERE e.target_symbol = 'findUser' AND e.kind = 'CALLS';

-- Find all symbols in a file
SELECT name, kind, line_start, line_end
FROM Symbol
WHERE file = 'src/auth.ts'
ORDER BY line_start;

-- Check symbol dependencies
SELECT COUNT(*) as dep_count
FROM Edge
WHERE source_symbol = 'AuthService' AND kind IN ('CALLS', 'READS');
```

---

## Reference Data

**Supported Languages (Tree-Sitter):**
- TypeScript, JavaScript
- Python, Go, Rust
- Java, C, C++
- Ruby, Dart, GDScript
- CSS, HTML
- (New languages via tree-sitter WASM)

**Symbol Kinds (per language):**
- Function/Method
- Class/Struct/Interface
- Variable/Constant
- Type/Enum
- Module/Package
- Field/Property
- Parameter

**Edge Confidence Levels:**
- **Resolved**: AST-verified, safe for automated changes
- **Fuzzy**: Name-only match, use with caution
- **Unresolved**: Could not verify, excluded from queries

---

**Last updated:** 2026-09-15
