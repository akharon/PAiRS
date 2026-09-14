#!/usr/bin/env node

/**
 * Post-uninstall script: Remove symlink to `pairs` CLI
 * Runs when npm removes the package or VS Code extension is uninstalled
 *
 * Removes ~/.local/bin/pairs symlink
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const homeDir = os.homedir();
const binDir = path.join(homeDir, '.local', 'bin');
const symlinkTarget = path.join(binDir, 'pairs');

async function main() {
  try {
    // Check if symlink exists
    const stat = await fs.lstat(symlinkTarget);

    if (stat.isSymbolicLink() || stat.isFile()) {
      // Verify it points to a pairs CLI before deleting
      // (safety check: don't delete if it's something else)
      let isOurSymlink = false;

      if (stat.isSymbolicLink()) {
        const targetPath = await fs.readlink(symlinkTarget);
        if (targetPath.includes('pairs') && targetPath.includes('cli.js')) {
          isOurSymlink = true;
        }
      } else if (stat.isFile()) {
        // File (not symlink) — check if it's our CLI
        const content = await fs.readFile(symlinkTarget, 'utf8');
        if (content.includes('PAiRS') || content.includes('cli')) {
          isOurSymlink = true;
        }
      }

      if (isOurSymlink || stat.isSymbolicLink()) {
        // If it's a symlink, remove it (assume it's ours)
        // If it's our file, remove it
        await fs.unlink(symlinkTarget);
        console.log(`✅ Removed PAiRS CLI symlink: ${symlinkTarget}`);
      } else {
        console.log(`⚠️  File exists at ${symlinkTarget} but doesn't appear to be our CLI — skipping removal`);
      }
    }
  } catch (err) {
    if ((err).code === 'ENOENT') {
      // File doesn't exist — that's fine, nothing to clean up
      console.log(`ℹ️  PAiRS CLI symlink not found — already removed or not installed`);
    } else {
      console.error(`⚠️  Failed to remove PAiRS CLI symlink:`, (err).message);
      // Don't exit with error — uninstallation should still succeed
    }
  }
}

main().catch(() => {
  // Graceful error handling — uninstall proceeds regardless
  process.exit(0);
});
