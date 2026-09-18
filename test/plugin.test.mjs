import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlugin, makeHost, emit } from './harness.mjs';

const memoryRoot = () => mkdtempSync(join(tmpdir(), 'gmem-root-'));
const cwd = () => mkdtempSync(join(tmpdir(), 'gmem-ws-'));

const COMMANDS = ['memory', 'remember', 'flush', 'dream', 'memclear'];
const TOOLS = ['memory_search', 'memory_get', 'memory_remember', 'memory_forget'];

function agentFor(dir) {
  return { session: { id: 'sess-1', header: { cwd: dir } } };
}

describe('plugin: registration', () => {
  it('exports the Cordis surface', async () => {
    const mod = await loadPlugin();
    assert.equal(mod.name, 'dsh-grok-memory');
    assert.equal(typeof mod.apply, 'function');
    assert.ok(mod.Config);
    assert.ok(mod.inject.includes('commands'));
  });

  it('registers all five commands and four tools', async () => {
    const mod = await loadPlugin();
    const { ctx, host } = makeHost();
    mod.apply(ctx, { memoryRoot: memoryRoot() });

    for (const c of COMMANDS) {
      assert.ok(host.commands.has(c), `command /${c} must be registered`);
    }
    for (const t of TOOLS) {
      assert.ok(host.tools.has(t), `tool ${t} must be registered`);
      assert.equal(typeof host.tools.get(t).output?.render, 'function', `${t} must declare output.render`);
    }
  });

  it('registers the usage section with the precedence rule', async () => {
    const mod = await loadPlugin();
    const { ctx, host } = makeHost();
    mod.apply(ctx, { memoryRoot: memoryRoot() });
    const section = host.sections.get('grok-memory:usage');
    assert.ok(section, 'usage section must exist');
    // Official wording (13-memory.md): "Instructions in the current
    // conversation take precedence over anything stored in a note."
    assert.match(section.text, /current conversation take precedence/i);
    assert.ok(host.contexts.get('grok-memory:snapshot'), 'first-turn snapshot context must be registered');
  });

  it('registers nothing when disabled', async () => {
    const mod = await loadPlugin();
    const { ctx, host } = makeHost();
    mod.apply(ctx, { memoryRoot: memoryRoot(), enabled: false });
    assert.equal(host.commands.size, 0);
    assert.equal(host.tools.size, 0);
  });
});

describe('plugin: command behaviour', () => {
  it('/remember saves a durable statement', async () => {
    const mod = await loadPlugin();
    const { ctx, host } = makeHost();
    const dir = cwd();
    mod.apply(ctx, { memoryRoot: memoryRoot() });

    const result = host.commands.get('remember').handler({
      rawInput: 'Preferences::always open PR links after pushing',
      agent: agentFor(dir),
    });
    assert.equal(result.kind, 'success');
    assert.match(result.text, /saved to/i);
  });

  it('/remember rejects empty input with usage text', async () => {
    const mod = await loadPlugin();
    const { ctx, host } = makeHost();
    mod.apply(ctx, { memoryRoot: memoryRoot() });
    const result = host.commands.get('remember').handler({ rawInput: '   ', agent: agentFor(cwd()) });
    assert.equal(result.kind, 'error');
  });

  it('/memory reports an empty workspace honestly', async () => {
    const mod = await loadPlugin();
    const { ctx, host } = makeHost();
    mod.apply(ctx, { memoryRoot: memoryRoot() });
    const result = host.commands.get('memory').handler({ rawInput: '', agent: agentFor(cwd()) });
    assert.equal(result.kind, 'success');
    assert.match(result.text, /no memory yet/i);
  });

  it('/flush refuses a trivial session', async () => {
    const mod = await loadPlugin();
    const { ctx, host } = makeHost();
    mod.apply(ctx, { memoryRoot: memoryRoot() });
    const result = host.commands.get('flush').handler({ rawInput: 'hi', agent: agentFor(cwd()) });
    assert.equal(result.kind, 'success');
    assert.match(result.text, /too small/i);
  });

  it('/dream reports closed gates without forcing', async () => {
    const mod = await loadPlugin();
    const { ctx, host } = makeHost();
    mod.apply(ctx, { memoryRoot: memoryRoot() });
    const result = host.commands.get('dream').handler({ rawInput: '', agent: agentFor(cwd()) });
    assert.equal(result.kind, 'success');
    assert.match(result.text, /gates closed/i);
  });
});

