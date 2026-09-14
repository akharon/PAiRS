import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

// Cross-platform "put `pairs` on PATH" for the CLI bundled with the extension.
// Runs from activate() so it also covers Marketplace installs, where npm's
// postinstall hook never fires. Best-effort: any failure is swallowed, since
// the extension itself works without the CLI being globally linked.

function binDirFor(platform: NodeJS.Platform, homeDir: string): string {
  if (platform === 'win32') {
    // No POSIX-style ~/.local/bin convention on Windows; use a per-user dir
    // that's simple to add to PATH and doesn't require admin rights.
    return path.join(homeDir, 'AppData', 'Local', 'Pairs', 'bin');
  }
  return path.join(homeDir, '.local', 'bin');
}

export async function ensureCliLinked(extensionPath: string): Promise<void> {
  try {
    const cliSource = path.join(extensionPath, 'dist', 'cli.js');
    await fs.access(cliSource, fs.constants.F_OK);

    const homeDir = os.homedir();
    const binDir = binDirFor(process.platform, homeDir);
    await fs.mkdir(binDir, { recursive: true });

    if (process.platform === 'win32') {
      await linkWindows(binDir, cliSource);
    } else {
      await linkPosix(binDir, cliSource);
    }
  } catch {
    // Graceful degradation — the extension's Language Model Tools work
    // regardless of whether the standalone `pairs` CLI is on PATH.
  }
}

async function linkPosix(binDir: string, cliSource: string): Promise<void> {
  const target = path.join(binDir, 'pairs');
  await replaceLink(target, async () => {
    await fs.symlink(cliSource, target, 'file');
    await fs.chmod(target, 0o755);
  });
}

async function linkWindows(binDir: string, cliSource: string): Promise<void> {
  // A .cmd shim works without Developer Mode/admin, unlike an NTFS symlink.
  const target = path.join(binDir, 'pairs.cmd');
  const shim = `@echo off\r\nnode "${cliSource}" %*\r\n`;
  await replaceLink(target, () => fs.writeFile(target, shim, 'utf8'));
}

async function replaceLink(target: string, create: () => Promise<void>): Promise<void> {
  try {
    await fs.unlink(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  await create();
}
