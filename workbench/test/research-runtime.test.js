const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'deepmath-v3-runtime-'));
process.env.deepmath_app_data = path.join(temp, 'app-data');
const { ProjectStore, AgentManager, closeResearchLibrary } = require('../src/server');
const { ResearchLibrary } = require('../src/research-store');
const { executeTool } = require('../src/mcp-tools');
const { executeResearchTool } = require('../src/research-tools');
after(() => { closeResearchLibrary(); assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir())); fs.rmSync(temp, { recursive: true, force: true }); });
function fixture(t) {
  const store = new ProjectStore(); store.runtimeDir = fs.mkdtempSync(path.join(temp, 'case-'));
  store.project = { id: 'P1', name: '研究', workspacePath: store.runtimeDir, model: null, controllerThreadId: 'controller-thread', controllerThreadReady: true,
    automation: { state: 'running', goal: '原始问题 Q', reason: '' }, agents: [], runs: [], progress: [], activity: [], artifacts: [] };
  store.research = new ResearchLibrary(':memory:'); store.research.ensureProject(store.project);
  const codex = new EventEmitter(); codex.isSimulation = () => false; codex.startThread = async () => 'controller-thread';
  const manager = new AgentManager(store, codex), scheduled = [];
  manager.scheduleControllerReview = (options) => scheduled.push(options); manager.startControllerRun = () => {};
  const agent = store.createAgent({ displayName: '分析', researchContent: '探索条件 U', skills: ['证明'] });
  agent.threadId = 'worker-thread'; agent.lifecycleState = 'Running'; agent.currentRunId = 'run1';
  const run = { id: 'run1', agentId: agent.id, status: 'running', threadId: agent.threadId, turnId: 'worker-turn', userPrompt: '探索问题 Q', prompt: '探索问题 Q', events: [], toolCalls: 0, finalOutput: '' };
  store.project.runs.push(run);
  t.after(() => { store.research.close(); for (const timer of store.timers.values()) clearTimeout(timer); if (store.saveTimer) clearTimeout(store.saveTimer); });
  const submit = (args) => executeTool({ name: 'submit_report', arguments: args, kind: 'agent', store, manager, threadId: agent.threadId, turnId: run.turnId });
  return { store, codex, manager, scheduled, agent, run, submit };
}

test('checkpoints persist immediately, retries are idempotent, final reports survive execution end', async (t) => {
  const f = fixture(t), data = { phase: 'checkpoint', summary: 'U 下得到估计', body_md: '严格推导\n尚未解决 Q' };
  const first = await f.submit(data), retry = await f.submit(data);
  assert.equal(first.report_id, retry.report_id); assert.equal(retry.already_submitted, true);
  assert.equal(f.run.handoffSequence, 1); assert.equal(f.scheduled.length, 1);
  const final = await f.submit({ summary: 'Q 未解，独立证明 C', body_md: 'C 的完整证明与限制' });
  f.manager.finish(f.agent, f.run, '实际研究输出');
  assert.equal(f.run.reportIds.length, 2);
  assert.equal(f.store.research.get(final.report_id).generated, false);
  assert.equal(f.store.research.get(final.report_id).body_md, 'C 的完整证明与限制');
});

test('busy Controller acknowledgement freezes the delivered batch and preserves reports arriving later', async (t) => {
  const f = fixture(t), first = await f.submit({ phase: 'checkpoint', summary: '阶段一', body_md: '细节一' });
  const review = await f.manager.startAutomaticReview();
  assert.deepEqual(review.sourceReportIds, [first.report_id]);
  const later = await f.submit({ summary: '阶段二', body_md: '随后产生的独立成果' });
  review.turnId = 'controller-turn'; f.manager.acknowledgeReviewContext(review); f.manager.acknowledgeReviewContext(review);
  assert.equal(f.store.research.reportsForRun('P1', f.run.id, true)[0].id, later.report_id);
  assert.equal(f.run.pendingControllerReview, true);
  assert.equal(f.store.research.inbox('P1').total, 2);
  f.manager.finishAutomaticReview(review, true); assert.ok(f.scheduled.length >= 3);
});

