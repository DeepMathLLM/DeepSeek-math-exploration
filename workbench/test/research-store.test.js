const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ResearchLibrary, ASSET_FIELDS } = require('../src/research-store');

function library(t) { const lib = new ResearchLibrary(':memory:'); t.after(() => lib.close()); return lib; }
const asset = (lib, title = '紧性与一致估计', body = '在紧性条件下成立；推广尚未完成。', project = 'P1') => lib.save('asset', { title, body_md: body }, { project_id: project });
const ref = (record, note = '此估计用于控制误差', relation = 'uses') => ({ asset_id: record.id, revision: record.revision, relation, note });
const revise = (lib, doc, changes, context = {}) => lib.save(lib.row(doc.id).kind, { id: doc.id, ...changes }, { expected_revision: doc.revision, project_id: 'P1', ...context });

test('asset exports have exactly the requested seven fields and retain precise source reports', (t) => {
  const lib = library(t); lib.ensureProject({ id: 'P1', name: '初始问题' });
  const report = lib.addReport({ project_id: 'P1', run_id: 'run1', agent_id: 'worker', body_md: '详细证明\n独立发现：猜想 C 成立。', title: '目标尚未解决，但已证 C' }, 'report1');
  const a = lib.save('asset', { title: '猜想 C 的证明', body_md: '在假设 U 下已证 C，原问题仍未解决。', source_reports: [report.id] }, { project_id: 'P1' });
  assert.deepEqual(Object.keys(a), ASSET_FIELDS);
  assert.deepEqual(JSON.parse(lib.exportRecord(a.id).content), a);
  lib.processReport('P1', { report_id: report.id, disposition: 'integrated', note: '独立成果保留；目标仍未解决', asset_ids: [a.id] });
  const assessment = lib.saveProject('P1', { expected_revision: 1, body_md: '原始目标未解；已证猜想 C。', outcomes: [a.id] });
  assert.equal(assessment.pending, 0); assert.equal(assessment.outcomes[0].id, a.id);
  assert.equal(lib.get(report.id).body_md, '详细证明\n独立发现：猜想 C 成立。');
  assert.throws(() => revise(lib, report, { body_md: '覆盖汇报' }), /not found/);
  assert.throws(() => asset(lib, ''), /title/);
});

test('reference versions, multiple connections and reverse links resolve without rewriting historical evidence', (t) => {
  const lib = library(t); const a = asset(lib), b = asset(lib, '一个推广障碍');
  const c = lib.save('asset', { title: '路线二', references: [ref(a), ref(b, '与障碍相对应', 'related'), ref(a, '另一处使用')] });
  const updated = revise(lib, a, { body_md: '估计需要额外条件 U。先前版本遗漏此条件。' });
  assert.equal(lib.get(a.id, 1).body_md, a.body_md);
  assert.equal(lib.get(c.id).references[0].revision, 1);
  assert.equal(lib.read({ asset_id: c.id }).warnings.length, 2);
  assert.equal(lib.links({ asset_id: a.id, direction: 'incoming' }).total, 2);
  assert.equal(lib.get(c.id).revision, 1); // An update is not a semantic invalidation.
  assert.throws(() => revise(lib, updated, { references: [ref({ id: 'A999999', revision: 1 })] }), /target/);
  assert.throws(() => revise(lib, updated, { references: [ref({ id: b.id, revision: 99 })] }), /Revision/);
});

test('atomic edits support references to other new batch versions and roll back invalid dependencies', (t) => {
  const lib = library(t), a = asset(lib), b = asset(lib, '推广');
  const saved = lib.commit([{ id: a.id, expected_revision: 1, changes: { body_md: '加强条件得到新结论' } },
    { id: b.id, expected_revision: 1, changes: { references: [ref({ id: a.id, revision: 2 })] } }]);
  assert.equal(saved[1].references[0].revision, 2);
  assert.throws(() => lib.commit([{ id: a.id, expected_revision: 2, changes: { body_md: '不应写入' } },
    { id: b.id, expected_revision: 2, changes: { references: [ref({ id: a.id, revision: 999 })] } }]), /Revision/);
  assert.equal(lib.get(a.id).revision, 2); assert.equal(lib.get(b.id).revision, 2);
  assert.throws(() => revise(lib, a, { title: '过期编辑' }), /conflict/);
});

