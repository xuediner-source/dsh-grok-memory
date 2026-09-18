/**
 * dsh-grok-memory — Grok Build-style cross-session memory for DSH.
 *
 * Surface, mirroring the official Grok Build client
 * (~/.grok/docs/user-guide/13-memory.md):
 *
 *   /memory      browse memory files grouped by scope
 *   /remember    save a durable statement to MEMORY.md
 *   /flush       write the current session's summary to the session log
 *   /dream       consolidate session logs into deduplicated topic files
 *   /memclear    clear workspace / global / all memory
 *
 *   memory_search / memory_get / memory_remember / memory_forget
 *
 * Prompt injection: a system-prompt usage section tells the model when to use
 * the tools; instructions in the current conversation always take precedence
 * over anything stored in a note (official rule).
 *
 * Hooks: `agent/settled` records a metadata summary after each turn and counts
 * sessions toward the auto-dream gates; `agent/turn-stopping` buffers user
 * text so the settle-time summary has something to summarise.
 */
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { rmSync } from 'node:fs';
import { allMarkdownFiles, appendEntry, ensureDirs, listMemory, pathsFor, readText, removeEntry } from './store.js';
import { DEFAULTS, openIndex, reindex, search } from './search.js';
import { DREAM_DEFAULTS, appendSession, dream, gatesOpen, noteSessionEnd, renderSummaryMarkdown, sessionSummary } from './dream.js';

export const name = 'dsh-grok-memory';
export const inject = ['commands', 'agents', 'tools', 'systemPrompt'];

export const Config = z.object({
  memoryRoot: z.string(),
  enabled: z.boolean().default(true),
  promptSectionOrder: z.number().default(128),
  search: z.object({
    maxResults: z.number().min(1).default(DEFAULTS.maxResults),
    minScore: z.number().default(DEFAULTS.minScore),
  }),
  dream: z.object({
    enabled: z.boolean().default(DREAM_DEFAULTS.enabled),
    minHours: z.number().default(DREAM_DEFAULTS.minHours),
    minSessions: z.number().default(DREAM_DEFAULTS.minSessions),
    staleLockSecs: z.number().default(DREAM_DEFAULTS.staleLockSecs),
  }),
});

const ok = (text) => ({ kind: 'success', text });
const err = (text) => ({ kind: 'error', text });

const workspaceOf = (agent) => agent?.session?.header?.cwd ?? process.cwd();
const sessionIdOf = (agent) => String(agent?.session?.id ?? 'unknown');

/** Rebuild the FTS index for a memory root before answering a query. */
function indexed(paths) {
  ensureDirs(paths);
  const db = openIndex(paths.index);
  reindex(db, allMarkdownFiles(paths.root), paths.root);
  return db;
}

const USAGE_SECTION = `Memory tools (Grok Build-style cross-session memory):
- memory_search — search across memory before starting unfamiliar work
- memory_get — read a specific memory file by path
- memory_remember — save a durable statement (conventions, decisions, facts)
- memory_forget — best-effort removal of a matching statement
Memory holds conventions, decisions and durable project facts. Task state,
tentative conclusions, secrets, and anything the repository already documents
belong OUTSIDE memory. Instructions in the current conversation take precedence
over anything stored in a note.`;

