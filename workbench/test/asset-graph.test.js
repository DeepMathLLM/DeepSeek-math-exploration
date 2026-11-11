const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ResearchLibrary } = require('../src/research-store');
const { layout, trace, projectGroups, groupConnections, mergeEdges, bundleEdges, findAssets, extendRoute, directGraph, routeGraph, routeConnections } = require('../public/asset-graph');

test('selecting a next node finds the actual connection to the route and route-only views contain only chosen segments', () => {
  const e1={source:'A',source_revision:1,target:'B',target_revision:1,note:'旧版'}, e2={...e1,source_revision:2,note:'新版'};
  const e3={source:'B',source_revision:1,target:'C',target_revision:1,note:'后续'};
  const data={nodes:['A','B','C','D'].map((id)=>({id})),edges:[e1,e2,e3,{source:'A',source_revision:1,target:'C',target_revision:1,note:'另一种关系'}]};
  let route={nodes:[{id:'A',revision:null}],steps:[]};
  const choices=routeConnections(data,route,'B'); assert.equal(choices.variants.length,2); assert.equal(choices.anchor.id,'A');
  assert.equal(routeConnections(data,route,'D'),null);
  route=extendRoute(route,choices.variants[0],choices.anchor.id,choices.index);
  const next=routeConnections(data,route,'C'); assert.equal(next.anchor.id,'B'); assert.equal(next.variants.length,1);
  route=extendRoute(route,next.variants[0],next.anchor.id,next.index);
  const only=routeGraph(data,route);
  assert.deepEqual(only.nodes.map((n)=>n.id),['A','B','C']);
  assert.equal(only.edges.length,2); assert.ok(!only.edges.some((edge)=>edge.source==='A'&&edge.target==='C'));
  assert.equal(only.edges[0].source_revision,1);
  const branch=routeConnections(data,{nodes:[{id:'A',revision:1},{id:'B',revision:1}],steps:[route.steps[0]]},'C',null,0);
  assert.equal(branch.anchor.id,'A'); assert.equal(branch.index,0);
});

test('direct-only views omit every unrelated node, indirect hop and wrong-version relation', () => {
  const data = { nodes:['A','B','C','D','E'].map((id)=>({id})), edges:[
    {source:'A',source_revision:1,target:'B',target_revision:2},
    {source:'A',source_revision:2,target:'C',target_revision:1},
    {source:'B',source_revision:2,target:'D',target_revision:1},
  ] };
  assert.deepEqual(directGraph(data,'A',1).nodes.map((n)=>n.id),['A','B']);
  assert.equal(directGraph(data,'A',1).edges.length,1);
  assert.deepEqual(directGraph(data,'A').nodes.map((n)=>n.id),['A','B','C']);
  assert.deepEqual(directGraph(data,'B').nodes.map((n)=>n.id),['A','B','D']);
  assert.deepEqual(directGraph(data,'E').nodes.map((n)=>n.id),['E']);
  assert.equal(data.nodes.length,5); assert.equal(data.edges.length,3);
});

test('routes retain exact versions, mark version changes and replace a branch only when explicitly extended', () => {
  const edge = (source, source_revision, target, target_revision) => ({ source, source_revision, target, target_revision, note: '用途' });
  const empty = { nodes: [], steps: [] };
  const first = extendRoute(empty, edge('A',1,'B',2));
  const second = extendRoute(first, edge('B',3,'C',1), 'B');
  assert.equal(first.steps.length, 1); assert.equal(second.steps.length, 2);
  assert.equal(second.steps[1].switched, true);
  assert.equal(second.nodes[1].revision, 2); assert.equal(second.steps[1].from.revision, 3);
  const branch = extendRoute(second, edge('B',2,'D',4), 'B');
  assert.deepEqual(branch.nodes.map((node) => node.id), ['A','B','D']);
  assert.equal(branch.steps[1].switched,false);
  assert.deepEqual(second.nodes.map((node) => node.id), ['A','B','C']);
  const upstream = extendRoute(empty, edge('A',1,'B',2),'B');
  assert.equal(upstream.steps[0].forward,false); assert.equal(upstream.nodes[1].id,'A');
  assert.throws(() => extendRoute(first,edge('X',1,'Y',1),'X'), /请选择|所选节点/);
  const cycle = extendRoute(first,edge('B',2,'A',1),'B');
  const reroute = extendRoute(cycle,edge('A',1,'D',1),'A',0);
  assert.deepEqual(reroute.nodes.map((node) => node.id),['A','D']);
});

