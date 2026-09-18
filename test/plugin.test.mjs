/**
 * Plugin-level tests: registration, the two tools, the six commands, context
 * injection and the lifecycle hooks. These drive the real plugin entry through
 * the Cordis-like host in harness.mjs.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlugin, makeHost, emit } from './harness.mjs';
import { resolveTracks } from '../lib/tracks.js';

const memoryRoot = () => mkdtempSync(join(tmpdir(), 'gmem-root-'));
const cwd = () => mkdtempSync(join(tmpdir(), 'gmem-ws-'));

/** Track locations for one project under one root. */
const tracksFor = (root, dir) => resolveTracks(root, dir);

const COMMANDS = ['memory', 'remember', 'flush', 'dream', 'memclear', 'suggest'];
const TOOLS = ['memory', 'memory_suggest'];

function agentFor(dir, id = 'sess-1') {
  return { session: { id, header: { cwd: dir } } };
}

/** Boot the plugin against a fresh root; returns the host and its tools. */
async function boot(config = {}) {
  const mod = await loadPlugin();
  const { ctx, host } = makeHost();
  const root = config.memoryRoot ?? memoryRoot();
  mod.apply(ctx, { memoryRoot: root, ...config });
  return { host, root, tool: (n) => host.tools.get(n) };
}

/** Call one tool and return its rendered text. */
async function call(host, name, args, agent) {
  const tool = host.tools.get(name);
  const result = await tool.execute(args, { agent });
  return tool.output.render(args, result)[0].text;
}

describe('plugin: registration', () => {
  it('exports the Cordis surface', async () => {
    const mod = await loadPlugin();
    assert.equal(mod.name, 'dsh-grok-memory');
    assert.equal(typeof mod.apply, 'function');
    assert.ok(mod.Config);
    assert.ok(mod.inject.includes('commands'));
  });

  it('registers all six commands and both tools', async () => {
    const { host } = await boot();
    for (const c of COMMANDS) {
      assert.ok(host.commands.has(c), `command /${c} must be registered`);
    }
    for (const t of TOOLS) {
      assert.ok(host.tools.has(t), `tool ${t} must be registered`);
      assert.equal(typeof host.tools.get(t).output?.render, 'function', `${t} must declare output.render`);
    }
  });

  it('registers the usage section naming every track and the precedence rule', async () => {
    const { host } = await boot();
    const section = host.sections.get('grok-memory:usage');
    assert.ok(section, 'usage section must exist');
    // Official wording (13-memory.md): "Instructions in the current
    // conversation take precedence over anything stored in a note."
    assert.match(section.text, /current conversation take precedence/i);
    for (const track of ['memory', 'user', 'project', 'key', 'daily']) {
      assert.match(section.text, new RegExp(`\`${track}\``), `usage must document the ${track} track`);
    }
    assert.ok(host.contexts.get('grok-memory:snapshot'), 'first-turn snapshot context must be registered');
  });

  it('registers nothing when disabled', async () => {
    const { host } = await boot({ enabled: false });
    assert.equal(host.commands.size, 0);
    assert.equal(host.tools.size, 0);
  });
});

