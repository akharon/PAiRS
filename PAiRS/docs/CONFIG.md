# Configuration Reference

Quick guide to all configuration files in PAiRS.

---

## Configuration Files

| File | Purpose | Key Settings | Notes |
|------|---------|--------------|-------|
| `package.json` | Project dependencies | dependencies, devDependencies, scripts | npm workspaces |
| `tsconfig.json` | TypeScript compiler | target (ES2020), strict: true, module resolution | Strict mode enforced |
| `.eslintrc.json` | Linting rules | no-restricted-imports (blocks vscode in core) | Adapter boundary enforced |
| `.prettierrc.json` | Code formatter | printWidth: 100, semi: true | Consistent style |
| `src/adapters/vscode/package.json` | VS Code extension manifest | displayName, activationEvents, contributes | Extension entry point |
| `.pairs/index.db` | SQLite code index | (auto-generated) | Safe to gitignore |
| `src/test/fixtures/*/` | Test projects | (mini codebases) | For integration tests |

---

## Critical Configuration Points

### Adapter Boundary Enforcement (G1 Rule)
- **`eslint` config**: `no-restricted-imports` blocks `vscode` outside `src/adapters/vscode/extension.ts`
- **Verified by**: `npm run lint` — fails if boundary violated
- **Why**: Keeps core editor-agnostic; CLI and extension share same logic

### TypeScript Strictness
- **`tsconfig.json`**: All strict flags enabled
- **Current**: Strict mode enforced; no implicit `any`, null checks, etc.
- **Violations**: Linter catches and fails build

### Tool Registration (Language Model Tools)
- **`src/adapters/vscode/package.json`**: Under `contributes.lm-tools`
- **Auto-discovery**: Extension reads `codeToolSchemas` and registers all tools
- **Format**: Each tool must have Zod schema in `src/core/tools/tools.ts`

### Code Store Facade
- **`src/store/graph/sqliteCodeStore.ts`**: Single entry point for all queries
- **No imports of low-level query functions**: Everything goes through facade
- **Reason**: Ensures consistency; single optimization point

---

## How to Modify Common Configurations

### Add New Language Support
```typescript
// Edit src/core/indexer/parserRegistryImpl.ts

// 1. Register parser + query strings
const parsers: Record<Language, ParserConfig> = {
  golang: {
    parser: await wasmParsers.golang(),
    symbolQuery: '(function_declaration name: (identifier) @symbol)',
  },
  // ... Add new language
};
```

Then update tests:
```bash
npm test -- src/test/  # Verify parsing works
```

### Add New Tool
```typescript
// 1. Define schema in src/core/tools/tools.ts
export const newToolSchema = z.object({
  query: z.string(),
  options: z.object({ recursive: z.boolean() }),
});

// 2. Implement in src/core/tools/executors.ts
export async function executeNewTool(input: typeof newToolSchema) {
  // Query builder, return results
}

// 3. Register in codeToolSchemas
export const codeToolSchemas = {
  find_symbol: findSymbolSchema,
  new_tool: newToolSchema,  // Add here
};

// 4. Extension auto-discovers it as Language Model Tool
```

### Update TypeScript Target
```json
// Edit tsconfig.json under "compilerOptions"
{
  "target": "ES2022",    // Was ES2020
  "lib": ["ES2022", "DOM"]
}
```

### Disable a Linting Rule (Not Recommended)
```json
// Edit .eslintrc.json under "rules"
{
  "rules": {
    "@typescript-eslint/explicit-function-return-types": "warn"  // Downgrade to warning
  }
}
```

---

## Build & Package

**Development:**
```bash
npm run build       # Compile TS → JS
npm run build:watch # Watch mode
```

**Testing:**
```bash
npm run test        # Run tests
npm test:watch      # Watch mode
```

**Packaging:**
```bash
npm run package     # Build .vsix (VS Code extension)
npm run install     # Full pipeline: build → test → package → install
```

---

**Last updated:** 2026-09-15
