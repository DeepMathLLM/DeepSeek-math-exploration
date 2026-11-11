const projectFiles = require('./project-files');
/*
 * Project control tools exposed to Codex app-server dynamic tool calls.
 *
 * The tool catalog is deliberately kept in one small module.  HTTP buttons,
 * Controller turns and Agent turns all call the same AgentManager/ProjectStore
 * methods; this bridge only translates JSON tool arguments to those methods.
 */
const fs = require('fs');
const path = require('path');
const { researchControllerTools, researchAgentTools, researchToolNames, researchReadNames, executeResearchTool } = require('./research-tools');

const text = (value, fallback = '') => typeof value === 'string' ? value.trim() : fallback;

const stringProperty = (description, extra = {}) => ({ type: 'string', description, ...extra });
const researchSkillNames = { controller: 'research-orchestration', agent: 'research-reporting' };
const researchSkillPath = (kind) => path.join(__dirname, '..', '.codex', 'skills', researchSkillNames[kind], 'SKILL.md');
function loadResearchSkill(kind) {
  if (!Object.hasOwn(researchSkillNames, kind)) throw new Error(`No research skill is available for ${kind}`);
  const instructions = fs.readFileSync(researchSkillPath(kind), 'utf8').trim();
  const frontmatter = instructions.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  const name = frontmatter?.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = frontmatter?.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (name !== researchSkillNames[kind] || !description) throw new Error(`Invalid research skill metadata for ${kind}`);
  return { name, description, instructions };
}
const researchSkillDescriptions = Object.fromEntries(Object.keys(researchSkillNames).map((kind) => {
  const { name, description } = loadResearchSkill(kind);
  return [kind, `${name}: ${description} Load the full guidance when relevant.`];
}));

// Project-authored skills follow the same frontmatter and on-demand loading
// contract as the built-in research skills, but are resolved from the
// selected project's workspace rather than from the application bundle.
const PROJECT_SKILLS_RELATIVE_ROOT = path.join('.agents', 'skills');
const PROJECT_SKILL_MAX_BYTES = 512 * 1024;
function projectSkillsRoot(workspacePath) {
  if (!text(workspacePath)) return null;
  return path.resolve(workspacePath, PROJECT_SKILLS_RELATIVE_ROOT);
}
function parseSkillDocument(instructions, expectedName = '') {
  const frontmatter = instructions.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  const name = frontmatter?.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = frontmatter?.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (!name || !description) throw new Error('Skill must define non-empty name and description frontmatter.');
  if (expectedName && name !== expectedName) throw new Error(`Skill name ${name} does not match its directory ${expectedName}.`);
  return { name, description };
}
function listProjectSkills(workspacePath) {
  const root = projectSkillsRoot(workspacePath);
  if (!root) return { root: PROJECT_SKILLS_RELATIVE_ROOT.replace(/\\/g, '/'), skills: [], warnings: [] };
  let entries;
  try { entries = projectFiles.list(workspacePath, '.agents/skills').map((item) => ({ ...item, isDirectory: () => item.type === 'directory' })); }
  catch (error) {
    if (error.code === 'ENOENT') return { root: PROJECT_SKILLS_RELATIVE_ROOT.replace(/\\/g, '/'), skills: [], warnings: [] };
    throw error;
  }
  const workspaceRoot = path.resolve(workspacePath);
  const skills = [];
  const warnings = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(root, entry.name, 'SKILL.md');
    try {
      const bytes = projectFiles.readFile(workspacePath, `.agents/skills/${entry.name}/SKILL.md`, PROJECT_SKILL_MAX_BYTES);
      const stat = { size: bytes.length };
      const instructions = bytes.toString('utf8').trim();
      const metadata = parseSkillDocument(instructions, entry.name);
      skills.push({
        name: metadata.name,
        description: metadata.description,
        path: path.relative(workspaceRoot, file).replace(/\\/g, '/'),
        size: stat.size
      });
    } catch (error) {
      warnings.push({ path: path.relative(workspaceRoot, file).replace(/\\/g, '/'), message: error.message || String(error) });
    }
  }
  return { root: path.relative(workspaceRoot, root).replace(/\\/g, '/'), skills, warnings };
}
function loadProjectSkill(workspacePath, requestedName) {
  const name = text(requestedName);
  if (!name) throw new Error('Project skill name is required.');
  const catalog = listProjectSkills(workspacePath);
  const metadata = catalog.skills.find((skill) => skill.name === name);
  if (!metadata) {
    const warning = catalog.warnings.find((item) => item.path.endsWith(`/${name}/SKILL.md`));
    throw new Error(warning ? `Unable to load project skill ${name}: ${warning.message}` : `Project skill not found: ${name}`);
  }
  const file = path.resolve(workspacePath, metadata.path);
  const instructions = projectFiles.readFile(workspacePath, metadata.path, PROJECT_SKILL_MAX_BYTES).toString('utf8').trim();
  parseSkillDocument(instructions, name);
  return { ...metadata, instructions };
}

