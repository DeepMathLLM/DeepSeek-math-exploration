/* Research library: readable navigation, record selection and reversible edits. */
window.ResearchPanel = (() => {
  let host, context, project, result, selection = { kind: 'map', id: 'project' }, generation = 0, dirty = false;
  let nav = 'project', trail = [], searchQuery = '';
  let treeCache = new Map(), treeExpanded = new Set(['MROOT']), treeCollapsed = new Set(), treeAutoExpand = true, treeEpoch = 0, treePath = [], treeDetached = null, treeError = '';
  let treeScrollTop = 0, treeFocus = '', detailScrollTop = 0, detailFocus = '';
  let directoryPath = null, pathCache = new Map(), projectMapId = '';
  let browseScope = null, treeVisible = true, navigationPending = null, inboxCount = null, inboxGeneration = 0;
  let outcomeIds = new Set(), outcomesLoaded = false, outcomeGeneration = 0;
  let treeScrollLeft = 0, mapWide = false, mapLinkObserver;
  let graphReturn = null;
  const rememberView = () => ({ ...selection, _nav: nav, _scope: browseScope && { ...browseScope }, _treeVisible: treeVisible });
  const h = (value) => context.escapeHtml(String(value ?? ''));
  const displayTitle = (item) => item.id === 'MROOT' ? '全库总览' : item.title;
  const kindLabel = (kind) => ({ asset: '研究资产', map: '项目与专题', report: '原始汇报' }[kind] || '研究内容');
  const itemLabel = (item) => item.kind === 'map' ? item.id === 'MROOT' ? '全库总览' : item.project_map ? '研究项目' : '研究专题' : kindLabel(item.kind);
  const shortId = (id) => String(id).replace(/^([AMREN])0+(?=\d)/, '$1');
  const previewText = (text) => String(text || '').replace(/^\s*#{1,6}\s+/gm, '').replace(/\s+/g, ' ').trim();
  const queryId = (query) => { const match = String(query).trim().match(/^([AMR])([0-9]+)$/i); return match ? match[1].toUpperCase() + match[2].replace(/^0+(?=\d)/, '').padStart(6, '0') : String(query).trim(); };
  const invalidateTree = () => { treeCache.clear(); pathCache.clear(); treeExpanded = new Set(['MROOT']); treeCollapsed.clear(); treeAutoExpand = true; treeFocus = ''; treeError = ''; ++treeEpoch; };
  const call = async (name, args = {}) => {
    const data = await context.api('/api/research/tools', { method: 'POST', headers: { 'x-deepmath-project-id': project }, body: JSON.stringify({ name, arguments: args }) });
    if (['save_asset', 'save_map', 'commit_research_updates', 'archive_research_record'].includes(name) && !(data.record && data.record.revision === args.expected_revision)) invalidateTree();
    return data;
  };
  const readGraph = (args) => context.api('/api/research/graph', { method: 'POST', headers: { 'x-deepmath-project-id': project }, body: JSON.stringify(args) });
  const graphScope = () => result?.project_map ? result.project_id : browseScope?.projectId || undefined;
  function openGraph(focus = null) {
    graphReturn?.close(); graphReturn = null;
    const panel = window.AssetGraph.open({ projectId: graphScope(), fetchGraph: readGraph, focus,
      readRecord: (next, offset = 0) => call(`read_${next.kind}`, { [`${next.kind}_id`]: next.id, revision: next.revision, offset, max_chars: 80000 }),
      renderMarkdown: (body) => context.renderMarkdown(body),
      onLocate: async (next, resume) => { graphReturn = { project, resume, close: () => panel.closePanel() }; treeVisible = true; mapWide = true; nav = browseScope ? 'project' : 'root'; await load({ ...next, _treeVisible: true }, true); },
      onClosed: () => { if (graphReturn?.close) { graphReturn = null; if (result) draw(); } },
      onOpen: (next) => load(next, true) });
    return panel;
  }
  const errorText = (error) => /Version conflict/i.test(error.message) ? '内容已被更新。请复制需要保留的草稿，关闭窗口后刷新，再重新编辑。' : /containment.*cycle/i.test(error.message) ? '项目或专题不能互相包含，请选择其他内容。' : /Integrated reports require asset_ids/i.test(error.message) ? '请先保存整理后的资产，再选择接收这份汇报的资产；没有形成资产时请选择保留原汇报。' : /must appear in source_reports/i.test(error.message) ? '请先编辑接收这份汇报的资产，将汇报加入来源，再记录处理结果。' : error.message;
  const fail = (error) => context.showToast(errorText(error));
  const button = (label, action, value = '', active = false) => `<button type="button" class="research-button${active ? ' active' : ''}" data-r-action="${action}" data-r-value="${h(value)}"${active ? ' aria-pressed="true"' : ''}>${h(label)}</button>`;
  const card = (item, note = '', path = null) => `<button type="button" class="research-card" data-r-open="${h(item.id)}" data-r-kind="${h(item.kind)}"${path ? ` data-r-path="${h(JSON.stringify(path))}"` : ''}><strong>${h(displayTitle(item))}</strong><span class="research-card-preview">${h(previewText(note || item.excerpt))}</span>${item.tags?.length ? `<span class="research-card-tags">${item.tags.slice(0, 3).map(h).join(' · ')}</span>` : ''}<span class="research-card-id">${itemLabel(item)}${item.id === 'MROOT' ? '' : ` · ${h(shortId(item.id))}`}${item.archived ? ' · 在回收站' : ''}</span></button>`;

  const listArgs = (view) => ({ kind: view.recordKind || 'asset', ...(view.scope === 'project' ? { project_id: view.projectId || project } : {}), ...(view.unmapped ? { unmapped: true } : {}), ...(view.trash ? { archived_only: true } : {}), include_archived: Boolean(view.archived || view.trash) });
  const scopeArgs = () => browseScope ? { scope: 'project', projectId: browseScope.projectId, projectTitle: browseScope.title } : {};
  const activeSection = () => treeVisible && result?.record && ['map', 'asset'].includes(result.kind) ? 'browse' : selection.kind === 'search' ? 'search' : selection.kind === 'inbox' ? 'inbox' : selection.trash ? 'trash' : selection.kind === 'inventory' ? selection.recordKind === 'map' ? 'browse' : selection.recordKind === 'report' ? 'reports' : 'assets' : result?.kind === 'report' ? 'reports' : ['project', 'root'].includes(nav) || result?.kind === 'map' ? 'browse' : 'assets';
  async function readSearch(view, offset = 0) {
    const query = String(view.query).trim(), match = query.match(/^([AMR])\d+$/i), projectArgs = view.scope === 'project' ? { project_id: view.projectId || project } : {};
    if (match || view.searchKind === 'report') return call('list_research_records', { ...projectArgs, kind: match ? ({ A: 'asset', M: 'map', R: 'report' })[match[1].toUpperCase()] : 'report', query, offset });
    return call('list_research_records', { ...projectArgs, kind: 'asset', query, offset });
  }
  async function updateInboxCount() {
    const token = ++inboxGeneration, currentProject = project;
    try { const data = await call('get_research_inbox', { limit: 1 }); if (token !== inboxGeneration || currentProject !== project) return; inboxCount = data.total + data.notice_total; const el = host?.querySelector('[data-r-action=inbox]'); if (el) el.textContent = `待处理${inboxCount ? ` (${inboxCount})` : ''}`; } catch { /* The inbox remains reachable if its count is unavailable. */ }
  }
  const initialOverview = (body) => [
    '从项目或专题入口逐层查看研究内容。未归类资产、待处理汇报及完整目录可独立浏览。',
    '此项目的成果、探索和待澄清问题尚待 controller 整理。'
  ].includes(body);
  async function load(next = selection, remember = false) {
    if (remember && result) trail.push(rememberView());
    if (dirty) invalidateTree();
    const token = ++generation; selection = { ...next }; result = null; directoryPath = null; draw();
    try {
      let data;
      if (['map', 'asset', 'report'].includes(next.kind)) data = await call(`read_${next.kind}`, { [`${next.kind}_id`]: next.id, ...(next.revision ? { revision: next.revision } : {}), ...(next.kind === 'map' ? { limit: 12 } : {}) });
      else if (next.kind === 'inbox') data = await call('get_research_inbox');
      else if (next.kind === 'assessment') data = await call('read_project_research');
      else if (next.kind === 'search') data = await readSearch(next);
      else data = await call('list_research_records', listArgs(next));
      if (token !== generation) return;
      if (data.kind === 'map') {
        if (data.record.id === 'MROOT') nav = 'root';
        else if (data.project_map) nav = data.project_id === project ? 'project' : 'root';
        else if (!['project', 'root'].includes(nav)) nav = ['project-inventory', 'assessment', 'inbox'].includes(nav) ? 'project' : 'root';
      }
      if (data.project_map && data.project_id === project) projectMapId = data.record.id;
      if (data.record && ['map', 'asset'].includes(data.kind)) {
        const resolved = await resolveDirectoryPath(data, next, token);
        if (token !== generation) return;
        directoryPath = resolved;
        selection.mapPath = resolved.nodes.map((node) => node.id);
        if (browseScope && resolved.status === 'rooted' && !resolved.nodes.some((node) => node.project_id === browseScope.projectId)) browseScope = null;
      }
      if (data.kind === 'report' && data.record.project_id !== browseScope?.projectId) browseScope = null;
      if (data.record && ['map', 'asset'].includes(data.kind)) { const reads = [call('get_asset_links', { asset_id: data.record.id, direction: 'incoming', limit: 3 })]; if (data.project_map || data.record.id === 'MROOT') reads.push(call('list_research_records', { kind: 'asset', ...(data.project_map ? { project_id: data.project_id } : {}), unmapped: true, limit: 1 })); const responses = await Promise.allSettled(reads); if (token !== generation) return; data.incoming = responses[0].status === 'fulfilled' ? responses[0].value : null; if (responses[1]?.status === 'fulfilled') data.unplaced = responses[1].value; }
      if (data.kind === 'asset') {
        try { data.asset_graph = await readGraph({ project_id: browseScope?.projectId || undefined, asset_id: data.record.id, all_versions: true }); }
        catch (error) { data.graph_error = errorText(error); }
        if (token !== generation) return;
      }
      result = data; dirty = false;
      if (data.record && treeVisible && ['map', 'asset'].includes(data.kind)) await prepareTree(data, selection, token);
      else treePath = [];
      if (token === generation) draw();
    } catch (error) { if (token !== generation) return; result = { error: errorText(error) }; draw(); }
  }
  const pathInfo = (data) => ({ node: { id: data.record.id, title: displayTitle(data.record), kind: data.kind, project_map: Boolean(data.project_map), project_id: data.project_id, archived: data.archived }, parents: data.locations.items.map(({ map }) => map), next: data.locations.next_offset });
  async function resolveDirectoryPath(data, next, token) {
    const epoch = treeEpoch, selected = pathInfo(data), budget = { remaining: 48 };
    const active = () => token === generation && epoch === treeEpoch;
    const answer = (reverse, status = 'rooted') => ({ nodes: [...reverse].reverse(), status });
    if (data.record.revision === data.current_revision) pathCache.set(selected.node.id, selected);
    const readMapInfo = async (id) => {
      if (!active()) throw new Error('Reading changed');
      if (id === 'MROOT') return { node: { id, title: '全库总览', kind: 'map' }, parents: [], next: null };
      if (pathCache.has(id)) return pathCache.get(id);
      if (budget.remaining-- <= 0) throw new Error('Path reading budget reached');
      const map = await call('read_map', { map_id: id, max_chars: 1, limit: 1 });
      if (!active()) throw new Error('Reading changed');
      const info = pathInfo(map); pathCache.set(id, info); return info;
    };
    const moreParents = async (info) => {
      if (info.next === null || budget.remaining-- <= 0) return false;
      const page = await call(`read_${info.node.kind}`, { [`${info.node.kind}_id`]: info.node.id, max_chars: 1, ...(info.node.kind === 'map' ? { limit: 1 } : {}), location_offset: info.next });
      if (!active()) throw new Error('Reading changed');
      info.parents.push(...page.locations.items.map(({ map }) => map)); info.next = page.locations.next_offset;
      return true;
    };
    const parents = (info) => info.parents.filter((parent) => !parent.archived);
    let rooted = null, detached = null;
    try {
      // A clicked directory entry carries its actual route. References never carry a containment route.
      const requested = next.mapPath;
      if (Array.isArray(requested) && requested.at(-1) === selected.node.id && new Set(requested).size === requested.length) {
        const reverse = [selected.node]; let child = selected, valid = true;
        for (let index = requested.length - 2; index >= 0; index--) {
          const parentId = requested[index];
          while (!parents(child).some((parent) => parent.id === parentId) && child.next !== null && await moreParents(child)) {}
          if (!parents(child).some((parent) => parent.id === parentId)) { valid = false; break; }
          child = await readMapInfo(parentId); reverse.push(child.node);
        }
        // A partial cached route must not prevent finding its still-unread ancestors.
        if (valid && requested[0] === 'MROOT') return answer(reverse);
      }
      const queue = [{ info: selected, reverse: [selected.node] }], visited = new Set();
      const preferProject = browseScope ? browseScope.mapId || projectMapId : '';
      while (queue.length && active()) {
        const current = queue.shift();
        const key = `${current.reverse.at(-1).id}/${current.reverse.some((node) => node.id === preferProject)}`;
        if (visited.has(key)) continue; visited.add(key);
        const info = current.info || await readMapInfo(current.reverse.at(-1).id);
        current.reverse[current.reverse.length - 1] = info.node;
        if (info.node.id === 'MROOT') {
          const found = answer(current.reverse);
          if (!preferProject || current.reverse.some((node) => node.id === preferProject)) return found;
          rooted ||= found; continue;
        }
        while (info.next !== null && await moreParents(info)) {}
        const available = parents(info).filter((parent) => !current.reverse.some((node) => node.id === parent.id));
        if (!available.length && info.next === null) detached ||= answer(current.reverse, current.reverse.length === 1 && data.kind === 'asset' ? 'unplaced' : 'detached');
        for (const parent of available.sort((a, b) => Number(b.id === preferProject) - Number(a.id === preferProject))) {
          queue.push({ reverse: [...current.reverse, parent] });
        }
      }
      return rooted || detached || answer([selected.node], 'partial');
    } catch { return rooted || detached || answer([selected.node], 'partial'); }
  }
  function breadcrumbView() {
    const back = trail.length ? button('返回上一页', 'back') : '';
    if (!result) return `${back}<span>正在读取…</span>`;
    if (directoryPath) {
      const notes = { unplaced: '尚未添加到项目或专题', detached: '尚未添加到全库总览', partial: '浏览路径尚未完整读取' };
      const path = directoryPath.nodes;
      return `${back}<ol class="research-breadcrumb-list" aria-label="浏览路径">${path.map((node, index) => `<li>${index < path.length - 1 ? `<button class="research-path-link" data-r-open="${h(node.id)}" data-r-kind="map" data-r-path="${h(JSON.stringify(path.slice(0, index + 1).map((item) => item.id)))}">${h(displayTitle(node))}</button>` : `<span aria-current="page">${h(displayTitle(node))}</span>`}</li>`).join('')}</ol>${notes[directoryPath.status] ? `<span class="research-path-note">${h(notes[directoryPath.status])}</span>` : ''}`;
    }
    if (result.record) return `${back}<span>当前${result.kind === 'report' ? '汇报' : '内容'}：${h(displayTitle(result.record))}</span>`;
    return back;
  }
  function draw() {
    if (!host?.isConnected || context.isActive?.() === false) return;
    const pageScrollers = [];
    for (let element = host.parentElement; element; element = element.parentElement) pageScrollers.push({ element, top: element.scrollTop });
    // Keep the page height while an asynchronous read replaces the selected content.
    host.style.minHeight = !result && host.querySelector('.research-panel') ? `${host.getBoundingClientRect().height}px` : '';
    host.setAttribute('aria-busy', String(!result));
    const oldTree = host.querySelector('.research-tree-scroll'), oldDetail = host.querySelector('.research-detail');
    if (oldTree) { treeScrollTop = oldTree.scrollTop; treeScrollLeft = oldTree.scrollLeft; }
    if (oldDetail) detailScrollTop = oldDetail.scrollTop;
    const section = activeSection(), foreignScope = browseScope && browseScope.projectId !== project;
    const canCreate = !foreignScope, canNavigate = result?.record && ['map', 'asset'].includes(result.kind);
    const toolbar = `<header class="research-library-head"><h1>研究资产库</h1><button type="button" class="research-button research-mobile-overview" data-r-action="project-overview">项目总览</button><label class="research-scope-control">查看范围<select data-research-scope aria-label="查看范围"><option value="project"${browseScope?.projectId === project ? ' selected' : ''}>本项目 · ${h(context.projectTitle)}</option><option value="all"${!browseScope ? ' selected' : ''}>全库</option>${foreignScope ? `<option value="foreign" selected>${h(browseScope.title)} · 仅浏览</option>` : ''}</select></label></header>
      <div class="research-toolbar research-library-tools"><form class="research-search"><input name="query" aria-label="搜索研究内容" placeholder="${section === 'reports' ? '搜索汇报标题或编号' : '搜索标题、术语或编号'}" required><button class="research-button${section === 'search' ? ' active' : ''}"${section === 'search' ? ' aria-pressed="true"' : ''}>搜索</button></form>${canCreate ? `<details class="research-menu research-create-menu"><summary>＋新建</summary><div class="research-menu-items">${button('新建资产', 'new-asset')}${button('新建专题', 'new-map')}</div></details>` : ''}</div>
      <div class="research-navigation"><div class="research-main-tabs" role="group" aria-label="浏览方式">${viewTab('资产地图', '浏览项目、专题与资产的脉络', 'browse', 'map', section === 'browse')}${viewTab('资产列表', '直接查找和阅读研究内容', 'assets', 'list', section === 'assets')}${viewTab('原始汇报', '查看研究过程与证据', 'reports', 'report', section === 'reports')}</div><div class="research-secondary-tools">${browseScope?.projectId === project || section === 'inbox' ? button(`待处理${inboxCount ? ` (${inboxCount})` : ''}`, 'inbox', '', section === 'inbox') : ''}<details class="research-menu research-library-menu"><summary>更多</summary><div class="research-menu-items">${button(dirty ? '有更新，刷新' : '刷新', 'refresh')}${button('查看所有项目与专题', 'all-topics')}${button('查看回收站', 'trash')}${browseScope?.projectId !== project ? button('本项目待处理', 'inbox') : ''}</div></details></div></div>
      ${canNavigate || trail.length ? `<div class="research-location-bar"><div class="research-breadcrumb">${breadcrumbView()}</div>${canNavigate && !treeVisible ? button('在资产地图中查看', 'toggle-navigation') : ''}</div>` : ''}`;
    let body = '<p class="muted">正在读取…</p>';
    if (result?.error) body = `<p role="alert">${h(result.error)}</p>`;
    else if (result?.record) body = recordView();
    else if (result && selection.kind === 'assessment') body = assessmentView(result);
    else if (result && selection.kind === 'inbox') body = inboxView();
    else if (result) body = listView();
    if (canNavigate && treeVisible) body = `<div class="research-explorer${mapWide ? ' map-wide' : ''}">${treeView()}<div class="research-detail"><div class="research-detail-bar"><span>所选内容</span>${button('专注阅读', 'toggle-navigation')}</div>${body}</div></div>`;
    const focus = result?.record ? `${result.kind}/${result.record.id}/${result.record.revision}` : '';
    const folds = focus && host.dataset.researchFocus === focus ? [...host.querySelectorAll('.research-fold[open]')].map((el) => el.dataset.rFold) : [];
    host.innerHTML = `<section class="research-panel">${toolbar}${graphReturn?.project === project ? '<div class="research-graph-return"><span>正在查看资产在项目与专题中的位置，已选脉络已保留。</span><button type="button" class="research-button" data-return-graph>返回已选脉络</button></div>' : ''}<div class="research-body">${body}</div></section>`; host.dataset.researchFocus = focus;
    const returnGraph = host.querySelector('[data-return-graph]'); if (graphReturn?.project === project && returnGraph) returnGraph.onclick = () => { const resume = graphReturn.resume; graphReturn = null; draw(); resume(); };
    folds.forEach((key) => { const fold = host.querySelector(`[data-r-fold="${key}"]`); if (fold) fold.open = true; });
    const directLinks = host.querySelector('[data-r-fold="direct-links"]');
    if (directLinks) { const label = directLinks.querySelector('summary'); const updateLabel = () => { label.textContent = label.textContent.replace(/^(展开|收起)直接联系/, directLinks.open ? '收起直接联系' : '展开直接联系'); }; directLinks.ontoggle = updateLabel; updateLabel(); }
    host.querySelector('.research-search input').value = nav === 'search' ? searchQuery : '';
    host.querySelector('.research-search').onsubmit = (event) => { event.preventDefault(); const searchKind = section === 'reports' || selection.searchKind === 'report' ? 'report' : undefined; searchQuery = new FormData(event.target).get('query'); nav = 'search'; trail = []; load({ kind: 'search', query: searchQuery, searchKind, ...scopeArgs() }); };
    host.querySelector('[data-research-scope]').onchange = (event) => { if (event.target.value === 'foreign') return; browseScope = event.target.value === 'all' ? null : { projectId: project, title: context.projectTitle }; trail = []; action(section === 'browse' ? 'browse' : section === 'reports' ? 'reports' : 'assets').catch(fail); };
    host.querySelectorAll('[data-r-open]').forEach((element) => { element.onclick = () => { if (element.closest('.research-map-structure')) mapWide = false; return load({ kind: element.dataset.rKind, id: element.dataset.rOpen, ...(element.dataset.rRevision ? { revision: Number(element.dataset.rRevision) } : {}), ...(element.dataset.rPath ? { mapPath: JSON.parse(element.dataset.rPath) } : {}) }, true); }; });
    host.querySelectorAll('[data-tree-toggle]').forEach((element) => { element.onclick = () => toggleTree(element.dataset.treeToggle).catch(fail); });
    host.querySelectorAll('[data-tree-more]').forEach((element) => { element.onclick = () => moreTree(element.dataset.treeMore).catch(fail); });
    const linkVersion = host.querySelector('[data-direct-version]');
    if (linkVersion) linkVersion.onchange = () => { result.link_revision = linkVersion.value === 'all' ? null : Number(linkVersion.value); draw(); };
    host.querySelectorAll('[data-r-action]').forEach((element) => { element.onclick = async () => { element.disabled = true; try { await action(element.dataset.rAction, element.dataset.rValue); } catch (error) { fail(error); } finally { if (element.isConnected) element.disabled = false; } }; });
    if (navigationPending === generation) { const toggle = host.querySelector('[data-r-action=toggle-navigation]'); if (toggle) { toggle.disabled = true; toggle.textContent = '正在打开地图…'; } }
    host.querySelectorAll('[data-r-reveal]').forEach((element) => { element.onclick = () => { const fold = host.querySelector(`[data-r-fold="${element.dataset.rReveal}"]`); if (fold) { fold.open = true; fold.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } }; });
    bindMapPan();
    host.querySelectorAll('.research-record > .markdown-body h1,.research-record > .markdown-body h2,.research-record > .markdown-body h3,.research-record > .markdown-body h4').forEach((heading) => { if (/^(已得到的结论|主要结论|核心结论|结论|最终结论)$/.test(heading.textContent.trim())) heading.classList.add('research-key-heading'); });
    host.querySelectorAll('[data-asset-filter]').forEach((element) => { element.onchange = () => load({ ...selection, unmapped: element.value === 'unmapped' }); });
    host.onmousedown = (event) => host.querySelectorAll('.research-menu[open]').forEach((menu) => { if (!menu.contains(event.target)) menu.open = false; });
    host.onkeydown = (event) => { if (event.key === 'Escape') host.querySelectorAll('.research-menu[open]').forEach((menu) => { menu.open = false; }); };
    const treeScroll = host.querySelector('.research-tree-scroll'), detail = host.querySelector('.research-detail');
    if (treeScroll) {
      treeScroll.scrollTop = treeScrollTop; treeScroll.scrollLeft = treeScrollLeft;
      const treeFocusKey = treePath.join('/') || result.record.id;
      if (treeFocusKey !== treeFocus) focusMapNode(treeScroll);
      treeFocus = treeFocusKey;
    }
    if (detail) { detail.scrollTop = focus === detailFocus ? detailScrollTop : 0; detailFocus = focus; }
    mapLinkObserver?.disconnect();
    const stage = host.querySelector('.research-map-stage');
    if (stage) { drawMapLinks(stage); updateMapControls(treeScroll); mapLinkObserver = new ResizeObserver(() => { drawMapLinks(stage); updateMapControls(treeScroll); }); mapLinkObserver.observe(stage); mapLinkObserver.observe(treeScroll); }
    pageScrollers.forEach(({ element, top }) => { element.scrollTop = top; });
    if (window.MathJax?.typesetPromise) window.MathJax.typesetPromise([host]).catch(() => {});
  }
  async function readTreeMap(id, token = generation, epoch = treeEpoch) {
    if (treeCache.has(id)) return treeCache.get(id);
    const data = await call('read_map', { map_id: id, max_chars: 1, limit: 30 });
    if (token !== generation || epoch !== treeEpoch) return null;
    treeCache.set(id, data); return data;
  }
  function viewTab(title, description, action, icon, active) {
    const symbols = { map: '<rect x="2" y="8" width="6" height="7" rx="1"/><rect x="16" y="2" width="6" height="7" rx="1"/><rect x="16" y="15" width="6" height="7" rx="1"/><path d="M8 11.5h4V5.5h4M12 11.5v7h4"/>', list: '<path d="M8 5h14M8 12h14M8 19h14"/><path d="M2 5h1M2 12h1M2 19h1"/>', report: '<path d="M6 2h9l5 5v15H6zM15 2v6h5M9 12h8M9 17h6"/>' };
    return `<button type="button" class="research-view-tab${active ? ' active' : ''}" data-r-action="${action}"${active ? ' aria-pressed="true"' : ''}><svg viewBox="0 0 24 24" aria-hidden="true">${symbols[icon]}</svg><span><strong>${title}</strong><small>${description}</small></span></button>`;
  }
  async function updateOutcomes() {
    const token = ++outcomeGeneration, currentProject = project; outcomesLoaded = true;
    try { const doc = await call('read_project_research'); if (token !== outcomeGeneration || currentProject !== project) return; outcomeIds = new Set(doc.outcomes.map((item) => item.id)); if (result?.record) draw(); }
    catch { if (token === outcomeGeneration) outcomesLoaded = false; }
  }
  function relationshipOverview(uses, related) {
    const doc = result.record, sources = doc.source_reports || [], incoming = result.incoming;
    if (!uses.length && !related.length && !sources.length && !incoming?.total) return '';
    const entry = (title, count, key, action = '') => `<button type="button" ${action ? `data-r-action="${action}"` : `data-r-reveal="${key}"`}><span>${title}</span><strong>${count ?? '查看'}</strong><i aria-hidden="true">↗</i></button>`;
    return `<section class="research-connections" aria-label="联系与来源"><h4>联系与来源</h4><div>${uses.length ? entry('用到的依据', uses.length, 'uses') : ''}${incoming?.total ? entry('引用它的研究', incoming.total, '', 'incoming') : ''}${related.length ? entry('相关研究', related.length, 'related') : ''}${sources.length ? entry('来源汇报', sources.length, 'sources') : ''}</div></section>`;
  }
  function assetRelationshipView() {
    const graph = result.asset_graph, doc = result.record;
    if (!graph) return `<section class="research-focus-graph"><div class="research-heading"><h4>研究联系</h4>${button('重新读取', 'refresh')}</div><p class="minor">${h(result.graph_error || '联系尚未读取。')}</p></section>`;
    const revision = result.link_revision ?? null;
    const used = graph.edges.filter((edge) => edge.target === doc.id && (revision === null || edge.target_revision === revision));
    const users = graph.edges.filter((edge) => edge.source === doc.id && (revision === null || edge.source_revision === revision) && edge.target !== doc.id);
    const group = (edges, side) => {
      const groups = new Map();
      for (const edge of edges) { const id = edge[side]; if (!groups.has(id)) groups.set(id, []); groups.get(id).push(edge); }
      return [...groups];
    };
    const column = (edges, side, title) => {
      const groups = group(edges, side);
      return `<div class="rf-column"><h5>${title} <span>${groups.length}</span></h5>${groups.map(([id, refs]) => {
        const versions = [...new Set(refs.map((edge) => edge[`${side}_revision`]))];
        return `<div class="rf-item"><code class="research-id-badge" title="${h(id)}">${h(shortId(id))}</code><strong>${h(refs[0][`${side}_title`])}</strong><div>${versions.map((revision) => `<button type="button" class="research-link" data-r-open="${h(id)}" data-r-kind="asset" data-r-revision="${revision}">第 ${revision} 版</button>`).join(' · ')}</div><p title="${h(refs.map((edge) => edge.note).join('\n'))}">${h([...new Set(refs.map((edge) => edge.note))].join('；'))}</p></div>`;
      }).join('') || '<p class="minor">尚无已记录联系</p>'}</div>`;
    };
    const versions = graph.nodes.find((node) => node.id === doc.id)?.versions || [doc.revision];
    return `<section class="research-focus-graph" aria-label="研究联系"><div class="research-heading"><h4>研究联系</h4><label class="research-link-scope">联系范围 <select data-direct-version aria-label="直接联系的版本范围"><option value="all"${revision === null ? ' selected' : ''}>全部版本</option>${[...versions].sort((a,b) => b-a).map((v) => `<option value="${v}"${revision === v ? ' selected' : ''}>第 ${v} 版</option>`).join('')}</select></label>${button('放大查看', 'asset-graph')}</div><details class="research-fold" data-r-fold="direct-links" open><summary>直接联系 · ${group(used, 'source').length} 项依据 → 本资产 → ${group(users, 'target').length} 项研究</summary><div class="rf-flow">${column(used, 'source', '用到的内容')}<div class="rf-current"><span aria-hidden="true">→</span><code class="research-id-badge" title="${h(doc.id)}">${h(shortId(doc.id))}</code><strong>${h(doc.title)}</strong><small>${revision === null ? '全部版本' : `第 ${revision} 版`}</small><span aria-hidden="true">→</span></div>${column(users, 'target', '使用它的研究')}</div><p class="rf-footnote">${revision === null ? '汇集各版本已记录的直接联系，可选择具体版本聚焦。' : `展示第 ${revision} 版的直接联系。`}放大后可逐条查看双方版本与用途。</p></details></section>`;
  }
  function bindMapPan() {
    const area = host.querySelector('.research-tree-scroll'); if (!area) return;
    let drag;
    area.onscroll = () => updateMapControls(area);
    area.onpointerdown = (event) => {
      if (event.button !== 0 || event.target.closest('button,a,input,summary')) return;
      drag = { x: event.clientX, y: event.clientY, left: area.scrollLeft, top: area.scrollTop }; area.setPointerCapture(event.pointerId); area.classList.add('dragging'); event.preventDefault();
    };
    area.onpointermove = (event) => { if (drag) { area.scrollLeft = drag.left - event.clientX + drag.x; area.scrollTop = drag.top - event.clientY + drag.y; } };
    area.onpointerup = area.onpointercancel = () => { drag = null; area.classList.remove('dragging'); };
  }
  function focusMapNode(area) {
    const selected = [...area.querySelectorAll('[aria-current=true]')].find((element) => element.dataset.rPath === JSON.stringify(treePath));
    if (!selected) return;
    const bounds = (selected.closest('.research-tree-row') || selected).getBoundingClientRect(), viewport = area.getBoundingClientRect();
    if (bounds.bottom > viewport.bottom) area.scrollTop += bounds.bottom - viewport.bottom + 24;
    else if (bounds.top < viewport.top) area.scrollTop -= viewport.top - bounds.top + 24;
    if (bounds.width > viewport.width - 48) area.scrollLeft += bounds.left - viewport.left - 24;
    else if (bounds.right > viewport.right) area.scrollLeft += bounds.right - viewport.right + 24;
    else if (bounds.left < viewport.left) area.scrollLeft -= viewport.left - bounds.left + 24;
  }
  function updateMapControls(area) {
    const finder = host.querySelector('[data-r-action=map-focus]'); if (!area?.isConnected || !finder) return;
    const selected = area.querySelector('.research-tree-title[aria-current=true]');
    if (!selected) { finder.hidden = result?.archived || result?.record?.id === 'MROOT' || treePath.length < 2 || directoryPath?.status === 'partial'; return; }
    const bounds = selected.closest('.research-tree-row').getBoundingClientRect(), viewport = area.getBoundingClientRect();
    finder.hidden = bounds.left >= viewport.left - 1 && bounds.right <= viewport.right + 1 && bounds.top >= viewport.top - 1 && bounds.bottom <= viewport.bottom + 1;
  }
  async function prepareTree(data, next, token) {
    const epoch = treeEpoch;
    treeError = ''; treeDetached = null;
    try {
      await readTreeMap('MROOT', token, epoch);
      if (browseScope) await readTreeMap(browseScope.mapId || projectMapId || 'project', token, epoch);
      if (token !== generation || epoch !== treeEpoch) return;
      if (data.kind === 'map' && data.record.revision === data.current_revision) {
        const cached = treeCache.get(data.record.id);
        if ((!cached || cached.record.revision !== data.record.revision || cached.entries.length <= data.entries.length) && (data.entries.length >= 30 || data.next_entry_offset === null)) treeCache.set(data.record.id, data);
      }
      const path = next.mapPath || [data.record.id];
      if (token !== generation || epoch !== treeEpoch) return;
      treePath = path || [];
      if (treePath[0] !== 'MROOT' && (treePath.length > 1 || data.kind === 'map')) treeDetached = treePath[0];
      if (next.id === 'project') treeExpanded.add(projectMapId);
      if (data.kind === 'map') await readTreeMap(data.record.id, token, epoch);
      for (let index = 0; index < treePath.length; index++) {
        const id = treePath[index];
        if (index === treePath.length - 1) break;
        treeExpanded.add(id);
        const branch = await readTreeMap(id, token, epoch);
        if (!branch) return;
        const child = treePath[index + 1];
        // A focused item can lie beyond the first page. Keep pagination pinned to this revision.
        for (let pages = 0; child && !branch.entries.some((entry) => entry.target_id === child) && branch.next_entry_offset !== null && pages < 5; pages++) {
          const page = await call('read_map', { map_id: id, revision: branch.record.revision, max_chars: 1, entry_offset: branch.next_entry_offset, limit: 30 });
          if (token !== generation || epoch !== treeEpoch) return;
          branch.entries.push(...page.entries); branch.next_entry_offset = page.next_entry_offset;
        }
      }
      if (treeAutoExpand) await expandTreeDefaults(browseScope?.mapId || (browseScope ? projectMapId : 'MROOT'), token, epoch);
    } catch (error) { if (token === generation && epoch === treeEpoch) treeError = errorText(error); }
  }
  async function expandTreeDefaults(rootId, token, epoch) {
    const queue = [rootId], visited = new Set();
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i]; if (!id || visited.has(id) || treeCollapsed.has(id)) continue;
      visited.add(id);
      const branch = await readTreeMap(id, token, epoch);
      if (!branch || token !== generation || epoch !== treeEpoch) return;
      treeExpanded.add(id);
      while (branch.next_entry_offset !== null) {
        const offset = branch.next_entry_offset;
        const page = await call('read_map', { map_id: id, revision: branch.record.revision, max_chars: 1, entry_offset: offset, limit: 100 });
        if (token !== generation || epoch !== treeEpoch) return;
        branch.entries.push(...page.entries); branch.next_entry_offset = page.next_entry_offset;
        if (page.next_entry_offset === offset) throw new Error('Map pagination did not advance');
      }
      queue.push(...branch.entries.filter((entry) => entry.target.kind === 'map' && !entry.target.archived).map((entry) => entry.target_id));
    }
  }
  function visibleMapGraph(root, anchorPath) {
    const nodes = new Map(), edges = new Map(), regions = [], rootIds = new Set();
    const pathScore = (path) => { let index = 0; while (index < path.length && path[index] === treePath[index]) index++; return index; };
    const roots = root ? root.record.id === 'MROOT' ? root.entries.filter((entry) => !entry.target.archived).map((entry) => ({ item: entry.target, path: [...anchorPath, entry.target_id], note: entry.note })) : [{ item: { ...root.record, kind: 'map', project_map: root.project_map }, path: anchorPath }] : [];
    if (treeDetached && treeDetached !== root?.record.id && treeCache.has(treeDetached)) {
      const detached = treeCache.get(treeDetached);
      roots.push({ item: { ...detached.record, kind: 'map', project_map: detached.project_map }, path: treePath.slice(0, 1) });
    }
    roots.forEach(({ item }) => { rootIds.add(item.id); regions.push({ id: item.id, title: displayTitle(item), project: Boolean(item.project_map) }); });
    for (const entry of roots) {
      const visited = new Set();
      const walk = (item, path, note = '') => {
        const cached = item.kind === 'map' ? treeCache.get(item.id) : null;
        let current = nodes.get(item.id);
        if (!current) { current = { item: { ...item, ...(cached ? { title: cached.record.title, project_map: cached.project_map } : {}) }, path, note, owners: new Set(), parents: new Set(), children: [], depth: 0 }; nodes.set(item.id, current); }
        if (pathScore(path) > pathScore(current.path)) { current.path = path; current.note = note; }
        current.owners.add(entry.item.id);
        if (visited.has(item.id)) return;
        visited.add(item.id);
        if (item.kind !== 'map' || !treeExpanded.has(item.id) || !cached) return;
        for (const child of cached.entries.filter((value) => !value.target.archived)) {
          walk(child.target, [...path, child.target_id], child.note);
          const key = `${item.id}/${child.target_id}`;
          if (!edges.has(key)) { edges.set(key, { source: item.id, target: child.target_id }); current.children.push(child.target_id); nodes.get(child.target_id).parents.add(item.id); }
        }
      };
      walk(entry.item, entry.path, entry.note);
    }
    // Select the actual reading path without duplicating a shared node.
    treePath.forEach((id, index) => { if (nodes.has(id)) nodes.get(id).path = treePath.slice(0, index + 1); });
    const focus = nodes.get(treePath.at(-1)), focused = new Set(), descendants = focus ? [focus] : [];
    for (let index = 0; index < descendants.length; index++) {
      const parent = descendants[index];
      for (const id of parent.children) { if (focused.has(id)) continue; focused.add(id); const child = nodes.get(id); child.path = [...parent.path, id]; descendants.push(child); }
    }
    const remaining = new Map([...nodes].map(([id, node]) => [id, node.parents.size]));
    const queue = [...nodes.keys()].filter((id) => !remaining.get(id));
    for (let index = 0; index < queue.length; index++) {
      const parent = nodes.get(queue[index]);
      for (const id of parent.children) { const child = nodes.get(id); child.depth = Math.max(child.depth, parent.depth + 1); remaining.set(id, remaining.get(id) - 1); if (!remaining.get(id)) queue.push(id); }
    }
    for (const node of nodes.values()) {
      // The deepest parent determines placement; every real parent retains its line.
      node.parent = [...node.parents].sort((a, b) => nodes.get(b).depth - nodes.get(a).depth)[0];
    }
    // Shared content belongs outside individual topic branches, including within one project.
    for (const node of [...nodes.values()].sort((a, b) => a.depth - b.depth)) {
      node.shared = !rootIds.has(node.item.id) && Boolean(node.owners.size > 1 || node.parents.size > 1 || nodes.get(node.parent)?.shared);
      node.sharedOwner = node.shared && node.owners.size === 1 ? [...node.owners][0] : null;
    }
    for (const edge of edges.values()) {
      edge.shared = nodes.get(edge.target).parents.size > 1;
      edge.topic = !nodes.get(edge.source).item.project_map;
    }
    return { nodes, edges: [...edges.values()], regions, rootIds };
  }
  function drawMapLinks(stage) {
    if (!stage?.isConnected) return;
    const svg = stage.querySelector('.research-map-lines'), bounds = stage.getBoundingClientRect();
    if (!svg) return;
    const width = Math.ceil(bounds.width), height = Math.ceil(bounds.height);
    svg.setAttribute('width', width); svg.setAttribute('height', height); svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const cards = new Map([...stage.querySelectorAll('[data-tree-node]')].map((node) => [node.dataset.treeNode, node.querySelector(':scope > .research-tree-row')]));
    const rectangles = [...cards].map(([id, element]) => { const box = element.getBoundingClientRect(); return { id, left: box.left - bounds.left, right: box.right - bounds.left, top: box.top - bounds.top, bottom: box.bottom - bounds.top }; });
    const links = JSON.parse(stage.dataset.graphLinks), shared = links.filter((edge) => edge.shared);
    const roundedPath = (points) => {
      let path = `M ${points[0][0]} ${points[0][1]}`;
      for (let index = 1; index < points.length - 1; index++) {
        const [x, y] = points[index], [px, py] = points[index - 1], [nx, ny] = points[index + 1];
        const before = Math.hypot(x - px, y - py), after = Math.hypot(nx - x, ny - y), radius = Math.min(10, before / 2, after / 2);
        if (!radius) { path += ` L ${x} ${y}`; continue; }
        path += ` L ${x - (x - px) / before * radius} ${y - (y - py) / before * radius} Q ${x} ${y} ${x + (nx - x) / after * radius} ${y + (ny - y) / after * radius}`;
      }
      return path + ` L ${points.at(-1)[0]} ${points.at(-1)[1]}`;
    };
    svg.innerHTML = '<defs><marker id="research-map-arrow" viewBox="0 0 7 7" refX="7" refY="3.5" markerWidth="7" markerHeight="7" markerUnits="userSpaceOnUse" orient="auto"><polygon points="0 0,7 3.5,0 7" fill="context-stroke"/></marker></defs>' + links.map((edge) => {
      const source = cards.get(edge.source), target = cards.get(edge.target); if (!source || !target) return '';
      const a = source.getBoundingClientRect(), b = target.getBoundingClientRect();
      if (edge.shared) {
        // Leave a topic through its upper boundary so shared links do not reuse its private trunk.
        const group = source.closest('[data-topic-branch]')?.getBoundingClientRect();
        const outgoing = shared.filter((value) => value.source === edge.source), incoming = shared.filter((value) => value.target === edge.target);
        const sourcePort = (outgoing.indexOf(edge) + 1) / (outgoing.length + 1), targetPort = (incoming.indexOf(edge) + 1) / (incoming.length + 1);
        const x1 = a.left + a.width * sourcePort - bounds.left, y1 = a.top - bounds.top, x2 = b.left - bounds.left, y2 = b.top + b.height * targetPort - bounds.top, enter = x2 - 22 - Math.min(18, incoming.indexOf(edge) * 6);
        const preferredY = Math.max(8, (group?.top ?? a.top) - bounds.top - 12);
        const obstacles = rectangles.filter((box) => box.id !== edge.source && box.id !== edge.target && box.right > Math.min(x1, enter) && box.left < Math.max(x1, enter));
        const candidates = [preferredY, ...obstacles.flatMap((box) => [Math.max(8, box.top - 12), Math.min(height - 8, box.bottom + 12)])];
        const routeY = candidates.filter((y) => y <= y1 && !obstacles.some((box) => y > box.top - 6 && y < box.bottom + 6)).sort((a, b) => Math.abs(a - preferredY) - Math.abs(b - preferredY))[0] ?? preferredY;
        return `<path class="${edge.topic ? 'topic-link' : 'project-link'} shared-link" marker-end="url(#research-map-arrow)" data-graph-source="${h(edge.source)}" data-graph-target="${h(edge.target)}" d="${roundedPath([[x1, y1], [x1, routeY], [enter, routeY], [enter, y2], [x2, y2]])}"/>`;
      }
      const x1 = a.right - bounds.left, y1 = a.top + a.height / 2 - bounds.top, x2 = b.left - bounds.left, y2 = b.top + b.height / 2 - bounds.top;
      const middle = (x1 + x2) / 2, exit = x2 > x1 ? Math.min(x1 + 30, middle) : Math.max(x1, x2) + 48, enter = x2 > x1 ? Math.max(x2 - 30, middle) : exit;
      const obstacles = rectangles.filter((box) => box.id !== edge.source && box.id !== edge.target && box.right > Math.min(exit, enter) && box.left < Math.max(exit, enter));
      const candidates = [y2, y1, ...obstacles.flatMap((box) => [Math.max(8, box.top - 12), Math.min(height - 8, box.bottom + 12)])];
      const routeY = candidates.filter((y) => !obstacles.some((box) => y > box.top - 6 && y < box.bottom + 6)).sort((a, b) => Math.abs(a - y1) + Math.abs(a - y2) - Math.abs(b - y1) - Math.abs(b - y2))[0] ?? y2;
      return `<path class="${edge.topic ? 'topic-link' : 'project-link'}" marker-end="url(#research-map-arrow)" data-graph-source="${h(edge.source)}" data-graph-target="${h(edge.target)}" d="M ${x1} ${y1} H ${exit} V ${routeY} H ${enter} V ${y2} H ${x2}"/>`;
    }).join('');
  }
  function treeView() {
    const anchorId = browseScope?.mapId || (browseScope ? projectMapId : 'MROOT');
    const root = treeCache.get(anchorId), anchorIndex = treePath.indexOf(anchorId);
    const anchorPath = anchorIndex >= 0 ? treePath.slice(0, anchorIndex + 1) : anchorId === 'MROOT' ? ['MROOT'] : ['MROOT', anchorId];
    const graph = visibleMapGraph(root, anchorPath), emitted = new Set();
    const node = (id, owner, standalone = false) => {
      const current = graph.nodes.get(id); if (!current || emitted.has(id) || (!standalone && current.shared)) return '';
      emitted.add(id);
      const item = current.item, path = current.path, note = current.parents.size > 1 || (item.project_map && /^项目[:：]/.test(current.note)) ? '' : current.note;
      const isMap = item.kind === 'map', opened = treeExpanded.has(id), branch = treeCache.get(id);
      const selected = item.id === result.record.id && JSON.stringify(path) === JSON.stringify(treePath);
      const toggle = isMap ? `<button type="button" class="research-tree-toggle" data-tree-toggle="${h(id)}" aria-expanded="${opened}" aria-label="${opened ? '收起' : '展开'}${h(displayTitle(item))}的内容">${opened ? '收起内容' : '展开内容'}</button>` : '';
      const important = item.kind === 'asset' && outcomeIds.has(id);
      const meta = `${item.id === 'MROOT' ? '' : `<code class="research-id-badge" title="${h(id)}">${h(shortId(id))}</code>`}<span class="research-node-type">${itemLabel(item)}</span>${important ? '<span class="research-outcome-badge">★ 本项目成果</span>' : ''}${isMap && branch ? `<span class="research-tree-meta">${branch.entry_count} 项内容</span>` : ''}`;
      const title = `<button type="button" class="research-tree-title" data-r-open="${h(id)}" data-r-kind="${h(item.kind)}" data-r-path="${h(JSON.stringify(path))}"${selected ? ' aria-current="true"' : ''}><strong>${h(displayTitle(item))}</strong><span class="research-node-meta">${meta}</span>${note ? `<span class="research-tree-note">${h(note)}</span>` : ''}</button>`;
      let children = '';
      if (!standalone) children = current.children.filter((child) => { const target = graph.nodes.get(child); return !target.shared && target.parent === id && (!graph.rootIds.has(child) || child === owner); }).map((child) => node(child, owner)).join('');
      const footer = isMap && opened && !branch ? '<p class="research-node-hint">正在读取下级节点…</p>' : isMap && opened && !current.children.length && branch?.next_entry_offset === null ? '<p class="research-node-hint">还没有添加内容</p>' : '';
      const more = isMap && opened && branch?.next_entry_offset != null ? `<button type="button" class="research-link research-node-more" data-tree-more="${h(id)}">显示更多下级节点</button>` : '';
      return `<li data-tree-node="${h(id)}"${isMap && !item.project_map && children ? ` data-topic-branch="${h(id)}" aria-label="${h(displayTitle(item))}及其内容"` : ''} class="research-map-node ${item.kind === 'asset' ? 'node-asset' : item.project_map ? 'node-project' : 'node-topic'}${important ? ' node-outcome' : ''}${current.shared ? ' node-shared' : ''}"><div class="research-tree-row${selected ? ' selected' : ''}">${title}${isMap ? `<div class="research-node-actions">${toggle}${more}</div>` : ''}${footer}</div>${children ? `<ul class="research-tree-children">${children}</ul>` : ''}</li>`;
    };
    const sharedArea = (owner) => {
      const shared = [...graph.nodes.values()].filter((value) => value.shared && value.sharedOwner === owner), levels = [...new Set(shared.map((value) => value.depth))].sort((a, b) => a - b);
      return shared.length ? `<div class="${owner ? 'research-local-shared' : 'research-shared-area'}"><div class="research-shared-columns">${levels.map((depth) => `<ul class="research-tree research-shared-column">${shared.filter((value) => value.depth === depth).map((value) => node(value.item.id, owner, true)).join('')}</ul>`).join('')}</div></div>` : '';
    };
    const regions = graph.regions.map((region) => `<li class="${region.project ? 'research-project-region' : 'research-independent-region'}" data-project-region="${h(region.id)}" aria-label="${h(region.title)}${region.project ? '项目区域' : '独立专题区域'}"><ul class="research-tree">${node(region.id, region.id)}</ul>${sharedArea(region.id)}</li>`).join('');
    const common = sharedArea(null);
    const links = graph.edges;
    const canvas = `<div class="research-map-stage" data-graph-links="${h(JSON.stringify(links))}"><ul class="research-library-regions">${regions || '<li class="research-tree-hint">还没有添加项目或专题</li>'}</ul>${common}<svg class="research-map-lines" aria-hidden="true" focusable="false"></svg></div>`;
    const selectedVisible = graph.nodes.has(result.record.id) || result.record.id === 'MROOT';
    const locationHint = result.archived ? '这条内容保存在回收站，当前地图不显示它。' : directoryPath?.status === 'unplaced' ? '这条资产还没有加入项目或专题。' : directoryPath?.status === 'partial' ? '当前内容的所在位置尚未完整读取，可刷新后重试。' : '当前内容未在地图中显示，点击“在地图中找到当前内容”查看它的位置。';
    return `<aside class="research-map-structure" aria-label="资产地图"><div class="research-map-head"><div><h2>${browseScope ? h(browseScope.title) + ' · 资产地图' : '全库资产地图'}</h2><p>默认展开全部内容 · 点击标题阅读 · 拖动空白处移动地图</p></div><div class="research-map-tools">${button('查看资产联系图', 'project-graph')}${button(mapWide ? '显示内容' : '放大地图', 'map-wide')}${button(treeAutoExpand ? '全部收起' : '全部展开', 'map-collapse')}<button type="button" class="research-button" data-r-action="map-focus" title="展开当前内容所在的路径，并将它移入地图视野" hidden>在地图中找到当前内容</button></div></div><div class="research-map-legend"><span class="legend-project">项目</span><span class="legend-topic">专题</span><span class="legend-asset">资产</span><span class="legend-outcome">★ 本项目成果</span><span class="research-map-line-key">连线表示收录关系</span></div>${result.record.revision !== result.current_revision ? '<p class="research-tree-hint">正在阅读历史版本，地图显示当前组织结构。</p>' : ''}<div class="research-tree-scroll" tabindex="0" aria-label="移动和浏览资产地图"><div class="research-map-board">${canvas}${root?.record.id === 'MROOT' && root.next_entry_offset !== null ? '<button type="button" class="research-link" data-tree-more="MROOT">显示更多项目与专题</button>' : ''}${!selectedVisible ? `<p class="research-tree-hint">${h(locationHint)}</p>` : ''}${treeError ? `<p role="alert">${h(treeError)} ${button('重新读取地图', 'refresh')}</p>` : ''}</div></div>${result.unplaced?.total ? `<div class="research-unplaced-tray"><span>未放入项目或专题 <strong>${result.unplaced.total} 条资产</strong></span>${button('查看并整理', 'unplaced-assets')}</div>` : ''}</aside>`;
  }

  async function toggleTree(id) {
    if (treeExpanded.has(id)) { treeExpanded.delete(id); treeCollapsed.add(id); draw(); return; }
    const token = generation, epoch = treeEpoch;
    treeCollapsed.delete(id); treeExpanded.add(id); draw();
    try { await readTreeMap(id, token, epoch); }
    catch (error) { if (token === generation && epoch === treeEpoch) { treeExpanded.delete(id); treeError = errorText(error); } }
    if (token === generation && epoch === treeEpoch) draw();
  }
  async function moreTree(id) {
    const branch = treeCache.get(id); if (!branch || branch.next_entry_offset === null || branch.loading) return;
    const token = generation, epoch = treeEpoch; branch.loading = true;
    try {
      const data = await call('read_map', { map_id: id, revision: branch.record.revision, entry_offset: branch.next_entry_offset, max_chars: 1, limit: 30 });
      if (token !== generation || epoch !== treeEpoch) return;
      branch.entries.push(...data.entries); branch.next_entry_offset = data.next_entry_offset;
    } finally { branch.loading = false; }
    if (token === generation && epoch === treeEpoch) draw();
  }
  function listView() {
    const foreignProject = selection.scope === 'project' && selection.projectId && selection.projectId !== project;
    const scopeTitle = selection.scope === 'project' ? foreignProject ? selection.projectTitle : '本项目' : '全库';
    const recordKind = selection.recordKind || 'asset';
    const title = selection.kind === 'search' ? `搜索结果：${h(selection.query)}` : selection.trash ? '回收站' : recordKind === 'map' ? '项目与专题清单' : `${h(scopeTitle)}${foreignProject ? ' · ' : ''}${kindLabel(recordKind)}`;
    const filter = selection.kind === 'inventory' && recordKind === 'asset' && !selection.trash ? `<label class="research-list-filter">显示<select data-asset-filter aria-label="筛选资产"><option value="all"${!selection.unmapped ? ' selected' : ''}>全部资产</option><option value="unmapped"${selection.unmapped ? ' selected' : ''}>未放入项目或专题</option></select></label>` : '';
    const categories = selection.trash ? `<div class="research-toolbar" role="group" aria-label="回收站类别">${button('研究资产', 'kind', 'asset', recordKind === 'asset')}${button('研究专题', 'kind', 'map', recordKind === 'map')}</div>` : '';
    const count = result.total ?? result.total_candidates;
    return `<div class="research-heading research-list-heading"><h3>${title}</h3><span class="minor">${count} ${selection.kind === 'search' ? '条结果' : recordKind === 'asset' ? '条资产' : recordKind === 'report' ? '份汇报' : '个项目或专题'}</span>${filter}</div>${categories}${selection.trash ? '<p class="minor">删除的内容保存在这里，可以打开后恢复。</p>' : selection.unmapped ? '<p class="minor">这些资产已经保存，可以阅读和使用；尚未添加到项目或专题页面。</p>' : foreignProject ? '<p class="minor">正在浏览其他项目，当前执行的研究项目保持不变。</p>' : ''}<div class="research-grid research-content-list">${result.items.map((item) => card(item)).join('') || '<div class="research-empty">这里还没有内容。</div>'}</div>${result.next_offset !== null ? button('查看更多', 'more-list') : ''}`;
  }
  function assessmentView(data) {
    return `<div class="research-record"><div class="research-heading"><h3>研究现状与计划</h3>${button('编辑', 'edit-assessment')}</div><div class="markdown-body">${context.renderMarkdown(data.body_md || '还没有保存现状与计划。')}</div><h4>本项目成果</h4><div class="research-grid research-content-list">${data.outcomes.map((item) => card(item)).join('') || '<p class="muted">还没有选择成果资产。</p>'}</div></div>`;
  }
  function recordView() {
    const doc = result.record, kind = result.kind, isRoot = doc.id === 'MROOT', isCurrent = doc.revision === result.current_revision;
    const body = kind === 'map' && initialOverview(doc.body_md) ? '' : doc.body_md;
    const references = doc.references || doc.used_assets || [];
    const reference = (ref) => { const target = result.reference_records?.find((item) => item.id === ref.asset_id && item.revision === ref.revision); return `<li><button type="button" class="research-link" data-r-open="${h(ref.asset_id)}" data-r-kind="${target?.kind || (ref.asset_id.startsWith('M') ? 'map' : 'asset')}" data-r-revision="${ref.revision}"><code class="research-id-badge" title="${h(ref.asset_id)}">${h(shortId(ref.asset_id))}</code> ${h(target ? displayTitle(target) : ref.asset_id)}${target?.kind === 'map' ? ' · 研究概况' : ''} · 第 ${ref.revision} 版</button><p>${h(ref.note)}</p></li>`; };
    const fold = (key, title, count, contents) => count ? `<details class="research-fold" data-r-fold="${key}"><summary>${h(title)} <span>${count}</span></summary><div class="research-fold-content">${contents}</div></details>` : '';
    const uses = references.filter((ref) => ref.relation === 'uses'), related = references.filter((ref) => ref.relation !== 'uses');
    const deletable = kind !== 'report' && !isRoot && !result.project_map && isCurrent;
    const menu = `<details class="research-menu research-record-menu"><summary aria-label="更多操作">⋯</summary><div class="research-menu-items">${button('历史版本', 'versions')}${button('导出文件', 'export')}${!isRoot ? button('编号与版本', 'record-info') : ''}${kind === 'asset' && !result.archived && isCurrent ? button('添加到项目或专题', 'place') : ''}${deletable ? button(result.archived ? '恢复' : '删除到回收站', 'archive') : ''}</div></details>`;
    const currentParent = directoryPath?.nodes.at(-2)?.id;
    const locations = { ...result.locations, total: Math.max(0, result.locations.total - (currentParent ? 1 : 0)), items: result.locations.items.filter(({ map }) => map.id !== currentParent) };
    return `<div class="research-record"><div class="research-heading research-record-heading"><div><span class="research-kind-label">${itemLabel({ kind, id: doc.id, project_map: result.project_map })}${result.archived ? ' · 在回收站' : ''}</span><h3>${h(displayTitle(doc))}</h3>${kind === 'asset' ? `<code class="research-id-badge" title="${h(doc.id)}">${h(shortId(doc.id))}</code>` : ''}</div>${kind !== 'report' && isCurrent && !result.archived ? button(kind === 'map' ? '编辑概况' : '编辑', 'edit') : ''}${!isCurrent ? button('查看当前版本', 'current') : ''}${result.archived && deletable ? button('恢复', 'archive') : ''}${menu}</div>${!isCurrent ? `<p class="research-version-note">正在查看第 ${doc.revision} 版，当前是第 ${result.current_revision} 版。浏览位置按当前组织结构显示。</p>` : ''}${(doc.tags || []).length ? `<div class="research-tags">${doc.tags.map((tag) => `<span>${h(tag)}</span>`).join('')}</div>` : ''}${result.warnings?.length ? `<div class="research-warning">有更新需要核对。${result.warnings.map((w) => w.type === 'pending_review' ? w.message.startsWith('Project assessment changed') ? '现状与计划已更新，请核对研究判断与下一步安排。' : '此内容已更新，相关判断尚待复查。' : `${result.reference_records?.find((r) => r.id === w.asset_id)?.title || shortId(w.asset_id)}：引用第 ${w.referenced_revision} 版，当前第 ${w.current_revision} 版`).filter((message, index, messages) => messages.indexOf(message) === index).map((message) => `<div>${h(message)}</div>`).join('')}</div>` : ''}${relationshipOverview(uses, related)}${kind === 'asset' ? assetRelationshipView() : result.project_map ? `<div class="research-project-graph-entry">${button('查看资产联系图', 'project-graph')}<span>查看不同研究内容如何承接与相互使用</span></div>` : ''}${kind === 'asset' && outcomeIds.has(doc.id) ? '<p class="research-outcome-note">★ 已选为本项目成果</p>' : ''}${kind === 'map' ? '<h4 class="research-overview-label">研究概况</h4>' : ''}<div class="markdown-body">${context.renderMarkdown(body || (kind === 'map' ? '还没有填写研究概况。' : '还没有填写研究内容。'))}</div>${result.reading.next_offset !== null ? `<p class="minor">当前显示部分正文。</p>${button('继续阅读', 'more-body')}` : ''}${kind === 'map' ? mapEntriesView(isRoot, isCurrent && !result.archived) : ''}
      <div class="research-record-support">${fold('uses', kind === 'map' ? '概况用到的依据' : '用到的依据', uses.length, `<ul>${uses.map(reference).join('')}</ul>`)}${fold('related', '相关研究', related.length, `<ul>${related.map(reference).join('')}</ul>`)}${fold('sources', '来源汇报', (doc.source_reports || []).length, (doc.source_reports || []).map((id) => `<button class="research-link" data-r-open="${h(id)}" data-r-kind="report">${h(result.source_report_records?.find((r) => r.id === id)?.title || shortId(id))}</button>`).join(' · '))}${fold('evidence', '证据文件', (doc.evidence || []).length, (doc.evidence || []).map((item) => button(item.name, 'evidence', item.evidence_id)).join(' '))}${fold('locations', '其他项目与专题', locations?.total, locations.items.map(({ map }) => `<button class="research-link" data-r-open="${h(map.id)}" data-r-kind="map">${h(displayTitle(map))}${map.archived ? '（在回收站）' : ''}</button>`).join(' · ') + (locations.next_offset !== null ? button('查看更多位置', 'more-locations') : ''))}${kind !== 'report' ? `<details class="research-fold" data-r-fold="incoming"><summary>${kind === 'map' ? '哪些研究参考了这份概况' : '哪些研究引用了这条资产'}</summary><div class="research-fold-content">${button('查看引用内容', 'incoming')}</div></details>` : `<div class="research-report-actions">${button('整理为资产', 'from-report')}${doc.project_id === project ? button('处理汇报', 'review', doc.id) : '<p class="minor">此汇报属于其他项目，处理状态由原项目维护。</p>'}<p class="minor">${h({ checkpoint: '阶段进展', final: '本轮执行结束', blocked: '遇到障碍', concern: '需要核查', incomplete: '执行记录，尚未完整汇报' }[doc.phase] || doc.phase)}${result.processing?.note ? ` · ${h(result.processing.note)}` : ''}</p></div>`}</div></div>`;
  }
  function mapEntriesView(isRoot, isCurrent) {
    const counts = result.entry_counts || {}, history = result.record.revision !== result.current_revision;
    const groups = [{ key: 'projects', title: '研究项目', matches: (item) => item.kind === 'map' && item.project_map }, { key: 'topics', title: '研究专题', matches: (item) => item.kind === 'map' && !item.project_map }, { key: 'assets', title: '研究资产', matches: (item) => item.kind === 'asset' }];
    const path = directoryPath?.nodes.map((node) => node.id);
    const rows = groups.filter((group) => counts[group.key]).map((group) => { const entries = result.entries.filter((entry) => !entry.target.archived && group.matches(entry.target)); return `<section class="research-entry-group"><h4>${group.title} <span>${counts[group.key]}</span></h4><div class="research-directory-list research-grid">${entries.map((entry) => `<div class="research-map-entry">${card(entry.target, entry.note, path ? [...path, entry.target_id] : null)}${isCurrent ? `<details class="research-menu research-entry-menu"><summary aria-label="${h(displayTitle(entry.target))}的操作">⋯</summary><div class="research-menu-items">${button('从本页移出', 'remove-entry', entry.target_id)}</div></details>` : ''}</div>`).join('') || '<p class="minor">此页尚未显示，请继续加载下方内容。</p>'}</div></section>`; }).join('');
    return `<div class="research-map-contents">${result.project_map ? `<p class="research-project-total">此项目共保存 ${result.project_assets_total ?? '—'} 条资产 ${button(result.project_id === project ? '查看本项目研究资产' : '查看此项目研究资产', 'map-inventory')}</p>` : ''}${history ? '<p class="research-version-note">下方展示历史版本中的专题和资产；导航显示当前组织结构。</p>' : ''}${rows || `<div class="research-empty">${isRoot ? '这里还没有项目或专题。' : '这里还没有添加专题或资产。'}${isCurrent ? '<p>可以新建内容，或添加已有资产与专题。</p>' : ''}</div>`}${result.next_entry_offset !== null ? button('显示更多内容', 'more-entries') : ''}${isCurrent ? `<div class="research-entry-actions">${button(isRoot ? '添加项目或专题' : '添加已有资产或专题', 'add-entry')}</div>` : ''}${counts.archived ? `<p class="minor">另有 ${counts.archived} 条内容在回收站。${button('查看回收站', 'trash')}</p>` : ''}${!initialOverview(result.record.body_md) && result.record.body_md && result.coverage.descendants_changed_since_map_save ? `<p class="minor">${result.coverage.descendants_changed_since_map_save}${result.coverage.more ? '+' : ''} 条下层内容在概况保存后有更新，请核对概况是否需要调整。</p>` : ''}</div>`;
  }
  function inboxView() {
    const labels = { pending: '等待整理', deferred: '暂缓处理', integrated: '已整理为资产', retained: '保留原汇报' };
    return `<h3>待处理事项</h3><h4>待整理的汇报 · ${result.total} 份</h4><p class="research-description">阅读汇报后，决定整理为资产、保留原汇报或稍后处理。</p><div class="research-grid">${result.reports.map((row) => `<div>${card(row.report)}<p class="minor">${labels[row.disposition]} ${h(row.note)}</p>${button('处理汇报', 'review', row.report_id)}</div>`).join('') || '<p class="muted">没有待整理的汇报。</p>'}</div>${result.next_offset !== null ? button('查看更多汇报', 'more-inbox') : ''}<h4>需要核对的更新 · ${result.notice_total} 项</h4><p class="minor">检查更新是否影响已有结论或下一步计划。</p>${result.notices.map((notice) => `<div class="research-notice"><span>${h(notice.target?.title || notice.target_id)}${notice.message.startsWith('Project assessment changed') ? '：现状与计划有修改。' : '：内容已更新，需要检查相关依据。'}</span>${button('查看更新', notice.message.startsWith('Project assessment changed') ? 'assessment' : 'open-change', notice.target_id)}${button('完成复查', 'review-change', notice.id)}</div>`).join('') || '<p class="muted">没有需要核对的更新。</p>'}${result.next_notice_offset !== null ? button('查看更多更新', 'more-notices') : ''}`;
  }
  async function fullRecord(kind = result.kind, doc = result.record) {
    let offset = 0, body = '', response;
    do { response = await call(`read_${kind}`, { [`${kind}_id`]: doc.id, revision: doc.revision, offset, max_chars: 80000 }); body += response.record.body_md; offset = response.reading.next_offset; } while (offset !== null);
    let entries = response.entries || [], next = response.next_entry_offset;
    while (next !== undefined && next !== null) { const page = await call('read_map', { map_id: doc.id, revision: doc.revision, entry_offset: next, max_chars: 1 }); entries.push(...page.entries); next = page.next_entry_offset; }
    return { ...doc, body_md: body, ...(kind === 'map' ? { entries: entries.map((entry) => ({ ...entry, title: entry.target.title })) } : {}) };
  }
  function modal(title, body, onSubmit = null, submitLabel = '保存', onClose = null) {
    const dialog = document.createElement('dialog'); dialog.className = 'research-dialog';
    dialog.innerHTML = `<form><div class="research-heading"><h3>${h(title)}</h3><button type="button" data-close aria-label="关闭">×</button></div><div class="research-dialog-content">${body}</div><p class="research-form-error" role="alert"></p><div class="research-dialog-actions"><button type="button" data-close class="research-button">${onSubmit ? '取消' : '关闭'}</button>${onSubmit ? `<button class="research-button primary">${h(submitLabel)}</button>` : ''}</div></form>`;
    const openedProject = project; document.body.append(dialog); dialog.showModal();
    dialog.closePanel = () => { if (!dialog.isConnected) return; dialog.close(); dialog.remove(); onClose?.(); };
    dialog.querySelectorAll('[data-close]').forEach((element) => { element.onclick = dialog.closePanel; });
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); dialog.closePanel(); });
    dialog.querySelector('form').onsubmit = async (event) => { event.preventDefault(); if (!onSubmit) return; const submit = event.submitter || dialog.querySelector('.primary'); submit.disabled = true; try { if (openedProject !== project) throw new Error('当前项目已切换，请关闭窗口后重新打开。'); await onSubmit(new FormData(event.target), event.target); dialog.closePanel(); } catch (error) { dialog.querySelector('.research-form-error').textContent = errorText(error); submit.disabled = false; } };
    return dialog;
  }
  const field = (label, name, value = '', textarea = false, help = '', required = false) => `<label>${h(label)}${textarea ? `<textarea name="${name}" rows="${name === 'body_md' ? 12 : 3}"${required ? ' required' : ''}>${h(value)}</textarea>` : `<input name="${name}" value="${h(value)}"${required ? ' required' : ''}>`}${help ? `<small class="research-field-help">${h(help)}</small>` : ''}</label>`;
  function chooseRecords({ title = '选择资产', kinds = ['asset'], multiple = false, initial = [], exclude = [], description = '按标题选择，系统自动保存编号和版本。', confirmLabel = '选择这些内容' } = {}) {
    return new Promise((resolve) => {
      const chosen = new Map(initial.map((item) => [item.id, item])); let token = 0, resolved = false;
      const openedProject = project;
      const dialog = modal(title, `<p class="research-description">${h(description)}</p><div class="research-picker-toolbar"><input data-picker-query aria-label="按标题或编号查找" placeholder="输入标题关键词或编号"><select data-picker-kind aria-label="选择内容类别">${kinds.map((kind) => `<option value="${kind}">${kindLabel(kind)}</option>`).join('')}</select><button type="button" data-picker-search class="research-button">查找</button></div><div data-picker-results></div><div data-picker-selected class="minor"></div>`, multiple ? async () => { resolved = true; resolve([...chosen.values()]); } : null, confirmLabel, () => { if (!resolved) resolve(null); });
      const list = dialog.querySelector('[data-picker-results]');
      const renderChosen = () => { dialog.querySelector('[data-picker-selected]').textContent = multiple ? `已选择 ${chosen.size} 条` : ''; };
      const fetchPage = async (offset = 0, append = false) => {
        const request = ++token, kind = dialog.querySelector('[data-picker-kind]').value, query = queryId(dialog.querySelector('[data-picker-query]').value.trim());
        if (!append) list.innerHTML = '<p class="muted">正在查找…</p>';
        try {
          const data = await call('list_research_records', { kind, query, offset, limit: 30 }); if (request !== token || !dialog.isConnected) return; if (!append) list.innerHTML = '';
          for (const item of data.items.filter((item) => !exclude.includes(item.id))) {
            const element = document.createElement('button'); element.type = 'button'; element.className = `research-card${chosen.has(item.id) ? ' selected' : ''}`; element.dataset.pickerId = item.id; element.setAttribute('aria-pressed', String(chosen.has(item.id)));
            element.innerHTML = `<span class="research-card-id">${itemLabel(item)}${item.id === 'MROOT' ? '' : ` · ${h(shortId(item.id))} · 第 ${item.revision} 版`}</span><strong>${h(displayTitle(item))}</strong><span>${h(item.excerpt)}</span>`;
            element.onclick = () => { if (openedProject !== project) { dialog.closePanel(); return; } if (!multiple) { resolved = true; resolve([item]); dialog.closePanel(); return; } if (chosen.has(item.id)) chosen.delete(item.id); else chosen.set(item.id, item); element.classList.toggle('selected', chosen.has(item.id)); element.setAttribute('aria-pressed', String(chosen.has(item.id))); renderChosen(); }; list.append(element);
          }
          if (!list.children.length) list.innerHTML = '<p class="muted">没有找到内容，可以换一个标题关键词。</p>';
          if (data.next_offset !== null) { const more = document.createElement('button'); more.type = 'button'; more.className = 'research-button'; more.dataset.pickerMore = ''; more.textContent = '查看更多'; more.onclick = () => { more.remove(); fetchPage(data.next_offset, true); }; list.append(more); }
        } catch (error) { if (request === token && dialog.isConnected) list.innerHTML = `<p role="alert">${h(errorText(error))}</p>`; }
      };
      dialog.querySelector('[data-picker-search]').onclick = () => fetchPage(); dialog.querySelector('[data-picker-kind]').onchange = () => fetchPage(); dialog.querySelector('[data-picker-query]').onkeydown = (event) => { if (event.key === 'Enter') { event.preventDefault(); fetchPage(); } }; renderChosen(); fetchPage();
    });
  }
  function selectionField(label, name, items, kinds) { return `<section class="research-selection" data-selection="${name}"><h4>${h(label)}</h4><div data-selected-items>${items.map((item) => selectedItem(item, name)).join('')}</div><button type="button" data-choose-records="${name}" data-kinds="${kinds.join(',')}" class="research-button">${name === 'source_reports' ? '选择来源汇报' : name === 'outcomes' ? '选择成果资产' : '选择资产'}</button></section>`; }
  function selectedItem(item, name) { return `<div class="research-selected-item" data-selected-record="${h(item.id)}"><input type="hidden" name="${name}" value="${h(item.id)}"><span>${h(item.id === 'MROOT' ? '全库总览' : item.title || item.id)}</span><button type="button" data-remove-selection>移除</button></div>`; }
  function bindSelections(dialog) {
    dialog.querySelectorAll('[data-choose-records]').forEach((element) => { element.onclick = async () => { const name = element.dataset.chooseRecords, section = element.closest('[data-selection]'); const initial = [...section.querySelectorAll('[data-selected-record]')].map((row) => ({ id: row.dataset.selectedRecord, title: row.querySelector('span').textContent })); const picked = await chooseRecords({ title: name === 'source_reports' ? '选择来源汇报' : name === 'outcomes' ? '选择成果资产' : '选择资产', description: name === 'outcomes' ? '从已保存的资产中选择本项目的成果，可包含探索中得到的独立结论。原目标是否解决，需要在现状与计划正文中说明。' : undefined, kinds: element.dataset.kinds.split(','), multiple: true, initial }); if (picked && dialog.isConnected) section.querySelector('[data-selected-items]').innerHTML = picked.map((item) => selectedItem(item, name)).join(''); }; });
    dialog.addEventListener('click', (event) => { if (event.target.matches('[data-remove-selection]')) event.target.closest('[data-selected-record]').remove(); });
  }
  function editableContent(kind, doc) {
    const text = (value) => String(value ?? '').replace(/\r\n?/g, '\n');
    const content = { title: text(doc.title), body_md: text(doc.body_md), references: (doc.references || []).map((ref) => ({ asset_id: ref.asset_id, revision: ref.revision, relation: ref.relation, note: text(ref.note) })) };
    if (kind === 'asset') { content.tags = [...new Set((doc.tags || []).map((tag) => tag.trim()).filter(Boolean))]; content.source_reports = [...new Set(doc.source_reports || [])]; }
    else content.entries = (doc.entries || []).map((entry) => ({ target_id: entry.target_id, note: text(entry.note) }));
    return JSON.stringify(content);
  }
  async function edit(kind, isNew = false, seed = {}) {
    const openedProject = project, snapshot = result, viewToken = generation;
    const doc = isNew ? { title: '', body_md: '', tags: [], references: [], source_reports: [], entries: [], ...seed } : await fullRecord();
    if (kind === 'map' && initialOverview(doc.body_md)) doc.body_md = '';
    if (!isNew && doc.id === 'MROOT') doc.title = '全库总览';
    if (openedProject !== project) throw new Error('当前项目已切换，请重新打开编辑。'); if (viewToken !== generation) return; if (!isNew && doc.revision !== snapshot.current_revision) throw new Error('请先查看当前版本再编辑。');
    let placement = isNew && selection.kind === 'map' && snapshot?.record && !snapshot.archived ? { id: snapshot.record.id, title: displayTitle(snapshot.record) } : null;
    const sourceItems = (doc.source_reports || []).map((id) => snapshot.source_report_records?.find((item) => item.id === id) || { id, title: seed.source_title || id });
    const refRow = (ref, title) => `<div class="research-ref-row"><input type="hidden" name="ref_id" value="${h(ref.asset_id)}"><input type="hidden" name="ref_revision" value="${ref.revision}"><div><strong data-ref-title>${h(ref.asset_id === 'MROOT' ? '全库总览' : title || ref.asset_id)}</strong><div class="research-row-actions"><button type="button" data-change-ref class="research-button">更换内容</button><button type="button" data-ref-version class="research-button">第 ${ref.revision} 版</button></div></div><label>联系<select name="ref_relation"><option value="uses"${ref.relation === 'uses' ? ' selected' : ''}>用作依据</option><option value="related"${ref.relation === 'related' ? ' selected' : ''}>相关内容</option></select></label>${field('说明如何使用或关联', 'ref_note', ref.note || '', true, '', true)}<button type="button" data-remove-ref>移除引用</button></div>`;
    const entryRow = (entry) => `<div class="research-entry-row"><input type="hidden" name="entry_id" value="${h(entry.target_id)}"><strong>${h(entry.title || entry.target?.title || entry.target_id)}</strong>${field('在本页中的说明', 'entry_note', entry.note || '')}<button type="button" data-remove-entry>从本页移出</button></div>`;
    const dialog = modal(isNew ? `新建${kind === 'map' ? '专题' : '资产'}` : `编辑${kind === 'map' ? '研究概况' : '资产'}`, `<p class="research-description">${isNew ? `填写标题和研究内容即可保存，编号由系统生成。创建项目：${h(context.projectTitle || '当前项目')}。` : '内容有修改时保存为新版本，旧版保留。共用这条内容的项目会看到更新；内容未改变时保持原版本。'}</p>${field('标题', 'title', doc.title, false, '', true)}${kind === 'asset' ? field('标签', 'tags', doc.tags.join(', '), false, '可选，用逗号分隔，例如：紧性，一致估计。') : ''}${field(kind === 'asset' ? '研究内容' : '研究概况', 'body_md', doc.body_md, true, '写清结论、适用条件、证据和未解决的问题。支持 Markdown。')}${isNew ? `<div class="research-placement"><strong>添加到项目或专题</strong><span data-placement>${h(placement?.title || '暂不添加到项目或专题，可在资产列表中找到')}</span><button type="button" data-choose-placement class="research-button">选择项目或专题</button><button type="button" data-clear-placement class="research-button">暂不放入</button></div>` : ''}${kind === 'map' ? `<h4>本页展示的内容</h4><p class="minor">收录库中已保存的资产或专题，同一内容可以出现在多个项目或专题。从本页移出后，内容继续保留。</p><div data-entries>${doc.entries.map(entryRow).join('')}</div><button type="button" data-add-entry class="research-button">选择已有资产或专题</button>` : selectionField('来源汇报（可选）', 'source_reports', sourceItems, ['report'])}<h4>引用与联系（可选）</h4><p class="minor">选择资产或研究概况，系统记录所选版本。填写它提供了什么依据，或与这里的内容有什么联系。</p><div data-refs>${doc.references.map((ref) => refRow(ref, snapshot.reference_records?.find((item) => item.id === ref.asset_id && item.revision === ref.revision)?.title)).join('')}</div><button type="button" data-add-ref class="research-button">选择引用内容</button>`, async (data, form) => {
      const references = [...form.querySelectorAll('.research-ref-row')].map((row) => ({ asset_id: row.querySelector('[name=ref_id]').value, revision: Number(row.querySelector('[name=ref_revision]').value), relation: row.querySelector('[name=ref_relation]').value, note: row.querySelector('[name=ref_note]').value }));
      const args = { title: !isNew && doc.id === 'MROOT' && data.get('title') === '全库总览' ? snapshot.record.title : data.get('title'), body_md: !isNew && kind === 'map' && initialOverview(snapshot.record.body_md) && data.get('body_md') === '' ? snapshot.record.body_md : data.get('body_md'), references, ...(isNew ? {} : { [kind === 'asset' ? 'asset_id' : 'map_id']: doc.id, expected_revision: doc.revision }), ...(kind === 'asset' ? { tags: String(data.get('tags') || '').split(/[,，\n]/).map((s) => s.trim()).filter(Boolean), source_reports: data.getAll('source_reports') } : { entries: [...form.querySelectorAll('.research-entry-row')].map((row) => ({ target_id: row.querySelector('[name=entry_id]').value, note: row.querySelector('[name=entry_note]').value })) }) };
      if (!isNew && editableContent(kind, { ...args, title: data.get('title'), body_md: data.get('body_md') }) === editableContent(kind, doc)) {
        const latest = await call(`read_${kind}`, { [`${kind}_id`]: doc.id, max_chars: 1 });
        if (latest.current_revision !== doc.revision) throw new Error('Version conflict');
        context.showToast('内容未改变'); return;
      }
      const receipt = await call(kind === 'asset' ? 'save_asset' : 'save_map', args);
      let message = isNew ? '已保存' : receipt.record.revision === doc.revision ? '内容未改变' : '已保存新版本';
      if (isNew && placement) { try { await addToMap(placement.id, [{ id: receipt.record.id, title: receipt.record.title }]); } catch (error) { message = `已保存，添加到页面未成功：${errorText(error)}`; } }
      mapWide = false; await load({ ...(isNew ? {} : selection), kind, id: receipt.record.id, revision: undefined }, isNew); context.showToast(message);
    });
    bindSelections(dialog);
    if (isNew) { dialog.querySelector('[data-choose-placement]').onclick = async () => { const picked = await chooseRecords({ title: '选择项目或专题', kinds: ['map'] }); if (picked && dialog.isConnected) { placement = picked[0]; dialog.querySelector('[data-placement]').textContent = displayTitle(placement); } }; dialog.querySelector('[data-clear-placement]').onclick = () => { placement = null; dialog.querySelector('[data-placement]').textContent = '暂不添加到项目或专题，可在资产列表中找到'; }; }
    dialog.querySelector('[data-add-ref]').onclick = async () => { const picked = await chooseRecords({ title: '选择引用内容', kinds: ['asset', 'map'], exclude: doc.id ? [doc.id] : [] }); if (picked && dialog.isConnected) dialog.querySelector('[data-refs]').insertAdjacentHTML('beforeend', refRow({ asset_id: picked[0].id, revision: picked[0].revision, relation: 'uses' }, picked[0].title)); };
    const addEntry = dialog.querySelector('[data-add-entry]'); if (addEntry) addEntry.onclick = async () => { const picked = await chooseRecords({ title: '选择已有资产或专题', description: '选择已保存的内容，保存本次编辑后在本页展示。同一内容仍保存一份。', kinds: ['asset', 'map'], multiple: true, exclude: [doc.id, ...[...dialog.querySelectorAll('[name=entry_id]')].map((e) => e.value)] }); if (picked && dialog.isConnected) dialog.querySelector('[data-entries]').insertAdjacentHTML('beforeend', picked.map((item) => entryRow({ target_id: item.id, title: item.title, note: '' })).join('')); };
    dialog.addEventListener('click', async (event) => { try { if (event.target.matches('[data-remove-ref]')) event.target.closest('.research-ref-row').remove(); if (event.target.matches('[data-remove-entry]')) event.target.closest('.research-entry-row').remove(); if (event.target.matches('[data-change-ref]')) { const row = event.target.closest('.research-ref-row'), picked = await chooseRecords({ title: '更换引用内容', kinds: ['asset', 'map'], exclude: doc.id ? [doc.id] : [] }); if (picked && row.isConnected) row.outerHTML = refRow({ asset_id: picked[0].id, revision: picked[0].revision, relation: row.querySelector('[name=ref_relation]').value, note: row.querySelector('[name=ref_note]').value }, picked[0].title); } if (event.target.matches('[data-ref-version]')) await chooseVersion(event.target.closest('.research-ref-row')); } catch (error) { fail(error); } });
  }
  async function chooseVersion(row) {
    const id = row.querySelector('[name=ref_id]').value; const dialog = modal('选择引用版本', '<p class="minor">版本固定到实际使用的内容，后续更新会提供复查提示。</p><div data-version-list></div>');
    const fetch = async (offset = 0) => { const data = await call('list_record_versions', { record_id: id, offset }); if (!dialog.isConnected) return;
      for (const item of data.items) { const element = document.createElement('button'); element.type = 'button'; element.className = 'research-card'; element.textContent = `第 ${item.revision} 版 · ${new Date(item.at).toLocaleString()}`; element.onclick = async () => { try { const data = await call(id.startsWith('M') ? 'read_map' : 'read_asset', { [id.startsWith('M') ? 'map_id' : 'asset_id']: id, revision: item.revision, max_chars: 1 }); if (!row.isConnected) return; row.querySelector('[name=ref_revision]').value = item.revision; row.querySelector('[data-ref-title]').textContent = data.record.title; row.querySelector('[data-ref-version]').textContent = `第 ${item.revision} 版`; dialog.closePanel(); } catch (error) { fail(error); } }; dialog.querySelector('[data-version-list]').append(element); }
      if (data.next_offset !== null) { const more = document.createElement('button'); more.type = 'button'; more.textContent = '查看更多版本'; more.onclick = () => { more.remove(); fetch(data.next_offset).catch(fail); }; dialog.querySelector('[data-version-list]').append(more); }
    }; await fetch();
  }
  async function addToMap(mapId, items) {
    const response = await call('read_map', { map_id: mapId }); const doc = await fullRecord('map', response.record), existing = new Set(doc.entries.map((entry) => entry.target_id));
    await call('save_map', { map_id: doc.id, expected_revision: doc.revision, entries: [...doc.entries.map(({ target_id, note }) => ({ target_id, note })), ...items.filter((item) => !existing.has(item.id)).map((item) => ({ target_id: item.id, note: '' }))] });
  }
  function editAssessmentDocument(doc, onSaved) {
    const dialog = modal('编辑现状与计划', `${field('进展、成果、障碍与下一步', 'body_md', doc.body_md, true, '说明原目标是否解决，独立成果有什么价值，以及当前决策的依据。')}${selectionField('选择作为本项目成果的资产（可选）', 'outcomes', doc.outcomes, ['asset'])}<p class="research-field-help">从已有资产中组成成果清单。移除选择只会从清单移出，资产继续保留；选择成果不会将原研究目标标记为已解决。</p>`, async (data) => {
      const outcomes = [...new Set(data.getAll('outcomes'))];
      if (data.get('body_md') === doc.body_md && JSON.stringify(outcomes) === JSON.stringify(doc.outcomes.map((item) => item.id))) { const latest = await call('read_project_research'); if (latest.revision !== doc.revision) throw new Error('Version conflict'); context.showToast('内容未改变'); await onSaved?.(); return; }
      const saved = await call('save_project_research', { expected_revision: doc.revision, body_md: data.get('body_md'), outcomes });
      await onSaved?.(); updateInboxCount(); context.showToast(saved.unchanged ? '内容未改变' : '已保存现状与计划');
    }); bindSelections(dialog); return dialog;
  }
  function initializeContext(options) {
    context = { ...context, ...options };
    if (project === options.projectId) return;
    document.querySelectorAll('.research-dialog').forEach((dialog) => dialog.closePanel?.());
    project = options.projectId; selection = { kind: 'map', id: 'project' }; nav = 'project'; result = null; trail = []; searchQuery = ''; browseScope = { projectId: project, title: options.projectTitle }; treeVisible = true; mapWide = false; treeScrollLeft = 0; outcomeIds = new Set(); outcomesLoaded = false; ++outcomeGeneration; inboxCount = null; ++inboxGeneration;
    invalidateTree(); treeExpanded = new Set(['MROOT']); treePath = []; treeDetached = null; directoryPath = null; projectMapId = ''; ++generation;
  }
  async function openAssessment(options) {
    initializeContext(options); const currentProject = project;
    const doc = await call('read_project_research'); if (currentProject !== project || options.isCurrent?.() === false) return;
    const dialog = modal('研究现状与计划', `<div class="research-heading"><span class="minor">${h(context.projectTitle)} · 第 ${doc.revision} 版</span><button type="button" class="research-button" data-assessment-edit>编辑</button></div><div class="markdown-body">${context.renderMarkdown(doc.body_md || '还没有保存现状与计划。')}</div><h4>本项目成果 · ${doc.outcomes.length}</h4>${doc.outcomes.map((item) => `<button type="button" class="research-link" data-assessment-asset="${h(item.id)}">${h(item.title)}</button>`).join(' · ') || '<p class="muted">还没有选择成果资产。</p>'}`);
    dialog.querySelector('[data-assessment-edit]').onclick = () => { dialog.closePanel(); editAssessmentDocument(doc, async () => { options.onSaved?.(); await openAssessment(options); }); };
    dialog.querySelectorAll('[data-assessment-asset]').forEach((button) => { button.onclick = () => { dialog.closePanel(); options.openRecord?.({ kind: 'asset', id: button.dataset.assessmentAsset }); }; });
    if (window.MathJax?.typesetPromise) window.MathJax.typesetPromise([dialog]).catch(() => {});
  }
  async function action(name, value) {
    const viewToken = generation;
    host?.querySelectorAll('.research-menu[open]').forEach((menu) => { menu.open = false; });
    if (name === 'project-overview') return context.onProjectOverview?.();
    if (name === 'project-graph') return openGraph();
    if (name === 'asset-graph') return openGraph({ id: result.record.id, revision: result.link_revision ?? null });
    if (name === 'browse') { treeVisible = true; nav = browseScope ? 'project' : 'root'; trail = []; treeScrollTop = 0; treeFocus = ''; treeExpanded.add(browseScope?.mapId || (browseScope ? projectMapId : 'MROOT')); return load({ kind: 'map', id: browseScope?.mapId || (browseScope ? 'project' : 'root') }); }
    if (name === 'unplaced-assets') { const previous = rememberView(); treeVisible = false; mapWide = false; browseScope = result.project_map ? { projectId: result.project_id, title: result.record.title, mapId: result.record.id } : null; nav = 'project-inventory'; trail.push(previous); return load({ kind: 'inventory', recordKind: 'asset', unmapped: true, ...scopeArgs() }); }
    if (name === 'map-wide') { mapWide = !mapWide; draw(); return; }
    if (name === 'map-collapse') { if (!treeAutoExpand) { treeAutoExpand = true; treeCollapsed.clear(); await expandTreeDefaults(browseScope?.mapId || (browseScope ? projectMapId : 'MROOT'), generation, treeEpoch); draw(); return; } treeAutoExpand = false; treeExpanded = new Set(['MROOT']); treeFocus = ''; draw(); const area = host.querySelector('.research-tree-scroll'); area.scrollTo(0, 0); updateMapControls(area); return; }
    if (name === 'map-focus') { await prepareTree(result, selection, viewToken); if (viewToken === generation) { treeFocus = ''; draw(); } return; }
    if (name === 'assets' || name === 'reports') { treeVisible = false; mapWide = false; nav = name === 'reports' ? 'reports' : browseScope?.projectId === project ? 'project-inventory' : 'inventory'; trail = []; return load({ kind: 'inventory', recordKind: name === 'reports' ? 'report' : 'asset', ...scopeArgs() }); }
    if (name === 'all-topics') { if (result) trail.push(rememberView()); nav = browseScope ? 'project' : 'root'; return load({ kind: 'inventory', recordKind: 'map', ...scopeArgs() }); }
    if (name === 'toggle-navigation') {
      treeVisible = !treeVisible;
      if (!treeVisible) { mapWide = false; if (result.kind === 'asset') nav = 'project-inventory'; draw(); return; }
      const token = generation; navigationPending = token; draw();
      try { await prepareTree(result, selection, token); }
      finally { if (navigationPending === token) navigationPending = null; if (token === generation && treeVisible) draw(); }
      return;
    }
    if (name === 'inbox') { if (result) trail.push(rememberView()); browseScope = { projectId: project, title: context.projectTitle }; nav = 'inbox'; return load({ kind: 'inbox' }); }
    if (name === 'assessment') return openAssessment(context);
    if (name === 'record-info') { const doc = result.record; const dialog = modal('编号与版本', `<p>${h(displayTitle(doc))}</p><p>显示编号：${h(shortId(doc.id))} · 第 ${doc.revision} 版</p>${field('完整编号', 'complete_id', doc.id)}<button type="button" class="research-button" data-copy-id>复制完整编号</button>`); dialog.querySelector('input').readOnly = true; dialog.querySelector('[data-copy-id]').onclick = async () => { try { await navigator.clipboard.writeText(doc.id); context.showToast('已复制完整编号'); } catch { dialog.querySelector('input').select(); } }; return; }
    if (name === 'trash') { if (result) trail.push(rememberView()); browseScope = null; nav = 'trash'; return load({ kind: 'inventory', recordKind: 'asset', trash: true }); }
    if (name === 'back') { const previous = trail.pop(); if (!previous) return; nav = previous._nav || nav; browseScope = previous._scope || null; treeVisible = Boolean(previous._treeVisible); delete previous._nav; delete previous._scope; delete previous._treeVisible; return load(previous); }
    if (name === 'map-inventory') { treeVisible = false; const projectId = result.project_id, projectTitle = result.record.title; trail.push(rememberView()); browseScope = { projectId, title: projectTitle, mapId: result.record.id }; nav = projectId === project ? 'project-inventory' : 'inventory'; return load({ kind: 'inventory', recordKind: 'asset', ...scopeArgs() }); }
    if (name === 'refresh') { invalidateTree(); updateInboxCount(); updateOutcomes(); return load(selection); }
    if (name === 'kind') return load({ ...selection, recordKind: value });
    if (name === 'current') return load({ ...selection, kind: result.kind, id: result.record.id, revision: undefined });
    if (name === 'edit') return edit(result.kind);
    if (name === 'new-asset' || name === 'new-map') return edit(name === 'new-map' ? 'map' : 'asset', true);
    if (name === 'from-report') { const doc = await fullRecord(); if (viewToken !== generation) return; return edit('asset', true, { title: doc.title, body_md: doc.body_md, source_reports: [doc.id], source_title: doc.title }); }
    if (name === 'open-change') return load({ kind: value.startsWith('M') ? 'map' : 'asset', id: value }, true);
    if (name === 'more-body') { const data = await call(`read_${result.kind}`, { [`${result.kind}_id`]: result.record.id, revision: result.record.revision, offset: result.reading.next_offset }); if (viewToken !== generation) return; result.record.body_md += data.record.body_md; result.reading.next_offset = data.reading.next_offset; draw(); return; }
    if (name === 'more-entries') { const data = await call('read_map', { map_id: result.record.id, revision: result.record.revision, entry_offset: result.next_entry_offset, max_chars: 1 }); if (viewToken !== generation) return; result.entries.push(...data.entries); result.next_entry_offset = data.next_entry_offset; draw(); return; }
    if (name === 'more-locations') { const data = await call(`read_${result.kind}`, { [`${result.kind}_id`]: result.record.id, revision: result.record.revision, known_revision: result.record.revision, location_offset: result.locations.next_offset }); if (viewToken !== generation) return; result.locations.items.push(...data.locations.items); result.locations.next_offset = data.locations.next_offset; draw(); return; }
    if (name === 'more-list') { const data = await (selection.kind === 'search' ? readSearch(selection, result.next_offset) : call('list_research_records', { ...listArgs(selection), offset: result.next_offset })); if (viewToken !== generation) return; result.items.push(...data.items); result.next_offset = data.next_offset; draw(); return; }
    if (name === 'more-inbox' || name === 'more-notices') { const data = await call('get_research_inbox', name === 'more-inbox' ? { offset: result.next_offset } : { notice_offset: result.next_notice_offset }); if (viewToken !== generation) return; if (name === 'more-inbox') { result.reports.push(...data.reports); result.next_offset = data.next_offset; } else { result.notices.push(...data.notices); result.next_notice_offset = data.next_notice_offset; } draw(); return; }
    if (name === 'place' || name === 'add-entry') { const doc = result.record, kind = result.kind; const picked = await chooseRecords({ title: name === 'place' ? '添加到哪个项目或专题？' : doc.id === 'MROOT' ? '添加项目或专题' : '添加已有资产或专题', description: name === 'place' ? '选择项目或专题，让这条资产出现在对应页面中。同一资产可以出现在多个地方。' : doc.id === 'MROOT' ? '选择已有项目或专题，加入全库总览，便于跨项目查看。' : '选择已保存的资产或专题，添加到当前页面。同一内容仍保存一份。', confirmLabel: doc.id === 'MROOT' ? '添加入口' : '添加到本页', kinds: name === 'place' ? ['map'] : doc.id === 'MROOT' ? ['map'] : ['asset', 'map'], multiple: name === 'add-entry', exclude: [doc.id, ...(result.entries || []).map((entry) => entry.target_id)] }); if (!picked?.length) return; await addToMap(name === 'place' ? picked[0].id : doc.id, name === 'place' ? [{ id: doc.id, title: doc.title }] : picked); await load({ ...selection, kind, id: doc.id, revision: undefined }); context.showToast(name === 'place' ? '已添加' : '已添加'); return; }
    if (name === 'remove-entry') { const doc = await fullRecord(); const entry = doc.entries.find((item) => item.target_id === value); if (viewToken !== generation) return; return modal('从本页移出？', `<p>将“${h(entry?.title || value)}”从当前页面移出，资产库和其他项目或专题中的内容继续保留。</p>`, async () => { await call('save_map', { map_id: doc.id, expected_revision: doc.revision, entries: doc.entries.filter((entry) => entry.target_id !== value).map(({ target_id, note }) => ({ target_id, note })) }); await load({ ...selection, kind: 'map', id: doc.id, revision: undefined }); }, '从本页移出'); }
    if (name === 'archive') { const doc = result.record, kind = result.kind, restoring = result.archived; if (restoring) { await call('archive_research_record', { record_id: doc.id, expected_revision: result.current_revision, archived: false }); await load({ ...selection, kind, id: doc.id, revision: undefined }); context.showToast('已恢复'); return; } const links = await call('get_asset_links', { asset_id: doc.id, direction: 'incoming', limit: 1 }); if (viewToken !== generation) return; return modal('删除到回收站？', `<p>“${h(doc.title)}”会从所有项目的正常列表隐藏，放入回收站。历史版本、来源和原引用保留，可以恢复。</p>${kind === 'map' ? '<p>专题中的资产继续保留。</p>' : ''}${links.total ? `<p>有 ${links.total} 条引用使用或关联这条内容，删除后仍可查看原引用。</p>` : ''}`, async () => { await call('archive_research_record', { record_id: doc.id, expected_revision: doc.revision, archived: true }); await load({ ...selection, kind, id: doc.id, revision: undefined }); context.showToast('已放入回收站'); }, '删除到回收站'); }
    if (name === 'export') { const file = await call('export_research_record', { record_id: result.record.id, revision: result.record.revision }); const link = document.createElement('a'), url = URL.createObjectURL(new Blob([file.content], { type: 'application/json' })); link.href = url; link.download = file.filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 5000); return; }
    if (name === 'versions' || name === 'incoming') { const target = result.record.id, kind = result.kind; const dialog = modal(name === 'versions' ? '历史版本' : kind === 'map' ? '参考这份概况的研究' : '引用这条资产的研究', (name === 'incoming' ? '<p class="research-description">这里显示其他研究声明的引用及具体用途。添加到同一项目或专题不算研究引用。</p>' : '') + '<div data-records></div>'); const fetch = async (offset = 0) => { const data = await call(name === 'versions' ? 'list_record_versions' : 'get_asset_links', name === 'versions' ? { record_id: target, offset } : { asset_id: target, direction: 'incoming', offset }); if (!dialog.isConnected) return; for (const item of data.items) { const element = document.createElement('button'); element.type = 'button'; element.className = 'research-card'; element.textContent = name === 'versions' ? `第 ${item.revision} 版 · ${new Date(item.at).toLocaleString()}${item.archived ? ' · 已删除' : ''}` : `${item.target.title}：${item.note}`; element.onclick = () => { dialog.closePanel(); load(name === 'versions' ? { kind, id: target, revision: item.revision } : { kind: item.target.kind, id: item.source_id }, true); }; dialog.querySelector('[data-records]').append(element); } if (!data.items.length) dialog.querySelector('[data-records]').innerHTML = '<p class="muted">没有记录。</p>'; if (data.next_offset !== null) { const more = document.createElement('button'); more.type = 'button'; more.textContent = '查看更多'; more.onclick = () => { more.remove(); fetch(data.next_offset).catch(fail); }; dialog.querySelector('[data-records]').append(more); } }; await fetch(); return; }
    if (name === 'review' || name === 'review-change') { const dialog = modal(name === 'review' ? '处理汇报' : '完成复查', `${name === 'review' ? '<label>处理方式<select name="disposition"><option value="integrated">已整理进资产</option><option value="retained">保留原汇报</option><option value="deferred">稍后处理</option></select></label>' + selectionField('接收这份汇报的资产', 'asset_ids', [], ['asset']) : ''}${field(name === 'review' ? '处理说明' : '核查说明', 'note', '', true, name === 'review' ? '说明保留了什么、为什么保留或暂缓。整理进资产前，先保存资产并选择此汇报作为来源。' : '说明更新是否影响结论，以及已完成的调整。', true)}`, async (data) => { await call(name === 'review' ? 'review_report' : 'review_asset_changes', name === 'review' ? { report_id: value, disposition: data.get('disposition'), note: data.get('note'), asset_ids: data.get('disposition') === 'integrated' ? data.getAll('asset_ids') : [] } : { notice_ids: [value], note: data.get('note') }); await load(selection); }); bindSelections(dialog); if (name === 'review') { const disposition = dialog.querySelector('[name=disposition]'); disposition.onchange = () => { dialog.querySelector('[data-selection=asset_ids]').hidden = disposition.value !== 'integrated'; }; disposition.onchange(); } return; }
    if (name === 'edit-assessment') return editAssessmentDocument(result, () => load(selection));
    if (name === 'evidence') {
      const data = await call('read_evidence', { evidence_id: value, max_chars: 80000 });
      const dialog = modal('证据文件', `<p class="minor">${h(data.name)}</p><pre class="research-evidence">${h(data.text_available ? data.content : '此证据是二进制文件，可下载保存。')}</pre><p data-evidence-status class="minor">${data.next_offset !== null && data.text_available ? '当前显示部分文件内容。' : ''}</p>${data.next_offset !== null && data.text_available ? '<button type="button" class="research-button" data-more-evidence>继续阅读</button>' : ''}${data.download_url ? `<a class="research-button" href="${h(data.download_url)}" download>下载证据文件</a>` : ''}${data.file_path ? field('项目内文件位置', 'saved_path', data.file_path) : ''}`);
      let offset = data.next_offset;
      const more = dialog.querySelector('[data-more-evidence]');
      if (more) more.onclick = async () => { more.disabled = true; try { const page = await call('read_evidence', { evidence_id: value, offset, max_chars: 80000 }); if (!dialog.isConnected) return; dialog.querySelector('.research-evidence').textContent += page.content; offset = page.next_offset; if (offset === null) { more.remove(); dialog.querySelector('[data-evidence-status]').textContent = '已显示完整文件内容。'; } else more.disabled = false; } catch (error) { more.disabled = false; dialog.querySelector('[data-evidence-status]').textContent = errorText(error); } };
      const path = dialog.querySelector('[name=saved_path]'); if (path) path.readOnly = true;
    }
  }
  let countUpdateTimer, mapResizeFrame;
  window.addEventListener('resize', () => { cancelAnimationFrame(mapResizeFrame); mapResizeFrame = requestAnimationFrame(() => { const area = host?.querySelector('.research-tree-scroll'); if (area && context?.isActive?.() !== false) focusMapNode(area); }); });
  return {
    mount(options) { initializeContext(options); host = options.container; if (!result) load(selection); else if (!host.querySelector('.research-panel')) draw(); if (inboxCount === null) updateInboxCount(); if (!outcomesLoaded) updateOutcomes(); },
    openRecord(next) { return load(next, true); },
    openAssessment,
    changed() { window.AssetGraph?.changed(); dirty = true; outcomesLoaded = false; const element = host?.querySelector('[data-r-action=refresh]'); if (element) element.textContent = '有更新，刷新'; clearTimeout(countUpdateTimer); if (context) countUpdateTimer = setTimeout(updateInboxCount, 200); }
  };
})();
