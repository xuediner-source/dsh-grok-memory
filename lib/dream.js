/**
 * /dream consolidation — the official Grok Build behaviour
 * (~/.grok/docs/user-guide/13-memory.md, "Dream Consolidation with /dream").
 *
 * Dream reorganizes individual session logs and memory entries into a coherent,
 * deduplicated knowledge base, which reduces noise and improves search quality
 * over time. It writes one topic file per subject (e.g. topics/testing.md).
 *
 * Auto-Dream gates (official defaults):
 *   enabled            true
 *   min_hours          24      minimum hours between consolidations
 *   min_sessions       5       minimum sessions since the last consolidation
 *   stale_lock_secs    3600    seconds before a stale lock is reclaimed
 *   check_interval_secs 3600   periodic gate check; 0 disables
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendSession } from './store.js';

export const DREAM_DEFAULTS = {
  enabled: true,
  minHours: 24,
  minSessions: 5,
  staleLockSecs: 3600,
  checkIntervalSecs: 3600,
};

const LOCK_FILE = 'dream.lock';
const STATE_FILE = 'dream-state.json';

function statePath(paths) { return join(paths.workspace, STATE_FILE); }
function lockPath(paths) { return join(paths.workspace, LOCK_FILE); }

export function readState(paths) {
  try { return JSON.parse(readFileSync(statePath(paths), 'utf8')); }
  catch { return { lastConsolidation: 0, sessionsSinceConsolidation: 0, lastCheck: 0 }; }
}

function writeState(paths, state) {
  mkdirSync(paths.workspace, { recursive: true });
  writeFileSync(statePath(paths), JSON.stringify(state, null, 2), 'utf8');
}

/** Record one session end — drives the auto-dream session counter. */
export function noteSessionEnd(paths) {
  const state = readState(paths);
  state.sessionsSinceConsolidation = (state.sessionsSinceConsolidation ?? 0) + 1;
  writeState(paths, state);
  return state;
}

/**
 * Whether the consolidation gates are satisfied — the official rule is an AND:
 * enough hours since the last consolidation AND enough sessions accumulated.
 */
export function gatesOpen(paths, cfg = DREAM_DEFAULTS, now = Date.now()) {
  if (!cfg.enabled) return { open: false, reason: 'dream disabled' };
  const state = readState(paths);
  const hours = (now - (state.lastConsolidation ?? 0)) / 3_600_000;
  if (hours < cfg.minHours) return { open: false, reason: `only ${hours.toFixed(1)}h since last (min ${cfg.minHours}h)` };
  const sessions = state.sessionsSinceConsolidation ?? 0;
  if (sessions < cfg.minSessions) return { open: false, reason: `${sessions} sessions since last (min ${cfg.minSessions})` };
  return { open: true, hours, sessions };
}

/**
 * Acquire the consolidation lock. A stale lock older than staleLockSecs is
 * reclaimed, so a crashed run cannot block Dream forever.
 */
export function acquireLock(paths, cfg = DREAM_DEFAULTS, now = Date.now()) {
  const lp = lockPath(paths);
  if (existsSync(lp)) {
    const age = (now - statSync(lp).mtimeMs) / 1000;
    if (age < cfg.staleLockSecs) return { locked: false, reason: `lock held ${Math.round(age)}s` };
    rmSync(lp, { force: true });
  }
  mkdirSync(paths.workspace, { recursive: true });
  writeFileSync(lp, String(now), 'utf8');
  return { locked: true };
}

export function releaseLock(paths) { rmSync(lockPath(paths), { force: true }); }

/**
 * Topic slug for a heading — one topic file per subject, mirroring the
 * official `topics/testing.md` shape.
 */
export function topicSlug(heading) {
  return heading
    .toLowerCase()
    .replace(/^#+\s*/, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'general';
}

/** Pull `## Heading` sections out of a markdown blob. */
export function splitTopics(markdown) {
  const topics = new Map();
  const lines = markdown.split('\n');
  let current = 'general';
  for (const line of lines) {
    const m = line.match(/^#{2,3}\s+(.+?)\s*$/);
    if (m) { current = topicSlug(m[1]); continue; }
    const trimmed = line.trim();
    if (trimmed.startsWith('- ')) {
      if (!topics.has(current)) topics.set(current, []);
      topics.get(current).push(trimmed);
    }
  }
  return topics;
}

/**
 * Consolidate session logs and MEMORY entries into deduplicated topic files.
 * Statements identical after normalization collapse into one entry — the
 * "coherent, deduplicated knowledge base" the official doc describes.
 */
export function dream(paths, rootMarkdown, { now = Date.now(), cfg = DREAM_DEFAULTS } = {}) {
  const lock = acquireLock(paths, cfg, now);
  if (!lock.locked) return { ok: false, reason: lock.reason };
  try {
    const merged = new Map();
    const ingest = (markdown) => {
      for (const [topic, statements] of splitTopics(markdown)) {
        if (!merged.has(topic)) merged.set(topic, new Set());
        for (const s of statements) merged.get(topic).add(normalizeStatement(s));
      }
    };
    ingest(rootMarkdown || '');
    if (existsSync(paths.sessions)) {
      for (const f of readdirSync(paths.sessions).filter((n) => n.endsWith('.md'))) {
        ingest(readFileSync(join(paths.sessions, f), 'utf8'));
      }
    }

    mkdirSync(paths.topics, { recursive: true });
    const written = [];
    for (const [topic, statements] of merged) {
      if (!statements.size) continue;
      const file = join(paths.topics, `${topic}.md`);
      const header = `# ${topic}\n\n<!-- consolidated ${new Date(now).toISOString()} -->\n`;
      const body = [...statements].sort().map((s) => `- ${s}`).join('\n');
      writeFileSync(file, `${header}${body}\n`, 'utf8');
      written.push(file);
    }

    writeState(paths, { lastConsolidation: now, sessionsSinceConsolidation: 0, lastCheck: now });
    return { ok: true, topics: written.length, files: written };
  } finally {
    releaseLock(paths);
  }
}

function normalizeStatement(s) {
  return s.replace(/^-\s*/, '').replace(/\s+/g, ' ').trim();
}

/**
 * Metadata-only session summary — the official automatic save. Built from
 * conversation metadata with no LLM call, no added latency. Trivial sessions
 * (fewer than three substantive prompts, or under 50 bytes of user text) are
 * skipped, and the summary records no tool usage, file paths, or commands.
 */
export function sessionSummary({ userMessages = [], assistantMessages = 0, toolResults = 0, sessionId = '', now = Date.now() } = {}) {
  const substantive = userMessages.filter((m) => typeof m === 'string' && m.trim().length > 0);
  const bytes = substantive.reduce((n, m) => n + Buffer.byteLength(m, 'utf8'), 0);
  if (substantive.length < 3 || bytes < 50) return null;
  const topics = substantive.slice(0, 5).map((m) => m.trim().split('\n')[0].slice(0, 80));
  return {
    sessionId,
    timestamp: new Date(now).toISOString(),
    counts: { user: substantive.length, assistant: assistantMessages, toolResults },
    topics,
  };
}

export function renderSummaryMarkdown(summary) {
  return [
    '## Session',
    '',
    `- Session: \`${summary.sessionId}\``,
    `- When: ${summary.timestamp}`,
    `- Messages: ${summary.counts.user} user / ${summary.counts.assistant} assistant / ${summary.counts.toolResults} tool`,
    '### Topics',
    ...summary.topics.map((t) => `- ${t}`),
  ].join('\n');
}

export { appendSession };
