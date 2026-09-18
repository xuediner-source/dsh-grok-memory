/**
 * Test harness for dsh-grok-memory.
 *
 * The plugin entry imports `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-tools`,
 * which the DSH runtime supplies at load time and are not installed here. The
 * harness materialises minimal stand-ins under test/.stubs and imports the
 * real plugin bundle through them.
 *
 * It also provides a Cordis-like host: a real DSH host merges injected
 * services onto the plugin's own ctx, so the mock exposes commands / tools /
 * systemPrompt / on / effect as ctx properties.
 */
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const STUBS = join(HERE, '.stubs');

const STUB_SOURCES = {
  schemastery: `
const chain = () => { const o = {}; o.default = () => o; o.required = () => o; o.min = () => o; o.max = () => o; o.step = () => o; return o; };
const z = () => chain();
z.object = (shape) => { const o = { shape }; o.default = () => o; return o; };
z.string = () => chain();
z.boolean = () => chain();
z.number = () => chain();
z.array = () => chain();
z.union = () => chain();
z.const = () => chain();
z.natural = () => chain();
export default z;
`,
  'dsh-tools': `export const defineTool = (tool) => {
  // Mirror DSH: defineTool reads options.output.render unguarded.
  const userRender = tool.output.render;
  if (typeof userRender !== 'function') throw new TypeError('tool must declare output.render');
  return tool;
};
`,
};

export function ensureStubs() {
  const nm = join(STUBS, 'node_modules', '@deepseek-ai');
  try { rmSync(nm, { recursive: true, force: true }); } catch { /* first run */ }
  mkdirSync(nm, { recursive: true });
  for (const [name, source] of Object.entries(STUB_SOURCES)) {
    const dir = join(nm, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`, version: '0.0.0', type: 'module', main: 'index.js', exports: { '.': './index.js' } }));
    writeFileSync(join(dir, 'index.js'), source);
  }
  return STUBS;
}

/** Import the real plugin entry through the stub tree. */
export async function loadPlugin() {
  const root = ensureStubs();
  const copy = join(root, 'index.mjs');
  const src = join(ROOT, 'lib', 'index.js');
  // rewrite relative imports so the copy resolves against the plugin's lib/
  const text = readFileSync(src, 'utf8')
    .replace(/from '\.\/(store|search|dream|inject)\.js'/g, (m, f) => `from ${JSON.stringify(pathToFileURL(join(ROOT, 'lib', `${f}.js`)).href)}`);
  writeFileSync(copy, text);
  return import(`${pathToFileURL(copy).href}?t=${Date.now()}`);
}

/** Import one pure module directly (no stubs needed). */
export async function loadLib(moduleName) {
  return import(pathToFileURL(join(ROOT, 'lib', `${moduleName}.js`)).href);
}

/** A Cordis-like host that records registrations and delivers events. */
export function makeHost() {
  const host = {
    commands: new Map(),
    tools: new Map(),
    sections: new Map(),
    contexts: new Map(),
    listeners: new Map(),
    logs: [],
  };
  const ctx = {
    logger: {
      info: (m) => host.logs.push(`info:${m}`),
      warn: (m) => host.logs.push(`warn:${m}`),
    },
    commands: { register: (def) => { host.commands.set(def.name, def); return () => host.commands.delete(def.name); } },
    tools: { register: (tool) => { host.tools.set(tool.name, tool); return () => host.tools.delete(tool.name); } },
    systemPrompt: {
      section: (s) => { host.sections.set(s.name, s); return () => host.sections.delete(s.name); },
      context: (c) => { host.contexts.set(c.name, c); return () => host.contexts.delete(c.name); },
    },
    on: (event, handler) => { if (!host.listeners.has(event)) host.listeners.set(event, []); host.listeners.get(event).push(handler); },
    effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; },
    get: () => undefined,
  };
  return { ctx, host };
}

/**
 * Fire a registered hook exactly the way cordis does.
 *
 * Verified host contract (@deepseek-ai/cordis lib/index.js `dispatch` +
 * `serial`): listeners receive ONLY positional arguments — the event name is
 * shifted off, then `cb(...args)` runs with the payload. There is NO waterfall
 * `next` callback. The previous harness passed a synthetic `next` into every
 * listener, which masked a real crash ("next is not a function") that broke
 * the turn loop inside the live host.
 */
export async function emit(host, event, ...args) {
  const handlers = host.listeners.get(event) ?? [];
  let out;
  for (const h of handlers) out = await h(...args);
  return out;
}
