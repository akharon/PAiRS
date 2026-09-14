#!/usr/bin/env node

/**
 * Post-install script: put the `pairs` CLI on PATH for local dev installs
 * (`npm install`). VS Code Marketplace installs don't run this — extension.ts
 * calls the equivalent logic (src/adapters/vscode/cliLink.ts) from
 * activate() instead, since that's the only path every install method hits.
 *
 * POSIX: symlink ~/.local/bin/pairs -> <projectRoot>/dist/cli.js
 * Windows: ~\AppData\Local\Pairs\bin\pairs.cmd shim (no admin/Developer Mode
 * required, unlike an NTFS symlink)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const cliSource = path.resolve(projectRoot, 'dist', 'cli.js');
const homeDir = os.homedir();
const isWindows = process.platform === 'win32';
const binDir = isWindows ? path.join(homeDir, 'AppData', 'Local', 'Pairs', 'bin') : path.join(homeDir, '.local', 'bin');
const linkTarget = path.join(binDir, isWindows ? 'pairs.cmd' : 'pairs');

async function replaceLink(create) {
  try {
    await fs.unlink(linkTarget);
    console.log(`✅ Removed existing: ${linkTarget}`);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  await create();
}

async function main() {
  try {
    // Check if cli.js exists
    await fs.access(cliSource, fs.constants.F_OK);

    await fs.mkdir(binDir, { recursive: true });

    if (isWindows) {
      await replaceLink(() => fs.writeFile(linkTarget, `@echo off\r\nnode "${cliSource}" %*\r\n`, 'utf8'));
      console.log(`✅ Created shim: ${linkTarget} -> ${cliSource}`);
    } else {
      await replaceLink(async () => {
        await fs.symlink(cliSource, linkTarget, 'file');
        await fs.chmod(linkTarget, 0o755);
      });
      console.log(`✅ Created symlink: ${linkTarget} -> ${cliSource}`);
    }

    // Check if binDir is in PATH
    const pathEnv = process.env.PATH || '';
    if (!pathEnv.includes(binDir)) {
      console.log(`\n⚠️  Note: ${binDir} is not in your PATH`);
      if (isWindows) {
        console.log('Add it via System Properties > Environment Variables, or run in PowerShell:');
        console.log(`  [Environment]::SetEnvironmentVariable("Path", "$env:Path;${binDir}", "User")`);
      } else {
        console.log('Add this line to your shell RC file (~/.bashrc, ~/.zshrc, etc):');
        console.log(`  export PATH="$HOME/.local/bin:$PATH"`);
        console.log('\nThen restart your terminal or run: source ~/.bashrc');
      }
    } else {
      console.log(`✅ ${binDir} is in PATH`);
    }

    console.log(`\n✅ PAiRS CLI is now available as: pairs`);
    console.log(`   Location: ${linkTarget}`);
    console.log(`\n   Try it: pairs find_symbol --help`);
  } catch (err) {
    console.error(`❌ Failed to install PAiRS CLI:`, err.message);
    // Don't exit with error — graceful degradation
    // Extension still works, just no CLI
    process.exit(0);
  }
}

main();
