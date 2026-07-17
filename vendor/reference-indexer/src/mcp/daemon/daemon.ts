/**
 * PairsDaemon: per-user shared MCP server (docs/DaemonDesign.md). Listens on
 * loopback HTTP, serves one MCP session per connecting proxy over
 * StreamableHTTPServerTransport, and routes each session's tool calls to the
 * WorkspaceHandle for the root the proxy declared via the `X-Pairs-Workspace`
 * header on its first request.
 *
 * Every request (including the workspace header) must carry the bearer token
 * written to ~/.pairs/daemon.json — this is a localhost-only, single-user
 * daemon, but the token still stops other local users/processes from reading
 * or mutating the index over the loopback port.
 */

import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { codeToolSchemas, toolSchemas } from '../tools';
import { FileDaemonDiscovery, generateToken } from './discovery';
import { WorkspaceRegistryImpl, type WorkspaceRegistryDeps } from './workspaceRegistry';
import {
  WORKSPACE_HEADER,
  type DaemonConfig,
  type DaemonDiscovery,
  type DaemonInfo,
  type PairsDaemon,
  type WorkspaceHandle,
  type WorkspaceRegistry,
} from './types';

interface Session {
  transport: StreamableHTTPServerTransport;
  /** Mutable so `workspace_use` can re-bind this session without a new connection. */
  state: SessionState;
}

interface SessionState {
  root: string;
  handle: WorkspaceHandle;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export interface PairsDaemonTestDeps {
  discovery?: DaemonDiscovery;
  registryDeps?: Partial<WorkspaceRegistryDeps>;
}

export class PairsDaemonImpl implements PairsDaemon {
  private readonly discovery: DaemonDiscovery;
  private readonly registry: WorkspaceRegistry;
  private readonly sessions = new Map<string, Session>();
  private server?: http.Server;
  private idleTimer?: NodeJS.Timeout;
  private readonly token = generateToken();
  private readonly idleExitMs: number;
  private readonly workspaceIdleMs: number;
  private lastActivityAt = Date.now();

  constructor(private readonly config: DaemonConfig, private readonly bundleDir: string, testDeps: PairsDaemonTestDeps = {}) {
    this.idleExitMs = config.idleExitMs ?? 30 * 60_000;
    this.workspaceIdleMs = config.workspaceIdleMs ?? 10 * 60_000;
    this.discovery = testDeps.discovery ?? new FileDaemonDiscovery();
    // toolVersion stamps every generation (docs/MemoryIndexSynergy.md §F1) so
    // needsFullRebuild() can detect a daemon upgrade — without it every
    // workspace stamps 'unknown' and rebuilds never trigger on upgrade.
    this.registry = new WorkspaceRegistryImpl({ bundleDir, toolVersion: config.version, ...testDeps.registryDeps });
  }

  async start(): Promise<DaemonInfo> {
    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
    });

    await new Promise<void>((resolve) => this.server!.listen(this.config.port ?? 0, '127.0.0.1', resolve));
    const port = (this.server.address() as AddressInfo).port;

    const info: DaemonInfo = {
      pid: process.pid,
      port,
      token: this.token,
      version: this.config.version,
      startedAt: new Date().toISOString(),
    };
    await this.discovery.write(info);
    await this.discovery.unlock();

    this.idleTimer = setInterval(() => void this.tick(), 60_000);
    this.idleTimer.unref();

