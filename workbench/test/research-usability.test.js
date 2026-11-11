const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ResearchLibrary, ASSET_FIELDS } = require('../src/research-store');

function setup(t) {
  const lib = new ResearchLibrary(':memory:');
  t.after(() => lib.close());
  for (const id of ['P1', 'P2']) lib.ensureProject({ id, name: id });
  return lib;
}
const saveAsset = (lib, title, project_id = 'P1') => lib.save('asset', { title, body_md: title }, { project_id });

test('unchanged asset and directory saves keep revisions, ordering and notices intact', (t) => {
  const lib = setup(t), a = saveAsset(lib, '一致估计');
  const map = lib.get(lib.resolveMap('project', 'P1'));
  const before = lib.db.prepare('SELECT * FROM record_order WHERE record_id IN (?,?) ORDER BY record_id').all(a.id, map.id);
  const events = []; lib.on('changed', (event) => events.push(event));
  assert.deepEqual(lib.save('asset', { ...a }, { expected_revision: a.revision, project_id: 'P1', actor: 'user' }), a);
  assert.deepEqual(lib.save('map', { id: map.id, title: map.title, body_md: map.body_md, entries: [], references: [] }, { expected_revision: map.revision, project_id: 'P1', actor: 'user' }), map);
  assert.deepEqual(lib.db.prepare('SELECT * FROM record_order WHERE record_id IN (?,?) ORDER BY record_id').all(a.id, map.id), before);
  assert.equal(lib.inbox('P1').notice_total, 0); assert.equal(events.length, 0);
  assert.equal(lib.history(a.id).total, 1); assert.equal(lib.history(map.id).total, 1);
  const changed = lib.save('asset', { id: a.id, body_md: '补充条件 U' }, { expected_revision: 1, project_id: 'P1', actor: 'user' });
  assert.equal(changed.revision, 2); assert.equal(lib.inbox('P1').notice_total, 1);
  assert.throws(() => lib.save('asset', { ...a }, { expected_revision: 1, project_id: 'P1', actor: 'user' }), /conflict/);
  assert.equal(lib.get(a.id).body_md, '补充条件 U');
});

test('unchanged project assessment saves do not request a review or create a version', (t) => {
  const lib = setup(t), a = saveAsset(lib, '独立成果'), events = [];
  lib.on('changed', (event) => events.push(event));
  const same = lib.saveProject('P1', { expected_revision: 1, body_md: '', outcomes: [] }, { actor: 'user' });
  assert.equal(same.unchanged, true); assert.equal(same.revision, 1);
  assert.equal(lib.projectHistory('P1').total, 0); assert.equal(lib.inbox('P1').notice_total, 0); assert.equal(events.length, 0);
  const changed = lib.saveProject('P1', { expected_revision: 1, body_md: '原目标未解决，有独立成果。', outcomes: [a.id] }, { actor: 'user' });
  assert.equal(changed.revision, 2); assert.equal(lib.inbox('P1').notice_total, 1);
  assert.equal(lib.saveProject('P1', { expected_revision: 2, body_md: changed.body_md, outcomes: [a.id, a.id] }, { actor: 'user' }).unchanged, true);
  assert.equal(lib.inbox('P1').notice_total, 1); assert.equal(lib.projectHistory('P1').total, 2); assert.equal(events.length, 1);
});

test('mixed atomic updates create revisions and review notices only for changed records', (t) => {
  const lib = setup(t), a = saveAsset(lib, '旧依据'), b = saveAsset(lib, '新判断');
  const context = { project_id: 'P1', actor: 'user' }, events = []; lib.on('changed', (event) => events.push(event));
  const same = lib.commit([{ id: a.id, expected_revision: 1, changes: { body_md: a.body_md } }, { id: b.id, expected_revision: 1, changes: {} }], context);
  assert.deepEqual(same, [a, b]); assert.equal(events.length, 0); assert.equal(lib.inbox('P1').notice_total, 0);
  const mixed = lib.commit([{ id: a.id, expected_revision: 1, changes: { title: a.title } }, { id: b.id, expected_revision: 1, changes: { body_md: '依赖已存的依据', references: [{ asset_id: a.id, revision: 1, relation: 'uses', note: '用作依据' }] } }], context);
  assert.deepEqual(mixed.map((item) => item.revision), [1, 2]);
  assert.equal(lib.inbox('P1').notice_total, 1); assert.equal(lib.inbox('P1').notices[0].target_id, b.id);
  assert.throws(() => lib.commit([{ id: a.id, expected_revision: 1, changes: {} }, { id: b.id, expected_revision: 2, changes: { references: [{ asset_id: a.id, revision: 2, relation: 'uses', note: '不存在的版本' }] } }], context), /Revision/);
  assert.equal(lib.get(a.id).revision, 1); assert.equal(lib.get(b.id).revision, 2);
});

test('map cards count shared placements independently of logical references', (t) => {
  const lib = setup(t), a = saveAsset(lib, '共用成果');
  lib.save('map', { title: '专题一', entries: [{ target_id: a.id, note: '' }] });
  lib.save('map', { title: '专题二', entries: [{ target_id: a.id, note: '' }] });
  lib.save('asset', { title: '引用者', references: [{ asset_id: a.id, revision: 1, relation: 'uses', note: '引用证明' }] });
  assert.equal(lib.card(a.id).locations_count, 2); assert.equal(lib.links({ asset_id: a.id, direction: 'incoming' }).total, 1);
});