describe('plugin: the memory tool', () => {
  it('adds to each track and reports the resulting count', async () => {
    const { host } = await boot();
    const dir = cwd();
    const agent = agentFor(dir);
    assert.match(await call(host, 'memory', { action: 'add', target: 'memory', content: 'global fact' }, agent), /已添加/);
    assert.match(await call(host, 'memory', { action: 'add', target: 'user', content: 'user fact' }, agent), /已添加/);
    assert.match(await call(host, 'memory', { action: 'add', target: 'key', content: 'key fact' }, agent), /已添加/);
    assert.match(await call(host, 'memory', { action: 'add', target: 'project', content: 'log line' }, agent), /已添加/);
    assert.match(await call(host, 'memory', { action: 'add', target: 'daily', content: 'daily line' }, agent), /已添加/);
    const listed = await call(host, 'memory', { action: 'list', target: 'memory' }, agent);
    assert.match(listed, /global fact/);
    assert.match(listed, /1 条/);
  });

  it('lists, replaces and removes through the single entry point', async () => {
    const { host } = await boot();
    const agent = agentFor(cwd());
    await call(host, 'memory', { action: 'add', target: 'memory', content: 'original statement' }, agent);
    assert.match(await call(host, 'memory', { action: 'replace', target: 'memory', match: 'original', content: 'revised statement' }, agent), /已替换/);
    const listed = await call(host, 'memory', { action: 'list', target: 'memory' }, agent);
    assert.match(listed, /revised statement/);
    assert.ok(!listed.includes('original statement'));
    assert.match(await call(host, 'memory', { action: 'remove', target: 'memory', match: 'revised' }, agent), /已删除/);
    assert.match(await call(host, 'memory', { action: 'list', target: 'memory' }, agent), /0 条/);
  });

  it('searches across tracks and reports the source of each hit', async () => {
    const { host } = await boot();
    const agent = agentFor(cwd());
    await call(host, 'memory', { action: 'add', target: 'memory', content: 'wombat husbandry notes' }, agent);
    await call(host, 'memory', { action: 'add', target: 'key', content: 'wombat enclosure spec' }, agent);
    const found = await call(host, 'memory', { action: 'search', query: 'wombat' }, agent);
    assert.match(found, /\[memory\]/);
    assert.match(found, /\[key\]/);
    assert.match(await call(host, 'memory', { action: 'search', query: 'nonexistentterm' }, agent), /No memory matched/);
  });

  it('archives and promotes through the tool', async () => {
    const { host } = await boot();
    const agent = agentFor(cwd());
    await call(host, 'memory', { action: 'add', target: 'memory', content: 'aging fact' }, agent);
    assert.match(await call(host, 'memory', { action: 'archive', target: 'memory', match: 'aging fact' }, agent), /已归档/);
    assert.match(await call(host, 'memory', { action: 'list', target: 'memory' }, agent), /0 条/);
    assert.match(await call(host, 'memory', { action: 'list', target: 'memory', archived: true }, agent), /aging fact/);
    assert.match(await call(host, 'memory', { action: 'promote', target: 'memory', match: 'aging fact' }, agent), /已从归档取回/);
  });

  it('explains a missing or unknown action instead of failing silently', async () => {
    const { host } = await boot();
    const agent = agentFor(cwd());
    assert.match(await call(host, 'memory', { action: 'add', content: 'x' }, agent), /需要 target/);
    assert.match(await call(host, 'memory', { action: 'list' }, agent), /需要 target/);
    assert.match(await call(host, 'memory', { action: 'search' }, agent), /需要 query/);
    assert.match(await call(host, 'memory', { action: 'frobnicate', target: 'memory' }, agent), /未知 action/);
  });

  it('refuses a bad track name and a project write without a cwd', async () => {
    const { host } = await boot();
    assert.match(await call(host, 'memory', { action: 'add', target: 'nope', content: 'x' }, agentFor(cwd())), /无效的记忆轨/);
    // No cwd at all: workspaceOf falls back to process.cwd(), so the write lands
    // in the *host* project's memory rather than crashing the turn.
    const noCwd = { session: { id: 's2', header: {} } };
    assert.match(await call(host, 'memory', { action: 'add', target: 'key', content: 'fact' }, noCwd), /已添加/);
  });
});

describe('plugin: memory_suggest gating', () => {
  it('queues the injected tracks instead of writing them', async () => {
    const { host, root } = await boot();
    const agent = agentFor(cwd());
    const out = await call(host, 'memory_suggest', { target: 'memory', content: 'durable global fact', reason: 'evidence' }, agent);
    assert.match(out, /待确认/);
    // nothing landed in the live track
    assert.match(await call(host, 'memory', { action: 'list', target: 'memory' }, agent), /0 条/);
    const queueFile = join(root, 'SUGGESTIONS.jsonl');
    const queued = readFileSync(queueFile, 'utf8');
    assert.match(queued, /durable global fact/);
    assert.match(queued, /evidence/);
  });

  it('refuses a track that is meant to be written directly', async () => {
    const { host } = await boot();
    const out = await call(host, 'memory_suggest', { target: 'project', content: 'x' }, agentFor(cwd()));
    assert.match(out, /只用于注入轨/);
  });

  it('deduplicates a repeated suggestion', async () => {
    const { host } = await boot();
    const agent = agentFor(cwd());
    await call(host, 'memory_suggest', { target: 'key', content: 'same fact' }, agent);
    const second = await call(host, 'memory_suggest', { target: 'key', content: 'same   fact' }, agent);
    assert.match(second, /第 2 次提出/);
  });
});