const projectSkillTools = [
  {
    type: 'function', name: 'list_project_skills',
    description: 'List short metadata for user-authored project skills under .agents/skills. Refresh this list when the project files may have changed.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    type: 'function', name: 'load_project_skill',
    description: 'Load the full SKILL.md guidance for one user-authored project skill after list_project_skills identifies it as relevant.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { name: stringProperty('The project skill name from its SKILL.md frontmatter.') },
      required: ['name']
    }
  }
];

const controllerTools = [
  {
    type: 'function', name: 'load_research_skill', description: researchSkillDescriptions.controller,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  ...projectSkillTools,
  {
    type: 'function', name: 'list_agents',
    description: 'List research Agents, their lifecycle states, and active Run ids. Use get_team_state for one Agent\'s current instruction and latest progress.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    type: 'function', name: 'create_agent',
    description: 'Create a long-lived top-level research Agent for this project.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        displayName: stringProperty('Human-readable Agent name.'),
        researchContent: stringProperty('Persistent research direction and goals; assign the current question with run_agent or instruct_agent.'),
        skills: { type: 'array', minItems: 1, items: stringProperty('A research method or available skill name.'), description: 'Methods or skill names that guide the research; listing a name does not add an executable tool.' },
        instructions: stringProperty('Persistent working requirements for this Agent.'),
        automaticScheduling: { type: 'boolean', description: 'Whether automatic Controller reviews may start this Agent. Defaults to true.' }
      },
      required: ['displayName', 'researchContent', 'skills']
    }
  },
  {
    type: 'function', name: 'set_research_content',
    description: 'Change an existing Agent research content while preserving its Codex thread.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { agentId: stringProperty('Agent id or display name.'), researchContent: stringProperty('New persistent research direction and goals, separate from the current task.') },
      required: ['agentId', 'researchContent']
    }
  },
  {
    type: 'function', name: 'set_agent_profile',
    description: 'Update an Agent research content, skills or additional working requirements while preserving its Codex thread.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        agentId: stringProperty('Agent id or display name.'),
        researchContent: stringProperty('Persistent research direction and goals, separate from the current task.'),
        skills: { type: 'array', items: stringProperty('A research skill or method.') },
        instructions: stringProperty('Persistent working requirements.'),
        automaticScheduling: { type: 'boolean', description: 'Whether automatic Controller reviews may start this Agent.' }
      },
      required: ['agentId']
    }
  },
  {
    type: 'function', name: 'run_agent',
    description: 'Assign a task to an Agent. Idle Agents start a turn and Running Agents are steered.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { agentId: stringProperty('Agent id or display name.'), prompt: stringProperty('Self-contained current research question. Include relevant assumptions, known findings or exact record ids, and useful expected progress as needed. Free text; no fixed template.') },
      required: ['agentId', 'prompt']
    }
  },
  {
    type: 'function', name: 'instruct_agent',
    description: 'Send a direct question or instruction to an Agent. A Running Agent is steered, an Idle Agent starts a Run, and a Paused Agent queues it.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { agentId: stringProperty('Agent id or display name.'), message: stringProperty('Current instruction or question; include the context and evidence references needed to act on it.') },
      required: ['agentId', 'message']
    }
  },
  {
    type: 'function', name: 'pause_agent',
    description: 'Pause an Agent. Paused Agents retain queued messages and never auto-start.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { agentId: stringProperty('Agent id or display name.') }, required: ['agentId'] }
  },
  {
    type: 'function', name: 'resume_agent',
    description: 'Resume a paused Agent and optionally give it a task.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { agentId: stringProperty('Agent id or display name.'), prompt: stringProperty('Optional task after resuming.') },
      required: ['agentId']
    }
  },
  {
    type: 'function', name: 'stop_agent',
    description: 'Interrupt the current turn of an Agent and return it to Idle.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { agentId: stringProperty('Agent id or display name.') }, required: ['agentId'] }
  },
  {
    type: 'function', name: 'get_agent_status',
    description: 'Read one Agent lifecycle state, active Run, and queued message count.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { agentId: stringProperty('Agent id or display name.') }, required: ['agentId'] }
  },
  {
    type: 'function', name: 'get_team_state',
    description: 'Read one specified Agent\'s current Run instruction and latest progress record, with its Run id so older progress is not mistaken for current work. Use instruct_agent when a fresh answer is needed.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { agentId: stringProperty('Agent id or display name whose latest progress should be read.') },
      required: ['agentId']
    }
  },
  {
    type: 'function', name: 'get_run_detail',
    description: 'Read the complete input and final output for one Agent Run when the lightweight progress handoff is insufficient.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { runId: stringProperty('Agent Run id from an automatic review.') }, required: ['runId'] }
  },
  {
    type: 'function', name: 'set_project_state',
    description: 'Update the project goal state. Mark completed after verifying the full goal against current evidence. Use needs_user only when a concrete user answer, decision, material or action is required. Continue useful project work while running.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        state: { type: 'string', enum: ['running', 'paused', 'needs_user', 'completed'], description: 'Project automation state.' },
        reason: stringProperty('Reason for this goal-state change. For needs_user, specify the exact pending user question or action. For completed, identify the evidence that establishes completion.')
      },
      required: ['state', 'reason']
    }
  }
];