test('Controller delivery never permits completion while report disposition remains pending or deferred', async (t) => {
  const f = fixture(t); const receipt = await f.submit({ summary: '无解，但有非平凡观察', body_md: '可复用的障碍分析' });
  f.manager.finish(f.agent, f.run, '执行完成');
  f.manager.acknowledgeRunsInControllerContext([f.run.id]);
  assert.equal(f.run.pendingControllerReview, false);
  assert.throws(() => f.store.setAutomation({ state: 'completed' }), /unresolved/);
  f.store.research.processReport('P1', { report_id: receipt.report_id, disposition: 'deferred', note: '先核查一个条件' });
  assert.throws(() => f.store.setAutomation({ state: 'completed' }), /unresolved/);
  f.store.research.processReport('P1', { report_id: receipt.report_id, disposition: 'retained', note: '该观察不能解决 Q；保存原始汇报，目标仍开放' });
  f.store.setAutomation({ state: 'needs_user', reason: '请确认问题 Q 的条件是否允许使用紧性假设。' });
  assert.equal(f.store.project.automation.state, 'needs_user');
});

test('missing final reports and errors preserve actual partial output without inventing achievements', (t) => {
  const f = fixture(t); f.run.finalOutput = '已经推出非平凡结论 C，但证据仍不完整。';
  f.manager.fail(f.agent, f.run, new Error('后续计算失败'));
  const report = f.store.research.get(f.run.reportIds[0]);
  assert.equal(report.generated, true); assert.equal(report.phase, 'incomplete');
  assert.match(report.body_md, /非平凡结论 C/); assert.match(report.body_md, /后续计算失败/);
  assert.equal(f.store.research.list({ kind: 'asset' }).total, 0);
});

test('an empty completed execution preserves an incomplete record without claiming research success', (t) => {
  const f = fixture(t);
  f.manager.onTurnCompleted({ threadId: f.run.threadId, turnId: f.run.turnId, status: 'completed' });
  assert.equal(f.run.status, 'completed');
  assert.match(f.run.finalOutput, /without a final textual response/);
  assert.doesNotMatch(f.run.finalOutput, /advanced the assigned task|findings were saved/);
  const report = f.store.research.get(f.run.reportIds[0]);
  assert.equal(report.phase, 'incomplete'); assert.equal(report.generated, true);
  assert.equal(f.store.research.list({ kind: 'asset' }).total, 0);
});