describe('plugin: commands', () => {
  it('/memory reports every track and the pending count', async () => {
    const { host } = await boot();
    const dir = cwd();
    const agent = agentFor(dir);
    await call(host, 'memory', { action: 'add', target: 'memory', content: 'a fact' }, agent);
    await call(host, 'memory_suggest', { target: 'key', content: 'a suggestion' }, agent);
    const out = host.commands.get('memory').handler({ agent, rawInput: '' });
    assert.equal(out.kind, 'success');
    assert.match(out.text, /memory\s+1 条/);
    assert.match(out.text, /key\s+0 条/);
    assert.match(out.text, /\(injected\)/);
    assert.match(out.text, /Pending suggestions: 1/);
  });

  it('/remember writes the direct tracks and queues the injected ones', async () => {
    const { host } = await boot();
    const agent = agentFor(cwd());
    const direct = host.commands.get('remember').handler({ agent, rawInput: 'a progress note' });
    assert.equal(direct.kind, 'success');
    assert.match(await call(host, 'memory', { action: 'list', target: 'project' }, agent), /a progress note/);

    const gated = host.commands.get('remember').handler({ agent, rawInput: 'key::a durable key fact' });
    assert.equal(gated.kind, 'success');
    assert.match(gated.text, /待确认队列/);
    assert.match(await call(host, 'memory', { action: 'list', target: 'key' }, agent), /0 条/);
  });

  it('/remember explains its usage on empty input', async () => {
    const { host } = await boot();
    const out = host.commands.get('remember').handler({ agent: agentFor(cwd()), rawInput: '   ' });
    assert.equal(out.kind, 'error');
    assert.match(out.text, /Usage/);
  });

  it('/suggest lists, drops and clears the queue', async () => {
    const { host } = await boot();
    const agent = agentFor(cwd());
    const suggest = host.commands.get('suggest');
    assert.match(suggest.handler({ agent, rawInput: '' }).text, /队列为空/);
    await call(host, 'memory_suggest', { target: 'memory', content: 'first suggestion' }, agent);
    await call(host, 'memory_suggest', { target: 'key', content: 'second suggestion' }, agent);
    const listed = suggest.handler({ agent, rawInput: '' }).text;
    assert.match(listed, /2 条/);
    assert.match(listed, /first suggestion/);
    assert.match(suggest.handler({ agent, rawInput: 'drop 1' }).text, /已丢弃 #1/);
    assert.match(suggest.handler({ agent, rawInput: '' }).text, /1 条/);
    assert.match(suggest.handler({ agent, rawInput: 'clear' }).text, /已清空/);
    assert.match(suggest.handler({ agent, rawInput: '' }).text, /队列为空/);
  });

  it('/memclear scopes the delete to the requested track', async () => {
    const { host } = await boot();
    const dir = cwd();
    const agent = agentFor(dir);
    await call(host, 'memory', { action: 'add', target: 'key', content: 'key fact' }, agent);
    await call(host, 'memory', { action: 'add', target: 'memory', content: 'global fact' }, agent);
    const cleared = host.commands.get('memclear').handler({ agent, rawInput: 'key' });
    assert.equal(cleared.kind, 'success');
    assert.match(await call(host, 'memory', { action: 'list', target: 'key' }, agent), /0 条/);
    // the other track is untouched
    assert.match(await call(host, 'memory', { action: 'list', target: 'memory' }, agent), /global fact/);
    assert.equal(host.commands.get('memclear').handler({ agent, rawInput: 'bogus' }).kind, 'error');
  });

  it('/dream reports closed gates without forcing', async () => {
    const { host } = await boot();
    const out = host.commands.get('dream').handler({ agent: agentFor(cwd()), rawInput: '' });
    assert.equal(out.kind, 'success');
    assert.match(out.text, /gates closed/);
  });

  it('/flush refuses a session that is too small to summarise', async () => {
    const { host } = await boot();
    const out = host.commands.get('flush').handler({ agent: agentFor(cwd()), rawInput: '' });
    assert.match(out.text, /too small to flush/);
  });
});

describe('plugin: context injection', () => {
  it('injects this project key facts and the global tracks on the first turn', async () => {
    const { host } = await boot();
    const dir = cwd();
    const agent = agentFor(dir);
    await call(host, 'memory', { action: 'add', target: 'memory', content: 'global durable fact' }, agent);
    await call(host, 'memory', { action: 'add', target: 'user', content: 'user prefers terse answers' }, agent);
    await call(host, 'memory', { action: 'add', target: 'key', content: 'project key fact' }, agent);
    await call(host, 'memory', { action: 'add', target: 'project', content: 'progress log line' }, agent);
    const snapshot = host.contexts.get('grok-memory:snapshot').text({ agent });
    assert.match(snapshot, /Cross-session memory \(this project\)/);
    assert.match(snapshot, /global durable fact/);
    assert.match(snapshot, /user prefers terse answers/);
    assert.match(snapshot, /project key fact/);
    assert.ok(!snapshot.includes('progress log line'), 'the project log must stay out of the prompt');
  });

  it('does not inject anything into a subagent session', async () => {
    const { host } = await boot();
    const dir = cwd();
    const agent = { session: { id: 'sub', header: { cwd: dir, origin: 'subagent' } } };
    assert.equal(host.contexts.get('grok-memory:snapshot').text({ agent }), '');
  });

  it('returns empty for a project with no memory yet', async () => {
    const { host } = await boot();
    const agent = agentFor(cwd());
    assert.equal(host.contexts.get('grok-memory:snapshot').text({ agent }), '');
  });
});

describe('plugin: lifecycle hooks', () => {
  it('writes one session summary on settle and never calls next', async () => {
    const { host, root } = await boot();
    const dir = cwd();
    const agent = agentFor(dir);
    agent.session.events = [
      { type: 'user/message', data: { role: 'user', content: 'first substantive prompt' } },
      { type: 'user/message', data: { role: 'user', content: 'second substantive prompt' } },
      { type: 'user/message', data: { role: 'user', content: 'third substantive prompt' } },
    ];
    await emit(host, 'agent/settled', agent, 1, 'completed');
    await emit(host, 'agent/settled', agent, 2, 'completed');
    // Exactly one summary per session, not one per settle.
    const { projectDir } = tracksFor(root, dir);
    const summaryFile = readFileSync(join(projectDir, 'sessions', `${new Date().toISOString().slice(0, 10)}.md`), 'utf8');
    assert.equal(summaryFile.split('## Session').length - 1, 1);
  });

  it('skips a trivial session', async () => {
    const { host, root } = await boot();
    const dir = cwd();
    const agent = agentFor(dir);
    agent.session.events = [{ type: 'user/message', data: { role: 'user', content: 'hi' } }];
    await emit(host, 'agent/settled', agent, 1, 'completed');
    const { projectDir } = tracksFor(root, dir);
    const file = join(projectDir, 'sessions', `${new Date().toISOString().slice(0, 10)}.md`);
    assert.equal(existsSync(file), false);
  });

  it('tolerates the real {turn,signal} payload without a next callback', async () => {
    const { host } = await boot();
    await emit(host, 'agent/turn-stopping', { turn: 1, signal: undefined });
  });

  it('survives a disposed agent with no session', async () => {
    const { host } = await boot();
    await emit(host, 'agent/disposed', { agent: undefined });
  });
});