const agentTools = [
  {
    type: 'function', name: 'load_research_skill', description: researchSkillDescriptions.agent,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  ...projectSkillTools,
  {
    type: 'function', name: 'team_message',
    description: 'Send a direct question or instruction to another Agent. A Running Agent is steered, an Idle Agent starts a Run, and a Paused Agent queues it.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { target: stringProperty('Target Agent id or display name.'), message: stringProperty('Immediate message or task.') },
      required: ['target', 'message']
    }
  },
  {
    type: 'function', name: 'get_team_state',
    description: 'Read one specified Agent\'s current Run instruction and latest progress record, with its Run id so older progress is not mistaken for current work. Use team_message when a fresh answer is needed.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { agentId: stringProperty('Agent id or display name whose progress should be read.') },
      required: ['agentId']
    }
  },

];

const publicAgent = (agent) => agent ? ({
  id: agent.id, displayName: agent.displayName, researchContent: agent.researchContent || 'Complete assigned research tasks', skills: Array.isArray(agent.skills) ? agent.skills : [],
  instructions: agent.instructions || '', profileVersion: agent.profileVersion || 1, profileUpdatedAt: agent.profileUpdatedAt || agent.updatedAt,
  lifecycleState: agent.lifecycleState, currentRunId: agent.currentRunId || null, currentAction: agent.currentAction,
  attention: agent.attention,
  pendingMessages: (agent.pendingMessages || []).filter(message => !message.conversationId || message.conversationId === agent.currentConversationId).length,
  automaticScheduling: agent.automaticScheduling !== false,
  researchDocuments: agent.researchDocuments || null
}) : null;

const toolActionResult = (result) => result?.agentId && ['running', 'completed', 'interrupted', 'failed'].includes(result.status)
  ? { runId: result.id, agentId: result.agentId, status: result.status, detailAvailable: result.status !== 'running' }
  : result;