test('all-version graphs and direct views retain historical uses while exact-version filtering stays precise', (t) => {
  const lib = setup(t), c = save(lib, '旧依据'), a1 = save(lib, '中间结果', [ref(c)]);
  const b1 = save(lib, '后续研究', [ref(a1)]);
  const a2 = lib.save('asset', { id: a1.id, title: '修订结果', references: [] }, { expected_revision: 1 });
  lib.save('asset', { id: b1.id, references: [ref(a2)] }, { expected_revision: 1 });
  const all = lib.assetGraph({ project_id: 'P1', all_versions: true });
  assert.equal(all.nodes.filter((n) => n.id === a1.id).length, 1);
  assert.equal(all.edges.length, 3);
  assert.deepEqual(trace(all, a1.id, null).nodes, new Set([a1.id, c.id, b1.id]));
  assert.deepEqual(trace(all, a1.id, 2).nodes, new Set([a1.id, b1.id]));
  const direct = lib.assetGraph({ project_id: 'P1', asset_id: a1.id, all_versions: true });
  assert.equal(direct.focus.revision, null); assert.equal(direct.edges.length, 3);
  const v1 = lib.assetGraph({ asset_id: a1.id, revision: 1, all_versions: true });
  assert.equal(v1.edges.length, 2); assert.ok(v1.edges.some((e) => e.target === b1.id && e.target_revision === 1));
  const bundles = bundleEdges(all.edges);
  assert.equal(bundles.length, 2); assert.equal(bundles.find((e) => e.source === a1.id).variants.length, 2);
});

test('title fragments, partial digits and abbreviated IDs return all matching assets', (t) => {
  const nodes = [{ id: 'A000072', title: 'Haar stability' }, { id: 'A000172', title: 'Boundary stability' }, { id: 'A000073', title: 'Other result' }];
  assert.equal(findAssets(nodes, '72').length, 2);
  assert.equal(findAssets(nodes, 'stability').length, 2);
  assert.equal(findAssets(nodes, 'a72')[0].id, 'A000072');
  assert.equal(findAssets(nodes, '').length, 0);
  const lib = setup(t);
  for (let i=0; i<25; i++) save(lib, `资产 ${i}`);
  const expected = lib.list({ kind: 'asset', limit: 100 }).items.filter((n) => n.id.includes('2') || n.title.includes('2'));
  assert.equal(lib.list({ kind: 'asset', query: '2', limit: 100 }).total, expected.length);
  assert.ok(lib.list({ kind: 'asset', query: 'a1' }).items.some((n) => n.id === 'A000001'));
});

function setup(t) {
  const lib = new ResearchLibrary(':memory:'); t.after(() => lib.close());
  lib.ensureProject({ id: 'P1', name: '项目一' }); lib.ensureProject({ id: 'P2', name: '项目二' });
  return lib;
}
const save = (lib, title, references = [], project_id = 'P1') => lib.save('asset', { title, references }, { project_id });
const ref = (doc, relation = 'uses', note = '使用其结论') => ({ asset_id: doc.id, revision: doc.revision, relation, note });

