'use strict';
const crypto = require('node:crypto');
const makeId = () => `chat_${crypto.randomBytes(10).toString('hex')}`;
const actorKey = agent => agent?.id || 'controller';
const realThread = value => typeof value === 'string' && !value.startsWith('controller_') ? value : null;

// Application routing only. None of this catalog is sent in model prompts.
function ensure(project) {
  project.conversations ||= {};
  for (const agent of [null, ...(project.agents || [])]) {
    const key = actorKey(agent);
    let bucket = project.conversations[key];
    if (!bucket?.items?.length) {
      const initial = { id: makeId(), title: '对话 1', createdAt: project.createdAt || new Date().toISOString(), threadId: null };
      bucket = project.conversations[key] = { currentId: initial.id, items: [initial] };
    }
    const current = bucket.items.find(item => item.id === bucket.currentId);
    if (!current) throw new Error('当前对话记录不完整，请恢复项目备份');
    current.threadId = realThread(agent ? agent.threadId : project.controllerThreadId);
    if (agent) {
      agent.currentConversationId = current.id;
      for (const message of agent.pendingMessages || []) message.conversationId ||= current.id;
    }
  }
  for (const run of project.runs || []) {
    const bucket = project.conversations[run.agentId || 'controller'];
    if (bucket) run.conversationId ||= bucket.currentId;
  }
  return project.conversations;
}
function current(project, agent = null) {
  const bucket = ensure(project)[actorKey(agent)];
  return bucket.items.find(item => item.id === bucket.currentId);
}
function queued(agent) {
  return (agent.pendingMessages || []).filter(message => !message.conversationId || message.conversationId === agent.currentConversationId);
}
function switchTo(project, agent, requestedId) {
  const catalog = ensure(project), key = actorKey(agent), bucket = catalog[key];
  const previous = bucket.items.find(item => item.id === bucket.currentId);
  let next;
  if (requestedId) {
    next = bucket.items.find(item => item.id === requestedId);
    if (!next) throw Object.assign(new Error('当前角色下找不到这条对话'), { statusCode: 404 });
  } else {
    next = { id: makeId(), title: `对话 ${bucket.items.length + 1}`, createdAt: new Date().toISOString(), threadId: null };
    bucket.items.push(next);
  }
  if (next === previous) return next;
  previous.contextUsage = project.contextUsage?.[key] || null;
  bucket.currentId = next.id;
  if (agent) {
    agent.currentConversationId = next.id; agent.threadId = next.threadId || null;
    agent.currentRunId = null;
    agent.lastRunId = (project.runs || []).find(run => run.agentId === agent.id && run.conversationId === next.id)?.id || null;
    agent.currentAction = ''; agent.attention = null;
    if (agent.lifecycleState === 'Attention') agent.lifecycleState = 'Idle';
  } else {
    project.controllerThreadId = next.threadId || null;
    project.controllerThreadReady = Boolean(next.threadId);
  }
  project.contextUsage ||= {};
  if (next.contextUsage) project.contextUsage[key] = next.contextUsage;
  else delete project.contextUsage[key];
  return next;
}
function remove(project, agent, requestedId) {
  const catalog = ensure(project), key = actorKey(agent), bucket = catalog[key];
  const index = bucket.items.findIndex(item => item.id === requestedId);
  if (index < 0) throw Object.assign(new Error('当前角色下找不到这条对话'), { statusCode: 404 });
  if (bucket.items.length <= 1) throw Object.assign(new Error('至少保留一个对话，暂时不能删除'), { statusCode: 409 });
  const deletingCurrent = bucket.currentId === requestedId;
  const replacement = deletingCurrent
    ? bucket.items.filter(item => item.id !== requestedId).sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0]
    : null;
  bucket.items.splice(index, 1);
  project.runs = (project.runs || []).filter(run => run.conversationId !== requestedId);
  if (agent) agent.pendingMessages = (agent.pendingMessages || []).filter(message => message.conversationId !== requestedId);
  if (deletingCurrent) {
    bucket.currentId = replacement.id;
    if (agent) {
      agent.currentConversationId = replacement.id;
      agent.threadId = replacement.threadId || null;
      agent.currentRunId = null;
      agent.lastRunId = (project.runs || []).find(run => run.agentId === agent.id && run.conversationId === replacement.id)?.id || null;
      agent.currentAction = '';
      agent.attention = null;
    } else {
      project.controllerThreadId = replacement.threadId || null;
      project.controllerThreadReady = Boolean(replacement.threadId);
    }
    project.contextUsage ||= {};
    if (replacement.contextUsage) project.contextUsage[key] = replacement.contextUsage;
    else delete project.contextUsage[key];
  }
  return { deletedId: requestedId, currentId: bucket.currentId };
}
function webCatalog(project) {
  ensure(project);
  const counts = new Map();
  for (const run of project.runs || []) counts.set(run.conversationId, (counts.get(run.conversationId) || 0) + 1);
  return Object.fromEntries(Object.entries(project.conversations).map(([key, bucket]) => [key, {
    currentId: bucket.currentId,
    items: bucket.items.map(item => ({ id: item.id, title: item.title, createdAt: item.createdAt, runCount: counts.get(item.id) || 0 }))
  }]));
}
function forModel(value) {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value, (key, item) => ['conversationId', 'currentConversationId', 'conversations'].includes(key) ? undefined : item));
}
module.exports = { ensure, current, queued, switchTo, remove, webCatalog, forModel };