test('maps permit shared parallel assets and reject containment cycles without changing the library', (t) => {
  const lib = library(t), a = asset(lib);
  const m1 = lib.save('map', { title: '分析路线', entries: [{ target_id: a.id, note: '估计' }] });
  const m2 = lib.save('map', { title: '独立项目路线', entries: [{ target_id: a.id, note: '复用同一结论' }, { target_id: m1.id, note: '分析区域' }] });
  assert.equal(lib.get(a.id).parent_id, undefined);
  assert.throws(() => revise(lib, m1, { entries: [{ target_id: m2.id, note: '' }] }), /cycle/);
  assert.equal(lib.get(m1.id).revision, 1);
  assert.equal(lib.readMap({ map_id: m2.id, depth: 2 }).entries[1].expanded.entries[0].target.id, a.id);
});

test('large maps and full inventories paginate explicitly and expansion stays bounded', (t) => {
  const lib = library(t), entries = [];
  for (let i = 0; i < 230; i++) entries.push({ target_id: asset(lib, `资产 ${i}`).id, note: '' });
  const map = lib.save('map', { title: '较大项目', entries });
  let page = lib.readMap({ map_id: map.id, limit: 30 }), ids = page.entries.map((e) => e.target_id);
  assert.equal(page.record.entries, undefined); assert.equal(page.entry_count, 230);
  while (page.next_entry_offset !== null) { page = lib.readMap({ map_id: map.id, limit: 30, entry_offset: page.next_entry_offset }); ids.push(...page.entries.map((e) => e.target_id)); }
  assert.equal(new Set(ids).size, 230);
  let directory = lib.list({ kind: 'asset', limit: 100 }), count = directory.items.length;
  while (directory.next_offset !== null) { directory = lib.list({ kind: 'asset', limit: 100, offset: directory.next_offset }); count += directory.items.length; }
  assert.equal(count, 230);
  const regions = Array.from({ length: 12 }, (_, i) => lib.save('map', { title: `区域 ${i}`, entries }));
  const root = lib.save('map', { title: '展开测试', entries: regions.map((r) => ({ target_id: r.id, note: '' })) });
  const expanded = lib.readMap({ map_id: root.id, depth: 4, limit: 100 });
  assert.ok(expanded.entries.some((e) => e.expansion_deferred));
  assert.ok(JSON.stringify(expanded).length < 150000);
});

test('body and section reads preserve exact versions and never silently claim a fragment is complete', (t) => {
  const lib = library(t), a = asset(lib, '长证明', '# 引理\n' + '中'.repeat(90000) + '\n## 推广\n未解');
  let page = lib.read({ asset_id: a.id }), body = page.record.body_md;
  assert.equal(page.reading.complete, false);
  while (page.reading.next_offset !== null) { page = lib.read({ asset_id: a.id, revision: 1, offset: page.reading.next_offset }); body += page.record.body_md; }
  assert.equal(body, a.body_md);
  assert.throws(() => lib.read({ asset_id: a.id, section_id: 's2' }), /revision/);
  assert.match(lib.read({ asset_id: a.id, revision: 1, section_id: 's2' }).record.body_md, /未解/);
  assert.equal(lib.read({ asset_id: a.id, known_revision: 1 }).unchanged, true);
  assert.equal(lib.read({ asset_id: a.id, known_revision: 1, force: true }).record.id, a.id);
});

test('Chinese terms, literal formulas and alternative queries retrieve candidates honestly', (t) => {
  const lib = library(t), a = asset(lib, '紧性条件下的一致估计', '由 x^2+y^2≤1 得到界；失败路径需要紧性。');
  assert.ok(lib.search({ query: '一致估计' }).items.some((r) => r.id === a.id));
  assert.ok(lib.search({ query: 'x^2+y^2≤1' }).items.some((r) => r.id === a.id));
  assert.ok(lib.search({ query: '不存在的词', queries: ['紧性'] }).items.some((r) => r.id === a.id));
  assert.equal(lib.search({ query: '紧性' }).retrieval, 'lexical_fts_and_literal');
});