export function apply(ctx, config) {
  // `enabled` defaults to true: only an explicit false turns the plugin off.
  // Testing `!config.enabled` instead would silently disable the plugin for
  // every caller that passes a raw config object without the schema default.
  if (config.enabled === false) {
    ctx.logger?.info?.(`${name}: disabled by config`);
    return;
  }

  const opts = {
    ...config,
    search: { ...DEFAULTS, ...(config.search ?? {}) },
    dream: { ...DREAM_DEFAULTS, ...(config.dream ?? {}) },
  };
  const root = opts.memoryRoot;
  /** sessionId -> { user: string[], assistant: number, toolResults: number } */
  const turnBuffers = new Map();

  ctx.systemPrompt.section({
    name: 'grok-memory:usage',
    order: opts.promptSectionOrder,
    text: USAGE_SECTION,
  });

  // -------------------------------------------------------------- helpers
  const guard = (fn) => (invocation) => {
    try {
      return fn(invocation);
    } catch (error) {
      return err(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // -------------------------------------------------------------- commands
  const commands = [
    {
      name: 'memory',
      description: 'browse cross-session memory files, grouped by scope',
      input: { hint: '[query — optional]' },
      handler: guard((invocation) => {
        const paths = pathsFor(workspaceOf(invocation.agent), root);
        const groups = listMemory(paths);
        const total = Object.values(groups).flat().length;
        if (total === 0) return ok(`${name}: no memory yet for ${paths.identity} [${paths.slug}]`);
        const lines = [`Memory for ${paths.identity}  [${paths.slug}]`];
        for (const [scope, files] of Object.entries(groups)) {
          if (!files.length) continue;
          lines.push('', `${scope.toUpperCase()} (${files.length})`);
          for (const f of files.slice(0, 12)) lines.push(`  ${f}`);
          if (files.length > 12) lines.push(`  ... +${files.length - 12} more`);
        }
        return ok(lines.join('\n'));
      }),
    },
    {
      name: 'remember',
      description: 'save a durable statement to project memory',
      input: { hint: '<statement>  |  <heading>::<statement>' },
      handler: guard((invocation) => {
        const raw = invocation.rawInput.trim();
        if (!raw) return err('Usage: /remember <statement>  or  /remember <heading>::<statement>');
        const paths = pathsFor(workspaceOf(invocation.agent), root);
        const parts = raw.split('::');
        const hasHeading = parts.length > 1;
        const heading = hasHeading ? parts[0].trim() : 'Project Context';
        const statement = (hasHeading ? parts.slice(1).join('::') : parts[0]).trim();
        const target = appendEntry(paths.projectMemory, heading, statement);
        return ok(`${name}: saved to ${target}`);
      }),
    },
    {
      name: 'flush',
      description: "write the current session's summary into the memory session log",
      input: { hint: '[note — optional one-line context]' },
      handler: guard((invocation) => {
        const agent = invocation.agent;
        const paths = pathsFor(workspaceOf(agent), root);
        const buffer = turnBuffers.get(sessionIdOf(agent)) ?? { user: [], assistant: 0, toolResults: 0 };
        const note = invocation.rawInput.trim();
        const summary = sessionSummary({
          userMessages: note ? [...buffer.user, note] : buffer.user,
          assistantMessages: buffer.assistant,
          toolResults: buffer.toolResults,
          sessionId: sessionIdOf(agent),
        });
        if (!summary) {
          return ok(`${name}: session too small to flush (fewer than 3 substantive prompts or <50 bytes of user text)`);
        }
        const date = summary.timestamp.slice(0, 10);
        const file = appendSession(paths, date, renderSummaryMarkdown(summary));
        return ok(`${name}: flushed session summary to ${file}`);
      }),
    },
    {
      name: 'dream',
      description: 'consolidate session logs into deduplicated topic files',
      input: { hint: '[force — bypass auto-dream gates]' },
      handler: guard((invocation) => {
        const paths = pathsFor(workspaceOf(invocation.agent), root);
        const force = invocation.rawInput.trim().toLowerCase() === 'force';
        if (!force) {
          const gate = gatesOpen(paths, opts.dream);
          if (!gate.open) return ok(`${name}: dream gates closed — ${gate.reason}`);
        }
        const markdown = [readText(paths.globalMemory), readText(paths.projectMemory)].filter(Boolean).join('\n');
        const result = dream(paths, markdown, { cfg: opts.dream });
        if (!result.ok) return err(`${name}: dream could not run — ${result.reason}`);
        return ok(`${name}: consolidated ${result.topics} topic file(s)\n${result.files.join('\n')}`);
      }),
    },
    {
      name: 'memclear',
      description: 'clear workspace / global / all memory for this project',
      input: { hint: '[workspace|global|all]  (default: workspace)' },
      handler: guard((invocation) => {
        const paths = pathsFor(workspaceOf(invocation.agent), root);
        const scope = invocation.rawInput.trim() || 'workspace';
        const targets = {
          workspace: paths.workspace,
          global: paths.globalMemory,
          all: paths.root,
        }[scope];
        if (!targets) return err(`Usage: /memclear [workspace|global|all]`);
        rmSync(targets, { recursive: true, force: true });
        return ok(`${name}: cleared ${scope} memory (${targets})`);
      }),
    },
  ];

  for (const def of commands) {
    ctx.effect(() => ctx.commands.register(def), `${name}: /${def.name}`);
  }

  // ----------------------------------------------------------------- tools
  const cwdOf = (exec) => exec?.agent?.session?.header?.cwd ?? process.cwd();

  const tools = [
    defineTool({
      name: 'memory_search',
      description: 'Search cross-session memory (conventions, decisions, durable facts) for a query.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to look for in memory' },
          maxResults: { type: 'number', description: 'Maximum results to return' },
        },
        required: ['query'],
      },
      async execute(args, exec) {
        const paths = pathsFor(cwdOf(exec), root);
        const db = indexed(paths);
        const hits = search(db, args.query, {
          maxResults: args.maxResults ?? opts.search.maxResults,
          minScore: opts.search.minScore,
        });
        if (!hits.length) return { output: `No memory matched "${args.query}".` };
        return {
          output: hits
            .map((h, i) => `${i + 1}. [${h.source}] ${h.file}${h.stale ? ' (may be stale — verify before relying on it)' : ''}\n   ${h.body.slice(0, 300)}`)
            .join('\n'),
        };
      },
    }),
    defineTool({
      name: 'memory_get',
      description: 'Read one memory file by absolute path.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute path to the memory file' } },
        required: ['path'],
      },
      async execute(args) {
        return { output: readText(args.path) || `(empty or missing: ${args.path})` };
      },
    }),
    defineTool({
      name: 'memory_remember',
      description: 'Save a durable statement to project memory (conventions, decisions, facts).',
      parameters: {
        type: 'object',
        properties: {
          statement: { type: 'string', description: 'The durable statement to record' },
          heading: { type: 'string', description: 'Organized heading, e.g. Preferences / Project Context / Debugging' },
          scope: { type: 'string', description: 'project (default) or global' },
        },
        required: ['statement'],
      },
      async execute(args, exec) {
        const paths = pathsFor(cwdOf(exec), root);
        const target = args.scope === 'global' ? paths.globalMemory : paths.projectMemory;
        const file = appendEntry(target, args.heading || 'Project Context', args.statement);
        return { output: `Saved to ${file}` };
      },
    }),
    defineTool({
      name: 'memory_forget',
      description: 'Best-effort removal of memory entries matching a phrase.',
      parameters: {
        type: 'object',
        properties: { phrase: { type: 'string', description: 'Phrase identifying the entries to remove' } },
        required: ['phrase'],
      },
      async execute(args, exec) {
        const paths = pathsFor(cwdOf(exec), root);
        const a = removeEntry(paths.projectMemory, args.phrase);
        const b = removeEntry(paths.globalMemory, args.phrase);
        const total = a.removed + b.removed;
        return {
          output: total > 0
            ? `Removed ${total} matching entr(ies).`
            : 'No matching entry found — edit the file directly for guaranteed removal.',
        };
      },
    }),
  ];

  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool), `${name}: ${tool.name}`);
  }

  // ------------------------------------------------------------------ hooks
  ctx.on('agent/turn-stopping', async ({ messages }, next) => {
    const decision = await next();
    try {
      for (const m of messages ?? []) {
        if (m?.source?.kind !== 'user') continue;
        const text = (m.content ?? [])
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();
        if (!text) continue;
        const id = String(m.sessionId ?? m.session?.id ?? '__global__');
        const buffer = turnBuffers.get(id) ?? { user: [], assistant: 0, toolResults: 0 };
        buffer.user.push(text);
        turnBuffers.set(id, buffer);
      }
    } catch {
      // never break the turn
    }
    return decision;
  });

  ctx.on('agent/settled', ({ agent }) => {
    try {
      const id = sessionIdOf(agent);
      const buffer = turnBuffers.get(id);
      const paths = pathsFor(workspaceOf(agent), root);
      noteSessionEnd(paths);
      if (!buffer) return;
      const summary = sessionSummary({
        userMessages: buffer.user,
        assistantMessages: buffer.assistant,
        toolResults: buffer.toolResults,
        sessionId: id,
      });
      turnBuffers.delete(id);
      if (!summary) return;
      appendSession(paths, summary.timestamp.slice(0, 10), renderSummaryMarkdown(summary));
    } catch (error) {
      ctx.logger?.warn?.(`${name}: auto-save failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  ctx.logger?.info?.(`${name}: Grok Build-style memory enabled (root=${root})`);
}