test('project graph is complete across pages, includes unplaced and shared assets, and preserves read-only state', (t) => {
  const lib = setup(t), a = save(lib, '旧标题', [], 'P2');
  const a2 = lib.save('asset', { id: a.id, title: '新标题' }, { expected_revision: 1 });
  const b = save(lib, '后续成果', [ref(a), ref(a2, 'uses', '第二个用途')]);
  save(lib, '仅相关', [ref(a, 'related')]);
  const unrelated = save(lib, '项目外无关', [], 'P2');
  const topic = lib.save('map', { title: '方向一', entries: [{ target_id: b.id, note: '' }, { target_id: a.id, note: '' }] });
  const topic2 = lib.save('map', { title: '方向二', entries: [{ target_id: b.id, note: '' }] });
  const map = lib.get(lib.resolveMap('project', 'P1'));
  lib.save('map', { id: map.id, references: [ref(a)], entries: [topic, topic2].map((d) => ({ target_id: d.id, note: '' })) }, { expected_revision: map.revision });
  for (let i = 0; i < 145; i++) save(lib, `独立节点 ${i}`);
  lib.saveProject('P1', { expected_revision: 1, outcomes: [b.id], body_md: '有成果，目标尚未完成' });
  const before = lib.db.prepare('SELECT * FROM records ORDER BY id').all();
  const graph = lib.assetGraph({ project_id: 'P1' });
  assert.equal(graph.nodes.length, 148); assert.equal(graph.edges.length, 2);
  assert.equal(graph.nodes.filter((n) => n.id === b.id).length, 1);
  assert.ok(!graph.nodes.some((n) => n.id === unrelated.id));
  assert.equal(graph.nodes.find((n) => n.id === a.id).external, false); // Shared by directory membership.
  assert.equal(graph.nodes.find((n) => n.id === b.id).outcome, true);
  assert.deepEqual(graph.nodes.find((n) => n.id === a.id).versions, [1, 2]);
  assert.deepEqual(graph.edges.map((e) => [e.source, e.source_revision, e.target, e.target_revision]), [[a.id, 1, b.id, 1], [a.id, 2, b.id, 1]]);
  assert.equal(graph.edges[0].source_title, '旧标题'); assert.equal(graph.edges[1].source_title, '新标题');
  assert.deepEqual(graph.topics.map((topic) => topic.asset_ids.includes(b.id)), [true, true]);
  assert.deepEqual(lib.db.prepare('SELECT * FROM records ORDER BY id').all(), before);
  assert.equal(new Set(projectGroups(graph).flatMap((group) => group.nodes.map((n) => n.id))).size, graph.nodes.length);
});

test('external prerequisites and archived cited versions remain reachable without including unrelated outside assets', (t) => {
  const lib = setup(t), a = save(lib, '外部依据', [], 'P2'), b = save(lib, '本项目结果', [ref(a)]);
  lib.archive(a.id, 1, true);
  const graph = lib.assetGraph({ project_id: 'P1' });
  assert.equal(graph.nodes.length, 2); assert.equal(graph.edges.length, 1);
  assert.equal(graph.nodes.find((n) => n.id === a.id).archived, true);
  assert.equal(graph.nodes.find((n) => n.id === a.id).external, true);
  assert.equal(graph.edges[0].source_revision, 1);
  assert.equal(graph.edges[0].target, b.id);
});

test('historical focus reads its actual prerequisites and filters incoming references by exact version and asset kind', (t) => {
  const lib = setup(t), a = save(lib, '依据'), b = save(lib, '中间结论', [ref(a)]);
  const b2 = lib.save('asset', { id: b.id, references: [] }, { expected_revision: 1 });
  const c = save(lib, '依赖旧版', [ref(b)]), d = save(lib, '依赖新版', [ref(b2)]);
  save(lib, '仅相关', [ref(b, 'related')]);
  lib.save('map', { title: '概况', references: [ref(b)] });
  const old = lib.assetGraph({ project_id: 'P1', asset_id: b.id, revision: 1 });
  assert.equal(old.focus.revision, 1);
  assert.deepEqual(new Set(old.nodes.map((n) => n.id)), new Set([a.id, b.id, c.id]));
  assert.deepEqual(old.edges.map((e) => [e.source, e.source_revision, e.target, e.target_revision]), [[a.id, 1, b.id, 1], [b.id, 1, c.id, 1]]);
  const current = lib.assetGraph({ asset_id: b.id });
  assert.equal(current.edges.length, 1); assert.equal(current.edges[0].target, d.id);
  assert.throws(() => lib.assetGraph({ asset_id: b.id, revision: 999 }), /Revision/);
  assert.equal(lib.assetGraph({ project_id: 'P1' }).focus, null); // Failed snapshot rolls back cleanly.
});