    return info;
  }

  private async tick(): Promise<void> {
    await this.registry.evictIdle(this.workspaceIdleMs);
    if (this.sessions.size === 0 && Date.now() - this.lastActivityAt > this.idleExitMs) {
      await this.stop();
    }
  }

  async stop(): Promise<void> {
    if (this.idleTimer) clearInterval(this.idleTimer);
    for (const session of this.sessions.values()) await session.transport.close();
    this.sessions.clear();
    await this.registry.closeAll();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    await this.discovery.clear();
  }

  private authorized(req: http.IncomingMessage): boolean {
    const auth = req.headers.authorization;
    return auth === `Bearer ${this.token}`;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.lastActivityAt = Date.now();

    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessions: this.sessions.size }));
      return;
    }

    if (!this.authorized(req)) {
      res.writeHead(401).end('Unauthorized');
      return;
    }

    if (req.method === 'POST' && req.url === '/shutdown') {
      res.writeHead(200).end('ok');
      void this.stop();
      return;
    }

    if (req.url !== '/mcp') {
      res.writeHead(404).end('Not found');
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const existing = sessionId ? this.sessions.get(sessionId) : undefined;
    if (existing) {
      const bodyText = await readBody(req);
      await existing.transport.handleRequest(req, res, bodyText.length ? JSON.parse(bodyText) : undefined);
      return;
    }

    const root = req.headers[WORKSPACE_HEADER.toLowerCase()] as string | undefined;
    if (!root) {
      res.writeHead(400).end(`Missing ${WORKSPACE_HEADER} header on new session`);
      return;
    }

    let handle: WorkspaceHandle;
    try {
      handle = await this.registry.acquire(root);
    } catch (err) {
      res.writeHead(400).end((err as Error).message);
      return;
    }

    const state: SessionState = { root, handle };
    const server = this.buildServer(state);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        this.sessions.set(id, { transport, state });
        this.registry.retain(state.root);
      },
      onsessionclosed: (id) => {
        const session = this.sessions.get(id);
        if (session) this.registry.release(session.state.root);
        this.sessions.delete(id);
      },
    });
    await server.connect(transport);

    const bodyText = await readBody(req);
    await transport.handleRequest(req, res, bodyText.length ? JSON.parse(bodyText) : undefined);
  }

  /**
   * Fan out a memory_search across every known root (not just open ones),
   * merging rendered text per-workspace. Roots that fail to acquire (deleted,
   * corrupted) are skipped with a note rather than failing the whole search.
   * Bounded to 10s total so one slow/hung workspace can't stall the others.
   */
  private async memorySearchAll(
    state: SessionState,
    parsed: { query: string; tags?: string[]; types?: string[]; limit?: number; offset?: number; includeBody?: boolean; scope: 'workspace' | 'all' }
  ): Promise<string> {
    const roots = await this.registry.knownRoots();
    const timeoutMs = 10_000;
    const { scope: _scope, ...baseArgs } = parsed;

    const perRoot = async (root: string): Promise<{ root: string; text: string } | { root: string; skipped: true }> => {
      try {
        const handle = await this.registry.acquire(root);
        const result = await handle.memory.execute('memory_search', baseArgs as never, 'mcp');
        return { root, text: result.text };
      } catch {
        return { root, skipped: true };
      }
    };

    const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs));
    const settled = await Promise.race([Promise.allSettled(roots.map(perRoot)), timeout]);

    if (settled === 'timeout') {
      return `Cross-workspace search timed out after ${timeoutMs}ms; try scope:"workspace" or narrow the query.`;
    }

    const sections: string[] = [];
    const skippedRoots: string[] = [];
    for (const outcome of settled) {
      if (outcome.status !== 'fulfilled') continue;
      const value = outcome.value;
      if ('skipped' in value) {
        skippedRoots.push(value.root);
        continue;
      }
      if (value.text.startsWith('No memories found')) continue;
      sections.push(`## ${value.root}\n\n${value.text}`);
    }

    if (!sections.length) {
      const note = skippedRoots.length ? `\n(skipped, unavailable: ${skippedRoots.join(', ')})` : '';
      return `No memories found across ${roots.length} known workspace(s).${note}`;
    }
    if (skippedRoots.length) {
      sections.push(`_(skipped, unavailable: ${skippedRoots.join(', ')})_`);
    }
    return sections.join('\n\n');
  }

  /**
   * One McpServer per session. Handlers read `state.handle` at call time (not
   * captured up front) so `workspace_use` re-binding this session's state
   * takes effect on the very next tool call, with no new connection needed.
   */
  private buildServer(state: SessionState): McpServer {
    const server = new McpServer({ name: 'pairs-daemon', version: this.config.version });

    for (const [name, schema] of Object.entries(toolSchemas)) {
      if (name === 'memory_search') continue; // overridden below with scope:'all' fan-out
      server.registerTool(
        name,
        { description: schema.description, inputSchema: schema.input.shape },
        async (input: unknown) => {
          const result = await state.handle.memory.execute(name as keyof typeof toolSchemas, input as never, 'mcp');
          return { content: [{ type: 'text' as const, text: result.text }], isError: result.isError };
        }
      );
    }

    const daemonMemorySearchInput = toolSchemas.memory_search.input.extend({
      scope: z
        .enum(['workspace', 'all'])
        .default('workspace')
        .describe('"all" searches every workspace PAiRS has seen for this user, not just the bound one.'),
    });
    server.registerTool(
      'memory_search',
      { description: toolSchemas.memory_search.description, inputSchema: daemonMemorySearchInput.shape },
      async (input: unknown) => {
        const parsed = daemonMemorySearchInput.parse(input);
        if (parsed.scope === 'workspace') {
          const result = await state.handle.memory.execute('memory_search', parsed, 'mcp');
          return { content: [{ type: 'text' as const, text: result.text }], isError: result.isError };
        }
        const text = await this.memorySearchAll(state, parsed);
        return { content: [{ type: 'text' as const, text }] };
      }
    );

    const workspaceSearchInput = z.object({
      query: z.string().min(1).describe('Search query.'),
      limit: z.number().int().min(1).max(25).default(5).describe('Per-workspace limit.'),
      tags: z.array(z.string()).optional().describe('Optional tag filter.'),
    });
    server.registerTool(
      'workspace_search',
      {
        description:
          'Search EVERY workspace this PAiRS daemon knows about — not just the ' +
          'currently bound one. Fuses results across workspaces and labels each ' +
          'result with its workspace root. Call this when you remember a fact ' +
          'exists somewhere but aren\'t sure which project has it.',
        inputSchema: workspaceSearchInput.shape,
      },
      async (input: unknown) => {
        const parsed = workspaceSearchInput.parse(input);
        const { query, limit, tags } = parsed;
        const text = await this.memorySearchAll(state, {
          query,
          tags,
          limit: limit ?? 5,
          offset: 0,
          includeBody: false,
          scope: 'all',
        });
        return { content: [{ type: 'text' as const, text }] };
      }
    );

    for (const [name, schema] of Object.entries(codeToolSchemas)) {
      server.registerTool(
        name,
        { description: schema.description, inputSchema: schema.input.shape },
        async (input: unknown) => {
          if (!state.handle.code) {
            return {
              content: [{ type: 'text' as const, text: 'Code tools are not available: this workspace has no .pairs/code.db.' }],
              isError: true,
            };
          }
          const result = await state.handle.code.execute(name as keyof typeof codeToolSchemas, input as never, 'mcp');
          return { content: [{ type: 'text' as const, text: result.text }], isError: result.isError };
        }
      );
    }

    server.registerTool(
      'workspace_list',
      {
        description: 'List workspaces currently open in the shared PAiRS daemon, with index stats and active session counts.',
        inputSchema: {},
      },
      async () => {
        const infos = await this.registry.list();
        const openRoots = new Set(infos.map((w) => w.root));
        const lines = infos.length
          ? infos.map(
              (w) =>
                `- ${w.root}${w.indexing ? ' (indexing…)' : ''} — ${w.files ?? 0} files, ${w.symbols ?? 0} symbols, ${w.sessions} session(s)`
            )
          : ['(no workspaces open)'];

        const closed = (await this.registry.knownRoots()).filter((r) => !openRoots.has(r));
        if (closed.length) {
          lines.push('', ...closed.map((r) => `- ${r} (closed)`));
        }
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      }
    );

    server.registerTool(
      'workspace_use',
      {
        description: 'Re-bind this session to another workspace root (must already contain .pairs/).',
        inputSchema: { root: z.string().describe('Absolute path to the workspace root.') },
      },
      async (input: unknown) => {
        const { root } = input as { root: string };
        try {
          const handle = await this.registry.acquire(root);
          this.registry.release(state.root);
          this.registry.retain(root);
          state.root = root;
          state.handle = handle;
          return { content: [{ type: 'text' as const, text: `Switched to workspace: ${handle.root}` }] };
        } catch (err) {
          const infos = await this.registry.list();
          const known = infos.map((w) => w.root).join(', ') || '(none open)';
          return {
            content: [{ type: 'text' as const, text: `${(err as Error).message}\nCurrently open workspaces: ${known}` }],
            isError: true,
          };
        }
      }
    );

    return server;
  }
}