function runtimeSnapshot(project) {
  const runs = project?.runs || [];
  return {
    controllerRunId: runs.find((run) => !run.agentId && run.status === 'running')?.id || null,
    runningAgentCount: runs.filter((run) => run.agentId && run.status === 'running').length,
    pendingReviewCount: runs.filter((run) => run.agentId && run.pendingControllerReview).length
  };
}

function activeAgentRun(project, agent) {
  const run = project?.runs?.find((item) => item.id === agent?.currentRunId && item.agentId === agent.id && item.status === 'running');
  return run ? { id: run.id, status: run.status, startedAt: run.startedAt || null, instruction: run.userPrompt || run.prompt || '' } : null;
}

function toolCatalog(kind) {
  return kind === 'controller' ? [...controllerTools, ...researchControllerTools] : [...agentTools, ...researchAgentTools];
}

function agentForThread(store, threadId) {
  return store.project?.agents.find((agent) => agent.threadId === threadId) || null;
}

function requireAgent(store, value) {
  const agent = store.getAgent(text(value));
  if (!agent) throw new Error(`Agent not found: ${text(value, '(empty)')}`);
  return agent;
}

function requireCurrentTurn(store, run, turnId, threadId) {
  if (!turnId) return;
  if (!run || run.status !== 'running' || (run.turnId && run.turnId !== turnId)
    || (threadId && run.threadId && run.threadId !== threadId)
    || store.project.runs.some((item) => item !== run && item.turnId === turnId)) {
    throw new Error('This tool call belongs to an inactive Codex Turn.');
  }
  // A tool call may arrive before turn/start responds. It proves this Turn
  // entered the model context and binds later events to the right Run.
  if (!run.turnId) { run.turnId = turnId; store.save(); }
}

function teamSnapshot(store, targetAgent) {
  const progress = [...store.project.progress].reverse().find((entry) => entry.agentId === targetAgent.id) || null;
  const currentRun = activeAgentRun(store.project, targetAgent);
  return {
    project: { id: store.project.id, name: store.project.name },
    agent: publicAgent(targetAgent),
    currentRun,
    progress,
    progressFromCurrentRun: Boolean(currentRun && progress?.runId === currentRun.id)
  };
}

/**
 * Execute a tool using the existing business objects.  `kind` is selected when
 * the Codex thread is created; the thread id is still checked for Agent tools.
 */
