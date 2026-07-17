#!/usr/bin/env node
// Phase 0 Spike S2 (plan.md): does a KuzuDB read snapshot stay stable while a
// concurrent write transaction is in flight? And: investigate the segfault
// observed during ad hoc smoke testing on explicit db.close()/conn.close()
// teardown (kuzu@0.11.3, Node 22).
//
// Usage: node spikes/s2-kuzu-concurrency.mjs
import kuzu from 'kuzu';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Kuzu wants a path it can create itself — a pre-made directory is rejected.
const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gizem-s2-')), 'graph.kz');
console.log(`[S2] db at ${dbPath}`);

const db = new kuzu.Database(dbPath);
const writer = new kuzu.Connection(db);
const reader = new kuzu.Connection(db);

await writer.query('CREATE NODE TABLE Symbol(id INT64, name STRING, PRIMARY KEY(id))');
await writer.query("CREATE (:Symbol {id: 0, name: 'seed'})");

let writeErrors = 0;
let readErrors = 0;
let torn = 0;
const WRITES = 200;

async function writeLoop() {
  for (let i = 1; i <= WRITES; i++) {
    try {
      await writer.query(`CREATE (:Symbol {id: ${i}, name: 'sym${i}'})`);
    } catch (err) {
      writeErrors++;
      console.error(`[S2] write ${i} failed:`, err.message);
    }
  }
}

async function readLoop() {
  let lastCount = 0;
  while (lastCount < WRITES) {
    try {
      const res = await reader.query('MATCH (s:Symbol) RETURN count(s) AS c');
      const rows = await res.getAll();
      res.close();
      const count = Number(rows[0]?.c ?? 0);
      // A "torn" read would be a count that goes backwards between polls —
      // MVCC should make this impossible; flag it loudly if seen.
      if (count < lastCount) {
        torn++;
        console.error(`[S2] TORN READ: count went from ${lastCount} to ${count}`);
      }
      lastCount = count;
    } catch (err) {
      readErrors++;
      console.error('[S2] read failed:', err.message);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

const start = Date.now();
await Promise.all([writeLoop(), readLoop()]);
const elapsedMs = Date.now() - start;

const finalRes = await writer.query('MATCH (s:Symbol) RETURN count(s) AS c');
const finalCount = Number((await finalRes.getAll())[0]?.c ?? 0);
finalRes.close();

console.log('[S2] Results:');
console.log(`  writes attempted: ${WRITES}, write errors: ${writeErrors}`);
console.log(`  read errors: ${readErrors}, torn reads: ${torn}`);
console.log(`  final count: ${finalCount} (expect ${WRITES + 1})`);
console.log(`  elapsed: ${elapsedMs}ms`);
console.log(`  PASS (S2 exit criteria): ${writeErrors === 0 && readErrors === 0 && torn === 0 && finalCount === WRITES + 1}`);

// --- close()-teardown segfault investigation --------------------------------
// Ad hoc smoke testing during Phase 0 scaffolding found that calling
// res.close() -> conn.close() -> db.close() in sequence segfaults the
// process on process exit (kuzu@0.11.3, Node 22.23.1), even though the
// queries themselves complete correctly and print results first. Try a few
// teardown orderings here so the finding is reproducible and narrowed down
// rather than anecdotal.
console.log('[S2] Testing teardown orderings for the close() segfault...');
console.log('  (each ordering runs in-process; a segfault here crashes this script —');
console.log('   run each variant with GIZEM_S2_VARIANT=<n> node spikes/s2-kuzu-concurrency.mjs --teardown-only to isolate)');

const variant = process.env.GIZEM_S2_VARIANT;
if (variant === '1') {
  reader.close?.();
  writer.close?.();
  db.close();
} else if (variant === '2') {
  db.close(); // close db first, without closing connections
} else if (variant === '3') {
  // Don't call close() at all — let process exit naturally.
} else {
  console.log('[S2] No GIZEM_S2_VARIANT set — skipping teardown, exiting via process.exit(0) to avoid the observed segfault path.');
  process.exit(0);
}