describe('plugin: tool behaviour', () => {
  it('memory_remember then memory_search round-trips', async () => {
    const mod = await loadPlugin();
    const { ctx, host } = makeHost();
    const root = memoryRoot();
    const dir = cwd();
    mod.apply(ctx, { memoryRoot: root });

    const remember = host.tools.get('memory_remember');
    const saved = await remember.execute({ statement: 'deployment port is 8080', heading: 'Project Context' }, { agent: agentFor(dir) });
    assert.match(saved.output, /Saved to/);

    const searchTool = host.tools.get('memory_search');
    const found = await searchTool.execute({ query: 'deployment port' }, { agent: agentFor(dir) });
    assert.ok(found.output.includes('8080'), `search must find the saved note, got: ${found.output}`);
  });

  it('memory_get reads a memory file by path', async () => {
    const mod = await loadPlugin();
    const { ctx, host } = makeHost();
    const dir = cwd();
    mod.apply(ctx, { memoryRoot: memoryRoot() });

    const remember = host.tools.get('memory_remember');
    const saved = await remember.execute({ statement: 'use pnpm, not npm' }, { agent: agentFor(dir) });
    const path = saved.output.replace(/^Saved to\s*/, '').trim();
    const get = host.tools.get('memory_get');
    const read = await get.execute({ path });
    assert.match(read.output, /use pnpm/);
  });

  it('memory_forget removes a matching statement', async () => {
    const mod = await loadPlugin();
    const { ctx, host } = makeHost();
    const dir = cwd();
    mod.apply(ctx, { memoryRoot: memoryRoot() });

    await host.tools.get('memory_remember').execute({ statement: 'the snake_case convention applies to files' }, { agent: agentFor(dir) });
    const forget = host.tools.get('memory_forget');
    const out = await forget.execute({ phrase: 'snake_case' }, { agent: agentFor(dir) });
    assert.match(out.output, /Removed/);
  });

  it('memory_search reports honestly when nothing matches', async () => {
    const mod = await loadPlugin();
    const { ctx, host } = makeHost();
    mod.apply(ctx, { memoryRoot: memoryRoot() });
    const out = await host.tools.get('memory_search').execute({ query: 'nonexistent-xyzzy' }, { agent: agentFor(cwd()) });
    assert.match(out.output, /No memory matched/);
  });
});

describe('plugin: same-project sharing', () => {
  it('injects workspace MEMORY.md into a new conversation in the same project', async () => {
    const mod = await loadPlugin();
    const root = memoryRoot();
    const dir = cwd();

    const first = makeHost();
    mod.apply(first.ctx, { memoryRoot: root });
    const saved = first.host.commands.get('remember').handler({
      rawInput: 'Preferences::always open PR links after pushing',
      agent: agentFor(dir),
    });
    assert.equal(saved.kind, 'success');

    const second = makeHost();
    mod.apply(second.ctx, { memoryRoot: root });
    const snap = second.host.contexts.get('grok-memory:snapshot').text({ agent: agentFor(dir) });
    assert.match(snap, /Cross-session memory/);
    assert.match(snap, /always open PR links after pushing/);
    assert.match(snap, /current conversation take precedence/i);
  });

  it('does not inject an empty snapshot when the project has no memory yet', async () => {
    const mod = await loadPlugin();
    const { ctx, host } = makeHost();
    mod.apply(ctx, { memoryRoot: memoryRoot() });
    const snap = host.contexts.get('grok-memory:snapshot').text({ agent: agentFor(cwd()) });
    assert.equal(snap, '');
  });
});

describe('plugin: lifecycle hooks', () => {
  /**
   * A session carrying user/message events — the authoritative shape verified
   * in @deepseek-ai/dsh-session: for `user/message` the event data IS the
   * message record ({ role, source.kind, content }).
   */
  function agentWithEvents(dir, prompts, id = 'sess-1') {
    const events = prompts.map((text, i) => ({
      type: 'user/message',
      data: {
        id: `m${i}`,
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text }],
      },
    }));
    return { session: { id, header: { cwd: dir }, events } };
  }

  it('settled reads session events, writes one summary, and never calls next', async () => {
    const mod = await loadPlugin();
    const { ctx, host } = makeHost();
    const dir = cwd();
    const root = memoryRoot();
    mod.apply(ctx, { memoryRoot: root });

    const settled = host.listeners.get('agent/settled');
    assert.ok(settled?.length, 'settled hook must be registered');

    const prompts = [
      'refactor the auth middleware for async token validation',
      'add tests covering the expired-token path',
      'run the full test suite and report failures',
    ];
    const agent = agentWithEvents(dir, prompts);

    // Cordis serial dispatch: positional args only, no `next` callback.
    // Passing a next() here would mask the exact crash seen in the host log.
    await emit(host, 'agent/settled', agent, 1, { kind: 'completed' });

    const store = await import(new URL('../lib/store.js', import.meta.url).href);
    const paths = store.pathsFor(dir, root);
    const groups = store.listMemory(paths);
    assert.ok(groups.sessions.length >= 1, 'a dated session summary must be written');
    const body = store.readText(groups.sessions[0]);
    assert.match(body, /auth middleware/, 'topics must come from user/message events');

    const before = body;
    await emit(host, 'agent/settled', agent, 2, { kind: 'completed' });
    const after = store.readText(groups.sessions[0]);
    assert.equal(after, before, 'a second settle of the same conversation must not duplicate the summary');
  });

  it('turn-stopping hook tolerates the real {turn,signal} payload without a next callback', async () => {
    const mod = await loadPlugin();
    const { ctx, host } = makeHost();
    mod.apply(ctx, { memoryRoot: memoryRoot() });

    const stopping = host.listeners.get('agent/turn-stopping');
    assert.ok(stopping?.length, 'turn-stopping hook must be registered');

    // Exactly what the host dispatches: dispatch.serial(name, { turn, signal }).
    // This must not throw — "next is not a function" broke live turns.
    const controller = new AbortController();
    await emit(host, 'agent/turn-stopping', { turn: 1, signal: controller.signal });
  });

  it('skips trivial sessions (fewer than 3 substantive prompts)', async () => {
    const mod = await loadPlugin();
    const { ctx, host } = makeHost();
    const dir = cwd();
    const root = memoryRoot();
    mod.apply(ctx, { memoryRoot: root });

    await emit(host, 'agent/settled', agentWithEvents(dir, ['hi']), 1, { kind: 'completed' });
    const store = await import(new URL('../lib/store.js', import.meta.url).href);
    const groups = store.listMemory(store.pathsFor(dir, root));
    assert.equal(groups.sessions.length, 0, 'a trivial session must not produce a summary');
  });
});
