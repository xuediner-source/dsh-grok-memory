/**
 * Migration tests: splitting a v0.2 free-form MEMORY.md into v0.3 tracks.
 * These import the script's pure helpers directly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const migrate = await import(pathToFileURL(join(HERE, '..', 'scripts', 'migrate-v0.2.mjs')).href);

describe('migration: section splitting', () => {
  it('splits a v0.2 MEMORY.md into heading + body sections', () => {
    const md = [
      '',
      '## 项目定位与正式名称',
      '- 这是耐久结论',
      '',
      '## C 表的遗留问题与待办',
      '- 这是待办',
      '',
    ].join('\n');
    const sections = migrate.sectionsOf(md);
    assert.equal(sections.length, 2);
    assert.equal(sections[0].heading, '项目定位与正式名称');
    assert.match(sections[0].body, /耐久结论/);
    assert.equal(sections[1].heading, 'C 表的遗留问题与待办');
  });

  it('drops an empty section and tolerates a file with no headings', () => {
    assert.equal(migrate.sectionsOf('## Empty\n\n## Also empty\n').length, 0);
    assert.equal(migrate.sectionsOf('just a paragraph, no headings').length, 0);
  });
});

describe('migration: track classification', () => {
  it('routes durable conclusions to the injected key track', () => {
    assert.equal(migrate.trackForSection('项目定位与正式名称'), 'key');
    assert.equal(migrate.trackForSection('建模口径与核心结论'), 'key');
    assert.equal(migrate.trackForSection('政策法规证据台账'), 'key');
  });

  it('routes pending work items to the on-demand project track', () => {
    assert.equal(migrate.trackForSection('C 表的遗留问题与待办'), 'project');
    assert.equal(migrate.trackForSection('命名现状与同步待办'), 'project');
    assert.equal(migrate.trackForSection('Next steps'), 'project');
    assert.equal(migrate.trackForSection('TODO list'), 'project');
  });
});
