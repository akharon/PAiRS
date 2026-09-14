#!/usr/bin/env node

/**
 * Post-install script: Create symlink to make `pairs` CLI available globally
 * Runs after npm install or VS Code extension installation
 *
 * Creates ~/.local/bin/pairs -> <extensionPath>/dist/cli.js
 * and ensures ~/.local/bin is in PATH
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const cliSource = path.resolve(projectRoot, 'dist', 'cli.js');
const homeDir = os.homedir();
const binDir = path.join(homeDir, '.local', 'bin');
const symlinkTarget = path.join(binDir, 'pairs');

async function main() {
  try {
    // Check if cli.js exists
    await fs.access(cliSource, fs.constants.F_OK);

    // Create ~/.local/bin if it doesn't exist
    try {
      await fs.mkdir(binDir, { recursive: true });
    } catch (err) {
      if ((err).code !== 'EEXIST') throw err;
    }

    // Remove existing symlink/file if it exists
    try {
      const stat = await fs.lstat(symlinkTarget);
      if (stat.isSymbolicLink() || stat.isFile()) {
        await fs.unlink(symlinkTarget);
        console.log(`✅ Removed existing symlink: ${symlinkTarget}`);
      }
    } catch (err) {
      if ((err).code !== 'ENOENT') throw err;
      // File doesn't exist, which is fine
    }

    // Create symlink
    await fs.symlink(cliSource, symlinkTarget, 'file');
    console.log(`✅ Created symlink: ${symlinkTarget} -> ${cliSource}`);

    // Make it executable
    await fs.chmod(symlinkTarget, 0o755);
    console.log(`✅ Made executable: ${symlinkTarget}`);

    // Check if ~/.local/bin is in PATH
    const pathEnv = process.env.PATH || '';
    if (!pathEnv.includes(binDir)) {
      console.log(`\n⚠️  Note: ${binDir} is not in your PATH`);
      console.log('Add this line to your shell RC file (~/.bashrc, ~/.zshrc, etc):');
      console.log(`  export PATH="$HOME/.local/bin:$PATH"`);
      console.log('\nThen restart your terminal or run: source ~/.bashrc');
    } else {
      console.log(`✅ ${binDir} is in PATH`);
    }

    console.log(`\n✅ PAiRS CLI is now available as: pairs`);
    console.log(`   Location: ${symlinkTarget}`);
    console.log(`\n   Try it: pairs find_symbol --help`);
  } catch (err) {
    console.error(`❌ Failed to install PAiRS CLI:`, (err).message);
    // Don't exit with error — graceful degradation
    // Extension still works, just no CLI
    process.exit(0);
  }
}

main();
