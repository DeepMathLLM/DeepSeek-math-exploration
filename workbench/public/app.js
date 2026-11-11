const state = { project: null, projectId: sessionStorage.getItem('deepmath-v3-project-id') || '', projects: [], projectsError: '', models: [], selectedAgentId: null, activeView: 'overview', activeTab: 'progress', files: null, connected: false, mentionIndex: 0, mentionRange: null, mentions: [], home: true, editingAgentId: null, scrollConversationToEnd: false, conversationFollowEnd: false, conversationScrollGeneration: 0, citedFilePath: '', authenticated: false, user: null, limits: null };
let pendingProjectOpen = null;
function cancelProjectOpen() {
  const request = pendingProjectOpen; pendingProjectOpen = null;
  request?.controller.abort();
}
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
const escapeRegExp = (value = '') => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Render Codex's Markdown-like final text in the browser while keeping all
// generated HTML escaped. This intentionally covers the common response
// primitives (tables, headings, lists, quotes, links, inline and fenced code)
// without executing arbitrary markup from a model response.
function renderMarkdown(value = '') {
  const source = String(value).replace(/\r\n?/g, '\n');
  const codeBlocks = [];
  const withPlaceholders = source.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_, language, code) => {
    const index = codeBlocks.push(`<pre class="md-code"><code class="language-${escapeHtml(language || 'text')}">${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`) - 1;
    return `\n@@CODE_BLOCK_${index}@@\n`;
  });
  const codexDirectives = [];
  const directiveValue = (text = '') => String(text).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  const withCodexDirectives = withPlaceholders
    .replace(/:{1,2}codex-followup\[([^\]\n]+)\](?:\s*\{prompt="((?:\\.|[^"\n])*)"\})?/g, (_, label, prompt) => {
      const cleanLabel = directiveValue(label).trim();
      const cleanPrompt = directiveValue(prompt === undefined ? label : prompt).trim() || cleanLabel;
      const detail = cleanPrompt && cleanPrompt !== cleanLabel
        ? `<span class="codex-followup-prompt">${escapeHtml(cleanPrompt).replace(/\n/g, '<br>')}</span>`
        : '';
      const index = codexDirectives.push(`<button type="button" class="codex-followup" data-codex-followup="${escapeHtml(cleanPrompt)}"><span class="codex-followup-content"><strong>${escapeHtml(cleanLabel)}</strong>${detail}</span><small>填入输入框&nbsp;→</small></button>`) - 1;
      return `@@CODEXDIRECTIVE${index}@@`;
    })
    .replace(/:{1,2}codex-file-citation\{path="((?:\\.|[^"\n])*)"(?:\s+purpose="((?:\\.|[^"\n])*)")?\}/g, (_, filePath) => {
      const cleanPath = directiveValue(filePath);
      const fileName = cleanPath.split(/[\\/]/).filter(Boolean).pop() || cleanPath;
      const index = codexDirectives.push(`<button type="button" class="codex-file-citation" data-codex-file="${escapeHtml(cleanPath)}" title="在项目文件列表中定位 ${escapeHtml(cleanPath)}"><span aria-hidden="true">□</span>${escapeHtml(fileName)}</button>`) - 1;
      return `@@CODEXDIRECTIVE${index}@@`;
    });
  const mathBlocks = [];
  const withMathBlocks = withCodexDirectives
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, expression) => {
      const index = mathBlocks.push(`<div class="md-math md-math-display">\\[${escapeHtml(expression)}\\]</div>`) - 1;
      return `\n@@MATH_BLOCK_${index}@@\n`;
    })
    .replace(/\$\$([\s\S]*?)\$\$/g, (_, expression) => {
      const index = mathBlocks.push(`<div class="md-math md-math-display">\\[${escapeHtml(expression)}\\]</div>`) - 1;
      return `\n@@MATH_BLOCK_${index}@@\n`;
    });
  const mathInline = [];
  const withMath = withMathBlocks
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, expression) => {
      const index = mathInline.push(`\\(${escapeHtml(expression)}\\)`) - 1;
      return `@@MATHINLINE${index}@@`;
    })
    .replace(/\$([^$\n]+)\$/g, (_, expression) => {
      const index = mathInline.push(`\\(${escapeHtml(expression)}\\)`) - 1;
      return `@@MATHINLINE${index}@@`;
    });
  const inline = (text) => escapeHtml(text)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/(?<![\p{L}\p{N}_])_([^_\n]+)_(?![\p{L}\p{N}_])/gu, '<em>$1</em>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/@@MATHINLINE(\d+)@@/g, (_, index) => mathInline[Number(index)] || '')
    .replace(/@@CODEXDIRECTIVE(\d+)@@/g, (_, index) => codexDirectives[Number(index)] || '');
  const lines = withMath.split('\n');
  const tableCells = (raw) => {
    // Accept pasted tables with an escaped outer edge, as well as ordinary
    // pipe tables. Escaped pipes inside cells and pipes inside code stay text.
    const line = raw.trim().replace(/^\\\|/, '|').replace(/\|\\$/, '|');
    const cells = []; let cell = '', codeTicks = 0, delimiters = 0, lastDelimiter = false;
    for (let pos = 0; pos < line.length; pos++) {
      const char = line[pos];
      if (char === '\\') {
        let end = pos; while (line[end] === '\\') end++;
        const count = end - pos;
        if (line[end] === '|' && count % 2) { cell += '\\'.repeat(count - 1) + '|'; pos = end; }
        else { cell += '\\'.repeat(count); pos = end - 1; }
        lastDelimiter = false; continue;
      }
      if (char === '`') {
        let end = pos; while (line[end] === '`') end++;
        const count = end - pos;
        if (!codeTicks) codeTicks = count; else if (codeTicks === count) codeTicks = 0;
        cell += line.slice(pos, end); pos = end - 1; lastDelimiter = false; continue;
      }
      if (char === '|' && !codeTicks) { cells.push(cell.trim()); cell = ''; delimiters++; lastDelimiter = true; }
      else { cell += char; lastDelimiter = false; }
    }
    if (!delimiters) return null;
    cells.push(cell.trim());
    if (line.startsWith('|')) cells.shift();
    if (lastDelimiter) cells.pop();
    return cells;
  };
  const html = [];
  let list = null;
  let paragraph = [];
  const closeList = () => { if (list) { html.push(`</${list}>`); list = null; } };
  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${paragraph.map((line, index) => `${index ? '<br>' : ''}${inline(line)}`).join('')}</p>`);
    paragraph = [];
  };
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const trimmed = line.trim();
    const code = trimmed.match(/^@@CODE_BLOCK_(\d+)@@$/);
    if (code) { flushParagraph(); closeList(); html.push(codeBlocks[Number(code[1])]); continue; }
    const math = trimmed.match(/^@@MATH_BLOCK_(\d+)@@$/);
    if (math) { flushParagraph(); closeList(); html.push(mathBlocks[Number(math[1])]); continue; }
    if (!trimmed) { flushParagraph(); closeList(); continue; }
    const header = tableCells(line), divider = tableCells(lines[lineIndex + 1] || '');
    if (header?.length && header.length === divider?.length && divider.every(cell => /^:?-{3,}:?$/.test(cell))) {
      flushParagraph(); closeList(); lineIndex++;
      const alignment = divider.map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left');
      const row = (cells, heading = false) => '<tr>' + header.map((_, index) => {
        const tag = heading ? 'th' : 'td';
        return `<${tag}${heading ? ' scope="col"' : ''} class="md-align-${alignment[index]}">${inline(cells[index] || '')}</${tag}>`;
      }).join('') + '</tr>';
      const rows = [];
      while (lineIndex + 1 < lines.length) {
        const next = lines[lineIndex + 1].trim();
        if (!next || /^(?:#{1,3}\s|>\s?|[-*+]\s|\d+\.\s)/.test(next)) break;
        const cells = tableCells(next); if (!cells) break;
        rows.push(row(cells)); lineIndex++;
      }
      html.push(`<div class="md-table-wrap" tabindex="0" role="region" aria-label="表格"><table class="md-table"><thead>${row(header, true)}</thead><tbody>${rows.join('')}</tbody></table></div>`);
      continue;
    }
    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) { flushParagraph(); closeList(); const level = heading[1].length; html.push(`<h${level}>${inline(heading[2])}</h${level}>`); continue; }
    const item = trimmed.match(/^[-*+]\s+(.+)$/) || trimmed.match(/^\d+\.\s+(.+)$/);
    if (item) { flushParagraph(); const ordered = /^\d+\./.test(trimmed); const tag = ordered ? 'ol' : 'ul'; if (list !== tag) { closeList(); list = tag; html.push(`<${tag}>`); } html.push(`<li>${inline(item[1])}</li>`); continue; }
    if (/^>\s?/.test(trimmed)) { flushParagraph(); closeList(); html.push(`<blockquote>${inline(trimmed.replace(/^>\s?/, ''))}</blockquote>`); continue; }
    closeList(); paragraph.push(trimmed);
  }
  flushParagraph();
  closeList();
  return html.join('');
}
function typesetMath(root) {
  if (!root) return;
  if (window.MathJax?.typesetPromise) {
    window.MathJax.typesetPromise([root]).catch(() => {});
  } else if (!window.__mathTypesetRetry) {
    window.__mathTypesetRetry = true;
    setTimeout(() => { window.__mathTypesetRetry = false; typesetMath(root); }, 250);
  }
}
const formatTime = (iso) => { if (!iso) return ''; const date = new Date(iso); return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
const formatDateTime = (iso) => {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(date).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
};
const formatDuration = (start, end) => { if (!start) return ''; const seconds = Math.max(0, Math.round(((end ? new Date(end) : new Date()) - new Date(start)) / 1000)); return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`; };
const statusIcon = (stateName) => ({ Running: '⟳', Idle: '●', Paused: '⏸', Attention: '!' }[stateName] || '●');
const statusClass = (stateName) => String(stateName || 'Idle').toLowerCase();
const statusLabel = (stateName) => ({ Running: '进行中', Idle: '可接任务', Paused: '已暂停', Attention: '需要处理' }[stateName] || '可接任务');
const reasoningEffortLabel = (value) => ({ none: '关闭', minimal: '最低', low: '低', medium: '中等', high: '高', xhigh: '更高', max: '最高', ultra: '超高' }[value] || value);
const friendlyAction = (action = '') => {
  if (!action) return '';
  if (/Starting research turn/i.test(action)) return '准备开始研究';
  if (/Running Codex turn/i.test(action)) return '正在分析问题';
  if (/Incorporating a new instruction/i.test(action)) return '正在处理新要求';
  if (/Writing final response/i.test(action)) return '正在整理研究结果';
  if (/Reading relevant workspace files/i.test(action)) return '正在阅读项目资料';
  if (/Checking the current research context/i.test(action)) return '正在了解研究背景';
  if (/Working through the assigned question/i.test(action)) return '正在研究问题';
  if (/Preparing a complete final response/i.test(action)) return '正在整理结果';
  if (/Reviewing .* new team update/i.test(action)) return '正在查看团队最新进展';
  if (/Using /i.test(action)) return '正在使用研究工具';
  return action;
};
const friendlyActivity = (message = '') => message
  .replace(/(.+) created$/, '添加了研究 Agent：$1')
  .replace(/(.+) started a run$/, '$1 开始处理一项研究任务')
  .replace(/(.+) completed run_[\w]+$/, '$1 结束了一次任务执行')
  .replace(/(.+) paused$/, '$1 已暂停接收任务')
  .replace(/(.+) resumed$/, '$1 已恢复接收任务')
  .replace(/(.+) role changed$/, '$1 的研究方向已更新')
  .replace(/(.+) published progress$/, '$1 更新了任务进展')
  .replace(/发布了本轮进展$/, '更新了本次任务的进展')
  .replace(/(.+) needs attention$/, '$1 的任务需要处理');
const friendlyEvent = (message = '') => message
  .replace(/Codex runtime error/gi, '处理任务时遇到问题')
  .replace(/Turn interrupted by user/gi, '任务已被停止')
  .replace(/Codex turn interrupted/gi, '任务已被停止')
  .replace(/dynamic tool/gi, '研究工具')
  .replace(/userMessage/gi, '已接收任务')
  .replace(/Reading relevant workspace files/gi, '正在阅读项目资料')
  .replace(/Working through the assigned question/gi, '正在研究问题')
  .replace(/Preparing a complete final response/gi, '正在整理研究结果');
const showToast = (message) => { const toast = $('#toast'); toast.textContent = message; toast.classList.add('show'); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.remove('show'), 2600); };
const friendlyError = (message) => {
  if (String(message).startsWith('当前已有项目')) return '当前已有另一个项目正在运行，请先暂停或停止它，再运行当前项目。';
  return ({
  'Workspace directory does not exist': '找不到这个项目文件夹，请检查路径。',
  'Workspace directory is not accessible': '无法读取这个项目文件夹。',
  '项目状态文件无法读取，原文件已保留，请从备份恢复。': '项目记录暂时无法读取，原文件已经保留，请从备份恢复。',
  'Agent not found': '找不到对应的研究 Agent。',
  '当前项目还没有研究 Agent，请先添加研究 Agent，或在任务中说明要创建的 Agent。': '当前项目还没有研究 Agent，请先添加一个，或在任务中说明要创建 Agent。',
  '当前已有项目': '当前已有另一个项目正在运行，请先暂停或停止它，再运行当前项目。',
  '请输入任务内容': '请先输入研究任务。'
  }[message] || message);
};

async function api(path, options = {}) {
  const projectId = state.projectId || state.project?.id;
  const headers = { 'Content-Type': 'application/json', ...(projectId ? { 'x-deepmath-project-id': projectId } : {}), ...(options.headers || {}) };
  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(friendlyError(data.error || `请求失败（${response.status}）`));
  return data;
}

