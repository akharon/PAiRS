import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeHeartbeat } from '../../platform/pairsDir';
import { nodeSqlDriver, type SqlDriver } from '../../store/graph/sqliteDriver';
import { bootstrapCli, classifyCommand, parseGlobalFlags, SNAPSHOT_NOTICE, type CliContext } from './context';

const GRAMMARS_DIR = path.join(__dirname, '..', '..', '..', 'dist', 'grammars');
const QUERIES_DIR = path.join(__dirname, '..', '..', 'core', 'indexer', 'queries');

const tmp = (): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-ctx-')));
function write(root: string, rel: string, body: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}
function repo(): string {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.git'));
  write(root, 'src/a.ts', 'export function alpha(): number { return 1; }\n');
  write(root, 'src/b.ts', "import { alpha } from './a';\nexport function beta(): number { return alpha(); }\n");
  return root;
}

const open: CliContext[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
  process.exitCode = undefined;
});

async function boot(command: string, cwd: string, extra: string[] = [], env: NodeJS.ProcessEnv = {}) {
  const lines: string[] = [];
  const flags = parseGlobalFlags([command, ...extra]);
  const ctx = await bootstrapCli(command, flags, {
    grammarsDir: GRAMMARS_DIR,
    queriesDir: QUERIES_DIR,
    cwd,
    env,
    log: (l) => lines.push(l),
  });
  if (ctx) open.push(ctx);
  return { ctx, lines };
}

describe('parseGlobalFlags', () => {
  it('strips --root and --no-refresh from anywhere and keeps the rest', () => {
    const f = parseGlobalFlags(['--root', '/r', 'find_symbol', 'login', '--no-refresh', '--preview']);
    expect(f).toEqual({ command: 'find_symbol', rest: ['login', '--preview'], explicitRoot: '/r', noRefresh: true });
  });
  it('supports --root=<dir>', () => {
    expect(parseGlobalFlags(['stats', '--root=/x']).explicitRoot).toBe('/x');
  });
  it('flags a --root without a value', () => {
    expect(parseGlobalFlags(['stats', '--root']).error).toMatch(/--root/);
    expect(parseGlobalFlags(['--root', '--naked', 'stats']).error).toMatch(/--root/);
  });
  it('no args → no command', () => {
    expect(parseGlobalFlags([]).command).toBeUndefined();
  });
});

describe('classifyCommand', () => {
  it('classifies tools, stats, sql, index, watch, read', () => {
    expect(classifyCommand('find_symbol')).toBe('graph');
    expect(classifyCommand('rename_symbol')).toBe('graph');
    expect(classifyCommand('stats')).toBe('stats');
    expect(classifyCommand('query')).toBe('sql');
    expect(classifyCommand('files')).toBe('sql');
    expect(classifyCommand('index')).toBe('index');
    expect(classifyCommand('watch')).toBe('watch');
    expect(classifyCommand('read')).toBe('read');
    expect(classifyCommand('nope')).toBe('unknown');
    expect(classifyCommand(undefined)).toBe('unknown');
  });
});