async function executeTool({ name, arguments: rawArguments = {}, kind, store, manager, threadId, turnId }) {
  const descriptor = toolCatalog(kind).find(tool => tool.name === name);
  if (!descriptor) throw new Error(`Tool is not available in this thread: ${name}`);
  const args = require('./tool-arguments').parseArguments(rawArguments, descriptor.inputSchema);

  if (kind === 'controller') {
    const controllerRun = manager.activeControllerRun();
    requireCurrentTurn(store, controllerRun, turnId, threadId);
    if (controllerRun?.autoReview && turnId) manager.acknowledgeReviewContext(controllerRun);
    // Goal-state changes perform their own user-reply and pause checks.
    if (controllerRun?.autoReview && store.project.automation?.state !== 'running' && name !== 'set_project_state'
      && !researchReadNames.has(name) && !['get_research_inbox', 'load_research_skill', 'list_project_skills', 'load_project_skill', 'list_agents', 'get_run_detail', 'get_team_state', 'get_agent_status'].includes(name)) {
      throw new Error('Automatic orchestration has stopped; this Controller review cannot make further changes.');
    }
    if (name === 'load_research_skill') return loadResearchSkill(kind);
    if (name === 'list_project_skills') return listProjectSkills(store.project.workspacePath);
    if (name === 'load_project_skill') return loadProjectSkill(store.project.workspacePath, args.name);
    if (researchToolNames.has(name)) return executeResearchTool({ name, args, kind, store, manager, run: controllerRun });
    if (name === 'list_agents') return { agents: manager.list().map(publicAgent) };
    if (name === 'get_run_detail') {
      const detail = manager.getRunDetail(text(args.runId));
      manager.acknowledgeRunsInControllerContext([detail.runId]);
      return detail;
    }
    if (name === 'get_team_state') {
      const snapshot = teamSnapshot(store, requireAgent(store, args.agentId));
      if (snapshot.progress?.reportId) manager.acknowledgeResearchReports([snapshot.progress.reportId]);
      else if (snapshot.progress?.runId && !store.research) manager.acknowledgeRunsInControllerContext([snapshot.progress.runId]);
      return snapshot;
    }
    if (name === 'create_agent') {
      if (!text(args.researchContent) || !Array.isArray(args.skills) || !args.skills.length) {
        throw new Error('Before creating an Agent, provide its research content and at least one research skill based on the user request.');
      }
      return { agent: publicAgent(manager.create(args)) };
    }
    if (name === 'set_project_state') return { automation: manager.setProjectState(args.state, args.reason) };
    const agent = requireAgent(store, args.agentId);
    if (name === 'set_research_content') return { agent: publicAgent(manager.updateProfile(agent, { researchContent: text(args.researchContent) })) };
    if (name === 'set_agent_profile') return { agent: publicAgent(manager.updateProfile(agent, args)) };
    if (name === 'run_agent') return { agent: publicAgent(agent), run: toolActionResult(await manager.runFromController(agent, text(args.prompt))) };
    if (name === 'instruct_agent') return { agent: publicAgent(agent), result: toolActionResult(await manager.instructFromController(agent, text(args.message))) };
    if (name === 'pause_agent') return { agent: publicAgent(manager.pause(agent)) };
    if (name === 'resume_agent') return { agent: publicAgent(agent), result: toolActionResult(manager.resumeFromController(agent, text(args.prompt))) };
    if (name === 'stop_agent') return { agent: publicAgent(manager.stop(agent)) };
    if (name === 'get_agent_status') return { agent: publicAgent(agent), currentRun: activeAgentRun(store.project, agent) };
  }

  const ownAgent = agentForThread(store, threadId);
  if (!ownAgent) throw new Error('This Codex thread is not linked to a project Agent');
  const activeRun = store.project.runs.find((run) => run.id === ownAgent.currentRunId && run.agentId === ownAgent.id);
  requireCurrentTurn(store, activeRun, turnId, threadId);
  if (researchToolNames.has(name)) return executeResearchTool({ name, args, kind, store, manager, run: activeRun, actor: 'agent' });
  if (name === 'load_research_skill') return loadResearchSkill(kind);
  if (name === 'list_project_skills') return listProjectSkills(store.project.workspacePath);
  if (name === 'load_project_skill') return loadProjectSkill(store.project.workspacePath, args.name);
  if (name === 'team_message') {
    const target = requireAgent(store, args.target);
    const message = text(args.message);
    if (!message) throw new Error('Team message is empty');
    const attributedMessage = [
      '[BEGIN TEAM MESSAGE]',
      `From Agent: ${ownAgent.displayName}`,
      `From Agent ID: ${ownAgent.id}`,
      'Message:',
      message,
      '[END TEAM MESSAGE]'
    ].join('\n');
    const sourceRunId = activeRun?.id;
    const result = await manager.sendTeamMessage(target, attributedMessage);
    store.recordCollaboration(ownAgent, target, message, sourceRunId, result.mode);
    return { from: publicAgent(ownAgent), target: publicAgent(target), result: { ...result, run: toolActionResult(result.run) } };
  }
  if (name === 'get_team_state') {
    // Old persisted Agent threads may still have the parameterless schema.
    // Treat that legacy call as an explicit request for the caller's own history.
    const target = text(args.agentId) ? requireAgent(store, args.agentId) : ownAgent;
    return teamSnapshot(store, target);
  }

  throw new Error(`Unknown tool: ${name}`);
}

module.exports = { controllerTools: toolCatalog('controller'), agentTools: toolCatalog('agent'), toolCatalog, executeTool, loadResearchSkill, listProjectSkills, loadProjectSkill, publicAgent, runtimeSnapshot, activeAgentRun, teamSnapshot };