function selectedAgent() { return state.project?.agents.find((agent) => agent.id === state.selectedAgentId); }
function openAgentDialog(agent = null) {
  state.editingAgentId = agent?.id || null;
  $('#agent-dialog-title').textContent = agent ? '编辑研究 Agent' : '添加研究 Agent';
  $('#agent-dialog-help').textContent = agent ? '保存长期研究方向、方法与要求，用于后续任务；正在执行的 Agent 也会收到配置更新。' : '为当前项目添加一个长期研究 Agent。研究方向、方法和要求会在它每次接收任务时生效。';
  $('#agent-submit').textContent = agent ? '保存研究配置' : '创建研究 Agent';
  $('#agent-name').value = agent?.displayName || '';
  $('#agent-content').value = agent?.researchContent || '';
  $('#agent-skills').value = Array.isArray(agent?.skills) ? agent.skills.join('，') : '';
  $('#agent-instructions').value = agent?.instructions || '';
  $('#agent-automatic').checked = agent ? agent.automaticScheduling !== false : true;
  $('#agent-dialog').showModal();
}
function showProjectOverview() { state.selectedAgentId = null; state.activeView = 'overview'; if (state.activeTab === 'research') state.activeTab = 'progress'; render(); }
function showResearchAssets() { state.selectedAgentId = null; state.activeView = 'research'; state.activeTab = 'research'; render(); }
function showConversation() { state.selectedAgentId = null; state.activeView = 'conversation'; state.scrollConversationToEnd = true; state.conversationFollowEnd = true; render(); }
function goHome() {
  cancelProjectOpen();
  state.home = true; state.selectedAgentId = null; state.activeView = 'overview'; state.files = null; state.activeTab = 'progress';
  $$('#project-dialog, #agent-dialog').forEach((dialog) => { if (dialog.open) dialog.close(); });
  render(); loadProjects();
}
function mentionContext(text, caret) {
  const before = text.slice(0, caret);
  const match = before.match(/(?:^|[\s([{，。！？、])@([^\s@]*)$/u);
  if (!match) return null;
  return { query: match[1], start: caret - match[1].length - 1, end: caret };
}
function hideMentionMenu() { const menu = $('#agent-mention-menu'); menu.classList.add('hidden'); state.mentionRange = null; state.mentionIndex = 0; }
function updateMentionMenu() {
  const prompt = $('#prompt'); const menu = $('#agent-mention-menu');
  if (!state.project || document.activeElement !== prompt) { hideMentionMenu(); return; }
  const context = mentionContext(prompt.value, prompt.selectionStart);
  if (!context) { hideMentionMenu(); return; }
  const query = context.query.toLowerCase();
  const agents = state.project.agents.filter((agent) => agent.displayName.toLowerCase().includes(query));
  if (!agents.length) { hideMentionMenu(); return; }
  state.mentionRange = context;
  state.mentionIndex = Math.min(state.mentionIndex, agents.length - 1);
  menu.innerHTML = agents.map((agent, index) => `<button type="button" class="mention-option ${index === state.mentionIndex ? 'active' : ''}" data-mention-agent="${escapeHtml(agent.id)}" role="option"><span class="mention-icon">@</span><span><strong>${escapeHtml(agent.displayName)}</strong><small>${escapeHtml(agent.researchContent || '研究任务')}</small></span></button>`).join('');
  menu.classList.remove('hidden');
  $$('#agent-mention-menu [data-mention-agent]').forEach((button) => {
    button.addEventListener('mousedown', (event) => { event.preventDefault(); selectMention(button.dataset.mentionAgent); });
    button.addEventListener('click', () => selectMention(button.dataset.mentionAgent));
  });
}
function selectMention(agentId) {
  const agent = state.project?.agents.find((item) => item.id === agentId); const prompt = $('#prompt'); const range = state.mentionRange;
  if (!agent || !range) return;
  const insertion = `@${agent.displayName} `;
  prompt.value = `${prompt.value.slice(0, range.start)}${insertion}${prompt.value.slice(range.end)}`;
  const caret = range.start + insertion.length; prompt.focus(); prompt.setSelectionRange(caret, caret); autoSize(prompt); hideMentionMenu();
  refreshMentionRanges(prompt.value);
}
function refreshMentionRanges(value = $('#prompt')?.value || '') {
  const agents = state.project?.agents || [];
  const mentions = [];
  // Prefer the longest matching name when one Agent name is a prefix of
  // another (for example, "Alpha" and "Alpha Beta").  Without this,
  // overlapping ranges make Backspace/Delete ambiguous and can leave a
  // partially deleted mention behind.
  const orderedAgents = [...agents].sort((a, b) => {
    const length = String(b.displayName || '').trim().length - String(a.displayName || '').trim().length;
    return length || String(a.id || '').localeCompare(String(b.id || ''));
  });
  for (const agent of orderedAgents) {
    const name = String(agent.displayName || '').trim();
    if (!name) continue;
    const pattern = new RegExp(`(?:^|[\\s([{，。！？、])(@${escapeRegExp(name)})(?=\\s|$|[，。！？])`, 'gu');
    for (const match of value.matchAll(pattern)) {
      const start = (match.index || 0) + match[0].length - match[1].length;
      const tokenEnd = start + match[1].length;
      const end = value[tokenEnd] === ' ' ? tokenEnd + 1 : tokenEnd;
      if (!mentions.some((mention) => start < mention.end && end > mention.start)) {
        mentions.push({ start, end, agentId: agent.id });
      }
    }
  }
  state.mentions = mentions.sort((a, b) => a.start - b.start || a.end - b.end);
}
function removeMentionAtCaret(event) {
  const prompt = event.currentTarget;
  if (!['Backspace', 'Delete'].includes(event.key)) return;
  refreshMentionRanges(prompt.value);
  const start = prompt.selectionStart; const end = prompt.selectionEnd;
  let mention = null;
  if (start !== end) {
    const overlaps = state.mentions.filter((item) => start < item.end && end > item.start);
    if (!overlaps.length) return;
    event.preventDefault();
    const deletionStart = Math.min(start, ...overlaps.map((item) => item.start));
    const deletionEnd = Math.max(end, ...overlaps.map((item) => item.end));
    prompt.setRangeText('', deletionStart, deletionEnd, 'start');
    refreshMentionRanges(prompt.value); autoSize(prompt); updateMentionMenu(); return;
  }
  mention = event.key === 'Backspace'
    ? state.mentions.find((item) => item.end === start)
    : state.mentions.find((item) => item.start === start);
  // A selected Agent name is one atomic token.  If the caret is moved into
  // that token, either deletion key should still remove the complete mention
  // instead of leaving a broken `@Name` fragment behind.
  mention ||= state.mentions.find((item) => item.start < start && start < item.end);
  if (!mention) return;
  event.preventDefault();
  prompt.setRangeText('', mention.start, mention.end, 'start');
  refreshMentionRanges(prompt.value); autoSize(prompt); updateMentionMenu();
}
function chooseMentionWithKeyboard(direction) {
  const prompt = $('#prompt'); const context = mentionContext(prompt.value, prompt.selectionStart); if (!context) return false;
  const agents = state.project.agents.filter((agent) => agent.displayName.toLowerCase().includes(context.query.toLowerCase())); if (!agents.length) return false;
  state.mentionIndex = (state.mentionIndex + direction + agents.length) % agents.length; updateMentionMenu(); return true;
}
function captureInstructionScroll(root) {
  const positions = new Map();
  root?.querySelectorAll('.user-instruction-body.is-long[data-instruction-key]').forEach((body) => {
    positions.set(body.dataset.instructionKey, { top: body.scrollTop, left: body.scrollLeft });
  });
  return positions;
}
function restoreInstructionScroll(root, positions) {
  if (!positions.size) return;
  root.querySelectorAll('.user-instruction-body.is-long[data-instruction-key]').forEach((body) => {
    const position = positions.get(body.dataset.instructionKey);
    if (!position) return;
    body.scrollTop = position.top;
    body.scrollLeft = position.left;
  });
}
const contentScrollPositions = new Map();
let renderedContentView = null;
function contentViewKey() {
  if (!state.project || state.home) return 'home';
  const agent = selectedAgent();
  return JSON.stringify([state.project.id || state.project.workspacePath, agent ? `agent:${agent.id}` : state.activeView, conversationBucket(agent?.id || 'controller')?.currentId || '']);
}
function render() {
  renderStopButtons();
  // Save against the view still on screen, before navigation replaces its DOM.
  const scrollGeneration = ++state.conversationScrollGeneration;
  const scroller = $('.content-scroll');
  const viewKey = contentViewKey();
  const viewChanged = viewKey !== renderedContentView;
  if (scroller && renderedContentView !== null) {
    contentScrollPositions.set(renderedContentView, { top: scroller.scrollTop, left: scroller.scrollLeft });
  }
  const savedPosition = contentScrollPositions.get(viewKey);
  const restoreViewScroll = (followEnd = false) => {
    renderedContentView = viewKey;
    if (!scroller || !viewChanged) return;
    scroller.scrollTop = followEnd ? scroller.scrollHeight : savedPosition?.top || 0;
    scroller.scrollLeft = savedPosition?.left || 0;
  };
  if (!state.project || state.home) {
    if (!state.project) state.home = true;
    state.scrollConversationToEnd = false;
    state.conversationFollowEnd = false;
    renderHeader(); renderHome(); restoreViewScroll(); return;
  }
  const activeAgent = selectedAgent();
  const conversationHasMessages = activeAgent
    ? conversationRuns(activeAgent.id).length > 0
    : state.activeView === 'conversation' && conversationRuns('controller').length > 0;
  const conversationWasFollowing = Boolean(scroller && conversationHasMessages && state.conversationFollowEnd);
  renderHeader();
  renderAgents();
  renderContext();
  if (activeAgent) {
    renderAgentView();
  } else if (state.activeView === 'conversation') {
    renderConversationView();
  } else {
    renderStats();
    renderPulse();
    renderRecentProgress();
    renderTabs();
  }
  renderComposerTarget();
  renderContextUsage();
  renderHome();
  const shouldScrollToEnd = (state.scrollConversationToEnd && conversationHasMessages) || conversationWasFollowing;
  if (state.scrollConversationToEnd && conversationHasMessages) state.conversationFollowEnd = true;
  state.scrollConversationToEnd = false;
  if (!activeAgent && state.activeView !== 'conversation') state.conversationFollowEnd = false;
  restoreViewScroll(shouldScrollToEnd);
  if (shouldScrollToEnd) {
    requestAnimationFrame(() => {
      if (scrollGeneration !== state.conversationScrollGeneration || viewKey !== contentViewKey()) return;
      const viewport = $('.content-scroll');
      // A wheel/PageUp action can happen between render and this frame. Never
      // override that explicit choice to read older messages.
      if (!viewport || !state.conversationFollowEnd) return;
      viewport.scrollTop = viewport.scrollHeight;
    });
  }
}
function renderHome() {
  const home = $('#home-view'); const layout = $('.layout'); const sidebar = $('#workspace-sidebar'); const context = $('#context-panel'); const dashboard = $('#dashboard-view'); const agentView = $('#agent-view'); const bottom = $('#bottom-section'); const composer = $('.composer-wrap');
  const isHome = state.home || !state.project?.workspacePath;
  const isConversation = !isHome && state.activeView === 'conversation' && !selectedAgent();
  const isResearch = !isHome && state.activeView === 'research' && !selectedAgent();
  layout.classList.toggle('home-mode', isHome);
  layout.classList.toggle('research-mode', isResearch);
  $('#research-assets-nav').classList.toggle('selected', isResearch);
  home.classList.toggle('hidden', !isHome); sidebar.classList.toggle('hidden', isHome); context.classList.toggle('hidden', isHome || isResearch); dashboard.classList.toggle('hidden', isHome || Boolean(selectedAgent()) || isConversation || isResearch); $('#conversation-view').classList.toggle('hidden', !isConversation); agentView.classList.toggle('hidden', isHome || !selectedAgent() || isConversation); bottom.classList.toggle('hidden', isHome || Boolean(selectedAgent()) || isConversation); composer.classList.toggle('hidden', isHome || isResearch);
  if (isHome) {
    $('#home-project-count').textContent = state.projects.length;
    const list = $('#home-project-list');
    list.innerHTML = state.projectsError
      ? `<div class="empty-section"><strong>项目列表暂时无法读取</strong><span>${escapeHtml(state.projectsError)}</span></div>`
      : state.projects.length ? state.projects.map((project) => {
        const available = project.stateReadable !== false && project.workspaceAvailable !== false;
        const status = project.automationState === 'running' ? '自动运行中' : project.runningAgentCount ? `${project.runningAgentCount} 个 Agent 运行中` : '';
        const detail = project.stateReadable === false ? '状态文件需要恢复' : available ? `${status ? `${status} · ` : ''}${project.workspacePath}` : `${project.workspacePath || '原项目文件夹'} · 暂时不可用`;
        return `<button type="button" class="home-project-card ${available ? '' : 'unavailable'}" ${available ? `data-home-project-id="${escapeHtml(project.id)}" data-home-project-name="${escapeHtml(project.name)}"` : 'disabled'}><span><strong>${escapeHtml(project.name)}</strong><small>${escapeHtml(detail)}</small></span><span>${available ? '打开项目&nbsp; →' : '暂不可用'}</span></button>`;
      }).join('') : '<div class="empty-section"><strong>还没有研究项目</strong><span>选择一个本地文件夹，新建第一个项目。</span></div>';
    $$('#home-project-list [data-home-project-id]').forEach((button) => button.addEventListener('click', () => openSavedProject(button.dataset.homeProjectId, button.dataset.homeProjectName)));
  }
}
function renderComposerTarget() {
  const agent = selectedAgent();
  const help = $('.composer-label-help');
  const hint = $('.hint');
  const send = $('#send');
  const stopAgent = $('#stop-agent-run');
  if (!help || !hint || !send || !stopAgent) return;
  const controllerBusy = Boolean(state.project?.runs?.some((run) => !run.agentId && run.status === 'running'));
  if (agent) {
    help.innerHTML = `已选择 <strong>${escapeHtml(agent.displayName)}</strong>，提交后会直接发送给它`;
    hint.textContent = 'Enter 提交 · Shift+Enter 换行 · @ 改选 Agent · /compact 压缩会话';
    send.innerHTML = '提交任务&nbsp; <span>↑</span>';
  } else if (controllerBusy) {
    help.textContent = 'Controller 正在处理；提交新内容会追加到当前请求';
    hint.textContent = 'Enter 追加 · Shift+Enter 换行 · @ 指定 Agent';
    send.innerHTML = '追加指令&nbsp; <span>↑</span>';
  } else {
    help.textContent = '描述目标、问题或需要验证的假设';
    hint.textContent = 'Enter 提交 · Shift+Enter 换行 · @ 选择 Agent · /compact 压缩会话';
    send.innerHTML = '提交任务&nbsp; <span>↑</span>';
  }
}
function renderHeader() {
  $('#project-name').textContent = state.home || !state.project ? '多agent科研协作工作台' : state.project.name;
  $('.project-picker .eyebrow').textContent = state.home || !state.project ? '项目中心' : '当前项目';
  $('.project-picker-action').textContent = state.home || !state.project ? '管理项目' : '切换项目';
  $('.top-status').classList.toggle('hidden', state.home || !state.project);
  $('#back-home').classList.toggle('hidden', state.home || !state.project);
  $('#hero-title').textContent = state.project?.name || '多agent科研协作工作台';
  const workspace = state.project?.workspacePath || '';
  const shortPath = workspace.split(/[\\/]/).filter(Boolean).pop() || workspace;
  $('#workspace-label').textContent = `项目文件夹：${shortPath}`;
  $('#workspace-label').title = workspace;
  $('#agent-count').textContent = state.project?.agents.length || 0;
  renderModelPicker();
  renderAutomation();
  renderResearchAssessment();
}
let researchAssessmentCache = null, researchAssessmentRequest = 0;
function researchUiContext() {
  const projectId = state.projectId;
  return { projectId, projectTitle: state.project.name, api, renderMarkdown, escapeHtml, showToast, isCurrent: () => state.projectId === projectId,
    onSaved: () => renderResearchAssessment(true), onProjectOverview: showProjectOverview, openRecord: (record) => { showResearchAssets(); window.ResearchPanel.openRecord(record); } };
}
async function renderResearchAssessment(force = false) {
  const element = $('#research-assessment-preview'), projectId = state.projectId;
  if (!element || !projectId) return;
  if (!force && researchAssessmentCache?.projectId === projectId) return;
  const token = ++researchAssessmentRequest;
  researchAssessmentCache = { projectId };
  element.textContent = '正在读取研究现状…';
  try {
    const data = await api('/api/research/tools', { method: 'POST', headers: { 'x-deepmath-project-id': projectId }, body: JSON.stringify({ name: 'read_project_research', arguments: {} }) });
    if (token !== researchAssessmentRequest || projectId !== state.projectId) return;
    element.innerHTML = renderMarkdown(data.body_md || '还没有保存现状与计划。');
    element.classList.toggle('muted', !data.body_md);
    if (data.outcomes.length) element.insertAdjacentHTML('beforeend', `<p class="minor">已选择 ${data.outcomes.length} 条资产作为本项目成果。</p>`);
    typesetMath(element);
  } catch (error) { if (token === researchAssessmentRequest && projectId === state.projectId) { element.textContent = '研究现状暂时无法读取。'; researchAssessmentCache = null; } }
}
function renderAutomation() {
  const automation = state.project?.automation || { state: 'paused', goal: '', reason: '' };
  const input = $('#automation-goal'); const button = $('#automation-toggle'); const status = $('#automation-status'); const runtimeLine = $('#automation-runtime'); const reason = $('#automation-reason');
  if (!input || !button || !status || !runtimeLine || !reason) return;
  const labels = { running: '正在自动推进项目目标', paused: '自动运行已暂停', needs_user: '需要你的回答或处理', completed: 'Controller 已核验项目目标完成' };
  status.textContent = labels[automation.state] || '已暂停';
  status.className = `automation-state ${automation.state || 'paused'}`;
  const runtime = state.project?.runtime || {};
  const activity = [];
  if (runtime.controllerRunId) activity.push('Controller 正在处理');
  if (runtime.runningAgentCount) activity.push(`${runtime.runningAgentCount} 个 Agent 正在执行`);
  if (!runtime.controllerRunId && !runtime.runningAgentCount) activity.push('当前没有正在执行的任务');
  if (runtime.pendingReviewCount) activity.push(`${runtime.pendingReviewCount} 次任务有新汇报由 Controller 处理中`);
  runtimeLine.textContent = activity.join(' · ');
  if (document.activeElement !== input) input.value = automation.goal || '';
  input.disabled = automation.state === 'running';
  button.textContent = automation.state === 'running' ? '暂停自动运行' : automation.state === 'needs_user' ? '补充后继续' : automation.state === 'completed' ? '继续新一轮' : '启动自动运行';
  button.classList.toggle('pause-automation', automation.state === 'running');
  let detail = automation.reason || (automation.state === 'running'
    ? 'Controller 会审阅研究进展，并在空闲时核验项目目标、继续推进，直到通过工具确认完成或提出需要你处理的事项。'
    : '设置项目目标并启动后，Controller 会根据汇报整理资产、安排研究任务。');
  if (automation.runtimeError) detail = `正在内部处理。${automation.runtimeError.message}`;
  if (automation.state === 'needs_user') detail = automation.userRequest || automation.reason;
  reason.textContent = detail;
}
function renderModelPicker() {
  const picker = $('#project-model');
  const effortPicker = $('#project-effort');
  if (!picker || !effortPicker) return;
  const defaultModel = state.models.find((model) => model.isDefault) || state.models[0];
  const pending = state.modelSettingsPending?.projectId === state.project?.id ? state.modelSettingsPending : null;
  const displayedProject = pending ? { ...state.project, ...pending } : state.project;
  picker.innerHTML = state.models.length
    ? state.models.map((model) => `<option value="${escapeHtml(model.model || model.id)}" title="${escapeHtml(model.description || '')}">${escapeHtml(model.displayName || model.model || model.id)}</option>`).join('')
    : '<option value="">模型目录暂不可用</option>';
  const unavailableModel = Boolean(displayedProject?.model && !state.models.some(model => (model.model || model.id) === displayedProject.model));
  if (unavailableModel) picker.innerHTML += `<option value="${escapeHtml(displayedProject.model)}" disabled>原模型未启用，请重新选择</option>`;
  picker.value = displayedProject?.model || defaultModel?.model || defaultModel?.id || '';
  picker.disabled = !state.project || Boolean(pending);
  const selectedModel = state.models.find((model) => (model.model || model.id) === picker.value) || defaultModel;
  const requestOptions = Array.isArray(selectedModel?.configurableReasoningEfforts);
  const efforts = requestOptions ? selectedModel.configurableReasoningEfforts : selectedModel?.supportedReasoningEfforts || [];
  const defaultEffort = selectedModel?.defaultReasoningEffort || efforts[0]?.reasoningEffort || '';
  const currentEffort = selectedModel?.reasoningEffortSupported === false ? ''
    : requestOptions ? displayedProject?.reasoningEffort || '' : displayedProject?.reasoningEffort || defaultEffort;
  const inheritLabel = selectedModel?.defaultReasoningEffort ? `跟随配置（${reasoningEffortLabel(selectedModel.defaultReasoningEffort)}）` : '模型默认';
  effortPicker.innerHTML = efforts.length
    ? (requestOptions ? `<option value="">推理：${escapeHtml(inheritLabel)}</option>` : '')
      + efforts.map((effort) => `<option value="${escapeHtml(effort.reasoningEffort)}" title="${escapeHtml(effort.description || '')}">推理：${escapeHtml(reasoningEffortLabel(effort.reasoningEffort))}${requestOptions ? ' · ' + escapeHtml(effort.reasoningEffort) : ''}</option>`).join('')
    : `<option value="${escapeHtml(currentEffort)}">推理：${escapeHtml(currentEffort ? reasoningEffortLabel(currentEffort) : '模型默认')}</option>`;
  const unavailableEffort = requestOptions && Boolean(currentEffort) && !efforts.some(option => option.reasoningEffort === currentEffort);
  if (unavailableEffort) effortPicker.innerHTML += `<option value="${escapeHtml(currentEffort)}" disabled>原档位不可用：${escapeHtml(currentEffort)}</option>`;
  effortPicker.value = currentEffort;
  effortPicker.disabled = !state.project || !efforts.length || unavailableModel || Boolean(pending);
  effortPicker.title = selectedModel?.reasoningEffortSupported === false ? '使用模型默认推理' : '选择当前项目的推理强度';
  const note = $('#reasoning-effort-note');
  if (note) {
    note.textContent = unavailableModel ? '原模型未在当前配置中启用，请先选择其他模型。'
      : unavailableEffort ? '原推理档位已不在当前模型选项中，请重新选择。'
      : '';
    note.title = '';
    note.classList.toggle('hidden', !state.project || !note.textContent);
  }
}
function composerRequestSettings() {
  return { model: $('#project-model').value, reasoningEffort: $('#project-effort').value };
}
function agentStateText(agent) {
  const run = agent.lifecycleState === 'Running' && state.project?.runs?.find(run => run.id === agent.currentRunId && run.status === 'running');
  if (run && modelProcessingText(run)) return modelProcessingText(run);
  if (agent.lifecycleState === 'Running') return agent.currentAction ? `当前任务进行中 · 最近活动：${friendlyAction(agent.currentAction)}` : '当前任务进行中';
  if (agent.lifecycleState === 'Paused') return '已暂停接收任务';
  if (agent.lifecycleState === 'Attention') return '任务需要处理';
  return '可接收新的研究任务';
}
function renderAgents() {
  const list = $('#agent-list');
  list.innerHTML = state.project.agents.map((agent) => `<button class="agent-item status-${statusClass(agent.lifecycleState)} ${agent.id === state.selectedAgentId ? 'selected' : ''}" data-agent="${escapeHtml(agent.id)}" title="查看 ${escapeHtml(agent.displayName)}"><span class="agent-icon" aria-hidden="true">${statusIcon(agent.lifecycleState)}</span><span class="agent-item-body"><span class="agent-item-head"><span class="name" title="${escapeHtml(agent.displayName)}">${escapeHtml(agent.displayName)}</span><span class="agent-state-badge">${statusLabel(agent.lifecycleState)}</span></span><span class="sub role-line" title="${escapeHtml(agent.researchContent || '研究任务')}">${escapeHtml(agent.researchContent || '研究任务')}</span><span class="sub state-line" title="${escapeHtml(agentStateText(agent))}">${escapeHtml(agentStateText(agent))}</span></span></button>`).join('');
  $$('#agent-list .agent-item').forEach((button) => button.addEventListener('click', () => { state.selectedAgentId = button.dataset.agent; state.activeView = 'agent'; state.scrollConversationToEnd = true; state.conversationFollowEnd = true; render(); }));
  $('#project-overview').classList.toggle('selected', !state.selectedAgentId && state.activeView !== 'research');
}
function renderStats() {
  const counts = state.project.agents.reduce((acc, agent) => { acc[agent.lifecycleState] = (acc[agent.lifecycleState] || 0) + 1; return acc; }, {});
  $('#stat-grid').innerHTML = [
    ['进行中', counts.Running || 0, '正在处理研究任务'],
    ['可接任务', counts.Idle || 0, '可以接收新的任务'],
    ['已暂停', counts.Paused || 0, '恢复后继续接收任务'],
    ['需处理', counts.Attention || 0, '任务遇到问题']
  ].map(([label, value, sub]) => `<div class="stat"><div class="eyebrow">${label}</div><div class="value">${value}</div><div class="label">${sub}</div></div>`).join('');
}
function renderPulse() {
  const agents = state.project.agents;
  const cards = agents.map((agent) => `<button class="pulse-card status-${statusClass(agent.lifecycleState)}" data-agent="${escapeHtml(agent.id)}"><div class="pulse-top"><span class="agent-icon ${statusClass(agent.lifecycleState)}" aria-hidden="true">${statusIcon(agent.lifecycleState)}</span><span class="pulse-name" title="${escapeHtml(agent.displayName)}">${escapeHtml(agent.displayName)}</span><span class="pulse-status">${statusLabel(agent.lifecycleState)}</span></div><div class="pulse-role" title="${escapeHtml(agent.researchContent || '研究任务')}">${escapeHtml(agent.researchContent || '研究任务')}</div><div class="pulse-action" title="${escapeHtml(agentStateText(agent))}">${escapeHtml(agentStateText(agent))}</div><span class="pulse-link">查看对话 →</span></button>`).join('');
  if (!agents.length) {
    $('#team-pulse').innerHTML = '<div class="empty-team"><strong>还没有研究 Agent</strong><span>点击左侧“添加研究 Agent”，创建第一个研究 Agent。</span></div>';
  } else {
    $('#team-pulse').innerHTML = cards + (agents.length === 1 ? '<div class="team-note"><strong>当前项目有 1 个研究 Agent</strong><span>提交任务后，研究结果会显示在这里。</span></div>' : '<div class="team-note"><strong>这是当前项目的全部研究 Agent</strong><span>点击任意卡片查看该 Agent 的任务和结果。</span></div>');
  }
  $$('#team-pulse .pulse-card').forEach((button) => button.addEventListener('click', () => { state.selectedAgentId = button.dataset.agent; state.activeView = 'agent'; state.scrollConversationToEnd = true; state.conversationFollowEnd = true; render(); }));
}
function renderRecentProgress() {
  const entries = [...state.project.progress].reverse().slice(0, 4);
  $('#recent-progress').innerHTML = entries.length ? entries.map((entry) => `<article class="progress-item"><header class="progress-entry-head"><span class="progress-agent"><span class="progress-agent-dot" aria-hidden="true"></span>${escapeHtml(entry.agentName)}</span><time class="progress-time">${formatDateTime(entry.updatedAt || entry.at)}</time></header><div class="message">${escapeHtml(entry.message)}</div></article>`).join('') : '<div class="empty-section"><strong>还没有任务进展</strong><span>Agent 提交汇报后，这里显示发现、障碍或部分成果的简短说明。</span></div>';
}
function controllerInitialRequest(run) {
  const match = String(run?.prompt || '').match(/REQUEST:\s*([\s\S]*)$/);
  const request = (match ? match[1] : run?.userPrompt || run?.prompt || '').trim();
  return request.split(/\n\s*Steered instruction:\s*/i)[0].trim();
}
function controllerUserMessages(run) {
  if (run?.autoReview) return [];
  const initial = controllerInitialRequest(run);
  if (Array.isArray(run?.userMessages) && run.userMessages.length) {
    return run.userMessages.some((message) => message.kind === 'initial') || !initial
      ? run.userMessages
      : [{ at: run.startedAt, kind: 'initial', text: initial }, ...run.userMessages];
  }
  const steerEvents = (run?.events || []).filter((event) => event.kind === 'steer' && event.text);
  if (steerEvents.length) {
    return [
      ...(initial ? [{ at: run.startedAt, kind: 'initial', text: initial }] : []),
      ...steerEvents.map((event) => ({ at: event.at, kind: 'steer', text: event.text }))
    ];
  }
  const match = String(run?.prompt || '').match(/REQUEST:\s*([\s\S]*)$/);
  const parts = (match ? match[1] : '').split(/\n\s*Steered instruction:\s*/i).map((part) => part.trim()).filter(Boolean);
  return parts.length
    ? parts.map((text, index) => ({ at: index ? null : run.startedAt, kind: index ? 'steer' : 'initial', text }))
    : initial ? [{ at: run.startedAt, kind: 'initial', text: initial }] : [];
}
function renderControllerUserMessage(message, index, initialLabel = '初始任务', runId = '') {
  const text = String(message?.text || '').trim();
  const isSteer = message?.kind === 'steer';
  const delivery = message?.delivery === 'queued' ? ' · 正在内部处理…' : message?.delivery === 'sending' ? ' · 发送中' : message?.delivery === 'failed' ? ' · 发送失败' : message?.delivery === 'not_delivered' ? ' · 未发送' : '';
  const label = isSteer ? `追加指令 ${index}${delivery}` : initialLabel;
  const isLong = text.length > 900 || text.split('\n').length > 14;
  const scrollKey = isLong ? ` data-instruction-key="${escapeHtml(`${runId}:${index}`)}"` : '';
  const content = `<div class="conversation-text markdown-body user-instruction-body ${isLong ? 'is-long' : ''}"${scrollKey}>${renderMarkdown(text)}</div>`;
  return `<div class="conversation-user controller-user"><div class="controller-user-bubble"><div class="conversation-meta"><span class="conversation-badge user-instruction">${label}</span>${message?.at ? `<span class="message-time">${formatTime(message.at)}</span>` : ''}</div>${content}</div><span class="conversation-avatar user-avatar">你</span></div>`;
}
function modelProcessingText(target) {
  if (target?.networkRetrying) return '网络连接暂时异常，正在恢复…';
  if (target?.internalProcessing) return '正在内部处理…';
  return '';
}
function controllerRunStatus(run) {
  if (!run) return ['尚无任务', 'idle'];
  if (run.status === 'queued') return ['正在内部处理…', 'running'];
  if (run.status === 'completed') return missingFinalAnswer(run) ? ['本轮结束，未收到最终答复', 'interrupted'] : ['本次执行结束', 'completed'];
  if (run.status === 'failed') return ['执行失败', 'failed'];
  if (run.status === 'interrupted') return ['已停止', 'interrupted'];
  if (modelProcessingText(run)) return [modelProcessingText(run), 'running'];
  return ['处理中', 'running'];
}
function runtimeActivity(run) {
  if (run.status !== 'running') return '';
  if (modelProcessingText(run)) return modelProcessingText(run);
  return { writing: '正在生成回复…', tool: '正在调用工具…', thinking: '正在思考…' }[run.liveActivity] || '正在处理任务…';
}
const loadedConversationPages = new Set();
function conversationBucket(target = state.selectedAgentId || 'controller') {
  return state.project?.conversations?.[target];
}
function conversationRuns(target = state.selectedAgentId || 'controller') {
  const current = conversationBucket(target)?.currentId;
  return (state.project?.runs || []).filter(run => (run.agentId || 'controller') === target && (!current || run.conversationId === current));
}
function activeConversationRun(target) {
  return conversationRuns(target).find(run => run.status === 'running');
}
function renderStopButtons() {
  const visible = !state.home && Boolean(state.project) && state.project.id === state.projectId;
  const controller = visible && state.activeView === 'conversation' && !selectedAgent() && activeConversationRun('controller');
  const agent = visible && state.activeView === 'agent' && selectedAgent() && activeConversationRun(state.selectedAgentId);
  for (const [id, run] of [['#stop-controller', controller], ['#stop-agent-run', agent]]) {
    const button = $(id);
    if (!button) continue;
    button.classList.toggle('hidden', !run);
    button.disabled = Boolean(run && state.stoppingRunId === run.id);
  }
}
function conversationBusy(target) {
  return (state.project?.runs || []).some(run => (run.agentId || 'controller') === target && ['running', 'queued'].includes(run.status))
    || state.project?.contextCompactions?.[target]?.status === 'running';
}
function conversationControls(target) {
  const bucket = conversationBucket(target);
  if (!bucket) return '';
  const disabled = conversationBusy(target) || state.project?.automation?.state === 'running' ? 'disabled' : '';
  const deleteDisabled = disabled || bucket.items.length <= 1 ? 'disabled' : '';
  const deleteTitle = bucket.items.length <= 1 ? '至少保留一个对话' : '删除当前对话及其聊天记录';
  return `<span class="conversation-controls"><select class="outline-button" aria-label="历史对话" title="选择历史对话继续" data-conversation-history="${escapeHtml(target)}" ${disabled}>${bucket.items.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === bucket.currentId ? 'selected' : ''}>${escapeHtml(item.title)}${item.id === bucket.currentId ? ' · 当前' : ''}</option>`).join('')}</select><button type="button" class="outline-button" data-new-conversation="${escapeHtml(target)}" ${disabled}>新建对话</button><button type="button" class="outline-button danger-outline" title="${escapeHtml(deleteTitle)}" data-delete-conversation="${escapeHtml(target)}" ${deleteDisabled}>删除对话</button></span>`;
}
async function changeConversation(target, conversationId = null) {
  const bucket = conversationBucket(target);
  if (!bucket || (conversationId && conversationId === bucket.currentId)) return;
  try {
    const project = await api('/api/conversations', { method: 'POST', body: JSON.stringify({ target,
      action: conversationId ? 'activate' : 'new', conversationId, expectedCurrentId: bucket.currentId }) });
    selectViewedProject(project);
    state.scrollConversationToEnd = true; state.conversationFollowEnd = false;
    render();
  } catch (error) { showToast(error.message); await reload().catch(() => {}); }
}
async function deleteConversation(target) {
  const bucket = conversationBucket(target);
  if (!bucket || bucket.items.length <= 1 || conversationBusy(target) || state.project?.automation?.state === 'running') return;
  const current = bucket.items.find(item => item.id === bucket.currentId);
  if (!window.confirm(`确定删除“${current?.title || '当前对话'}”及其聊天记录吗？项目文件、研究资产和 Agent 配置不会删除。`)) return;
  try {
    const project = await api('/api/conversations', { method: 'POST', body: JSON.stringify({ target, action: 'delete', conversationId: bucket.currentId, expectedCurrentId: bucket.currentId }) });
    selectViewedProject(project);
    state.scrollConversationToEnd = true; state.conversationFollowEnd = false;
    render();
    showToast('对话已删除');
  } catch (error) { showToast(error.message); await reload().catch(() => {}); }
}
function ensureConversationRuns(target) {
  const bucket = conversationBucket(target);
  if (!bucket) return;
  const count = bucket.items.find(item => item.id === bucket.currentId)?.runCount || 0;
  const key = `${state.projectId}:${target}:${bucket.currentId}`;
  if (conversationRuns(target).length >= Math.min(30, count) || loadedConversationPages.has(key)) return;
  loadedConversationPages.add(key);
  const projectId = state.projectId;
  api(`/api/runs?conversationId=${encodeURIComponent(bucket.currentId)}`).then(data => {
    if (state.projectId !== projectId) return;
    const ids = new Set(state.project.runs.map(run => run.id));
    state.project.runs.push(...data.runs.filter(run => !ids.has(run.id)));
    state.project.runs.sort((left, right) => String(right.startedAt || '').localeCompare(String(left.startedAt || '')));
    render();
  }).catch(error => { loadedConversationPages.delete(key); showToast(error.message); });
}
function renderConversationView() {
  const list = $('#controller-conversation'); const status = $('#controller-status');
  if (!list || !status || !state.project) return;
  const instructionScroll = captureInstructionScroll(list);
  ensureConversationRuns('controller');
  const tools = $('#controller-conversation-tools'); if (tools) tools.innerHTML = conversationControls('controller');
  const runs = conversationRuns('controller').slice().reverse();
  const active = runs.find((run) => run.status === 'running');
  status.textContent = modelProcessingText(active) || (active ? '● Controller 正在处理' : '● Controller 当前未运行');
  status.className = `live-label conversation-status ${active ? 'is-running' : ''}`;
  const savedCompaction = state.project.contextCompactions?.controller;
  const compaction = savedCompaction?.threadId === state.project.controllerThreadId ? savedCompaction : null;
  const compactButton = $('#compact-controller');
  compactButton.disabled = Boolean(active || runs.some((run) => run.status === 'queued') || compaction?.status === 'running' || !state.project.controllerThreadReady);
  compactButton.textContent = compaction?.status === 'running' ? (modelProcessingText(compaction) || '压缩中…') : '压缩上下文';
  $('#controller-compaction-status').textContent = compaction?.status === 'completed' ? '上下文已压缩，项目记录保留。' : compaction?.status === 'failed' ? `压缩失败：${compaction.error}` : '';
  list.innerHTML = runs.length ? runs.map((run) => {
    const [label, kind] = controllerRunStatus(run);
    const userMessages = controllerUserMessages(run);
    const output = run.finalOutput || (run.status === 'running' ? '正在分析请求并协调研究 Agent…' : '暂无回复');
    const event = runtimeActivity(run);
    return `<article class="conversation-turn controller-exchange"><div class="controller-user-stack">${userMessages.map((message, index) => renderControllerUserMessage(message, index, '初始任务', run.id)).join('')}</div><div class="conversation-assistant"><span class="conversation-avatar assistant">C</span><div class="conversation-reply"><div class="conversation-meta"><span>Controller</span><span class="conversation-badge ${kind}">${label}</span></div><div class="conversation-text markdown-body">${renderRunOutput(run, output)}</div>${event && run.status === 'running' ? `<div class="conversation-event">${escapeHtml(event)}</div>` : ''}</div></div></article>`;
  }).join('') : '<div class="conversation-empty"><strong>这条对话还没有消息</strong><span>在下方输入一个研究请求，Controller 会在这里显示处理过程和回复。</span></div>';
  list.innerHTML = earlierRunButton() + list.innerHTML;
  restoreInstructionScroll(list, instructionScroll);
  typesetMath(list);
}
function renderAgentConversation(run, agentName) {
  const status = controllerRunStatus(run);
  const taskMatch = String(run.prompt || '').match(/\[BEGIN CURRENT RESEARCH TASK\]\s*([\s\S]*?)\s*\[END CURRENT RESEARCH TASK\]/);
  const initialTask = (taskMatch ? taskMatch[1] : run.userPrompt || run.prompt || '').trim();
  const userMessages = Array.isArray(run.userMessages) && run.userMessages.length
    ? (run.userMessages.some((message) => message.kind === 'initial') || !initialTask
        ? run.userMessages
        : [{ at: run.startedAt, kind: 'initial', text: initialTask }, ...run.userMessages])
    : [
        ...(initialTask ? [{ at: run.startedAt, kind: 'initial', text: initialTask }] : []),
        ...(run.events || []).filter((event) => event.kind === 'steer' && event.text).map((event) => ({ at: event.at, kind: 'steer', text: event.text }))
      ];
  const output = run.finalOutput || (run.status === 'running' ? '正在处理研究任务…' : '暂无回复');
  const event = runtimeActivity(run);
  return `<article class="conversation-turn agent-exchange"><div class="controller-user-stack">${userMessages.map((message, index) => renderControllerUserMessage(message, index, `分配给 ${escapeHtml(agentName)}`, run.id)).join('')}</div><div class="conversation-assistant"><span class="conversation-avatar assistant">A</span><div class="conversation-reply"><div class="conversation-meta"><span>${escapeHtml(agentName)}</span><span class="conversation-badge ${status[1]}">${status[0]}</span></div><div class="conversation-text markdown-body">${renderRunOutput(run, output)}</div>${event && run.status === 'running' ? `<div class="conversation-event">${escapeHtml(event)}</div>` : ''}</div></div></article>`;
}
function outputText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(outputText).filter(Boolean).join('\n\n');
  return typeof value.text === 'string' ? value.text : JSON.stringify(value, null, 2);
}
function runCopyText(run) {
  const messageText = (run?.outputItems || [])
    .filter((item) => item.type === 'agentMessage')
    .map((item) => item.data?.text || '')
    .filter(Boolean)
    .join('\n\n');
  return String(run?.finalOutput || messageText || '').trim();
}
async function copyText(value) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed'; textarea.style.opacity = '0';
  document.body.appendChild(textarea); textarea.select();
  try {
    if (!document.execCommand('copy')) throw new Error('copy failed');
  } finally { textarea.remove(); }
}
async function copyRunOutput(runId, button) {
  const run = state.project?.runs?.find((candidate) => candidate.id === runId);
  const text = runCopyText(run);
  if (!text) { showToast('当前还没有可复制的回复'); return; }
  button.disabled = true;
  try { await copyText(text); showToast('已复制回复内容'); }
  catch { showToast('复制失败，请手动选择文本复制'); }
  finally { button.disabled = false; }
}
const expandedReasoningRuns = new Set();
function renderReasoning(run, items) {
  const rawOnly = items.some(item => item.type === 'reasoning' && outputText(item.data?.content))
    && !items.some(item => item.type === 'reasoning' && outputText(item.data?.summary));
  const parts = items.filter(item => item.type === 'reasoning').map(item => {
    const data = item.data || {};
    const summary = outputText(data.summary);
    const content = outputText(data.content);
    return (summary ? renderMarkdown(summary) : '')
      + (content && content !== summary ? `${summary ? '<div class="runtime-reasoning-label">推理内容</div>' : ''}${renderMarkdown(content)}` : '');
  }).filter(Boolean);
  if (!parts.length) return '';
  const key = `${state.projectId || state.project?.id || ''}:${run.id}`;
  return `<details class="runtime-reasoning" data-reasoning-disclosure="${escapeHtml(key)}"${expandedReasoningRuns.has(key) ? ' open' : ''}><summary>${rawOnly ? '推理内容' : '推理摘要'}</summary><div class="runtime-reasoning-body markdown-body">${parts.join('<div class="runtime-reasoning-separator" aria-hidden="true"></div>')}</div></details>`;
}
function contextUsageMetrics(usage) {
  const valid = value => Number.isFinite(value) && value >= 0;
  const last = usage?.last || usage?.lastTokenUsage || (usage && !usage.total && !usage.totalTokenUsage ? usage : null);
  const total = last?.totalTokens ?? last?.total_tokens;
  const input = last?.inputTokens ?? last?.input_tokens;
  const output = last?.outputTokens ?? last?.output_tokens;
  const used = valid(total) ? total : valid(input) ? input + (valid(output) ? output : 0) : null;
  const reportedLimit = usage?.modelContextWindow ?? usage?.model_context_window;
  const limit = Number.isFinite(reportedLimit) && reportedLimit > 0 ? reportedLimit : null;
  const configured = usage?.configuredContextWindow;
  return { used, limit, percent: used !== null && limit !== null ? Math.round(used / limit * 100) : null,
    ...(Number.isFinite(configured) && configured > 0 ? { configuredWindow: configured } : {}) };
}
function currentContextUsage() {
  const project = state.project;
  const agent = selectedAgent();
  const target = agent?.id || 'controller';
  const name = agent?.displayName || 'Controller';
  const threadId = agent?.threadId || (!agent ? project?.controllerThreadId : null);
  const pending = state.modelSettingsPending;
  const model = pending && pending.projectId === project?.id ? pending.model : project?.model;
  if (!threadId) return { name, status: 'awaiting-usage', ...contextUsageMetrics(null) };
  const saved = project?.contextUsage?.[target];
  if (saved && saved.threadId === threadId) {
    if (saved.model && model && saved.model !== model) return { name, status: 'awaiting-model', ...contextUsageMetrics(null) };
    return { name, status: saved.status, ...contextUsageMetrics(saved.tokenUsage) };
  }
  const runs = (project?.runs || []).filter(run => (agent ? run.agentId === agent.id : !run.agentId)
    && (!threadId || run.threadId === threadId) && run.tokenUsage);
  runs.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
  const latest = runs[0];
  const compaction = project?.contextCompactions?.[target];
  if (compaction?.status === 'completed' && latest && String(compaction.completedAt || '') > String(latest.completedAt || latest.startedAt || '')) return { name, status: 'awaiting-usage', ...contextUsageMetrics(null) };
  const matchesModel = !latest?.requestSettings?.model || latest.requestSettings.model === model;
  return { name, status: 'ready', ...contextUsageMetrics(matchesModel ? latest?.tokenUsage : null) };
}
function compactTokenCount(value) {
  if (value >= 1000000) return `${Number((value / 1000000).toFixed(2))}m`;
  if (value >= 1000) return `${Number((value / 1000).toFixed(1))}k`;
  return String(Math.round(value));
}
function renderContextUsage() {
  const meter = $('#context-meter');
  if (!meter) return;
  const value = currentContextUsage();
  const button = $('#context-meter-button');
  const label = $('#context-meter-value');
  const tooltip = $('#context-meter-tooltip');
  meter.classList.toggle('hidden', !state.project || state.home);
  const percent = value.percent;
  label.textContent = percent === null ? value.configuredWindow ? `${compactTokenCount(value.configuredWindow)}` : '—' : `${percent}%`;
  meter.style.setProperty('--context-percent', String(Math.min(100, percent ?? 0)));
  meter.classList.toggle('is-high', percent !== null && percent >= 90);
  const updatedWindow = value.limit === null && Boolean(value.configuredWindow);
  const status = value.status === 'preparing' ? '正在整理上下文…' : value.status === 'preparation-failed' ? '上下文整理尚未完成' : updatedWindow ? '窗口已生效' : percent !== null ? `${percent}% 已用` : '用量统计中';
  const counts = value.used === null ? '' : `${updatedWindow ? '上轮用量' : '已用'} ${compactTokenCount(value.used)} 标记${value.limit === null ? '' : `，共 ${compactTokenCount(value.limit)}`}`;
  tooltip.innerHTML = `<div class="context-meter-heading">上下文窗口 · ${escapeHtml(value.name)}</div><div class="context-meter-status">${status}</div>${counts ? `<div class="context-meter-counts">${counts}</div>` : ''}${value.configuredWindow ? `<div class="context-meter-note">窗口 ${compactTokenCount(value.configuredWindow)}${value.limit !== null && value.limit !== value.configuredWindow ? `，运行器可用 ${compactTokenCount(value.limit)}` : ''}</div>` : ''}${updatedWindow ? '<div class="context-meter-note">后续模型调用后更新用量统计</div>' : value.used !== null && value.limit === null ? '<div class="context-meter-note">总容量暂未返回</div>' : ''}`;
  button.setAttribute('aria-label', `${value.name} 上下文窗口：${status}${counts ? '，' + counts : ''}`);
}
function missingFinalAnswer(run) {
  if (run.completion?.finalAnswer) return run.completion.finalAnswer === 'missing';
  const messages = (run.outputItems || []).filter(item => item.type === 'agentMessage' && item.data?.text?.trim());
  return messages.length > 0 && messages.every(item => item.data.phase === 'commentary');
}
function renderRunOutput(run, fallback = '') {
  const items = run.outputItems || [];
  const sections = items.map(item => {
    if (item.type === 'reasoning') return '';
    const toolItem = /tool|commandExecution|fileChange|webSearch|imageView|imageGeneration|codeExecution/i.test(item.type || '');
    if (toolItem) return '';
    const data = item.data || {};
    let body = '';
    if (item.type === 'agentMessage') body = renderMarkdown(data.text || '');
    else if (item.type === 'plan') {
      body = renderMarkdown(data.text || data.explanation || '');
      if (Array.isArray(data.plan)) body += `<ul class="runtime-plan">${data.plan.map(step => `<li>${step.status === 'completed' ? '✓ ' : ''}${escapeHtml(step.step || step.text || '')}</li>`).join('')}</ul>`;
    } else if (item.type !== 'error' && typeof data.text === 'string') body = renderMarkdown(data.text);
    if (!body) return '';
    return `<div class="runtime-response-text markdown-body" data-output-item="${escapeHtml(item.id)}">${body}</div>`;
  }).join('');
  const messageText = items.filter((item) => item.type === 'agentMessage').map((item) => item.data?.text || '').filter(Boolean).join('\n\n');
  const content = sections + (!messageText && run.finalOutput ? `<div class="runtime-response-text markdown-body">${renderMarkdown(run.finalOutput)}</div>` : '') || renderMarkdown(fallback);
  let notice = '';
  if (run.status === 'completed' && missingFinalAnswer(run)) notice = '<div class="runtime-output-notice">本轮已结束，未收到模型的最终答复。</div>';
  if (messageText && ['failed', 'interrupted'].includes(run.status) && run.finalOutput !== messageText) {
    const detail = messageText && run.finalOutput?.startsWith(messageText) ? run.finalOutput.slice(messageText.length) : run.finalOutput;
    if (detail) notice = `<div class="runtime-output-notice markdown-body">${renderMarkdown(detail)}</div>`;
  }
  const copyButton = ['completed', 'failed', 'interrupted'].includes(run.status) && runCopyText(run) ? `<button type="button" class="runtime-copy-button" data-copy-run="${escapeHtml(run.id)}">复制回复</button>` : '';
  return `<div class="runtime-output">${renderReasoning(run, items)}<div class="runtime-response-flow">${content}${notice}</div>${copyButton ? `<div class="runtime-output-actions">${copyButton}</div>` : ''}</div>`;
}
function earlierRunButton() {
  const bucket = conversationBucket();
  if (bucket) {
    const count = bucket.items.find(item => item.id === bucket.currentId)?.runCount || 0;
    return count > conversationRuns().length ? '<button type="button" class="outline-button load-run-history" data-load-run-history>加载更早的执行记录</button>' : '';
  }
  return state.project?.runCount > state.project?.runs?.length ? '<button type="button" class="outline-button load-run-history" data-load-run-history>加载更早的执行记录</button>' : '';
}
async function loadEarlierRuns() {
  const projectId = state.projectId;
  const bucket = conversationBucket();
  const source = bucket ? conversationRuns() : state.project?.runs;
  const lastId = source?.at(-1)?.id;
  if (!lastId) return;
  try {
    const data = await api(`/api/runs?beforeId=${encodeURIComponent(lastId)}${bucket ? '&conversationId=' + encodeURIComponent(bucket.currentId) : ''}`);
    if (state.projectId !== projectId) return;
    const ids = new Set(state.project.runs.map((run) => run.id));
    state.project.runs.push(...data.runs.filter((run) => !ids.has(run.id)));
    if (bucket) bucket.items.find(item => item.id === bucket.currentId).runCount = data.total;
    else state.project.runCount = data.total;
    render();
  } catch (error) { showToast(error.message); }
}
function renderTabs() {
  $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === state.activeTab));
  const content = $('#tab-content');
  if (state.activeTab === 'research') { window.ResearchPanel.mount({ ...researchUiContext(), container: content, isActive: () => state.activeView === 'research' && state.activeTab === 'research' }); return; }
  if (state.activeTab === 'progress') {
    const entries = [...state.project.progress].reverse();
    const help = '<p class="section-note tab-description">这里显示最近 50 次有记录的 Agent 任务，每次保留最新的进展说明，包括发现、遇到的问题和未解决部分。详细内容见 Agent 任务记录和资产库中的原始汇报。</p>';
    content.innerHTML = help + (entries.length ? `<div class="progress-history">${entries.map((entry) => `<article class="progress-history-item"><header class="progress-entry-head"><span class="progress-agent"><span class="progress-agent-dot" aria-hidden="true"></span>${escapeHtml(entry.agentName)}</span><time class="progress-time">${formatDateTime(entry.updatedAt || entry.at)}</time></header><div class="progress-history-message">${escapeHtml(entry.message)}</div></article>`).join('')}</div>` : '<div class="empty-section"><strong>还没有任务进展</strong><span>Agent 提交汇报后，这里显示该次任务的最新进展。</span></div>');
  } else if (state.activeTab === 'activity') {
    content.innerHTML = '<p class="section-note tab-description">最近 20 条操作与运行记录，包括创建 Agent、提交任务、启动、停止和提交汇报。</p>' + (state.project.activity.length ? state.project.activity.slice(0, 20).map((item) => `<div class="table-row"><span>${escapeHtml(friendlyActivity(item.message))}</span><span class="minor">${formatTime(item.at)}</span></div>`).join('') : '<div class="empty-section"><strong>还没有操作记录</strong><span>创建 Agent 或提交任务后，这里会记录相关操作。</span></div>');
  } else {
    if (!state.files) { content.innerHTML = '<div class="muted">正在读取当前项目文件…</div>'; loadFiles(); return; }
    const citation = String(state.citedFilePath || '').replace(/\\/g, '/').toLowerCase();
    const parent = (state.fileDir || '').split('/').slice(0, -1).join('/');
    const uploading = state.fileUpload?.projectId === state.projectId;
    const result = state.uploadResult?.projectId === state.projectId ? state.uploadResult : null;
    const downloading = state.fileDownload?.projectId === state.projectId;
    content.innerHTML = `<div class="file-toolbar"><div><p class="file-location">项目文件区 <span>/${escapeHtml(state.fileDir || '')}</span></p><p class="section-note">上传文件统一保存到 <button type="button" class="text-button" data-file-directory="upload">upload/</button>，同名文件不覆盖。</p></div><div class="file-actions"><button type="button" class="outline-button" data-file-refresh>刷新</button><button type="button" class="outline-button" data-file-archive ${state.fileDownload ? 'disabled' : ''}>${downloading ? '正在打包并下载…' : '下载整个项目 · ZIP'}</button><button type="button" class="primary-button" data-file-upload ${state.fileUpload ? 'disabled' : ''}>上传文件</button></div></div><p class="file-limit section-note">可多选 · 单文件上限 ${formatFileSize(state.fileLimits?.uploadBytes || 100 * 1024 * 1024)}</p><div class="file-upload-progress ${uploading ? '' : 'hidden'}" aria-live="polite"><div><span data-file-upload-status></span><button type="button" class="text-button" data-file-cancel>取消上传</button></div><progress max="100" value="${state.fileUpload?.progress || 0}"></progress></div>${result ? `<div class="file-upload-result ${result.errors.length ? 'has-errors' : ''}" role="status"><strong>${escapeHtml(result.text)}</strong>${result.errors.map(message => `<p>${escapeHtml(message)}</p>`).join('')}</div>` : ''}${state.fileDir ? `<button type="button" class="outline-button file-up" data-file-directory="${escapeHtml(parent)}">返回上一级</button>` : ''}` + (state.files.length ? state.files.map((file) => {
      if (file.type === 'directory') return `<button type="button" class="table-row file-directory" data-file-directory="${escapeHtml(file.path)}"><span>▣ ${escapeHtml(file.name)}</span><span>打开文件夹 →</span></button>`;
      const href = `/api/files/download?projectId=${encodeURIComponent(state.projectId)}&path=${encodeURIComponent(file.path)}`;
      const cited = citation && (file.path.toLowerCase() === citation || citation.endsWith('/' + file.path.toLowerCase()));
      return `<div class="table-row project-file-row ${cited ? 'cited-file' : ''}" data-project-file="${escapeHtml(file.path)}"><span class="file-path">□ ${escapeHtml(file.name || file.path)}</span><span class="file-download-actions"><span class="minor">${formatFileSize(file.size)}</span><a class="file-download" href="${escapeHtml(href)}" download="${escapeHtml(file.name || '')}">下载</a><button type="button" class="file-delete" data-file-delete="${escapeHtml(file.path)}">删除</button></span></div>`;
    }).join('') : '<div class="empty-files"><strong>当前文件夹暂无文件</strong><span>可以上传研究资料，或查看研究过程中生成的文件。</span></div>');
    content.querySelector('.file-limit').insertAdjacentHTML('beforebegin', renderProjectStorage());
    updateUploadProgress();
    requestAnimationFrame(() => content.querySelector('.cited-file')?.scrollIntoView({ block: 'center' }));
  }
}
async function loadFiles(directory = state.fileDir || '') {
  const projectId = state.projectId;
  const generation = state.fileLoadGeneration = (state.fileLoadGeneration || 0) + 1;
  try {
    const result = await api(`/api/files?path=${encodeURIComponent(directory)}`);
    if (state.projectId !== projectId || state.fileLoadGeneration !== generation) return;
    state.files = result.files; state.fileDir = result.directory; state.fileLimits = result.limits; state.fileStorage = result.storage;
    if (state.activeTab === 'files') renderTabs();
  } catch (error) { if (state.projectId === projectId && state.fileLoadGeneration === generation) showToast(error.message); }
}
function formatFileSize(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const unit = bytes < 1024 * 1024 ? 'KB' : bytes < 1024 * 1024 * 1024 ? 'MB' : 'GB';
  const divisor = unit === 'KB' ? 1024 : unit === 'MB' ? 1024 * 1024 : 1024 * 1024 * 1024;
  return `${Number((bytes / divisor).toFixed(1))} ${unit}`;
}
function renderProjectStorage() {
  const usage = state.fileStorage;
  if (!usage) return '';
  const percent = Math.min(100, Math.max(0, usage.usedBytes / usage.limitBytes * 100));
  const note = usage.kind === 'kernel' ? '按项目文件区实际占用的磁盘空间统计；1 MB = 1,048,576 字节' : '1 MB = 1,048,576 字节；计入上传文件与 Agent 生成的文件';
  return `<div class="project-storage ${percent >= 90 ? 'nearly-full' : ''}" title="${note}"><div><strong>项目容量${percent >= 100 ? ' · 已满，请清理文件' : ''}</strong><span>已用 ${formatFileSize(usage.usedBytes)} / ${formatFileSize(usage.limitBytes)} · 剩余 ${formatFileSize(usage.remainingBytes)}</span></div><progress max="100" value="${percent}" aria-label="项目文件区已用空间"></progress></div>`;
}
let filePickerContext = null;
function cancelFileTransfers() {
  if (state.fileUpload) { state.fileUpload.cancelled = true; state.fileUpload.xhr?.abort(); }
  state.fileDownload?.controller.abort();
  filePickerContext = null;
}
function updateUploadProgress() {
  const transfer = state.fileUpload;
  if (!transfer || transfer.projectId !== state.projectId) return;
  const label = $('[data-file-upload-status]'), progress = $('.file-upload-progress progress');
  if (label) label.textContent = `${transfer.index + 1} / ${transfer.total} · ${transfer.fileName} · ${transfer.progress === 100 ? '正在保存…' : transfer.progress + '%'}`;
  if (progress) progress.value = transfer.progress;
}
function uploadOneFile(file, transfer) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); transfer.xhr = xhr;
    xhr.open('POST', `/api/files/upload?projectId=${encodeURIComponent(transfer.projectId)}&name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('x-deepmath-project-id', transfer.projectId);
    xhr.timeout = 5 * 60 * 1000;
    xhr.upload.onprogress = event => { transfer.progress = event.lengthComputable ? Math.round(event.loaded / event.total * 100) : 0; updateUploadProgress(); };
    xhr.onload = () => {
      let data = {}; try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status === 201) resolve(data.file);
      else reject(new Error(data.error || `上传失败（${xhr.status}）`));
    };
    xhr.onerror = () => reject(new Error('网络连接中断，请检查文件列表后重新操作'));
    xhr.ontimeout = () => reject(new Error('上传超时，请检查文件列表后重新操作'));
    xhr.onabort = () => reject(new Error('已取消上传'));
    xhr.send(file);
  });
}
async function uploadProjectFiles(selected, context) {
  if (!selected.length || !context || state.fileUpload || !state.authenticated || state.user?.username !== context.username) return;
  const transfer = { ...context, total: selected.length, index: 0, fileName: '', progress: 0, cancelled: false };
  state.fileUpload = transfer; state.uploadResult = null;
  const errors = []; let completed = 0;
  try {
    for (let index = 0; index < selected.length && !transfer.cancelled; index++) {
      const file = selected[index]; Object.assign(transfer, { index, fileName: file.name, progress: 0 });
      if (state.activeTab === 'files') renderTabs();
      try {
        if (file.size > context.maxBytes) throw new Error(`单个文件不能超过 ${formatFileSize(context.maxBytes)}`);
        await uploadOneFile(file, transfer); completed++;
      } catch (error) { if (!transfer.cancelled) errors.push(`${file.name}：${error.message}`); }
    }
  } finally {
    if (state.fileUpload === transfer) state.fileUpload = null;
    if (state.authenticated && state.user?.username === context.username) {
      const text = `${transfer.cancelled ? '上传已取消，' : ''}已上传 ${completed} / ${selected.length} 个文件到 ${context.projectName} / upload/`;
      state.uploadResult = { projectId: context.projectId, text, errors };
      if (state.projectId === context.projectId) await loadFiles(completed ? 'upload' : state.fileDir || '');
      showToast(errors.length ? '部分文件上传失败，请查看文件区提示' : text);
    }
  }
}
async function downloadProjectArchive() {
  if (!state.projectId || state.fileDownload) return;
  const transfer = { projectId: state.projectId, username: state.user?.username, controller: new AbortController() };
  const projectName = state.project?.name || 'project';
  state.fileDownload = transfer; renderTabs();
  try {
    const response = await fetch(`/api/files/archive?projectId=${encodeURIComponent(transfer.projectId)}`, { signal: transfer.controller.signal });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `下载失败（${response.status}）`);
    }
    const blob = await response.blob();
    if (!state.authenticated || state.user?.username !== transfer.username) return;
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = projectName.replace(/[\\/\x00-\x1f]/g, '_') + '.zip';
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (error) { if (error.name !== 'AbortError') showToast(error.message); }
  finally { if (state.fileDownload === transfer) state.fileDownload = null; if (state.authenticated && state.activeTab === 'files') renderTabs(); }
}
async function deleteProjectFile(relative) {
  const projectId = state.projectId;
  if (!projectId || !window.confirm(`确定永久删除“${relative}”吗？此操作无法撤销。`)) return;
  try {
    await api(`/api/files?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(relative)}`, { method: 'DELETE', headers: { 'x-deepmath-project-id': projectId } });
    if (state.projectId === projectId) await loadFiles();
    showToast('文件已删除，项目容量已更新');
  } catch (error) { showToast(error.message); }
}
async function loadProjects() {
  try {
    state.projects = (await api('/api/projects')).projects || [];
    state.projectsError = '';
    renderHome();
    const list = $('#project-list');
    list.innerHTML = state.projects.length ? state.projects.map((project) => {
      const available = project.stateReadable !== false && project.workspaceAvailable !== false;
      const status = project.automationState === 'running' ? '自动运行中' : project.runningAgentCount ? `${project.runningAgentCount} 个 Agent 运行中` : '';
      const detail = project.stateReadable === false ? '状态文件需要恢复' : available ? `${status ? `${status} · ` : ''}${project.workspacePath}` : `${project.workspacePath || '原项目文件夹'} · 暂时不可用`;
      return `<button type="button" class="project-option ${project.id === state.project?.id ? 'current' : ''} ${available ? '' : 'unavailable'}" ${available ? `data-project-id="${escapeHtml(project.id)}" data-project-name="${escapeHtml(project.name)}"` : 'disabled'}><span class="project-option-main"><strong>${escapeHtml(project.name)}</strong><small>${escapeHtml(detail)}</small></span><span class="project-option-meta">${available ? `${project.agentCount} 个研究 Agent` : '无法打开'}</span></button>`;
    }).join('') : '<div class="empty-projects">还没有已保存的项目，请在下方选择一个本地文件夹。</div>';
    $$('#project-list .project-option').forEach((button) => button.addEventListener('click', async () => {
      await openSavedProject(button.dataset.projectId, button.dataset.projectName); $('#project-dialog').close();
    }));
  } catch (error) {
    state.projectsError = error.message;
    renderHome();
    const list = $('#project-list');
    if (list) list.innerHTML = `<div class="empty-projects">项目列表暂时无法读取：${escapeHtml(error.message)}</div>`;
    showToast(error.message);
  }
}
async function openSavedProject(projectId, name) {
  if (pendingProjectOpen?.projectId === projectId) return pendingProjectOpen.promise;
  if (!pendingProjectOpen && !state.home && state.project?.id === projectId) {
    state.selectedAgentId = null; state.activeView = 'overview'; render(); return;
  }
  cancelProjectOpen();
  const request = { projectId, promise: null, controller: new AbortController() };
  pendingProjectOpen = request;
  request.promise = (async () => {
    try {
      const project = await api('/api/project', { method: 'POST', body: JSON.stringify({ projectId }), signal: request.controller.signal });
      if (pendingProjectOpen !== request) return;
      if (project?.id !== projectId) throw new Error('项目响应不匹配，请刷新后重新操作');
      selectViewedProject(project);
      state.home = false; state.selectedAgentId = null; state.activeView = 'overview'; state.files = null; state.activeTab = 'progress';
      // The open response is already the full project snapshot. SSE keeps it
      // current; another GET here delays the toast and repeats slow work.
      render(); showToast(`已打开项目：${name}`);
    } catch (error) { if (pendingProjectOpen === request) showToast(error.message); }
    finally { if (pendingProjectOpen === request) pendingProjectOpen = null; }
  })();
  return request.promise;
}
function openProjectDialog() { $('#project-dialog').showModal(); $('#project-title').value = ''; loadProjects(); }
function renderContext() {
  const agent = selectedAgent();
  if (agent) {
    const currentRun = state.project.runs.find((run) => run.id === agent.currentRunId && run.agentId === agent.id && run.status === 'running');
    const latestProgress = [...state.project.progress].reverse().find((entry) => entry.agentId === agent.id);
    const stateText = agent.lifecycleState === 'Running'
      ? (currentRun ? '当前任务正在执行。' : 'Agent 显示为进行中，但当前任务记录暂不可见。')
      : agent.lifecycleState === 'Paused' ? '已暂停接收新任务。'
      : agent.lifecycleState === 'Attention' ? '当前任务需要处理。'
      : '当前没有正在执行的任务，可以接收新任务。';
    const currentTask = currentRun ? `<div class="context-block"><div class="context-label">当前指令</div><div class="context-value">${escapeHtml(currentRun.userPrompt || '当前指令未记录。')}</div></div>` : '';
    const lastActivity = currentRun && agent.currentAction ? `<div class="context-block"><div class="context-label">最近活动</div><div class="context-value">${escapeHtml(friendlyAction(agent.currentAction))}</div></div>` : '';
    const progressSource = currentRun
      ? (latestProgress?.runId === currentRun.id ? '来自当前任务' : '来自之前的任务，并非当前任务进展')
      : '来自最近一次有记录的任务';
    const progressBlock = latestProgress ? `<div class="context-block"><div class="context-label">最近任务进展 · ${escapeHtml(progressSource)}</div><div class="context-value">${escapeHtml(latestProgress.generated ? `系统记录：${latestProgress.message}` : latestProgress.message)}</div></div>` : '';
    $('#context-content').innerHTML = `<div class="context-block"><div class="context-label">当前项目</div><div class="context-value role">${escapeHtml(state.project.name)}</div></div><div class="context-block"><div class="context-label">当前研究 Agent</div><div class="context-value role">${escapeHtml(agent.displayName)}</div></div><div class="context-actions"><button class="outline-button profile-edit-button" data-edit-profile>编辑研究配置</button><button class="outline-button danger-button" data-delete-agent>删除 Agent</button></div><div class="context-divider"></div><div class="context-block"><div class="context-label">当前状态</div><div class="context-value">${escapeHtml(stateText)}</div></div>${currentTask}${lastActivity}${progressBlock}${agent.pendingMessages?.length ? `<div class="context-block"><div class="context-label">暂存任务</div><div class="context-value">${agent.pendingMessages.length} 条任务会在恢复后继续处理。</div></div>` : ''}${agent.attention ? `<div class="attention-box"><div class="context-label">需要处理</div><div class="context-value">${escapeHtml(agent.attention.message)}</div>${agent.attention.error ? `<div class="minor" style="margin-top:8px">${escapeHtml(agent.attention.error)}</div>` : ''}<button class="action-button" data-action="attention" style="margin-top:10px">标记为已处理</button></div>` : ''}<div class="context-divider"></div><div class="context-block"><div class="context-label">如何分配任务</div><div class="context-value">在下方输入框中输入 @，从列表中选择这个 Agent；也可以直接提交自然语言任务。</div></div>`;
  } else {
    $('#context-content').innerHTML = `<div class="context-block"><div class="context-label">项目总览</div><div class="context-value role">${escapeHtml(state.project.name)}</div></div><div class="context-block"><div class="context-value muted">这里显示 Agent 状态、最近任务进展和项目文件。研究资产库按专题组织可复用内容，并保留原始汇报。研究现状与计划可在项目总览查看。点击某个 Agent 可查看它的任务与回复。</div></div><div class="context-divider"></div><div class="context-block"><div class="context-label">开始研究</div><div class="context-value">在下方输入研究任务即可开始。需要指定 Agent 时，输入 @，然后从列表中选择。</div></div>`;
  }
  $('#context-content').querySelector('[data-action="attention"]')?.addEventListener('click', () => agentAction('attention', agent));
  $('#context-content').querySelector('[data-edit-profile]')?.addEventListener('click', () => openAgentDialog(agent));
  // Keep destructive management next to the profile controls, but require a
  // native confirmation before the request is sent.
  $('#context-content').querySelector('[data-delete-agent]')?.addEventListener('click', () => deleteAgent(agent));
}
function agentActionLabel(agent) {
  if (agent.lifecycleState === 'Running') return ['pause', '暂停并停止当前任务'];
  if (agent.lifecycleState === 'Paused') return ['resume', '恢复接收任务'];
  if (agent.lifecycleState === 'Attention') return ['attention', '处理任务问题'];
  return ['pause', '暂停接收任务'];
}
function renderAgentView() {
  const agent = selectedAgent(); const dashboard = $('#dashboard-view'); const view = $('#agent-view'); const bottom = $('#bottom-section');
  dashboard.classList.toggle('hidden', Boolean(agent)); view.classList.toggle('hidden', !agent); bottom.classList.toggle('hidden', Boolean(agent));
  if (!agent) return;
  const instructionScroll = captureInstructionScroll(view);
  ensureConversationRuns(agent.id);
  const runs = conversationRuns(agent.id).slice().reverse();
  const [action, label] = agentActionLabel(agent);
  const helper = agent.lifecycleState === 'Running' ? '会停止当前任务，并暂停接收新任务。' : agent.lifecycleState === 'Paused' ? '恢复后继续处理暂存任务。' : '暂停后，新任务会暂存；恢复后继续处理。';
  const skillItems = Array.isArray(agent.skills) && agent.skills.length ? agent.skills : ['按任务选择合适的方法'];
  const directionLine = String(agent.researchContent || '已配置长期研究方向与目标').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '已配置长期研究方向与目标';
  const savedCompaction = state.project.contextCompactions?.[agent.id];
  const compaction = !agent.threadId || savedCompaction?.threadId === agent.threadId ? savedCompaction : null;
  view.innerHTML = `<div class="agent-breadcrumb"><button type="button" data-back-overview>项目总览</button><span>/</span><strong>${escapeHtml(agent.displayName)}</strong></div>
    <div class="agent-header"><div class="agent-title"><span class="agent-icon ${statusClass(agent.lifecycleState)}" style="font-size:18px">${statusIcon(agent.lifecycleState)}</span><div><div class="eyebrow">当前项目的研究 Agent</div><h1>${escapeHtml(agent.displayName)}</h1><p class="agent-direction-line">${escapeHtml(directionLine)}</p></div></div><div class="agent-action-wrap"><button class="action-button" data-edit-profile>编辑研究配置</button><button class="action-button" data-action="${action}">${label}</button><button class="outline-button" data-compact-agent ${agent.lifecycleState !== 'Running' && compaction?.status !== 'running' ? '' : 'disabled'}>${compaction?.status === 'running' ? (modelProcessingText(compaction) || '压缩中…') : '压缩上下文'}</button><button class="action-button danger-button" data-delete-agent>删除 Agent</button><span class="action-help">${helper}</span>${compaction?.status === 'completed' ? '<span class="action-help">上下文已压缩，研究记录保留。</span>' : compaction?.status === 'failed' ? `<span class="action-help">压缩失败：${escapeHtml(compaction.error)}</span>` : ''}</div></div>
    <div class="profile-summary"><section class="profile-section"><div class="profile-section-label"><span>01</span><div><strong>长期研究方向与目标</strong><small>每次接收任务时使用的研究背景</small></div></div><div class="profile-copy markdown-body">${renderMarkdown(agent.researchContent || '完成分配的研究任务')}</div></section>
    <section class="profile-section"><div class="profile-section-label"><span>02</span><div><strong>研究方法或技能</strong><small>可采用的方法和工作说明</small></div></div><div class="profile-skill-list">${skillItems.map((skill) => `<span class="profile-skill">${escapeHtml(skill)}</span>`).join('')}</div></section>
    ${agent.instructions ? `<section class="profile-section profile-instructions"><div class="profile-section-label"><span>03</span><div><strong>长期要求</strong><small>每次研究都需要遵守的要求</small></div></div><div class="profile-copy markdown-body">${renderMarkdown(agent.instructions)}</div></section>` : ''}</div>
    <div class="section-header agent-records-head"><div><h2>任务与回复</h2><p class="section-note">查看当前对话的任务和回复。</p></div>${conversationControls(agent.id)}</div><div class="conversation-list">${earlierRunButton()}${runs.length ? runs.map((run) => renderAgentConversation(run, agent.displayName)).join('') : `<div class="conversation-empty"><strong>这条对话还没有消息</strong><span>直接在下方输入框提交任务即可。</span></div>`}</div>`;
  restoreInstructionScroll(view, instructionScroll);
  view.querySelector('[data-back-overview]')?.addEventListener('click', showProjectOverview);
  view.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', () => agentAction(button.dataset.action, agent)));
  view.querySelector('[data-edit-profile]')?.addEventListener('click', () => openAgentDialog(agent));
  view.querySelector('[data-compact-agent]')?.addEventListener('click', () => compactContext(agent));
  view.querySelector('[data-delete-agent]')?.addEventListener('click', () => deleteAgent(agent));
  typesetMath(view);
}
function renderRun(run) {
  const status = run.status === 'completed' ? '✓ 本次执行结束' : run.status === 'interrupted' ? '■ 已停止' : run.status === 'failed' ? '! 需要处理' : '⟳ 进行中';
  return `<article class="run-card"><div class="run-head"><div><span class="run-title">任务 ${escapeHtml(run.id.replace('run_', '#'))}</span><span class="run-badge ${run.status === 'interrupted' || run.status === 'failed' ? 'interrupted' : ''}" style="margin-left:10px">${status}</span></div><span class="run-time">${run.status === 'running' ? formatDuration(run.startedAt) : formatDuration(run.startedAt, run.completedAt)} · ${formatTime(run.completedAt || run.startedAt)}</span></div><div class="run-body"><div class="eyebrow" style="margin-bottom:10px">任务目标</div><div class="muted" style="margin-bottom:17px">${escapeHtml(run.userPrompt || run.prompt)}</div><div class="eyebrow" style="margin-bottom:10px">执行回复</div><div class="run-output">${renderRunOutput(run, '正在处理…')}</div>${run.events?.length ? `<details class="run-events"><summary>查看处理过程</summary>${run.events.map((event) => `<div class="run-event">${formatTime(event.at)} · ${escapeHtml(friendlyEvent(event.text))}</div>`).join('')}</details>` : ''}${run.diff ? `<details class="run-events"><summary>查看文件变化</summary><pre class="run-output">${escapeHtml(run.diff)}</pre></details>` : ''}<div class="run-events" style="display:flex;gap:14px"><span>${run.toolCalls || 0} 次工具或执行活动</span><span>${run.fileChanges || 0} 次文件变更活动</span><span>${run.subagents || 0} 个协作 Agent</span></div></div></article>`;
}
async function agentAction(action, agent) {
  try {
    if (action === 'pause') await api(`/api/agents/${agent.id}/pause`, { method: 'POST', body: JSON.stringify({ conversationId: conversationBucket(agent.id)?.currentId }) });
    if (action === 'resume') await api(`/api/agents/${agent.id}/resume`, { method: 'POST', body: JSON.stringify({ requestSettings: composerRequestSettings(), conversationId: conversationBucket(agent.id)?.currentId }) });
    if (action === 'attention') await api(`/api/agents/${agent.id}/attention`, { method: 'POST', body: '{}' });
    showToast(`${agent.displayName} ${action === 'pause' ? '已暂停接收任务' : action === 'attention' ? '已标记为处理完成' : '已恢复接收任务'}`);
    await reload();
  } catch (error) { showToast(error.message); }
}
async function deleteAgent(agent) {
  if (!agent) return;
  const message = agent.lifecycleState === 'Running'
    ? `“${agent.displayName}”正在处理任务。删除会先停止当前任务，再移除这个 Agent 及其历史任务记录。确定继续吗？`
    : `确定删除“${agent.displayName}”吗？这会移除它及其历史任务记录，且无法从界面恢复。`;
  if (!window.confirm(message)) return;
  try {
    await api(`/api/agents/${encodeURIComponent(agent.id)}`, { method: 'DELETE' });
    state.selectedAgentId = null; state.activeView = 'overview';
    await reload();
    showToast(`已删除研究 Agent：${agent.displayName}`);
  } catch (error) { showToast(error.message); }
}
async function stopController() {
  await stopConversationRun('controller');
}
async function stopConversationRun(target) {
  const run = activeConversationRun(target), projectId = state.projectId;
  if (!run || state.project?.id !== projectId || state.stoppingRunId === run.id) return;
  state.stoppingRunId = run.id;
  renderStopButtons();
  try {
    const path = target === 'controller' ? '/api/controller/stop' : `/api/agents/${encodeURIComponent(target)}/stop`;
    await api(path, { method: 'POST', headers: { 'x-deepmath-project-id': projectId }, body: JSON.stringify({ runId: run.id, conversationId: run.conversationId }) });
    if (state.projectId === projectId) { await reload(); showToast('当前请求已停止'); }
  } catch (error) { if (state.projectId === projectId) showToast(error.message); }
  finally {
    if (state.stoppingRunId === run.id) state.stoppingRunId = null;
    renderStopButtons();
  }
}
async function compactContext(agent = null) {
  const button = agent ? $('#agent-view [data-compact-agent]') : $('#compact-controller');
  if (button) button.disabled = true;
  try {
    const path = agent ? `/api/agents/${encodeURIComponent(agent.id)}/compact` : '/api/controller/compact';
    await api(path, { method: 'POST', body: JSON.stringify({ conversationId: conversationBucket(agent?.id || 'controller')?.currentId }) });
    showToast(`${agent ? agent.displayName : 'Controller'} 已开始压缩上下文`);
    await reload();
    return true;
  } catch (error) {
    showToast(error.message);
    if (button) button.disabled = false;
    return false;
  }
}
async function stopCurrentAgentRun() {
  const agent = selectedAgent();
  if (agent) await stopConversationRun(agent.id);
}
async function toggleAutomation() {
  const automation = state.project?.automation || { state: 'paused', goal: '' };
  const button = $('#automation-toggle'); const goal = $('#automation-goal').value.trim();
  if (automation.state !== 'running' && !goal) { showToast('请先填写项目总体研究目标'); $('#automation-goal').focus(); return; }
  button.disabled = true;
  try {
    const nextState = automation.state === 'running' ? 'paused' : 'running';
    await api('/api/automation', { method: 'POST', body: JSON.stringify({ state: nextState, goal, requestSettings: composerRequestSettings(), reason: nextState === 'paused' ? '用户暂停了自动运行。' : '' }) });
    showToast(nextState === 'running' ? 'Controller 自动运行已启动' : '自动运行已暂停；当前 Turn 可以正常结束');
    await reload();
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; }
}
async function sendPrompt() {
  if ($('#send').disabled) return;
  const prompt = $('#prompt'); const text = prompt.value.trim();
  if (!text) { showToast('请先输入研究任务'); prompt.focus(); return; }
  if (text === '/compact') {
    if (await compactContext(selectedAgent())) { prompt.value = ''; autoSize(prompt); hideMentionMenu(); }
    return;
  }
  $('#send').disabled = true;
  // Read the displayed controls before render/reload can replace project state.
  // The task carries its own selection even if its background save is pending.
  const requestSettings = composerRequestSettings();
  const selected = selectedAgent();
  const selectedMention = /(?:^|[\s([{，。！？、])@[^\s@]+/u.test(text);
  // Enter the conversation before waiting for the server, so a slow runtime
  // never leaves the user wondering whether the request was accepted.
  if (!selected || selectedMention) { state.selectedAgentId = null; state.activeView = 'conversation'; state.scrollConversationToEnd = true; state.conversationFollowEnd = true; render(); }
  try {
    const agent = selected;
    const explicitMention = selectedMention;
    let response;
    if (agent && !explicitMention) {
      response = await api(`/api/agents/${encodeURIComponent(agent.id)}/run`, { method: 'POST', body: JSON.stringify({ prompt: text, requestSettings, conversationId: conversationBucket(agent.id)?.currentId }) });
      showToast(`任务已发送给 ${agent.displayName}`);
    } else {
      response = await api('/api/input', { method: 'POST', body: JSON.stringify({ text, requestSettings, ...(explicitMention
        ? { conversationIds: Object.fromEntries(Object.entries(state.project.conversations || {}).map(([target, bucket]) => [target, bucket.currentId])) }
        : { conversationId: conversationBucket('controller')?.currentId }) }) });
      showToast(response?.mode === 'controller-steer' ? '追加指令已发送给当前 Controller' : '研究任务已提交');
    }
    prompt.value = ''; autoSize(prompt); hideMentionMenu();
    const routedAgentId = response?.command?.agent?.id || response?.agent?.id || response?.run?.agentId;
    if (response?.mode === 'controller' || response?.mode === 'controller-steer') { state.selectedAgentId = null; state.activeView = 'conversation'; state.scrollConversationToEnd = true; state.conversationFollowEnd = true; }
    else if (explicitMention && routedAgentId) { state.selectedAgentId = routedAgentId; state.activeView = 'agent'; state.scrollConversationToEnd = true; state.conversationFollowEnd = true; }
    await reload();
  }
  catch (error) { showToast(error.message); }
  finally { $('#send').disabled = false; }
}
async function loadModels() {
  try { state.models = (await api('/api/models')).models || []; renderModelPicker(); }
  catch (error) { showToast(error.message); }
}
function renderModelConfiguration(config) {
  const content = $('#model-config-content');
  if (!content) return;
  const models = Array.isArray(config?.models) ? config.models : [];
  const baseUrl = config?.modelBaseUrl || '未填写';
  const cards = models.map(model => {
    const efforts = model.reasoningEffortSupported === false ? '模型默认' : (model.configurableReasoningEfforts || []).map(item => item.reasoningEffort).join('、') || '未配置';
    const budget = model.maxOutputTokens ? `${Number(model.maxOutputTokens).toLocaleString('zh-CN')} tokens` : '按上游默认值';
    return `<article class="model-config-card"><div class="model-config-card-head"><strong>${escapeHtml(model.displayName || model.id)}</strong>${model.isDefault ? '<span class="model-config-default">默认</span>' : ''}</div><dl><div><dt>ID</dt><dd>${escapeHtml(model.id || '')}</dd></div><div><dt>部署名</dt><dd>${escapeHtml(model.apiModel || model.model || '')}</dd></div><div><dt>接口模式</dt><dd>${escapeHtml(model.apiMode || 'responses')}</dd></div><div><dt>推理档位</dt><dd>${escapeHtml(efforts)}</dd></div><div><dt>输出预算</dt><dd>${escapeHtml(budget)}</dd></div></dl>${model.description ? `<p>${escapeHtml(model.description)}</p>` : ''}</article>`;
  }).join('');
  content.innerHTML = `<div class="model-config-summary"><div><span>默认模型</span><strong>${escapeHtml(config?.defaultModel || '未配置')}</strong></div><div><span>连接地址</span><strong>${escapeHtml(baseUrl)}</strong></div><div><span>运行模式</span><strong>${escapeHtml(config?.runtimeMode || 'real')}</strong></div><div><span>Key</span><strong>${config?.credentialsConfigured ? '已配置' : '未配置'}</strong></div></div><div class="model-config-list">${cards || '<div class="muted">没有可用模型，请检查 .env。</div>'}</div><p class="model-config-note">修改模型、推理档位或输出预算后，重启工作台使配置生效。</p>`;
}
async function openModelConfiguration() {
  const dialog = $('#model-config-dialog');
  const content = $('#model-config-content');
  if (!dialog || !content) return;
  content.innerHTML = '<div class="muted">正在读取模型配置…</div>';
  dialog.showModal();
  try { renderModelConfiguration(await api('/api/model-config')); }
  catch (error) { content.innerHTML = `<div class="model-config-error">${escapeHtml(error.message)}</div>`; }
}
function mergeRunHistory(project) {
  if (project?.id && project.id === state.project?.id) {
    const ids = new Set(project.runs.map((run) => run.id));
    project.runs.push(...state.project.runs.filter((run) => !ids.has(run.id)));
  }
}
function selectViewedProject(project) {
  if (project?.id !== state.projectId) state.fileDir = '';
  mergeRunHistory(project);
  state.project = project;
  state.projectId = project?.id || '';
  if (state.projectId) sessionStorage.setItem('deepmath-v3-project-id', state.projectId);
  else sessionStorage.removeItem('deepmath-v3-project-id');
  connectEvents();
}
async function reload(options = {}) {
  const firstProjectLoad = !state.project;
  const revision = streamViewRevision;
  let requestedId = state.projectId;
  let project;
  try { project = await api('/api/project', { signal: options.signal }); }
  catch (error) {
    if (options.signal?.aborted) throw error;
    if (!requestedId || state.project) throw error;
    state.projectId = ''; sessionStorage.removeItem('deepmath-v3-project-id'); requestedId = '';
    project = await api('/api/project', { signal: options.signal });
  }
  if (options.signal?.aborted || state.projectId !== requestedId) return;
  // A delayed full GET cannot replace a more recent streamed state.
  if (state.project && revision !== streamViewRevision) return;
  selectViewedProject(project);
  if (!state.project) { state.home = true; state.selectedAgentId = null; }
  else if (firstProjectLoad) state.home = false;
  if (state.selectedAgentId && !selectedAgent()) state.selectedAgentId = null;
  if (state.project) renderHeader();
  render();
}
let scheduledReload = null;
let runtimeReload = null;
let runtimeReloadPending = false;
function cancelRuntimeReload() {
  clearTimeout(scheduledReload); scheduledReload = null;
  runtimeReloadPending = false;
  const request = runtimeReload; runtimeReload = null;
  request?.controller.abort();
}
function scheduleRuntimeReload() {
  state.files = null;
  if (!state.authenticated) return;
  // Keep one refresh in flight on slow connections. Events arriving during it
  // request one trailing refresh, including the final completed response.
  runtimeReloadPending = true;
  if (scheduledReload || runtimeReload) return;
  const projectId = state.projectId;
  scheduledReload = setTimeout(async () => {
    scheduledReload = null;
    if (!state.authenticated || state.projectId !== projectId) { runtimeReloadPending = false; return; }
    runtimeReloadPending = false;
    const request = { controller: new AbortController() };
    runtimeReload = request;
    try { await reload({ signal: request.controller.signal }); }
    catch {}
    finally {
      if (runtimeReload === request) {
        runtimeReload = null;
        if (runtimeReloadPending) scheduleRuntimeReload();
      }
    }
  }, 200);
}
let eventSource = null;
let eventProjectId = null;
let streamViewRevision = 0;
let streamRenderTimer = null;
function cancelStreamRender() { clearTimeout(streamRenderTimer); streamRenderTimer = null; }
function acceptStreamProject(source, project, immediate = false) {
  if (eventSource !== source) return;
  const visible = project ? { ...project, runs: [...project.runs],
    contextCompactions: { ...project.contextCompactions },
    conversations: Object.fromEntries(Object.entries(project.conversations || {}).map(([target, bucket]) =>
      [target, { ...bucket, items: (bucket.items || []).map(item => ({ ...item })) }])) } : null;
  // Keep the transport baseline separate from locally paged history and
  // optimistic model settings. Output is retained verbatim.
  mergeRunHistory(visible); state.project = visible; state.connected = true;
  streamViewRevision++;
  if (state.selectedAgentId && !selectedAgent()) state.selectedAgentId = null;
  if (immediate) { cancelStreamRender(); render(); }
  else if (!streamRenderTimer) streamRenderTimer = setTimeout(() => {
    streamRenderTimer = null;
    if (eventSource === source && state.authenticated) render();
  }, 50);
}
function recoverProjectStream(source) {
  if (eventSource !== source) return;
  source.close(); eventSource = null; eventProjectId = null;
  state.connected = false; connectEvents();
}
function pauseProjectEvents() {
  cancelRuntimeReload(); cancelStreamRender();
  eventSource?.close(); eventSource = null; eventProjectId = null;
  state.connected = false;
}
function connectEvents() {
  const projectId = state.projectId;
  if (!state.authenticated || document.hidden === true) return;
  if (eventSource && eventProjectId === projectId) return;
  cancelRuntimeReload();
  cancelStreamRender();
  eventSource?.close();
  const delta = globalThis.DeepMathDelta;
  const source = new EventSource((projectId ? `/api/events?projectId=${encodeURIComponent(projectId)}` : '/api/events')
    + (delta ? `${projectId ? '&' : '?'}transport=delta-v1` : ''));
  let baseline = null, version = null;
  eventSource = source; eventProjectId = projectId;
  source.addEventListener('snapshot', (event) => {
    if (eventSource !== source) return;
    try {
      const packet = JSON.parse(event.data);
      const incremental = delta && packet?.protocol === delta.protocol;
      const project = incremental ? packet.project : packet;
      if (projectId && project?.id !== projectId) return;
      if (incremental && (!Number.isSafeInteger(packet.version) || packet.version < 0)) throw new Error('Invalid version');
      baseline = project; version = incremental ? packet.version : null;
      acceptStreamProject(source, project, true);
    } catch { recoverProjectStream(source); }
  });
  source.addEventListener('project.delta', event => {
    if (eventSource !== source || !delta) return;
    try {
      const packet = JSON.parse(event.data);
      if (packet.protocol !== delta.protocol || version === null || packet.baseVersion !== version
        || packet.version !== version + 1 || packet.projectId !== (baseline?.id || '')) throw new Error('Stream requires resync');
      const next = delta.apply(baseline, packet.ops);
      if ((next?.id || '') !== packet.projectId) throw new Error('Project changed');
      baseline = next; version = packet.version;
      acceptStreamProject(source, next);
    } catch { recoverProjectStream(source); }
  });
  source.addEventListener('research.changed', () => { if (eventSource !== source) return; window.ResearchPanel.changed(); researchAssessmentCache = null; if (state.activeView === 'overview') renderResearchAssessment(true); });
  source.addEventListener('files.changed', () => { if (eventSource !== source) return; state.files = null; if (state.activeTab === 'files') loadFiles(); });
  source.addEventListener('context.compaction', (event) => {
    if (eventSource !== source) return;
    const update = JSON.parse(event.data);
    if (state.project) {
      state.project.contextCompactions ||= {};
      state.project.contextCompactions[update.target] = update;
      render();
    }
    if (update.status === 'completed') showToast('上下文压缩完成，项目记录已保留');
    else if (update.status === 'failed') showToast(`上下文压缩失败：${update.error}`);
  });
  ['run.output', 'context.usage', 'project.updated', 'agent.created', 'agent.updated', 'agent.deleted', 'activity', 'progress', 'artifact.updated', 'research.result.saved', 'run.started', 'run.updated', 'run.event'].forEach((eventName) => source.addEventListener(eventName, () => { if (eventSource === source) scheduleRuntimeReload(); }));
  source.onerror = () => { if (eventSource === source) state.connected = false; };
}
function autoSize(textarea) { textarea.style.height = 'auto'; textarea.style.height = `${Math.min(textarea.scrollHeight, 100)}px`; }
function conversationSurfaceActive() { return state.activeView === 'conversation' || Boolean(selectedAgent()); }
function handleCodexDirective(event) {
  const followup = event.target.closest('[data-codex-followup]');
  if (followup) {
    const prompt = $('#prompt');
    prompt.value = followup.dataset.codexFollowup || '';
    refreshMentionRanges(prompt.value);
    autoSize(prompt);
    prompt.focus();
    prompt.setSelectionRange(prompt.value.length, prompt.value.length);
    showToast('建议指令已填入输入框，确认后即可提交');
    return;
  }
  const citation = event.target.closest('[data-codex-file]');
  if (citation) {
    state.citedFilePath = citation.dataset.codexFile || '';
    state.selectedAgentId = null;
    state.activeView = 'overview';
    state.activeTab = 'files';
    render();
    showToast('已在项目文件列表中定位引用文件');
  }
}
function init() {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pauseProjectEvents();
    else if (state.authenticated) connectEvents();
  });
  document.addEventListener('change', event => {
    const select = event.target.closest('[data-conversation-history]');
    if (select) changeConversation(select.dataset.conversationHistory, select.value);
  });
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-new-conversation]');
    if (button) changeConversation(button.dataset.newConversation);
    const deleteButton = event.target.closest('[data-delete-conversation]');
    if (deleteButton) deleteConversation(deleteButton.dataset.deleteConversation);
  });
  $('#context-meter').addEventListener('mouseenter', () => $('#context-meter').classList.remove('is-dismissed'));
  $('#context-meter').addEventListener('focusin', () => $('#context-meter').classList.remove('is-dismissed'));
  $('#context-meter-button').addEventListener('click', () => {
    const meter = $('#context-meter');
    meter.classList.remove('is-dismissed');
    const opened = meter.classList.toggle('is-open');
    $('#context-meter-button').setAttribute('aria-expanded', String(opened));
  });
  document.addEventListener('click', event => {
    if (!event.target.closest('#context-meter')) { $('#context-meter').classList.remove('is-open'); $('#context-meter-button').setAttribute('aria-expanded', 'false'); }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { $('#context-meter').classList.remove('is-open'); $('#context-meter').classList.add('is-dismissed'); $('#context-meter-button').setAttribute('aria-expanded', 'false'); }
  });
  document.addEventListener('toggle', (event) => {
    const reasoningKey = event.target?.dataset?.reasoningDisclosure;
    if (reasoningKey) { if (event.target.open) expandedReasoningRuns.add(reasoningKey); else expandedReasoningRuns.delete(reasoningKey); }
  }, true);
  const conversationScroller = $('.content-scroll');
  conversationScroller.addEventListener('wheel', (event) => {
    if (conversationSurfaceActive() && event.deltaY < 0) state.conversationFollowEnd = false;
  }, { passive: true });
  conversationScroller.addEventListener('scroll', () => {
    if (!conversationSurfaceActive()) return;
    const distanceFromEnd = conversationScroller.scrollHeight - conversationScroller.scrollTop - conversationScroller.clientHeight;
    state.conversationFollowEnd = distanceFromEnd < 48;
  }, { passive: true });
  conversationScroller.addEventListener('click', handleCodexDirective);
  document.addEventListener('keydown', (event) => {
    if (!conversationSurfaceActive() || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName || '')) return;
    if (['PageUp', 'Home', 'ArrowUp'].includes(event.key)) state.conversationFollowEnd = false;
  });
  document.addEventListener('click', (event) => {
    const copyButton = event.target.closest('[data-copy-run]');
    if (copyButton) { event.preventDefault(); copyRunOutput(copyButton.dataset.copyRun, copyButton); return; }
    if (event.target.closest('[data-load-run-history]')) loadEarlierRuns();
    const folder = event.target.closest('[data-file-directory]');
    if (folder) loadFiles(folder.dataset.fileDirectory);
    if (event.target.closest('[data-file-refresh]')) loadFiles();
    if (event.target.closest('[data-file-archive]')) downloadProjectArchive();
    const deleting = event.target.closest('[data-file-delete]');
    if (deleting) deleteProjectFile(deleting.dataset.fileDelete);
    if (event.target.closest('[data-file-cancel]') && state.fileUpload) { state.fileUpload.cancelled = true; state.fileUpload.xhr?.abort(); }
    if (event.target.closest('[data-file-upload]') && !state.fileUpload) {
      filePickerContext = { projectId: state.projectId, projectName: state.project?.name || '当前项目', username: state.user?.username, maxBytes: state.fileLimits?.uploadBytes || 100 * 1024 * 1024 };
      $('#project-file-upload').value = ''; $('#project-file-upload').click();
    }
  });
  $('#project-file-upload').addEventListener('change', event => {
    const context = filePickerContext; filePickerContext = null;
    const selected = Array.from(event.target.files || []); event.target.value = '';
    uploadProjectFiles(selected, context);
  });
  $('#send').addEventListener('click', sendPrompt);
  $('#open-conversation').addEventListener('click', showConversation);
  $('#conversation-back').addEventListener('click', showProjectOverview);
  $('#stop-controller').addEventListener('click', stopController);
  $('#compact-controller').addEventListener('click', () => compactContext());
  $('#stop-agent-run').addEventListener('click', stopCurrentAgentRun);
  $('#automation-toggle').addEventListener('click', toggleAutomation);
  $('#project-model').addEventListener('change', async (event) => {
    if (!state.project) return;
    const next = event.target.value;
    const selectedModel = state.models.find((model) => (model.model || model.id) === next);
    const nextEffort = Array.isArray(selectedModel?.configurableReasoningEfforts) ? '' : selectedModel?.defaultReasoningEffort || selectedModel?.supportedReasoningEfforts?.[0]?.reasoningEffort || '';
    const pending = { projectId: state.project.id, model: next, reasoningEffort: nextEffort };
    state.modelSettingsPending = pending;
    renderModelPicker();
    try {
      await api('/api/project', { method: 'PATCH', body: JSON.stringify({ model: next, reasoningEffort: nextEffort }) });
      if (state.project?.id === pending.projectId) { state.project.model = next; state.project.reasoningEffort = nextEffort; }
      showToast('项目模型已更新；下一次请求开始生效');
    } catch (error) { showToast(error.message); }
    finally { if (state.modelSettingsPending === pending) state.modelSettingsPending = null; renderModelPicker(); }
  });
  $('#project-effort').addEventListener('change', async (event) => {
    if (!state.project) return;
    const next = event.target.value;
    const pending = { projectId: state.project.id, model: $('#project-model').value, reasoningEffort: next };
    state.modelSettingsPending = pending;
    renderModelPicker();
    try {
      await api('/api/project', { method: 'PATCH', body: JSON.stringify({ reasoningEffort: next }) });
      if (state.project?.id === pending.projectId) state.project.reasoningEffort = next;
      showToast(next ? `推理强度已设为${reasoningEffortLabel(next)}，下一次请求生效` : '已恢复默认推理设置，下一次请求生效');
    } catch (error) { showToast(error.message); }
    finally { if (state.modelSettingsPending === pending) state.modelSettingsPending = null; renderModelPicker(); }
  });
  $('#prompt').addEventListener('input', (event) => { autoSize(event.target); refreshMentionRanges(event.target.value); state.mentionIndex = 0; updateMentionMenu(); });
  $('#prompt').addEventListener('focus', updateMentionMenu);
  $('#prompt').addEventListener('blur', () => setTimeout(hideMentionMenu, 140));
  $('#prompt').addEventListener('keydown', (event) => {
    removeMentionAtCaret(event);
    if (event.defaultPrevented) return;
    if (event.key === 'ArrowDown' && !$('#agent-mention-menu').classList.contains('hidden')) { event.preventDefault(); chooseMentionWithKeyboard(1); return; }
    if (event.key === 'ArrowUp' && !$('#agent-mention-menu').classList.contains('hidden')) { event.preventDefault(); chooseMentionWithKeyboard(-1); return; }
    if (event.key === 'Escape' && !$('#agent-mention-menu').classList.contains('hidden')) { event.preventDefault(); hideMentionMenu(); return; }
    if (event.key === 'Enter' && !event.shiftKey) {
      if (!$('#agent-mention-menu').classList.contains('hidden')) { event.preventDefault(); const option = $('#agent-mention-menu .mention-option.active') || $('#agent-mention-menu .mention-option'); option?.click(); return; }
      event.preventDefault(); sendPrompt();
    }
  });
  $('#add-agent').addEventListener('click', () => openAgentDialog());
  $('#project-overview').addEventListener('click', showProjectOverview);
  $('#research-assets-nav').addEventListener('click', showResearchAssets);
  $('#open-research-assessment').addEventListener('click', () => window.ResearchPanel.openAssessment(researchUiContext()).catch((error) => showToast(error.message)));
  $('#choose-project').addEventListener('click', openProjectDialog);
  $('#home-create-project').addEventListener('click', openProjectDialog);
  $('#project-picker').addEventListener('click', openProjectDialog);
  $('#open-model-config').addEventListener('click', openModelConfiguration);
  $('#back-home').addEventListener('click', goHome);
  $('#close-context').addEventListener('click', showProjectOverview);
  $$('.tab').forEach((tab) => tab.addEventListener('click', () => { if (tab.dataset.tab === 'research') return showResearchAssets(); state.activeTab = tab.dataset.tab; state.activeView = 'overview'; render(); }));
  $$('.text-button[data-tab]').forEach((button) => button.addEventListener('click', () => { state.activeTab = button.dataset.tab; renderTabs(); document.querySelector('.bottom-section').scrollIntoView({ behavior: 'smooth', block: 'start' }); }));
  $$('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
  $$('[data-close-model-config]').forEach((button) => button.addEventListener('click', () => $('#model-config-dialog').close()));
  $('#agent-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const profile = { displayName: $('#agent-name').value.trim(), researchContent: $('#agent-content').value.trim(), skills: $('#agent-skills').value.split(/[,，\n]/).map((value) => value.trim()).filter(Boolean), instructions: $('#agent-instructions').value.trim(), automaticScheduling: $('#agent-automatic').checked };
      const data = state.editingAgentId
        ? await api(`/api/agents/${encodeURIComponent(state.editingAgentId)}`, { method: 'PATCH', body: JSON.stringify(profile) })
        : await api('/api/agents', { method: 'POST', body: JSON.stringify(profile) });
      $('#agent-dialog').close(); state.selectedAgentId = data.agent.id; state.editingAgentId = null;
      ['#agent-name', '#agent-content', '#agent-skills', '#agent-instructions'].forEach((selector) => { $(selector).value = ''; });
      await reload(); showToast(data.agent ? '研究 Agent 配置已保存' : '研究 Agent 已创建');
    }
    catch (error) { showToast(error.message); }
  });
  $('#project-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = $('#project-title').value.trim();
    if (!name) { showToast('请填写项目名称'); $('#project-title').focus(); return; }
    cancelProjectOpen();
    try {
      const result = await api('/api/project', { method: 'POST', body: JSON.stringify({ name }) });
      selectViewedProject(result); $('#project-dialog').close(); state.home = false;
      state.selectedAgentId = null; state.activeView = 'overview'; state.files = null;
      state.fileDir = ''; state.activeTab = 'progress'; await loadProjects(); await reload(); showToast(result.notice || '项目已创建');
    } catch (error) { showToast(error.message); }
  });
  state.authenticated = true;
  Promise.all([reload(), loadProjects(), loadModels()]).then(connectEvents).catch(error => showToast(error.message));
}
init();