test('fallback records use English headings while retaining the original research input and output', (t) => {
  const f = fixture(t), output = '获得条件 U 下的结论，原问题 Q 仍未解决。';
  f.run.finalOutput = output;
  f.manager.finish(f.agent, f.run);
  assert.equal(f.run.finalOutput, output);
  const report = f.store.research.get(f.run.reportIds[0]);
  assert.match(report.body_md, /## Original research task\n\n探索问题 Q/);
  assert.match(report.body_md, /## Recorded output\n\n获得条件 U/);
  assert.match(report.body_md, /## Execution details/);
  assert.doesNotMatch(report.body_md, /## 原始任务|## 执行输出|## 执行信息/);
});

test('an empty simulated execution reports its limits in English', (t) => {
  const f = fixture(t); f.codex.isSimulation = () => true;
  f.run.userPrompt = 'Investigate Q';
  f.manager.finish(f.agent, f.run);
  assert.match(f.run.finalOutput, /Simulated execution ended/);
  assert.match(f.run.finalOutput, /No real research was performed and no verified findings were generated/);
  assert.doesNotMatch(f.run.finalOutput, /\p{Script=Han}/u);
  assert.equal(f.store.research.get(f.run.reportIds[0]).phase, 'incomplete');
});

test('user browsing does not consume Controller handoff and workers cannot curate official assets', async (t) => {
  const f = fixture(t), receipt = await f.submit({ summary: '需要整理', body_md: '完整研究' });
  await executeResearchTool({ name: 'read_report', args: { report_id: receipt.report_id }, kind: 'controller', store: f.store, manager: f.manager, actor: 'user' });
  assert.equal(f.store.research.reportsForRun('P1', f.run.id, true).length, 1);
  await assert.rejects(executeTool({ name: 'save_asset', arguments: { title: '不可写' }, kind: 'agent', store: f.store, manager: f.manager, threadId: f.agent.threadId, turnId: f.run.turnId }), /not available/);
  const map = await executeTool({ name: 'read_map', arguments: { map_id: 'root' }, kind: 'agent', store: f.store, manager: f.manager, threadId: f.agent.threadId, turnId: f.run.turnId });
  assert.equal(map.record.id, 'MROOT');
});

test('minimum context hints omit repeated maps and recover entry points after compaction', async (t) => {
  const f = fixture(t); await f.submit({ summary: '阶段结果', body_md: '长证明'.repeat(500) });
  const first = f.manager.buildControllerReviewPrompt([f.run]);
  assert.match(first, /Library entry/); assert.doesNotMatch(first, /长证明/);
  f.manager.researchEntryThreadId = f.store.project.controllerThreadId;
  const next = f.manager.buildControllerReviewPrompt([f.run]);
  assert.doesNotMatch(next, /Library entry|Research goal/);
  f.codex.emit('context.compacted', { threadId: f.store.project.controllerThreadId });
  assert.match(f.manager.buildControllerReviewPrompt([f.run]), /Library entry/);
});

test('every Controller turn receives the goal while manual turns do not consume the research entry hint', async (t) => {
  const f = fixture(t), delivered = [];
  f.manager.startControllerRun = AgentManager.prototype.startControllerRun;
  f.codex.startTurn = async (threadId, prompt) => {
    delivered.push(prompt);
    return { threadId, turnId: `controller-turn-${delivered.length}` };
  };
  const start = async (autoReview) => {
    const run = { id: `controller-${delivered.length}`, agentId: null, threadId: f.store.project.controllerThreadId,
      autoReview, status: 'running', events: [], prompt: autoReview ? f.manager.buildControllerReviewPrompt([]) : 'Assess the overall research direction' };
    f.store.project.runs.unshift(run);
    f.manager.startControllerRun(run);
    await f.manager.controllerStartOutcomes.get(run);
    assert.equal(run.status, 'running');
    run.status = 'completed';
    return delivered.at(-1);
  };
  const manual = await start(false);
  assert.match(manual, /^Project research goal: 原始问题 Q\nResearch reminder:/);
  assert.equal(f.manager.researchEntryThreadId, null);
  const first = await start(true);
  assert.match(first, /Library entry/);
  assert.match(first, /^Project research goal: 原始问题 Q\nResearch reminder:/);
  const next = await start(true);
  assert.doesNotMatch(next, /Library entry/);
  assert.match(next, /^Project research goal: 原始问题 Q\nResearch reminder:/);
  f.store.project.automation.goal = 'New global goal';
  f.codex.emit('context.compacted', { threadId: f.store.project.controllerThreadId });
  const compacted = await start(true);
  assert.match(compacted, /^Project research goal: New global goal\nResearch reminder:/);
  assert.match(compacted, /Library entry/);
  assert.doesNotMatch(compacted, /原始问题 Q/);
  for (const prompt of delivered) assert.equal(prompt.split('Project research goal:').length - 1, 1);
});

test('changes arriving during Controller work queue another review and never message workers', async (t) => {
  const f = fixture(t); await f.submit({ summary: '研究检查', body_md: '检查结果' });
  const review = await f.manager.startAutomaticReview(); review.turnId = 'controller-turn'; f.manager.acknowledgeReviewContext(review);
  const a = f.store.research.save('asset', { title: '当前估计' }, { project_id: 'P1' });
  let workerMessages = 0; f.codex.on('turn.steer', () => workerMessages++);
  f.store.research.save('asset', { id: a.id, body_md: '补充 U' }, { expected_revision: 1, project_id: 'P1', actor: 'user' });
  f.manager.finishAutomaticReview(review, true);
  assert.equal(f.manager.pendingResearchNotices().length, 1); assert.equal(workerMessages, 0);
  assert.ok(f.scheduled.length > 1);
});

test('a final report followed by another delivered instruction does not hide unreported later work', async (t) => {
  const f = fixture(t); f.run.userMessages = [{ text: '第一项任务', kind: 'initial' }];
  await f.submit({ summary: '第一项完成', body_md: '第一项证明' });
  f.run.userMessages.push({ text: '第二项新任务', kind: 'steer', delivery: 'delivered' });
  f.manager.finish(f.agent, f.run, '第二项获得新的部分结论，但未提交汇报');
  assert.equal(f.run.reportIds.length, 2);
  const fallback = f.store.research.get(f.run.reportIds[1]);
  assert.equal(fallback.phase, 'incomplete'); assert.match(fallback.body_md, /第二项获得/);
});

test('more than one page of pending changes is delivered in separate opportunities, without an edit wake loop', (t) => {
  const f = fixture(t), a = f.store.research.save('asset', { title: '待核查' }, { project_id: 'P1' });
  for (let i = 1; i <= 40; i++) f.store.research.save('asset', { id: a.id, body_md: `变化 ${i}` }, { expected_revision: i, project_id: 'P1', actor: 'user' });
  const first = f.manager.pendingResearchNotices(); assert.equal(first.length, 30);
  first.forEach((notice) => f.manager.deliveredNoticeIds.add(notice.id));
  assert.equal(f.manager.pendingResearchNotices().length, 10);
  assert.equal(f.store.research.inbox('P1', { notice_offset: 30 }).notices.length, 10);
  f.manager.pendingResearchNotices().forEach((notice) => f.manager.deliveredNoticeIds.add(notice.id));
  assert.equal(f.manager.pendingResearchNotices().length, 0);
  f.store.research.save('asset', { id: a.id, body_md: 'controller 已自行检查' }, { expected_revision: 41, project_id: 'P1', actor: 'controller' });
  assert.equal(f.manager.pendingResearchNotices().length, 0);
});

test('long bursts deliver bounded report entries and never acknowledge reports omitted by the response limit', async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 15; i++) await f.submit({ phase: 'checkpoint', summary: `${i}：${'长摘要'.repeat(600)}`, body_md: `完整证明 ${i}` });
  const review = await f.manager.startAutomaticReview(); review.turnId = 'controller-turn';
  assert.equal(review.sourceReportIds.length, 6); assert.ok(review.prompt.length < 4000);
  f.manager.acknowledgeReviewContext(review);
  assert.equal(f.store.research.reportsForRun('P1', f.run.id, true).length, 9);
  assert.equal(f.run.pendingControllerReview, true);
});

test('a team snapshot consumes only its actual report and recovery does not redeliver reviewed execution records', async (t) => {
  const f = fixture(t);
  await f.submit({ phase: 'checkpoint', summary: '早期观察', body_md: '需单独核查的早期内容' });
  const latest = await f.submit({ phase: 'checkpoint', summary: '最新观察', body_md: '不同的后续内容' });
  const controller = { id: 'c', agentId: null, status: 'running', threadId: 'controller-thread', turnId: 'controller-turn' }; f.store.project.runs.push(controller);
  await executeTool({ name: 'get_team_state', arguments: { agentId: f.agent.id }, kind: 'controller', store: f.store, manager: f.manager, threadId: controller.threadId, turnId: controller.turnId });
  const remaining = f.store.research.reportsForRun('P1', f.run.id, true);
  assert.equal(remaining.length, 1); assert.notEqual(remaining[0].id, latest.report_id);
  f.manager.finish(f.agent, f.run, '实际部分执行');
  f.manager.acknowledgeRunsInControllerContext([f.run.id]);
  assert.equal(f.run.pendingControllerReview, false);
  f.store.captureRunReport(f.run);
  assert.equal(f.run.pendingControllerReview, false);
});