test('upstream and downstream highlighting never crosses between versions of the same asset', () => {
  const graph = { edges: [
    { source: 'A', source_revision: 1, target: 'B', target_revision: 2 },
    { source: 'B', source_revision: 3, target: 'C', target_revision: 1 },
    { source: 'B', source_revision: 2, target: 'D', target_revision: 4 }
  ] };
  assert.deepEqual(trace(graph, 'A', 1).nodes, new Set(['A', 'B', 'D']));
  assert.deepEqual(trace(graph, 'C', 1).nodes, new Set(['C', 'B']));
});

test('complete paths through the selected version exclude bypasses, sibling branches and other inputs of later results', () => {
  const edge = (source, target, source_revision=1, target_revision=1) => ({ source, target, source_revision, target_revision });
  const paths = [edge('S','B'), edge('B','X'), edge('X','D'), edge('D','T'), edge('S2','X'), edge('X','T2')];
  const other = [edge('S','Q'), edge('Q','T'), edge('B','D'), edge('R','D'), edge('D','T',2,2)];
  const edgeKey = (e) => `${e.source}@${e.source_revision}/${e.target}@${e.target_revision}`;
  const result = trace({edges:[...paths,...other]},'X',1);
  assert.deepEqual(result.edgeKeys,new Set(paths.map(edgeKey)));
  assert.deepEqual(result.nodes,new Set(['S','B','X','D','T','S2','T2']));
  const nextVersion = [edge('S3','X',1,2),edge('X','D',2,2),edge('D','T',2,2)];
  const all = trace({edges:[...paths,...other,...nextVersion]},'X',null);
  assert.deepEqual(all.edgeKeys,new Set([...paths,...nextVersion].map(edgeKey)));
  assert.ok(!result.edgeKeys.has(edgeKey(other[2])),'a shortcut between an ancestor and a descendant bypasses the selected asset');
});

test('parallel uses are bundled only when both exact version endpoints agree, preserving every note', () => {
  const base = { source: 'A', source_revision: 1, target: 'B', target_revision: 3 };
  const edges = [{ ...base, id: 'e1', note: '控制误差' }, { ...base, id: 'e2', note: '处理边界' }, { ...base, id: 'e3', source_revision: 2, note: '新版方法' }];
  const merged = mergeEdges(edges);
  assert.equal(merged.length, 2); assert.equal(merged[0].note, '控制误差\n\n处理边界');
  assert.equal(merged[1].source_revision, 2); assert.equal(edges[0].note, '控制误差');
  const connections = groupConnections({ edges }, [{ id: 'T1', asset_ids: ['A'] }, { id: 'T2', asset_ids: ['B'] }, { id: 'T3', asset_ids: ['C'] }]);
  assert.equal(connections.length, 1); assert.deepEqual(connections[0].edge_ids, ['e1', 'e2', 'e3']);
});

test('layout handles cycles, self references, disconnected branches and growing inventories without duplicate or overlapping cards', () => {
  const nodes = Array.from({ length: 300 }, (_, i) => ({ id: `A${i}` }));
  const edges = [
    { source: 'A0', target: 'A1' }, { source: 'A1', target: 'A2' }, { source: 'A2', target: 'A0' },
    { source: 'A1', target: 'A1' }, { source: 'A2', target: 'A3' }
  ];
  for (let i = 4; i < 210; i++) edges.push({ source: `A${Math.floor(i / 2)}`, target: `A${i}` });
  const graph = layout({ nodes, edges });
  assert.equal(graph.places.size, 300);
  assert.ok(graph.places.get('A3').x > graph.places.get('A2').x);
  assert.deepEqual(graph, layout({ nodes, edges }));
  const positions = [...graph.places.values()];
  for (let i = 0; i < positions.length; i++) for (let j = i + 1; j < positions.length; j++) {
    const a = positions[i], b = positions[j];
    assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
  }
});
