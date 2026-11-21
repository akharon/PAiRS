import { describe, expect, it } from 'vitest';
import { shimsFor } from './cliLink';

describe('shimsFor', () => {
  it('runs the CLI on the extension host runtime in Node mode on POSIX', () => {
    const shims = shimsFor('linux', '/opt/code/code', '/ext/dist/cli.js');
    expect(shims).toEqual([
      { file: 'pairs', content: `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '/opt/code/code' '/ext/dist/cli.js' "$@"\n` },
    ]);
  });

  it('writes a .cmd shim and a Git Bash shim on Windows', () => {
    const runtime = 'C:\\Program Files\\Microsoft VS Code\\Code.exe';
    const cli = 'C:\\Users\\u\\.vscode\\extensions\\mkyr.pairs-1\\dist\\cli.js';
    const [cmd, sh] = shimsFor('win32', runtime, cli);
    expect(cmd.file).toBe('pairs.cmd');
    expect(cmd.content).toBe(`@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${runtime}" "${cli}" %*\r\n`);
    expect(sh.file).toBe('pairs');
    expect(sh.content).toContain(`exec 'C:/Program Files/Microsoft VS Code/Code.exe' 'C:/Users/u/.vscode/extensions/mkyr.pairs-1/dist/cli.js' "$@"`);
  });

  it('quotes single quotes in paths', () => {
    const [sh] = shimsFor('darwin', "/Users/o'neil/code", '/cli.js');
    expect(sh.content).toContain(`'/Users/o'\\''neil/code'`);
  });
});
