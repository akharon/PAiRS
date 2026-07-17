/**
 * PairsDaemonImpl end-to-end smoke test: real HTTP + real sqlite memory.db
 * (no code.db, so code tools are absent) + the SDK's own client transport,
 * verifying a full session round trip: connect with the workspace header,
 * call memory_save then memory_list, call workspace_list, and confirm
 * /health + token auth work as expected.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PairsDaemonImpl } from './daemon';
import { FileDaemonDiscovery } from './discovery';
import { WORKSPACE_HEADER } from './types';

let homeDir: string;
let workspaceRoot: string;
let daemon: PairsDaemonImpl;
let knownRootsPath: string;

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-daemon-home-'));
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-daemon-ws-'));
  fs.mkdirSync(path.join(workspaceRoot, '.pairs'));
  knownRootsPath = path.join(homeDir, 'workspaces.json');
});

afterEach(async () => {
  await daemon?.stop();
  fs.rmSync(homeDir, { recursive: true, force: true });
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

async function connectedClient(port: number, token: string): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}`, [WORKSPACE_HEADER]: workspaceRoot } },
  });
  await client.connect(transport);
  return client;
}

describe('PairsDaemonImpl', () => {
  it('serves /health without auth', async () => {
    daemon = new PairsDaemonImpl({ version: '1.0.0' }, '/bundle', { discovery: new FileDaemonDiscovery(homeDir), registryDeps: { knownRootsPath } });
    const info = await daemon.start();

    const res = await fetch(`http://127.0.0.1:${info.port}/health`);
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('rejects MCP requests without the bearer token', async () => {
    daemon = new PairsDaemonImpl({ version: '1.0.0' }, '/bundle', { discovery: new FileDaemonDiscovery(homeDir), registryDeps: { knownRootsPath } });
    const info = await daemon.start();

    const res = await fetch(`http://127.0.0.1:${info.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [WORKSPACE_HEADER]: workspaceRoot },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a new session with no X-Pairs-Workspace header', async () => {
    daemon = new PairsDaemonImpl({ version: '1.0.0' }, '/bundle', { discovery: new FileDaemonDiscovery(homeDir), registryDeps: { knownRootsPath } });
    const info = await daemon.start();

    const res = await fetch(`http://127.0.0.1:${info.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${info.token}` },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('round-trips memory_save -> memory_list over a real MCP session for the header-declared workspace', async () => {
    daemon = new PairsDaemonImpl({ version: '1.0.0' }, '/bundle', { discovery: new FileDaemonDiscovery(homeDir), registryDeps: { knownRootsPath } });
    const info = await daemon.start();
    const client = await connectedClient(info.port, info.token);

    const saveResult = await client.callTool({
      name: 'memory_save',
      arguments: { type: 'project', title: 'Daemon test fact', description: 'Set up during daemon.test.ts', body: 'Body text.' },
    });
    expect(saveResult.isError).toBeFalsy();

    const listResult = await client.callTool({ name: 'memory_list', arguments: { limit: 10 } });
    const text = (listResult.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    expect(text).toContain('Daemon test fact');

    await client.close();
  });

  it('workspace_list reports the acquired workspace with its session count', async () => {
    daemon = new PairsDaemonImpl({ version: '1.0.0' }, '/bundle', { discovery: new FileDaemonDiscovery(homeDir), registryDeps: { knownRootsPath } });
    const info = await daemon.start();
    const client = await connectedClient(info.port, info.token);

    // Any tool call is enough to force workspace acquisition.
    await client.callTool({ name: 'memory_list', arguments: { limit: 1 } });

    const result = await client.callTool({ name: 'workspace_list', arguments: {} });
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    expect(text).toContain(workspaceRoot);
    expect(text).toMatch(/1 session/);

    await client.close();
  });

  it('rejects a code tool when the workspace has no code.db', async () => {
    daemon = new PairsDaemonImpl({ version: '1.0.0' }, '/bundle', { discovery: new FileDaemonDiscovery(homeDir), registryDeps: { knownRootsPath } });
    const info = await daemon.start();
    const client = await connectedClient(info.port, info.token);

    const result = await client.callTool({ name: 'code_search', arguments: { query: 'anything' } });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    expect(text).toMatch(/no \.pairs\/code\.db/);

    await client.close();
  });

  it('workspace_use rejects a root without .pairs/, keeping the session on its original workspace', async () => {
    daemon = new PairsDaemonImpl({ version: '1.0.0' }, '/bundle', { discovery: new FileDaemonDiscovery(homeDir), registryDeps: { knownRootsPath } });
    const info = await daemon.start();
    const client = await connectedClient(info.port, info.token);

    const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-bare-'));
    const result = await client.callTool({ name: 'workspace_use', arguments: { root: bareDir } });
    expect(result.isError).toBe(true);

    await client.close();
    fs.rmSync(bareDir, { recursive: true, force: true });
  });

  it('memory_search scope:"all" finds a hit in another known workspace, prefixed with its root', async () => {
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-daemon-ws2-'));
    fs.mkdirSync(path.join(otherRoot, '.pairs'));

    daemon = new PairsDaemonImpl({ version: '1.0.0' }, '/bundle', { discovery: new FileDaemonDiscovery(homeDir), registryDeps: { knownRootsPath } });
    const info = await daemon.start();

    // Save a fact in otherRoot via its own session.
    const otherClient = new Client({ name: 'test-client', version: '0.0.0' });
    const otherTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${info.port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${info.token}`, [WORKSPACE_HEADER]: otherRoot } },
    });
    await otherClient.connect(otherTransport);
    await otherClient.callTool({
      name: 'memory_save',
      arguments: { type: 'project', title: 'Cross workspace fact', description: 'lives in otherRoot', body: 'unique-marker-xyz' },
    });
    await otherClient.close();

    // Search scope:"all" from a session bound to workspaceRoot.
    const client = await connectedClient(info.port, info.token);
    const result = await client.callTool({
      name: 'memory_search',
      arguments: { query: 'unique-marker-xyz', scope: 'all' },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    expect(text).toContain(otherRoot);
    expect(text).toContain('Cross workspace fact');

    await client.close();
    fs.rmSync(otherRoot, { recursive: true, force: true });
  });

  it('memory_search scope:"all" skips a root whose directory was deleted, without erroring', async () => {
    const deletedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-daemon-ws3-'));
    fs.mkdirSync(path.join(deletedRoot, '.pairs'));

    daemon = new PairsDaemonImpl({ version: '1.0.0' }, '/bundle', { discovery: new FileDaemonDiscovery(homeDir), registryDeps: { knownRootsPath } });
    const info = await daemon.start();

    const otherClient = new Client({ name: 'test-client', version: '0.0.0' });
    const otherTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${info.port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${info.token}`, [WORKSPACE_HEADER]: deletedRoot } },
    });
    await otherClient.connect(otherTransport);
    await otherClient.callTool({ name: 'memory_list', arguments: { limit: 1 } });
    await otherClient.close();

    fs.rmSync(deletedRoot, { recursive: true, force: true });

    const client = await connectedClient(info.port, info.token);
    const result = await client.callTool({ name: 'memory_search', arguments: { query: 'anything', scope: 'all' } });
    expect(result.isError).toBeFalsy();

    await client.close();
  });

  it('workspace_list surfaces a known-but-closed root (persisted from a prior daemon run)', async () => {
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pairs-daemon-ws4-'));
    fs.mkdirSync(path.join(otherRoot, '.pairs'));
    fs.mkdirSync(path.dirname(knownRootsPath), { recursive: true });
    fs.writeFileSync(knownRootsPath, JSON.stringify([otherRoot]), 'utf8');

    daemon = new PairsDaemonImpl({ version: '1.0.0' }, '/bundle', { discovery: new FileDaemonDiscovery(homeDir), registryDeps: { knownRootsPath } });
    const info = await daemon.start();

    // workspaceRoot gets opened by connectedClient; otherRoot stays closed —
    // it's only known from the pre-seeded workspaces.json, never acquired here.
    const client = await connectedClient(info.port, info.token);
    await client.callTool({ name: 'memory_list', arguments: { limit: 1 } });

    const result = await client.callTool({ name: 'workspace_list', arguments: {} });
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    expect(text).toContain(`${otherRoot} (closed)`);
    expect(text).not.toContain(`${workspaceRoot} (closed)`);

    await client.close();
    fs.rmSync(otherRoot, { recursive: true, force: true });
  });

  it('stop() clears the discovery file', async () => {
    const discovery = new FileDaemonDiscovery(homeDir);
    daemon = new PairsDaemonImpl({ version: '1.0.0' }, '/bundle', { discovery });
    await daemon.start();
    expect(await discovery.read()).not.toBeNull();

    await daemon.stop();
    expect(await discovery.read()).toBeNull();
  });
});
