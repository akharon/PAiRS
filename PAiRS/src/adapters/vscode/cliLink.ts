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

export interface CliShim {
  file: string;
  content: string;
}

// The CLI needs node:sqlite (Node >= 22.13). The `node` on PATH may be older
// or absent, so every shim runs the CLI on the runtime hosting the extension
// (`process.execPath`): VS Code's Electron in plain-Node mode, which always
// has node:sqlite since the extension itself uses it.
export function shimsFor(platform: NodeJS.Platform, runtime: string, cliSource: string): CliShim[] {
  if (platform === 'win32') {
    const fwd = (p: string): string => p.replace(/\\/g, '/');
    return [
      // cmd/PowerShell. A .cmd shim works without Developer Mode/admin, unlike
      // an NTFS symlink; setlocal keeps the variable out of the caller's shell.
      {
        file: 'pairs.cmd',
        content: `@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${runtime}" "${cliSource}" %*\r\n`,
      },
      // Git Bash/MSYS ignores .cmd when resolving a bare `pairs`.
      { file: 'pairs', content: posixShim(fwd(runtime), fwd(cliSource)) },
    ];
  }
  return [{ file: 'pairs', content: posixShim(runtime, cliSource) }];
}

function posixShim(runtime: string, cliSource: string): string {
  return `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shQuote(runtime)} ${shQuote(cliSource)} "$@"\n`;
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export async function ensureCliLinked(extensionPath: string): Promise<void> {
  try {
    const cliSource = path.join(extensionPath, 'dist', 'cli.js');
    await fs.access(cliSource, fs.constants.F_OK);

    const homeDir = os.homedir();
    const binDir = binDirFor(process.platform, homeDir);
    await fs.mkdir(binDir, { recursive: true });

    for (const shim of shimsFor(process.platform, process.execPath, cliSource)) {
      const target = path.join(binDir, shim.file);
      await replaceLink(target, async () => {
        await fs.writeFile(target, shim.content, 'utf8');
        await fs.chmod(target, 0o755);
      });
    }
  } catch {
    // Graceful degradation — the extension's Language Model Tools work
    // regardless of whether the standalone `pairs` CLI is on PATH.
  }
}

async function replaceLink(target: string, create: () => Promise<void>): Promise<void> {
  try {
    await fs.unlink(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  await create();
}
