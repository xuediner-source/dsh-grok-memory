import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLib } from './harness.mjs';

const store = await loadLib('store');
const dream = await loadLib('dream');
const search = await loadLib('search');

const tmp = () => mkdtempSync(join(tmpdir(), 'gmem-'));

describe('store: layout and identity', () => {
  it('falls back to the directory path when the repo has no origin', () => {
    const dir = tmp();
    assert.equal(store.projectIdentity(dir), dir);
  });

  it('derives workspace slug from the identity with a stable hash8', () => {
    const dir = tmp();
    const a = store.projectSlug(dir);
    const b = store.projectSlug(dir);
    assert.equal(a, b, 'slug must be stable for the same identity');
    assert.match(a, /-[0-9a-f]{8}$/, 'slug must end with 8 hex chars');
  });

  it('clones of the same origin share one memory directory (official rule)', () => {
    const origin = 'https://github.com/acme/shared-app.git';
    const makeClone = () => {
      const dir = tmp();
      const git = (...args) => execFileSync('git', ['-C', dir, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      git('init', '-q');
      git('remote', 'add', 'origin', origin);
      return dir;
    };
    const a = store.projectSlug(makeClone());
    const b = store.projectSlug(makeClone());
    assert.equal(a, b, 'clones/worktrees of the same origin must share one slug');
    assert.notEqual(store.projectSlug(tmp()), a, 'a path-identity workspace must not collide with an origin slug');
  });

  it('lays out MEMORY.md / sessions / topics per scope', () => {
    const dir = tmp();
    const paths = store.pathsFor(dir, join(dir, 'memory'));
    store.ensureDirs(paths);
    assert.equal(paths.globalMemory, join(paths.root, 'MEMORY.md'));
    assert.ok(paths.projectMemory.endsWith('MEMORY.md'));
    assert.ok(paths.sessions.endsWith('sessions'));
    assert.ok(paths.topics.endsWith('topics'));
  });

  it('appends a durable statement under an organized heading', () => {
    const dir = tmp();
    const paths = store.pathsFor(dir, join(dir, 'memory'));
    store.appendEntry(paths.projectMemory, 'Preferences', 'always open PR links after pushing');
    const text = store.readText(paths.projectMemory);
    assert.match(text, /## Preferences/);
    assert.match(text, /- always open PR links after pushing/);
  });

  it('removes matching entries best-effort', () => {
    const dir = tmp();
    const paths = store.pathsFor(dir, join(dir, 'memory'));
    store.appendEntry(paths.projectMemory, 'Preferences', 'use snake_case for files');
    const before = store.readText(paths.projectMemory);
    assert.match(before, /snake_case/);
    const { removed } = store.removeEntry(paths.projectMemory, 'snake_case');
    assert.ok(removed >= 1);
    assert.doesNotMatch(store.readText(paths.projectMemory), /snake_case/);
  });
});

describe('search: FTS5 + decay + MMR', () => {
  function seed(root) {
    const paths = store.pathsFor(root, root);
    store.ensureDirs(paths);
    store.appendEntry(paths.projectMemory, 'Project Context', 'deployment port is 8080');
    store.appendEntry(paths.projectMemory, 'Debugging', 'auth middleware logs the failing token');
    store.appendSession(paths, '2026-09-01', '## Session\n\n- reviewed the auth middleware on 2026-09-01\n');
    const files = store.allMarkdownFiles(root);
    const db = search.openIndex(paths.index);
    search.reindex(db, files, root);
    return { db, paths };
  }

  it('finds workspace memory by keyword', () => {
    const { db } = seed(tmp());
    const hits = search.search(db, 'deployment port', { minScore: 0.1 });
    assert.ok(hits.length > 0, 'expected at least one hit');
    assert.ok(hits.some((h) => h.source === 'workspace'));
  });

  it('applies temporal decay to session chunks only', () => {
    const { db, paths } = seed(tmp());
    const now = Date.now();
    const farFuture = now + 1000 * 60 * 60 * 24 * 365; // a year later
    const fresh = search.search(db, 'auth middleware', { minScore: 0.01, now });
    const aged = search.search(db, 'auth middleware', { minScore: 0.01, now: farFuture });
    const freshSession = fresh.find((h) => h.source === 'session');
    const agedSession = aged.find((h) => h.source === 'session');
    if (freshSession && agedSession) {
      assert.ok(agedSession.score <= freshSession.score, 'session score must not grow with age');
    }
    const freshWs = fresh.find((h) => h.source === 'workspace');
    const agedWs = aged.find((h) => h.source === 'workspace');
    if (freshWs && agedWs) {
      assert.equal(agedWs.score, freshWs.score, 'workspace memory must be decay-exempt');
    }
  });

  it('MMR rerank favours diversity when relevance is comparable', () => {
    // Under the official default lambda=0.7 (0.7 relevance, 0.3 diversity), a
    // near-duplicate must outrank a diverse entry ONLY when its relevance gap
    // exceeds the redundancy penalty. With comparable relevance the duplicate
    // loses.
    const dup = [
      { id: 1, file: 'a', source: 'workspace', body: 'deployment port is 8080', score: 1.0, stale: false },
      { id: 2, file: 'b', source: 'workspace', body: 'deployment port is 8080', score: 0.98, stale: false },
      { id: 3, file: 'c', source: 'workspace', body: 'auth middleware logs the failing token', score: 0.97, stale: false },
    ];
    const reranked = search.mmrRerank(dup, 0.7, 3);
    assert.equal(reranked[0].id, 1, 'highest relevance comes first');
    assert.equal(reranked[1].id, 3, 'the diverse entry must outrank the near-duplicate');
  });

  it('MMR with lambda=1.0 ranks purely by relevance (diversity ignored)', () => {
    const rows = [
      { id: 1, file: 'a', source: 'workspace', body: 'deployment port is 8080', score: 1.0, stale: false },
      { id: 2, file: 'b', source: 'workspace', body: 'deployment port is 8080', score: 0.99, stale: false },
      { id: 3, file: 'c', source: 'workspace', body: 'auth middleware logs the failing token', score: 0.5, stale: false },
    ];
    const reranked = search.mmrRerank(rows, 1.0, 3);
    assert.deepEqual(reranked.map((r) => r.id), [1, 2, 3], 'lambda=1.0 must equal pure relevance order');
  });

  it('chunks text with overlap per official index settings', () => {
    const text = 'x'.repeat(4000);
    const chunks = search.chunk(text, { maxChunkChars: 1600, chunkOverlapChars: 320 });
    assert.ok(chunks.length > 1);
    assert.ok(chunks[0].length <= 1600);
  });
});

describe('dream: gates, locks, consolidation', () => {
  it('gates: first consolidation needs sessions; later ones also need hours', () => {
    const dir = tmp();
    const paths = store.pathsFor(dir, join(dir, 'memory'));
    store.ensureDirs(paths);
    const cfg = { ...dream.DREAM_DEFAULTS, minHours: 24, minSessions: 5 };
    const now = Date.now();

    // Official semantics: min_hours is the minimum interval BETWEEN
    // consolidations. A project that has never consolidated has no prior
    // consolidation to wait for, so the hours gate is trivially satisfied —
    // the session gate is what blocks the first run.
    const noSessions = dream.gatesOpen(paths, cfg, now);
    assert.equal(noSessions.open, false, 'no sessions accumulated yet');

    for (let i = 0; i < 5; i++) dream.noteSessionEnd(paths);
    const first = dream.gatesOpen(paths, cfg, now);
    assert.equal(first.open, true, 'first consolidation opens once sessions are accumulated');

    // After a consolidation, the hours gate applies to the NEXT one.
    dream.dream(paths, '## Project Context\n- deployment port is 8080\n', { now, cfg });
    for (let i = 0; i < 5; i++) dream.noteSessionEnd(paths);
    const tooSoon = dream.gatesOpen(paths, cfg, now + 1 * 3600_000);
    assert.equal(tooSoon.open, false, 'hours gate blocks a second consolidation too soon');
    const later = dream.gatesOpen(paths, cfg, now + 25 * 3600_000);
    assert.equal(later.open, true, 'hours gate opens after min_hours elapses');
  });

  it('a stale lock is reclaimed', () => {
    const dir = tmp();
    const paths = store.pathsFor(dir, join(dir, 'memory'));
    store.ensureDirs(paths);
    const cfg = { ...dream.DREAM_DEFAULTS, staleLockSecs: 3600 };
    const first = dream.acquireLock(paths, cfg, Date.now());
    assert.equal(first.locked, true);
    const second = dream.acquireLock(paths, cfg, Date.now());
    assert.equal(second.locked, false, 'fresh lock must block');
    const later = dream.acquireLock(paths, cfg, Date.now() + 4000 * 1000);
    assert.equal(later.locked, true, 'stale lock must be reclaimed');
  });

  it('consolidates session logs into deduplicated topic files', () => {
    const dir = tmp();
    const paths = store.pathsFor(dir, join(dir, 'memory'));
    store.ensureDirs(paths);
    store.appendSession(paths, '2026-09-01', '## Debugging\n\n- auth middleware logs the failing token\n- auth middleware logs the failing token\n');
    store.appendSession(paths, '2026-09-02', '## Debugging\n\n- auth middleware logs the failing token\n');
    const result = dream.dream(paths, '', { now: Date.now() });
    assert.equal(result.ok, true);
    assert.ok(result.topics >= 1);
    const topicFile = result.files.find((f) => f.includes('debugging'));
    assert.ok(topicFile, 'expected a debugging topic file');
    const content = store.readText(topicFile);
    const occurrences = content.split('auth middleware logs the failing token').length - 1;
    assert.equal(occurrences, 1, 'identical statements must be deduplicated');
  });

  it('skips trivial sessions (<3 prompts or <50 bytes)', () => {
    assert.equal(dream.sessionSummary({ userMessages: ['hi'] }), null);
    assert.equal(dream.sessionSummary({ userMessages: ['a', 'b', 'c'] }), null, 'too few bytes');
    const ok = dream.sessionSummary({ userMessages: ['first substantive question here', 'second substantive question here', 'third substantive question here'] });
    assert.ok(ok);
    assert.equal(ok.topics.length, 3);
  });

  it('summary includes message counts but records no tool usage (official rule)', () => {
    const s = dream.sessionSummary({
      userMessages: ['refactor the auth middleware', 'add tests for the token flow', 'run the linter on src/auth'],
      toolResults: 42,
    });
    const md = dream.renderSummaryMarkdown(s);
    // Official spec: the summary CONTAINS "Message counts (user, assistant, and
    // tool results)". What it must NOT record is tool usage, file paths, or
    // shell commands pulled from tool calls.
    assert.match(md, /3 user/, 'user message count must be present');
    assert.match(md, /42 tool/, 'tool-result count must be present (official spec)');
    // No tool usage details leak in: no tool names or shell invocations.
    assert.doesNotMatch(md, /\b(pwsh|bash|rg|grep|node --test)\b/, 'tool usage must not leak');
    // File paths come only from the user's own prompts (topics), never
    // extracted from tool calls — src/auth appears because the USER typed it.
    assert.match(md, /Topics/);
  });
});

describe('inject: first-turn snapshot', () => {
  it('builds an empty snapshot when nothing is stored', async () => {
    const inject = await loadLib('inject');
    const dir = tmp();
    const paths = store.pathsFor(dir, join(dir, 'memory'));
    store.ensureDirs(paths);
    assert.equal(inject.buildInjection({ paths, query: 'auth' }), '');
  });

  it('injects curated workspace memory so a new conversation shares it', async () => {
    const inject = await loadLib('inject');
    const dir = tmp();
    const paths = store.pathsFor(dir, join(dir, 'memory'));
    store.appendEntry(paths.projectMemory, 'Preferences', 'always open PR links after pushing');
    const snap = inject.buildInjection({ paths, includeRecall: false });
    assert.match(snap, /Cross-session memory/);
    assert.match(snap, /always open PR links after pushing/);
    assert.match(snap, /current conversation take precedence/i);
  });

  it('turns a user prompt into an FTS-safe query', async () => {
    const inject = await loadLib('inject');
    assert.equal(inject.searchQueryOf('Search memory for "auth middleware patterns"!'), 'search memory for auth middleware patterns');
    assert.equal(inject.searchQueryOf('???'), '');
  });
});