test('change notices reach affected project controllers, including transitive dependencies, without semantic status changes', (t) => {
  const lib = library(t); for (const id of ['P1', 'P2', 'P3']) lib.ensureProject({ id, name: id });
  const a = asset(lib), b = lib.save('asset', { title: 'P2 推论', references: [ref(a)] }, { project_id: 'P2' });
  const c = lib.save('asset', { title: 'P3 后续工作', references: [ref(b)] }, { project_id: 'P3' });
  revise(lib, a, { body_md: '新条件 U' }, { actor: 'controller' });
  assert.equal(lib.inbox('P1').notice_total, 0);
  assert.equal(lib.inbox('P2').notice_total, 1); assert.equal(lib.inbox('P3').notice_total, 1);
  assert.equal(lib.get(b.id).revision, 1); assert.equal(lib.get(c.id).revision, 1);
  const notice = lib.inbox('P2').notices[0];
  assert.throws(() => lib.resolveNotices('P1', [notice.id], '核查'), /belong/);
  lib.resolveNotices('P2', [notice.id], '推论仍成立，但须补充 U；另行维护正文');
  assert.equal(lib.inbox('P2').notice_total, 0);
});

test('archive and restore preserve history and exact citations, while inventory excludes archived records by default', (t) => {
  const lib = library(t), a = asset(lib), b = lib.save('asset', { title: '引用', references: [ref(a)] });
  lib.archive(a.id, 1, true);
  assert.equal(lib.list({ kind: 'asset' }).total, 1);
  assert.equal(lib.read({ asset_id: a.id, revision: 1 }).record.body_md, a.body_md);
  assert.equal(lib.get(b.id).references[0].asset_id, a.id);
  lib.archive(a.id, 2, false); assert.equal(lib.list({ kind: 'asset' }).total, 2);
  assert.equal(lib.history(a.id).total, 3);
});

test('delivery and disposition are independent; integrated reports must have traceable resulting assets', (t) => {
  const lib = library(t), r = lib.addReport({ project_id: 'P1', run_id: 'r', agent_id: 'w', body_md: '失败探索也需要保存', title: '失败路径' }, 'k');
  lib.markSeen([r.id]); assert.equal(lib.inbox('P1').total, 1);
  lib.processReport('P1', { report_id: r.id, disposition: 'deferred', note: '待核查' });
  assert.equal(lib.inbox('P1').total, 1);
  const a = asset(lib);
  assert.throws(() => lib.processReport('P1', { report_id: r.id, disposition: 'integrated', asset_ids: [a.id], note: '已整合' }), /source_reports/);
  revise(lib, a, { source_reports: [r.id] });
  lib.processReport('P1', { report_id: r.id, disposition: 'integrated', asset_ids: [a.id], note: '保存该失败障碍' });
  assert.equal(lib.inbox('P1').total, 0);
  assert.equal(lib.addReport({ body_md: '重试' }, 'k').id, r.id);
});

test('SQLite reopen retains IDs, revisions, raw reports and map structure', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepmath-v3-db-')), file = path.join(dir, 'research.sqlite');
  let second;
  t.after(() => { second?.close(); const resolved = path.resolve(dir); assert.equal(path.dirname(resolved), path.resolve(os.tmpdir())); fs.rmSync(resolved, { recursive: true, force: true }); });
  const first = new ResearchLibrary(file); const a = asset(first); const m = first.save('map', { title: '区域', entries: [{ target_id: a.id, note: '已知' }] });
  revise(first, a, { title: '更准确的表述' }); first.close();
  second = new ResearchLibrary(file);
  assert.equal(second.get(a.id).revision, 2); assert.equal(second.get(a.id, 1).title, a.title);
  assert.equal(second.readMap({ map_id: m.id }).entries[0].target.title, '更准确的表述');
  assert.notEqual(asset(second).id, a.id);
});

