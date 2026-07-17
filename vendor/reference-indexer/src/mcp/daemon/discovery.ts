/**
 * File-based discovery of the shared PAiRS daemon (docs/DaemonDesign.md).
 *
 * Discovery file: `~/.pairs/daemon.json` (mode 0600) — `{ pid, port, token,
 * version, startedAt }`. A sibling lock file (`daemon.json.lock`, created with
 * `O_CREAT|O_EXCL`) makes spawn racing safe: only the proxy that wins the
 * exclusive create gets to spawn; losers back off and connect to the winner.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import type { DaemonDiscovery, DaemonInfo } from './types';

/** `~/.pairs` — the per-user (not per-workspace) daemon home. */
export function defaultDaemonHome(): string {
  return path.join(os.homedir(), '.pairs');
}

function isPidAlive(pid: number): boolean {
  try {
    // Signal 0 performs no-op existence/permission check without killing.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'; // exists, owned by another user
  }
}

export class FileDaemonDiscovery implements DaemonDiscovery {
  private readonly infoPath: string;
  private readonly lockPath: string;

  constructor(private readonly homeDir: string = defaultDaemonHome()) {
    this.infoPath = path.join(this.homeDir, 'daemon.json');
    this.lockPath = path.join(this.homeDir, 'daemon.json.lock');
  }

  async read(): Promise<DaemonInfo | null> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(this.infoPath, 'utf8');
    } catch {
      return null;
    }
    let info: DaemonInfo;
    try {
      info = JSON.parse(raw) as DaemonInfo;
    } catch {
      return null;
    }
    if (!info.pid || !info.port || !info.token) return null;
    if (!isPidAlive(info.pid)) return null;
    return info;
  }

  /** Locks older than this are reclaimed even if the pid inside can't be checked yet (narrow window between lock-creation and the spawned daemon writing its own pid in). */
  private static readonly LOCK_STALE_MS = 20_000;

  async tryLock(): Promise<boolean> {
    await fs.promises.mkdir(this.homeDir, { recursive: true });
    try {
      const fd = await fs.promises.open(this.lockPath, 'wx');
      await fd.writeFile(String(process.pid));
      await fd.close();
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        try {
          const stat = await fs.promises.stat(this.lockPath);
          const heldBy = Number((await fs.promises.readFile(this.lockPath, 'utf8')).trim());
          const stale = Date.now() - stat.mtimeMs > FileDaemonDiscovery.LOCK_STALE_MS;
          if (!heldBy || !isPidAlive(heldBy) || stale) {
            await fs.promises.rm(this.lockPath, { force: true });
            return this.tryLock();
          }
        } catch {
          // Race with the lock being removed concurrently; treat as held.
        }
        return false;
      }
      throw err;
    }
  }

  async write(info: DaemonInfo): Promise<void> {
    await fs.promises.mkdir(this.homeDir, { recursive: true });
    const tmp = `${this.infoPath}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(info, null, 2), { mode: 0o600 });
    await fs.promises.rename(tmp, this.infoPath);
  }

  async clear(): Promise<void> {
    await fs.promises.rm(this.infoPath, { force: true });
    await fs.promises.rm(this.lockPath, { force: true });
  }

  /** Release the spawn lock once daemon.json is written; the info file is the source of truth from then on. */
  async unlock(): Promise<void> {
    await fs.promises.rm(this.lockPath, { force: true });
  }
}

export function generateToken(): string {
  return crypto.randomBytes(24).toString('hex');
}