test('directory counts distinguish project entrances, topics and assets across paginated entries', (t) => {
  const lib = setup(t), a = saveAsset(lib, '已保存但未放入目录'), borrowed = saveAsset(lib, '共用成果', 'P2');
  const project = lib.get(lib.resolveMap('project', 'P1'));
  assert.deepEqual(lib.readMap({ map_id: 'root', limit: 1 }).entry_counts, { projects: 2, topics: 0, assets: 0, archived: 0 });
  assert.equal(lib.readMap({ map_id: 'project' }, 'P1').project_assets_total, 1);
  assert.equal(lib.readMap({ map_id: 'project' }, 'P1').entry_count, 0);
  const topic = lib.save('map', { title: '专题', entries: [{ target_id: borrowed.id, note: '复用' }] });
  lib.save('map', { id: project.id, entries: [{ target_id: topic.id, note: '' }, { target_id: a.id, note: '' }] }, { expected_revision: project.revision });
  const page = lib.readMap({ map_id: project.id, limit: 1 });
  assert.equal(page.entries.length, 1);
  assert.deepEqual(page.entry_counts, { projects: 0, topics: 1, assets: 1, archived: 0 });
  assert.equal(page.project_assets_total, 2);
  assert.equal(lib.readMap({ map_id: project.id, revision: 1 }).entry_count, 0);
  lib.archive(topic.id, 1, true);
  assert.deepEqual(lib.readMap({ map_id: project.id }).entry_counts, { projects: 0, topics: 0, assets: 1, archived: 1 });
});

test('title and ID selection handles literal punctuation, pagination and accurate trash counts', (t) => {
  const lib = setup(t), records = Array.from({ length: 35 }, (_, i) => saveAsset(lib, '共同标题 ' + i));
  const literal = saveAsset(lib, '100%_条件');
  assert.equal(lib.list({ kind: 'asset', query: '%' }).total, 1);
  assert.equal(lib.list({ kind: 'asset', query: literal.id.toLowerCase() }).items[0].id, literal.id);
  let page = lib.list({ kind: 'asset', query: '共同标题', limit: 30 });
  assert.equal(page.total, 35); assert.equal(page.next_offset, 30);
  assert.equal(lib.list({ kind: 'asset', query: '共同标题', offset: page.next_offset }).items.length, 5);
  lib.archive(records[0].id, 1, true); lib.archive(records[1].id, 1, true);
  assert.equal(lib.list({ kind: 'asset', archived_only: true }).total, 2);
  assert.equal(lib.list({ kind: 'asset', query: '共同标题' }).total, 33);
  assert.equal(lib.list({ kind: 'asset', query: '共同标题', include_archived: true }).total, 35);
});

test('removing a directory entrance and deleting a topic preserve assets, links and restoration', (t) => {
  const lib = setup(t), a = saveAsset(lib, '独立资产');
  const map = lib.save('map', { title: '唯一目录', entries: [{ target_id: a.id, note: '' }] });
  const dependent = lib.save('asset', { title: '使用原结论', references: [{ asset_id: a.id, revision: 1, relation: 'uses', note: '使用这版条件' }] });
  assert.ok(!lib.list({ unmapped: true }).items.some((item) => item.id === a.id));
  lib.archive(map.id, 1, true);
  assert.ok(lib.list({ unmapped: true }).items.some((item) => item.id === a.id));
  assert.equal(lib.get(map.id).entries[0].target_id, a.id);
  lib.archive(map.id, 2, false);
  assert.ok(!lib.list({ unmapped: true }).items.some((item) => item.id === a.id));
  lib.save('map', { id: map.id, entries: [] }, { expected_revision: 3 });
  assert.equal(lib.get(a.id).revision, 1);
  lib.archive(a.id, 1, true);
  assert.equal(lib.read({ asset_id: dependent.id }).reference_records[0].archived, true);
  assert.equal(lib.get(a.id, 1).title, '独立资产');
  lib.archive(a.id, 2, false);
  assert.equal(lib.links({ asset_id: a.id, direction: 'incoming' }).items[0].source_id, dependent.id);
});

test('resolved reference titles use the pinned version without changing the seven-field asset format', (t) => {
  const lib = setup(t), a = saveAsset(lib, '原始标题');
  const report = lib.addReport({ project_id: 'P1', run_id: 'run', agent_id: 'worker', title: '详细原始汇报', body_md: '证明' }, 'title-report');
  const dependent = lib.save('asset', { title: '后续结论', source_reports: [report.id], references: [
    { asset_id: a.id, revision: 1, relation: 'uses', note: '使用旧版' },
    { asset_id: a.id, revision: 1, relation: 'related', note: '另一联系' }
  ] });
  lib.save('asset', { id: a.id, title: '新标题' }, { expected_revision: 1 });
  const read = lib.read({ asset_id: dependent.id });
  assert.equal(read.reference_records.length, 2);
  assert.equal(read.reference_records[0].title, '原始标题');
  assert.equal(read.reference_records[0].revision, 1);
  assert.equal(read.source_report_records[0].title, '详细原始汇报');
  assert.deepEqual(Object.keys(read.record), ASSET_FIELDS);
  assert.deepEqual(JSON.parse(lib.exportRecord(dependent.id).content), dependent);
});
