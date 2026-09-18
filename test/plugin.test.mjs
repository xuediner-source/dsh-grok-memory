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

describe('plugin: lifecycle hooks', () => {
  it('settled counts a session toward the dream gates and skips trivial ones', async () => {
    const mod = await loadPlugin();
    const { ctx, host } = makeHost();
    const dir = cwd();
    const root = memoryRoot();
    mod.apply(ctx, { memoryRoot: root });

    const stopping = host.listeners.get('agent/turn-stopping');
    const settled = host.listeners.get('agent/settled');
    assert.ok(stopping?.length, 'turn-stopping hook must be registered');
    assert.ok(settled?.length, 'settled hook must be registered');

    // Feed three substantive prompts through turn-stopping, then settle.
    const messages = [
      { source: { kind: 'user' }, content: [{ type: 'text', text: 'refactor the auth middleware for async token validation' }], sessionId: 'sess-1' },
      { source: { kind: 'user' }, content: [{ type: 'text', text: 'add tests covering the expired-token path' }], sessionId: 'sess-1' },
      { source: { kind: 'user' }, content: [{ type: 'text', text: 'run the full test suite and report failures' }], sessionId: 'sess-1' },
    ];
    await emit(host, 'agent/turn-stopping', { messages });
    await emit(host, 'agent/settled', { agent: agentFor(dir) });

    // The session log should now hold a metadata summary.
    const store = await import(new URL('../lib/store.js', import.meta.url).href);
    const paths = store.pathsFor(dir, root);
    const groups = store.listMemory(paths);
    assert.ok(groups.sessions.length >= 1, 'a dated session summary must be written');
  });
});