describe('bootstrapCli', () => {
  it('auto-indexes on first use from a subdirectory, at the repo root, with a self-ignoring .pairs', async () => {
    const root = repo();
    const { ctx, lines } = await boot('find_symbol', path.join(root, 'src'));
    expect(ctx!.root).toBe(root);
    expect(await ctx!.store.fileCount()).toBe(2);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(new RegExp(`^pairs: indexed 2 files in \\d+ ms \\(.+\\)$`));
    expect(fs.readFileSync(path.join(root, '.pairs', '.gitignore'), 'utf8')).toBe('*\n');
    expect(fs.existsSync(path.join(root, 'src', '.pairs'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.gitignore'))).toBe(false);
  });

  it('honours --root and PAIRS_ROOT', async () => {
    const root = repo();
    const elsewhere = tmp();
    const viaFlag = await bootstrapCli('stats', parseGlobalFlags(['stats', '--root', root]), {
      grammarsDir: GRAMMARS_DIR, queriesDir: QUERIES_DIR, cwd: elsewhere, env: {}, log: () => {},
    });
    open.push(viaFlag!);
    expect(viaFlag!.root).toBe(root);
    const viaEnv = await boot('stats', elsewhere, [], { PAIRS_ROOT: root });
    expect(viaEnv.ctx!.root).toBe(root);
    expect(fs.existsSync(path.join(elsewhere, '.pairs'))).toBe(false);
  });

  it('query/files with no index: error, and no .pairs/ is created', async () => {
    const root = repo();
    const { ctx, lines } = await boot('query', root, ['select 1']);
    expect(ctx).toBeNull();
    expect(lines[0]).toMatch(/no index/i);
    expect(process.exitCode).toBe(1);
    expect(fs.existsSync(path.join(root, '.pairs'))).toBe(false);
  });

  it('read (and an unknown command) never create .pairs/', async () => {
    const root = repo();
    await boot('read', root, ['src/a.ts']);
    await boot('bogus', root);
    expect(fs.existsSync(path.join(root, '.pairs'))).toBe(false);
  });

  it('seeds a linked worktree from the main worktree index', async () => {
    const main = repo();
    const first = await boot('find_symbol', main);
    expect(await first.ctx!.store.fileCount()).toBe(2);
    await first.ctx!.close();
    open.pop();

    const gitdir = path.join(main, '.git', 'worktrees', 'wt');
    fs.mkdirSync(gitdir, { recursive: true });
    fs.writeFileSync(path.join(gitdir, 'commondir'), '../..\n');
    const wt = tmp();
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitdir}\n`);
    write(wt, 'src/a.ts', 'export function alpha(): number { return 1; }\n');
    write(wt, 'src/b.ts', "import { alpha } from './a';\nexport function beta(): number { return alpha(); }\n");

    // `stats` does not refresh, so a non-empty store here can only come from the seed.
    const second = await boot('stats', wt);
    expect(second.ctx!.root).toBe(wt);
    expect(await second.ctx!.store.fileCount()).toBe(2);
    expect(second.lines).toEqual([]); // seeded → no first-use full index
    expect(fs.existsSync(path.join(wt, '.pairs', 'index.db'))).toBe(true);
  });

  describe('auto-refresh', () => {
    const stampPath = (root: string): string => path.join(root, '.pairs', 'last-refresh');
    const staleStamp = (root: string): string => {
      fs.writeFileSync(stampPath(root), String(Date.now() - 120_000));
      return fs.readFileSync(stampPath(root), 'utf8');
    };

    async function indexed(): Promise<string> {
      const root = repo();
      const first = await boot('find_symbol', root);
      await first.ctx!.close();
      open.pop();
      return root;
    }

    it('refreshes when due, and picks up new files', async () => {
      const root = await indexed();
      const before = staleStamp(root);
      write(root, 'src/c.ts', 'export function gamma(): number { return 3; }\n');
      const { ctx } = await boot('find_symbol', root);
      expect(fs.readFileSync(stampPath(root), 'utf8')).not.toBe(before);
      expect(await ctx!.store.fileCount()).toBe(3);
    });

    it('is throttled to once per 30 s', async () => {
      const root = await indexed();
      const stamp = fs.readFileSync(stampPath(root), 'utf8');
      write(root, 'src/c.ts', 'export function gamma(): number { return 3; }\n');
      const { ctx } = await boot('find_symbol', root);
      expect(fs.readFileSync(stampPath(root), 'utf8')).toBe(stamp);
      expect(await ctx!.store.fileCount()).toBe(2);
    });

    it('--no-refresh skips even when due', async () => {
      const root = await indexed();
      const before = staleStamp(root);
      write(root, 'src/c.ts', 'export function gamma(): number { return 3; }\n');
      const { ctx } = await boot('find_symbol', root, ['--no-refresh']);
      expect(fs.readFileSync(stampPath(root), 'utf8')).toBe(before);
      expect(await ctx!.store.fileCount()).toBe(2);
    });

    it('skips while a live watcher heartbeat is fresh', async () => {
      const root = await indexed();
      const before = staleStamp(root);
      writeHeartbeat(path.join(root, '.pairs'));
      const { ctx } = await boot('find_symbol', root);
      expect(fs.readFileSync(stampPath(root), 'utf8')).toBe(before);
      expect(ctx).not.toBeNull();
    });

    it('stats never refreshes', async () => {
      const root = await indexed();
      const before = staleStamp(root);
      await boot('stats', root);
      expect(fs.readFileSync(stampPath(root), 'utf8')).toBe(before);
    });
  });
});

describe('index held across the WSL/Windows boundary', { timeout: 30_000 }, () => {
  const ioError = (): Error => Object.assign(new Error('disk I/O error'), { errcode: 4618 });
  /** `open` always fails like the 9p/drvfs -shm case; the read-only opener is real. */
  const heldDriver = (immutableFails = false): SqlDriver => ({
    open: () => {
      throw ioError();
    },
    openReadOnly: (p, o) => {
      if (immutableFails && o.immutable) throw ioError();
      return nodeSqlDriver.openReadOnly!(p, o);
    },
  });

  async function indexedRoot(): Promise<string> {
    const root = repo();
    const first = await boot('find_symbol', root);
    await first.ctx!.close();
    open.pop();
    return root;
  }
  const bootHeld = async (command: string, root: string, driver: SqlDriver, extra: string[] = [], tmpDir?: string) => {
    const lines: string[] = [];
    const ctx = await bootstrapCli(command, parseGlobalFlags([command, ...extra]), {
      grammarsDir: GRAMMARS_DIR,
      queriesDir: QUERIES_DIR,
      cwd: root,
      env: {},
      log: (l) => lines.push(l),
      driver,
      ...(tmpDir !== undefined ? { tmpDir } : {}),
    });
    if (ctx) open.push(ctx);
    return { ctx, lines };
  };

  it('graph query: answers from an immutable snapshot, one notice line, no refresh', async () => {
    const root = await indexedRoot();
    const stamp = path.join(root, '.pairs', 'last-refresh');
    fs.writeFileSync(stamp, String(Date.now() - 120_000));
    const before = fs.readFileSync(stamp, 'utf8');
    write(root, 'src/c.ts', 'export function gamma(): number { return 3; }\n');
    const { ctx, lines } = await bootHeld('find_symbol', root, heldDriver());
    expect(ctx!.snapshot).toBe(true);
    expect(lines).toEqual([SNAPSHOT_NOTICE]);
    expect(await ctx!.store.fileCount()).toBe(2); // gamma not indexed: snapshots are never refreshed
    expect(fs.readFileSync(stamp, 'utf8')).toBe(before);
    await expect(ctx!.close()).resolves.toBeUndefined(); // no checkpoint on a read-only handle
    open.pop();
  });

  it('stats and query/files also fall back to the snapshot', async () => {
    const root = await indexedRoot();
    for (const [cmd, extra] of [['stats', []], ['query', ['select 1']]] as const) {
      const { ctx, lines } = await bootHeld(cmd, root, heldDriver(), [...extra]);
      expect(ctx!.snapshot).toBe(true);
      expect(lines).toEqual([SNAPSHOT_NOTICE]);
      expect(await ctx!.store.fileCount()).toBe(2);
    }
  });

  it('falls back to a temp copy when even the immutable open fails, and removes it on close', async () => {
    const root = await indexedRoot();
    const tmpBase = tmp();
    const { ctx, lines } = await bootHeld('find_symbol', root, heldDriver(true), [], tmpBase);
    expect(lines).toEqual([SNAPSHOT_NOTICE]);
    expect(await ctx!.store.fileCount()).toBe(2);
    expect(fs.readdirSync(tmpBase).some((d) => d.startsWith('pairs-snapshot-'))).toBe(true);
    await ctx!.close();
    open.pop();
    expect(fs.readdirSync(tmpBase)).toEqual([]);
  });

  it('index and watch: one explanatory line, exit code 1, no context, no stack', async () => {
    const root = await indexedRoot();
    for (const cmd of ['index', 'watch']) {
      process.exitCode = undefined;
      const { ctx, lines } = await bootHeld(cmd, root, heldDriver());
      expect(ctx).toBeNull();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/held by another process.*WSL\/Windows.*VS Code/s);
      expect(lines[0]).not.toMatch(/\n/);
      expect(process.exitCode).toBe(1);
    }
  });

  it('reports a clean error when neither snapshot form can open', async () => {
    const root = await indexedRoot();
    const dead: SqlDriver = { open: () => { throw ioError(); }, openReadOnly: () => { throw ioError(); } };
    const err = await bootHeld('find_symbol', root, dead, [], tmp()).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/cannot open the index at .*no read-only snapshot/);
    expect((err as Error).message).not.toMatch(/\n/);
  });

  it('a stale-schema snapshot fails cleanly instead of being reset', async () => {
    const root = await indexedRoot();
    const dbPath = path.join(root, '.pairs', 'index.db');
    const c = nodeSqlDriver.open(dbPath);
    c.exec(`UPDATE Meta SET value = '0' WHERE key = 'schema_version'`);
    c.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    c.close();
    const err = await bootHeld('find_symbol', root, heldDriver(), [], tmp()).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/no read-only snapshot/);
    const c2 = nodeSqlDriver.open(dbPath);
    expect(c2.prepare(`SELECT value FROM Meta WHERE key = 'schema_version'`).get()).toEqual({ value: '0' }); // untouched
    c2.close();
  });

  it('any other open error becomes a single-line message', async () => {
    const root = await indexedRoot();
    const bad: SqlDriver = { open: () => { throw new Error('file is not a database'); } };
    const err = await bootHeld('find_symbol', root, bad).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/^cannot open the index at .*file is not a database/);
    expect((err as Error).message).not.toMatch(/\n/);
  });
});