test('borrowed assets appear in project scope and changes are visible even within the same millisecond', (t) => {
  const lib = library(t); lib.ensureProject({ id: 'P2', name: '另一项目' });
  const a = asset(lib), m = lib.get(lib.resolveMap('project', 'P2'));
  const placed = revise(lib, m, { body_md: '基于当前估计制定计划', entries: [{ target_id: a.id, note: '跨项目复用' }] }, { project_id: 'P2' });
  assert.ok(lib.list({ kind: 'asset', project_id: 'P2' }).items.some((item) => item.id === a.id));
  assert.ok(lib.search({ query: '紧性', project_id: 'P2' }).items.some((item) => item.id === a.id));
  revise(lib, a, { body_md: '新条件 U' });
  assert.equal(lib.coverage(placed.id).descendants_changed_since_map_save, 1);
  const navOnly = revise(lib, placed, { entries: placed.entries });
  assert.equal(lib.coverage(navOnly.id).descendants_changed_since_map_save, 1);
  revise(lib, navOnly, { body_md: '已检查新条件 U，调整计划' });
  assert.equal(lib.coverage(navOnly.id).descendants_changed_since_map_save, 0);
});

test('project assessments retain readable versions and independent outcomes', (t) => {
  const lib = library(t); lib.ensureProject({ id: 'P1', name: '长期研究' }); const a = asset(lib);
  lib.saveProject('P1', { expected_revision: 1, body_md: '目标尚未解决，保存独立成果', outcomes: [a.id] });
  lib.saveProject('P1', { expected_revision: 2, body_md: '新证据要求增加条件 U' });
  assert.match(lib.readProject('P1', 2).body_md, /目标尚未解决/);
  assert.match(lib.readProject('P1').body_md, /条件 U/);
  assert.equal(lib.projectHistory('P1').total, 3);
});

test('immutable evidence survives source edits and detects saved-byte corruption', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepmath-v3-evidence-'));
  const workspace = path.join(dir, 'workspace'); fs.mkdirSync(workspace);
  const source = path.join(workspace, 'calculation.txt'); fs.writeFileSync(source, '原始计算：界为 N');
  const lib = new ResearchLibrary(path.join(dir, 'research.sqlite'));
  t.after(() => { lib.close(); assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true }); });
  const evidence = lib.snapshotEvidence('P1', workspace, [{ path: 'calculation.txt' }]);
  const report = lib.addReport({ project_id: 'P1', agent_id: 'worker', run_id: 'run', body_md: '已计算', evidence }, 'evidence-test');
  fs.writeFileSync(source, '后来重写：界为 2N');
  const saved = lib.readEvidence({ evidence_id: report.evidence[0].evidence_id });
  assert.equal(saved.content, '原始计算：界为 N');
  assert.notEqual(lib.snapshotEvidence('P1', workspace, [{ path: 'calculation.txt' }])[0].evidence_id, evidence[0].evidence_id);
  fs.writeFileSync(path.join(dir, 'outside.txt'), '不应保存');
  assert.throws(() => lib.snapshotEvidence('P1', workspace, [{ path: '../outside.txt' }]), { statusCode: 403 });
  assert.equal(saved.file_path, undefined);
  fs.writeFileSync(path.join(dir, 'evidence', saved.sha256), '被改变的字节');
  assert.throws(() => lib.readEvidence({ evidence_id: evidence[0].evidence_id }), /integrity/);
});

test('logical reference cycles terminate change tracking without certifying any conclusion', (t) => {
  const lib = library(t), a = asset(lib), b = lib.save('asset', { title: '观察 B', references: [ref(a)] }, { project_id: 'P2' });
  revise(lib, a, { references: [ref(b, '两个观察的待检验联系')] });
  assert.equal(lib.get(b.id).revision, 1); assert.equal(lib.inbox('P2').notice_total, 1);
  assert.equal(lib.get(a.id).status, undefined);
});

test('assets expose paginated current map placements independently of historical research content', (t) => {
  const lib = library(t), a = asset(lib);
  for (let i = 0; i < 35; i++) lib.save('map', { title: `相关区域 ${i}`, entries: [{ target_id: a.id, note: '共同使用同一资产' }] });
  const first = lib.read({ asset_id: a.id, revision: 1 });
  assert.equal(first.locations.total, 35); assert.equal(first.locations.items.length, 30);
  const next = lib.read({ asset_id: a.id, revision: 1, known_revision: 1, location_offset: first.locations.next_offset });
  assert.equal(next.unchanged, true); assert.equal(next.locations.items.length, 5); assert.equal(next.locations.next_offset, null);
  assert.deepEqual(Object.keys(first.record), ASSET_FIELDS);
});
