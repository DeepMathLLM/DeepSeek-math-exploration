/* Version-aware research relationships. No inferred dependencies or asset writes. */
(function (root) {
  'use strict';
  const key = (id, revision) => `${id}@${revision}`;
  const versionEdgeKey = (edge) => `${key(edge.source, edge.source_revision)}/${key(edge.target, edge.target_revision)}`;
  function trace(data, id, revision) {
    const seeds = revision == null ? [...new Set(data.edges.flatMap((edge) => [edge.source === id ? key(id, edge.source_revision) : null, edge.target === id ? key(id, edge.target_revision) : null]).filter(Boolean))] : [key(id, revision)];
    const up = new Set(seeds), down = new Set(up), edgeKeys = new Set();
    // Keep the actual prefix/suffix edges of paths through the selected version.
    // Never walk forward from its ancestors or backward from its descendants.
    for (const [set, from, to] of [[up, 'target', 'source'], [down, 'source', 'target']]) {
      const adjacency = new Map();
      for (const edge of data.edges) {
        const start = key(edge[from], edge[`${from}_revision`]);
        if (!adjacency.has(start)) adjacency.set(start, []);
        adjacency.get(start).push({ next: key(edge[to], edge[`${to}_revision`]), edge });
      }
      const queue = [...set];
      for (let i = 0; i < queue.length; i++) for (const { next, edge } of adjacency.get(queue[i]) || []) {
        edgeKeys.add(versionEdgeKey(edge));
        if (!set.has(next)) { set.add(next); queue.push(next); }
      }
    }
    return { up, down, edgeKeys, nodes: new Set([id, ...[...up, ...down].map((value) => value.split('@')[0])]) };
  }
  function layout(data) {
    const nodes = new Map(data.nodes.map((node) => [node.id, node]));
    const forward = new Map([...nodes.keys()].map((id) => [id, new Set()]));
    const reverse = new Map([...nodes.keys()].map((id) => [id, new Set()]));
    for (const edge of data.edges) if (nodes.has(edge.source) && nodes.has(edge.target)) { forward.get(edge.source).add(edge.target); reverse.get(edge.target).add(edge.source); }
    // Collapse strongly connected components before assigning left-to-right layers.
    const visited = new Set(), order = [];
    for (const start of nodes.keys()) {
      if (visited.has(start)) continue;
      const stack = [[start, false]];
      while (stack.length) {
        const [id, done] = stack.pop();
        if (done) { order.push(id); continue; }
        if (visited.has(id)) continue;
        visited.add(id); stack.push([id, true]);
        for (const child of forward.get(id)) if (!visited.has(child)) stack.push([child, false]);
      }
    }
    const component = new Map(), groups = [];
    for (const start of order.reverse()) {
      if (component.has(start)) continue;
      const index = groups.length, group = [], stack = [start]; component.set(start, index);
      while (stack.length) {
        const id = stack.pop(); group.push(id);
        for (const parent of reverse.get(id)) if (!component.has(parent)) { component.set(parent, index); stack.push(parent); }
      }
      groups.push(group.sort());
    }
    const children = groups.map(() => new Set()), indegree = groups.map(() => 0), depth = groups.map(() => 0);
    for (const edge of data.edges) {
      const a = component.get(edge.source), b = component.get(edge.target);
      if (a !== undefined && b !== undefined && a !== b && !children[a].has(b)) { children[a].add(b); indegree[b]++; }
    }
    const queue = indegree.map((n, i) => n ? -1 : i).filter((i) => i >= 0);
    for (let i = 0; i < queue.length; i++) for (const child of children[queue[i]]) { depth[child] = Math.max(depth[child], depth[queue[i]] + 1); if (--indegree[child] === 0) queue.push(child); }
    const layers = [], isolated = [];
    for (const node of data.nodes) {
      if (!forward.get(node.id).size && !reverse.get(node.id).size) { isolated.push(node); continue; }
      const level = depth[component.get(node.id)]; (layers[level] ||= []).push(node.id);
    }
    // A few stable barycentre passes reduce crossings without changing membership.
    const position = new Map();
    for (let pass = 0; pass < 4; pass++) {
      layers.forEach((ids) => ids.forEach((id, i) => position.set(id, i)));
      for (const ids of pass % 2 ? [...layers].reverse() : layers) {
        const adjacent = pass % 2 ? forward : reverse;
        const score = (id) => { const ps = [...adjacent.get(id)].map((p) => position.get(p)).filter((p) => p !== undefined); return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : position.get(id); };
        ids.sort((a, b) => score(a) - score(b) || a.localeCompare(b));
      }
    }
    const width = 228, height = 112, column = 350, row = 154, padding = 52;
    const places = new Map(), maxRows = Math.max(0, ...layers.map((ids) => ids.length));
    layers.forEach((ids, level) => ids.forEach((id, i) => places.set(id, { x: padding + column * level, y: padding + (maxRows - ids.length) * row / 2 + row * i, width, height })));
    const isolatedY = maxRows ? padding + maxRows * row + 50 : padding;
    const isolatedColumns = Math.min(4, Math.max(1, isolated.length));
    isolated.forEach((node, i) => places.set(node.id, { x: padding + (i % isolatedColumns) * column, y: isolatedY + Math.floor(i / isolatedColumns) * row, width, height }));
    return { places, width: Math.max(550, ...[...places.values()].map((p) => p.x + width + padding)), height: Math.max(280, ...[...places.values()].map((p) => p.y + height + padding)) };
  }
  function projectGroups(data) {
    const nodes = new Map(data.nodes.filter((node) => !node.external).map((node) => [node.id, node]));
    const groups = data.topics.map((topic) => ({ ...topic, nodes: topic.asset_ids.map((id) => nodes.get(id)).filter(Boolean) })).filter((topic) => topic.nodes.length);
    const placed = new Set(groups.flatMap((group) => group.nodes.map((node) => node.id)));
    const remaining = [...nodes.values()].filter((node) => !placed.has(node.id));
    if (remaining.length) groups.push({ id: '__other', title: groups.length ? '其他研究资产' : '本项目研究资产', nodes: remaining, asset_ids: remaining.map((node) => node.id) });
    return groups;
  }
  function groupConnections(data, groups) {
    const memberships = new Map(), links = new Map();
    for (const group of groups) for (const id of group.asset_ids) { if (!memberships.has(id)) memberships.set(id, []); memberships.get(id).push(group.id); }
    for (const edge of data.edges) for (const source of memberships.get(edge.source) || []) for (const target of memberships.get(edge.target) || []) {
      if (source === target) continue;
      const id = `${source}/${target}`;
      if (!links.has(id)) links.set(id, { id, source, target, edge_ids: new Set() });
      links.get(id).edge_ids.add(edge.id);
    }
    return [...links.values()].map((link) => ({ ...link, edge_ids: [...link.edge_ids] }));
  }
  function mergeEdges(edges) {
    const merged = new Map();
    for (const edge of edges) {
      const id = `${key(edge.source, edge.source_revision)}/${key(edge.target, edge.target_revision)}`;
      if (!merged.has(id)) merged.set(id, { ...edge, notes: [] });
      const item = merged.get(id); if (!item.notes.includes(edge.note)) item.notes.push(edge.note);
    }
    return [...merged.values()].map((edge) => ({ ...edge, note: edge.notes.filter(Boolean).join('\n\n') }));
  }
  function bundleEdges(edges) {
    const groups = new Map();
    for (const edge of mergeEdges(edges)) {
      const id = `${edge.source}/${edge.target}`;
      if (!groups.has(id)) groups.set(id, { id, source: edge.source, target: edge.target, variants: [] });
      groups.get(id).variants.push(edge);
    }
    return [...groups.values()];
  }
  function relationLabel(variants, scoped = false) {
    if (!variants.length) return '';
    if (!scoped && variants.length > 1) return `${variants.length} 组版本联系`;
    const versions = (side) => {
      const values = [...new Set(variants.map((edge) => edge[`${side}_revision`]))].sort((a, b) => a - b);
      return values.length > 4 ? `${values.length} 个版本` : `第 ${values.join('、')} 版`;
    };
    return `${versions('source')} → ${versions('target')}`;
  }
  function findAssets(nodes, query) {
    const value = String(query).trim().toLowerCase();
    if (!value) return [];
    return nodes.filter((node) => node.title.toLowerCase().includes(value) || node.id.toLowerCase().includes(value) || node.id.replace(/^A0+(?=\d)/i, 'A').toLowerCase().includes(value));
  }
  const sameVersionEdge = (a, b) => a.source === b.source && a.target === b.target && a.source_revision === b.source_revision && a.target_revision === b.target_revision;
  function directGraph(data, id, revision = null) {
    const edges = data.edges.filter((edge) => (edge.source === id && (revision === null || edge.source_revision === revision)) || (edge.target === id && (revision === null || edge.target_revision === revision)));
    const ids = new Set([id, ...edges.flatMap((edge) => [edge.source, edge.target])]);
    return { ...data, nodes: data.nodes.filter((node) => ids.has(node.id)), edges };
  }
  function routeGraph(data, route) {
    const ids = new Set(route.nodes.map((node) => node.id));
    return { ...data, focus: null, nodes: data.nodes.filter((node) => ids.has(node.id)), edges: route.steps.map((step, index) => ({ ...step.edge, id: `r${index}` })) };
  }
  function routeConnections(data, route, targetId, revision = null, cursor = route.nodes.length - 1) {
    if (!route.nodes.length || route.nodes.some((node) => node.id === targetId)) return null;
    const indices = [...new Set([cursor, route.nodes.length - 1, ...route.nodes.map((_, index) => index).reverse()])];
    for (const index of indices) {
      const anchor = route.nodes[index]; if (!anchor) continue;
      const variants = mergeEdges(data.edges.filter((edge) => (edge.source === anchor.id && edge.target === targetId && (revision === null || edge.target_revision === revision)) || (edge.target === anchor.id && edge.source === targetId && (revision === null || edge.source_revision === revision))));
      if (variants.length) return { anchor, index, variants };
    }
    return null;
  }
  function extendRoute(route, edge, anchorId = edge.source, anchorIndex) {
    if (anchorId !== edge.source && anchorId !== edge.target) throw new Error('请选择与该联系相连的资产。');
    const forward = anchorId === edge.source;
    const from = { id: anchorId, revision: forward ? edge.source_revision : edge.target_revision };
    const to = { id: forward ? edge.target : edge.source, revision: forward ? edge.target_revision : edge.source_revision };
    const index = route.nodes.length ? anchorIndex ?? route.nodes.findLastIndex((node) => node.id === anchorId) : 0;
    if (route.nodes.length && route.nodes[index]?.id !== anchorId) throw new Error('所选节点不在脉络的这个位置。');
    if (index < 0) throw new Error('请先选择脉络中的节点，或从当前资产开始新脉络。');
    const nodes = route.nodes.length ? route.nodes.slice(0, index + 1).map((node) => ({ ...node })) : [from];
    if (nodes[index].revision == null) nodes[index].revision = from.revision;
    const step = { edge: { ...edge }, from, to, forward, switched: nodes[index].revision !== from.revision };
    return { nodes: [...nodes, to], steps: [...route.steps.slice(0, index), step] };
  }
  function open(options) {
    const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const short = (id) => id.replace(/^A0+(?=\d)/, 'A');
    const badge = (id) => `<code class="research-id-badge" title="${escape(id)}">${escape(short(id))}</code>`;
    const dialog = document.createElement('dialog'); dialog.className = 'research-dialog asset-graph-dialog';
    dialog.innerHTML = `<header class="ag-head"><div><h2>资产联系图</h2><p data-ag-caption></p></div><div class="ag-head-actions"><button class="research-button" type="button" data-ag-refresh>刷新</button><button class="research-button" type="button" data-ag-close aria-label="关闭资产联系图">关闭</button></div></header>
      <div class="ag-tools"><button type="button" class="research-button" data-ag-back hidden>返回上次查看</button><button type="button" class="research-button" data-ag-overview>研究全景</button><button type="button" class="research-button" data-ag-all>全部资产</button><form data-ag-search><input aria-label="在联系图中查找资产" placeholder="查找标题或编号"><button type="submit" class="research-button">查找</button></form><label><span data-ag-filter-name>专题</span> <select data-ag-topic aria-label="突出显示专题"><option value="">全部专题</option></select></label><div class="ag-zoom"><button type="button" class="research-button" data-ag-zoom="out" aria-label="缩小联系图">−</button><span data-ag-scale></span><button type="button" class="research-button" data-ag-zoom="in" aria-label="放大联系图">＋</button><button type="button" class="research-button" data-ag-fit>适合窗口</button></div></div>
      <div class="ag-route-bar"></div><p class="ag-legend">箭头：被使用的内容 → 使用它的研究 <span>★ 已选成果</span><span class="ag-external-key">项目外资产</span><span class="ag-flow-key" data-ag-highlight-key></span></p><div class="ag-search-results" hidden></div><div class="ag-notice" role="status" aria-live="polite"></div>
      <div class="ag-main"><div class="ag-map-panel"><div class="ag-focus-views" data-ag-focus-views hidden aria-label="当前联系图范围"><div class="ag-focus-scope"><div class="ag-focus-identity" aria-live="polite"><strong data-ag-focus-label></strong><span data-ag-focus-detail></span></div><button type="button" class="research-button" data-ag-exit-direct>退出</button></div><div class="ag-focus-tabs" role="group" aria-label="直接联系视野"><button type="button" class="research-button" data-ag-focus-view="compact">只看直接联系</button><button type="button" class="research-button" data-ag-focus-view="global">全图中显示</button></div></div>
      <div class="ag-viewport" tabindex="0" aria-label="资产联系图，拖动空白处移动，使用按钮缩放"><div class="ag-overview"></div><div class="ag-canvas"></div><div class="ag-minimap" hidden><span>全图位置</span><svg aria-label="全图位置，点击移动视野" role="button" tabindex="0" viewBox="0 0 200 120" preserveAspectRatio="none"></svg></div></div></div>
      <div class="ag-inspector-pane"><div class="ag-inspector-actions" data-ag-selected-actions hidden><button type="button" class="research-button primary" data-ag-local hidden></button></div><aside class="ag-inspector" aria-label="所选资产或联系"></aside></div><section class="ag-reader" hidden aria-label="阅读研究内容"></section></div>`;
    document.body.append(dialog); dialog.showModal();
    const $ = (query) => dialog.querySelector(query), canvas = $('.ag-canvas'), viewport = $('.ag-viewport'), inspector = $('.ag-inspector'), overview = $('.ag-overview');
    let data, allData, drawing, mode = 'graph', selected = null, selectedRevision = null, selectedEdge = null, topic = '', zoom = 1, x = 30, y = 30, serial = 0, closed = false;
    const history = [];
    let directReturn = null, globalDrawing = null, route = { nodes: [], steps: [] }, routeHistory = [], routeCursor = -1, readerSerial = 0, focusView = 'compact', routeView = 'browse', routeBrowseState = null;
    const focusCameras = new Map();
    const visitedFocusIds = new Set();
    let refreshToken = 0, pendingGraphRead = null;
    const reader = $('.ag-reader'), readingHistory = [];
    const close = () => { if (closed) return; closed = true; cancelNavigation(); ++readerSerial; resize.disconnect(); dialog.close(); dialog.remove(); options.onClosed?.(); };
    dialog.closePanel = close; $('[data-ag-close]').onclick = close;
    $('[data-ag-refresh]').onclick = refreshGraph;
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); if (!reader.hidden) closeReader(); else close(); });
    function transform() { canvas.style.transform = `translate(${x}px,${y}px) scale(${zoom})`; $('[data-ag-scale]').textContent = `${Math.round(zoom * 100)}%`; canvas.classList.toggle('ag-small', zoom < .6); drawMinimap(); }
    function fit() { if (!drawing || mode === 'overview') return; zoom = Math.min(1, (viewport.clientWidth - 40) / drawing.width, (viewport.clientHeight - 40) / drawing.height); zoom = Math.max(.005, zoom); x = (viewport.clientWidth - drawing.width * zoom) / 2; y = (viewport.clientHeight - drawing.height * zoom) / 2; transform(); }
    function magnify(factor, cx = viewport.clientWidth / 2, cy = viewport.clientHeight / 2) { const next = Math.max(.005, Math.min(2, zoom * factor)); x = cx - (cx - x) * next / zoom; y = cy - (cy - y) * next / zoom; zoom = next; transform(); }
    function focusNode(id) { const place = drawing?.places.get(id); if (!place) return; zoom = Math.max(.8, zoom); x = viewport.clientWidth / 2 - (place.x + place.width / 2) * zoom; y = viewport.clientHeight / 2 - (place.y + place.height / 2) * zoom; transform(); }
    function fitRoute() {
      const points = route.nodes.map((node) => drawing.places.get(node.id)).filter(Boolean); if (!points.length) { fit(); return; }
      const left = Math.min(...points.map((p) => p.x)) - 30, top = Math.min(...points.map((p) => p.y)) - 30;
      const width = Math.max(...points.map((p) => p.x + p.width)) - left + 30, height = Math.max(...points.map((p) => p.y + p.height)) - top + 30;
      zoom = Math.max(.005, Math.min(1, (viewport.clientWidth - 40) / width, (viewport.clientHeight - 40) / height));
      x = (viewport.clientWidth - width * zoom) / 2 - left * zoom; y = (viewport.clientHeight - height * zoom) / 2 - top * zoom; transform();
    }
    function setStatus(message) { $('.ag-notice').textContent = message; }
    function cancelNavigation() {
      ++serial;
      if (pendingGraphRead && $('.ag-notice').textContent === pendingGraphRead.message) setStatus('');
      pendingGraphRead = null;
    }
    function beginGraphRead(token, message) { pendingGraphRead = { token, message }; setStatus(message); }
    function snapshot() { return { data: { ...data, focus: data.focus && { ...data.focus } }, mode, selected, selectedRevision, selectedEdge, directReturn, topic, focusView, routeView, routeBrowseState, x, y, zoom }; }
    function remember() { history.push(snapshot()); }
    function restore(state) {
      cancelNavigation(); setStatus(''); const edge = state.selectedEdge;
      ({ data, mode, selected, selectedRevision, directReturn, topic, focusView, routeView, x, y, zoom } = state);
      data = resolveViewData(data);
      routeBrowseState = state.routeBrowseState || null;
      if (!route.nodes.length && routeView !== 'browse') {
        if (routeBrowseState) return restore({ ...routeBrowseState, routeView: 'browse', routeBrowseState: null });
        routeView = 'browse'; data = allData;
      }
      if (selected && !data.nodes.some((node) => node.id === selected)) { selected = null; selectedRevision = null; }
      selectedEdge = null; render(); if (edge) inspectEdge(edge);
    }
    function resolveViewData(previous) {
      const spec = previous._view;
      let edges, ids, title = previous.title;
      if (spec?.kind === 'region') {
        const group = projectGroups(allData).find((item) => item.id === spec.id);
        title = group?.title || title;
        ids = new Set(group?.asset_ids || []);
        edges = allData.edges.filter((edge) => ids.has(edge.source) || ids.has(edge.target));
        ids = new Set([...ids, ...edges.flatMap((edge) => [edge.source, edge.target])]);
      } else if (spec?.kind === 'connection') {
        const link = groupConnections(allData, projectGroups(allData)).find((item) => item.id === spec.id);
        const edgeIds = new Set(link?.edge_ids || []);
        edges = allData.edges.filter((edge) => edgeIds.has(edge.id));
        ids = new Set(edges.flatMap((edge) => [edge.source, edge.target]));
      }
      return { ...allData, ...(spec ? { _view: spec, title } : {}), ...(ids ? { nodes: allData.nodes.filter((node) => ids.has(node.id)), edges } : {}), focus: previous.focus && { ...previous.focus } };
    }
    function mergeGraph(base, extra) {
      const nodes = new Map(base.nodes.map((node) => [node.id, node]));
      for (const node of extra.nodes) {
        const old = nodes.get(node.id);
        nodes.set(node.id, old ? { ...old, ...node, versions: [...new Set([...old.versions, ...node.versions])] } : node);
      }
      const edges = new Map([...base.edges, ...extra.edges].map((edge) => [`${versionEdgeKey(edge)}/${edge.note}`, edge]));
      return { ...base, nodes: [...nodes.values()], edges: [...edges.values()].map((edge, index) => ({ ...edge, id: `g${index}` })), focus: null };
    }
    async function refreshGraph() {
      if (!allData || closed) return;
      const origin = snapshot(), token = ++serial, button = $('[data-ag-refresh]');
      refreshToken = token; button.disabled = true; beginGraphRead(token, '正在刷新研究资产…');
      try {
        let fresh = await options.fetchGraph({ project_id: options.projectId, all_versions: true });
        if (closed || token !== serial) return;
        const nodes = new Map(fresh.nodes.map((node) => [node.id, node])), edges = new Set(fresh.edges.map(versionEdgeKey)), centers = new Set();
        if (origin.data.focus) centers.add(origin.data.focus.id);
        for (const id of visitedFocusIds) if (!nodes.has(id) || nodes.get(id).external) centers.add(id);
        for (const node of route.nodes) if (!nodes.has(node.id)) centers.add(node.id);
        for (const step of route.steps) if (!edges.has(versionEdgeKey(step.edge))) centers.add(step.edge.target);
        if (selected && !nodes.has(selected)) centers.add(selected);
        for (const id of centers) {
          const extra = await options.fetchGraph({ project_id: options.projectId, asset_id: id, all_versions: true });
          if (closed || token !== serial) return;
          fresh = mergeGraph(fresh, extra);
        }
        allData = fresh;
        for (const id of centers) visitedFocusIds.add(id);
        restore({ ...origin, x, y, zoom });
      } catch (error) { if (!closed && token === serial) setStatus(`刷新失败：${error.message}`); }
      finally { if (pendingGraphRead?.token === token) pendingGraphRead = null; if (refreshToken === token) { refreshToken = 0; button.disabled = false; } }
    }
    function graphForView() {
      if (routeView === 'only') return routeGraph(allData, route);
      if (routeView === 'global') return allData;
      return data.focus && focusView === 'compact' ? directGraph(data, data.focus.id, data.focus.revision) : data;
    }
    function switchRouteView(view) {
      if (view === routeView || !route.nodes.length) return;
      cancelNavigation(); setStatus(''); const origin = snapshot();
      history.push(origin);
      if (view === 'browse' && routeBrowseState) return restore({ ...routeBrowseState, routeView: 'browse', routeBrowseState: null });
      if (routeView === 'browse') routeBrowseState = origin;
      routeView = view; data = allData; directReturn = null; mode = 'graph'; selectedEdge = null;
      if (view === 'only' && !route.nodes.some((node) => node.id === selected)) { selected = route.nodes.at(-1).id; selectedRevision = route.nodes.at(-1).revision; }
      render(); if (view === 'global') fitRoute(); else fit();
    }
    function toggleRouteView(view) { return switchRouteView(view === routeView ? 'browse' : view); }
    function exitDirect() {
      if (!data?.focus) return;
      cancelNavigation(); remember();
      const previous = directReturn || { ...snapshot(), data: allData, mode: 'graph', directReturn: null, routeView: 'browse', routeBrowseState: null };
      const previousData = resolveViewData(previous.data);
      const keepSelection = selected && previousData.nodes.some((node) => node.id === selected) && (previous.routeView !== 'only' || route.nodes.some((node) => node.id === selected));
      restore({ ...previous, ...(keepSelection ? { selected, selectedRevision } : {}), selectedEdge: null });
    }
    function switchFocusView(view) {
      if (!data?.focus || view === focusView) return;
      cancelNavigation(); setStatus('');
      const cameraKey = `${key(data.focus.id, data.focus.revision)}/`;
      focusCameras.set(cameraKey + focusView, { x, y, zoom });
      const edge = selectedEdge;
      focusView = view; render();
      const saved = focusCameras.get(cameraKey + view);
      if (saved) { ({ x, y, zoom } = saved); transform(); }
      else if (view === 'compact') fit(); else focusNode(selected || data.focus.id);
      if (edge) inspectEdge(edge);
    }
    function updateFocusControls() {
      const viewingDirect = routeView === 'browse' && data?.focus?.id === selected && (data.focus.revision ?? null) === selectedRevision;
      const local = $('[data-ag-local]'); local.hidden = mode === 'overview' || !selected || viewingDirect;
      $('[data-ag-selected-actions]').hidden = local.hidden;
      local.textContent = selected ? `查看 ${short(selected)} 的直接联系` : '查看直接联系';
      local.title = selected ? `查看所选资产 ${selected} 的直接联系` : '查看所选资产的直接联系';
      const scope = $('[data-ag-focus-views]'); scope.hidden = routeView !== 'browse' || mode === 'overview' || !data?.focus;
      viewport.classList.toggle('ag-direct-view', !scope.hidden);
      $('[data-ag-focus-label]').textContent = data?.focus ? `${short(data.focus.id)} 的直接联系` : '';
      $('[data-ag-focus-label]').title = data?.focus ? data.nodes.find((node) => node.id === data.focus.id)?.title || data.focus.id : '';
      $('[data-ag-focus-detail]').textContent = data?.focus ? `${$('[data-ag-focus-label]').title} · ${data.focus.revision == null ? '全部版本' : `第 ${data.focus.revision} 版`}` : '';
      $('[data-ag-focus-detail]').title = $('[data-ag-focus-detail]').textContent;
      $('[data-ag-exit-direct]').title = data?.focus ? `退出 ${short(data.focus.id)} 的直接联系，返回之前的视图` : '退出直接联系';
      $('[data-ag-exit-direct]').setAttribute('aria-label', $('[data-ag-exit-direct]').title);
      dialog.querySelectorAll('[data-ag-focus-view]').forEach((button) => { const active = button.dataset.agFocusView === focusView; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
      const legend = $('[data-ag-highlight-key]');
      legend.textContent = routeView !== 'browse' ? '绿色：已选脉络' : data?.focus ? '蓝色：所选资产的直接联系' : '蓝色：源头 → 所选资产 → 末尾';
      legend.classList.toggle('ag-route-key', routeView !== 'browse');
      if (routeView === 'browse' && data?.focus) $('[data-ag-caption]').textContent = `${data.title} · ${short(data.focus.id)} · ${data.focus.revision == null ? '全部版本' : `第 ${data.focus.revision} 版`}的直接联系 · ${focusView === 'compact' ? '只看直接联系' : '全图中显示'}`;
    }
    dialog.querySelectorAll('[data-ag-focus-view]').forEach((button) => { button.onclick = () => switchFocusView(button.dataset.agFocusView); });
    $('[data-ag-exit-direct]').onclick = exitDirect;
    $('[data-ag-local]').onclick = () => { if (selected) return fetchFocus(selected, selectedRevision); };
    function nodeButton(node, revision, label) { return `<button type="button" class="research-button" data-ag-read="${escape(node.id)}" data-ag-revision="${revision}">${escape(label || `阅读第 ${revision} 版`)}</button>`; }
    function bindReads() { inspector.querySelectorAll('[data-ag-read]').forEach((button) => { button.onclick = () => readContent({ kind: 'asset', id: button.dataset.agRead, revision: Number(button.dataset.agRevision) }); }); }
    async function readContent(next, push = true, offset = 0) {
      if (!options.readRecord) { close(); options.onOpen(next); return; }
      const token = ++readerSerial;
      if (push) readingHistory.push({ ...next });
      reader.hidden = false;
      reader.innerHTML = '<p class="ag-reader-loading">正在读取…</p><button type="button" class="research-button" data-ag-reader-close>返回研究脉络</button>';
      reader.querySelector('[data-ag-reader-close]').onclick = closeReader;
      try {
        const response = await options.readRecord(next, offset);
        if (closed || token !== readerSerial || reader.hidden) return;
        const doc = response.record;
        readingHistory[readingHistory.length - 1] = { kind: next.kind, id: doc.id, revision: doc.revision };
        const reference = (id, revision, title, kind) => `<button type="button" class="research-link" data-ag-reader-link="${escape(id)}" data-kind="${kind}" data-revision="${revision}">${badge(id)} ${escape(title || id)} · 第 ${revision} 版</button>`;
        reader.innerHTML = `<header class="ag-reader-head"><div><span>${badge(doc.id)} · 第 ${doc.revision} 版</span><h3>${escape(doc.title)}</h3></div><div class="ag-read-actions">${readingHistory.length > 1 ? '<button type="button" class="research-button" data-ag-reader-back>返回上一份内容</button>' : ''}<button type="button" class="research-button primary" data-ag-reader-close>返回研究脉络</button></div></header><div class="ag-reader-body"><div class="markdown-body">${options.renderMarkdown ? options.renderMarkdown(doc.body_md || '') : `<pre>${escape(doc.body_md)}</pre>`}</div>${response.reading?.next_offset != null ? '<button type="button" class="research-button" data-ag-reader-more>继续阅读</button>' : ''}${doc.references?.length ? `<section class="ag-reader-links"><h4>引用内容</h4>${doc.references.map((ref) => { const target = response.reference_records?.find((item) => item.id === ref.asset_id && item.revision === ref.revision); return `<div>${reference(ref.asset_id, ref.revision, target?.title, target?.kind || 'asset')}<p>${escape(ref.note)}</p></div>`; }).join('')}</section>` : ''}${response.source_report_records?.length ? `<section class="ag-reader-links"><h4>原始汇报</h4>${response.source_report_records.map((report) => reference(report.id, report.revision, report.title, 'report')).join('')}</section>` : ''}</div>`;
        reader.scrollTop = 0;
        reader.querySelector('[data-ag-reader-close]').onclick = closeReader;
        const back = reader.querySelector('[data-ag-reader-back]'); if (readingHistory.length > 1 && back) back.onclick = () => { readingHistory.pop(); readContent(readingHistory.at(-1), false); };
        reader.querySelectorAll('[data-ag-reader-link]').forEach((button) => { button.onclick = () => readContent({ kind: button.dataset.kind, id: button.dataset.agReaderLink, revision: Number(button.dataset.revision) }); });
        const more = reader.querySelector('[data-ag-reader-more]'); if (response.reading?.next_offset != null && more) more.onclick = async () => {
          more.disabled = true;
          try {
            const page = await options.readRecord({ kind: next.kind, id: doc.id, revision: doc.revision }, response.reading.next_offset);
            if (closed || token !== readerSerial || reader.hidden) return;
            doc.body_md += page.record.body_md;
            response.reading = page.reading;
            reader.querySelector('.markdown-body').innerHTML = options.renderMarkdown ? options.renderMarkdown(doc.body_md) : `<pre>${escape(doc.body_md)}</pre>`;
            more.hidden = page.reading.next_offset === null; more.disabled = false;
            root.MathJax?.typesetPromise?.([reader]).catch(() => {});
          } catch (error) { if (token === readerSerial) { more.disabled = false; setStatus(error.message); } }
        };
        root.MathJax?.typesetPromise?.([reader]).catch(() => {});
      } catch (error) { if (!closed && token === readerSerial) { reader.innerHTML = `<p>${escape(error.message)}</p><button type="button" class="research-button" data-ag-reader-close>返回研究脉络</button>`; reader.querySelector('[data-ag-reader-close]').onclick = closeReader; } }
    }
    function closeReader() { ++readerSerial; reader.hidden = true; readingHistory.length = 0; }
    function routeAnchor(edge) {
      const incident = (id) => edge.source === id || edge.target === id;
      if (selected && incident(selected) && (!route.nodes.length || route.nodes.some((node) => node.id === selected))) return selected;
      const tail = route.nodes.at(-1)?.id;
      if (tail && incident(tail)) return tail;
      return route.nodes.findLast((node) => incident(node.id))?.id || (selected && incident(selected) ? selected : edge.source);
    }
    function renderRoute() {
      const bar = $('.ag-route-bar');
      bar.innerHTML = `<div class="ag-route-heading"><strong>当前脉络</strong><span>${route.nodes.length ? routeView === 'browse' ? '点下一个节点，再点“加入脉络”；也可点连线审查。' : '再次点击已选视图按钮，返回原视图。' : '先选一个节点作为起点，再逐个加入相连的节点。'}</span>${route.nodes.length ? `<div class="ag-route-views" role="group" aria-label="已选脉络的显示方式"><button type="button" class="research-button${routeView === 'global' ? ' active' : ''}" data-ag-route-view="global">全图突出脉络</button><button type="button" class="research-button${routeView === 'only' ? ' active' : ''}" data-ag-route-view="only">只看脉络</button></div>` : ''}${routeHistory.length ? '<button type="button" class="research-button" data-ag-route-undo>撤回上一步</button>' : ''}${route.nodes.length ? '<button type="button" class="research-button" data-ag-route-clear>清除脉络</button>' : ''}</div>${route.nodes.length ? `<div class="ag-route-steps">${route.nodes.map((node, i) => { const step = route.steps[i - 1]; return `${step?.switched ? `<span class="ag-route-switch" title="此处使用了同一资产的另一个版本，不能视为连续的同版本依赖">版本切换：第 ${route.nodes[i-1].revision} → 第 ${step.from.revision} 版</span>` : ''}${step ? `<span class="ag-route-arrow">${step.forward ? '→' : '←'}</span>` : ''}<button type="button" data-ag-route-node="${i}" title="${escape((allData || data)?.nodes.find((n) => n.id === node.id)?.title || node.id)}">${badge(node.id)}<small>${node.revision == null ? '全部版本' : `第 ${node.revision} 版`}</small></button>`; }).join('')}</div>` : ''}`;
      bar.querySelectorAll('[data-ag-route-view]').forEach((button) => { const active = button.dataset.agRouteView === routeView; button.onclick = () => toggleRouteView(button.dataset.agRouteView); button.setAttribute('aria-pressed', String(active)); button.title = active ? '再次点击返回原视图' : '点击进入此视图'; });
      bar.querySelectorAll('[data-ag-route-node]').forEach((button) => { button.onclick = () => { cancelNavigation(); const index = Number(button.dataset.agRouteNode), node = route.nodes[index]; select(node.id, node.revision, true, index); }; });
      if (routeHistory.length) bar.querySelector('[data-ag-route-undo]').onclick = () => { cancelNavigation(); route = routeHistory.pop(); finishRouteEdit(); };
      if (route.nodes.length) bar.querySelector('[data-ag-route-clear]').onclick = () => { cancelNavigation(); route = { nodes: [], steps: [] }; routeHistory = []; finishRouteEdit(); };
    }
    function finishRouteEdit() {
      setStatus(''); routeCursor = Math.min(routeCursor, route.nodes.length - 1); selectedEdge = null;
      if (!route.nodes.length && routeView !== 'browse') {
        if (routeBrowseState) return restore({ ...routeBrowseState, routeView: 'browse', routeBrowseState: null, selectedEdge: null });
        routeView = 'browse'; data = allData; directReturn = null;
      }
      if (routeView === 'only' && !route.nodes.some((node) => node.id === selected)) { selected = route.nodes.at(-1)?.id || null; selectedRevision = route.nodes.at(-1)?.revision ?? null; }
      render();
    }
    function startRoute() { cancelNavigation(); routeHistory.push(route); route = { nodes: [{ id: selected, revision: selectedRevision }], steps: [] }; routeCursor = 0; render(); }
    function continueRoute(edge, anchorId, anchorIndex) {
      try {
        const anchor = anchorId || routeAnchor(edge), next = extendRoute(route, edge, anchor, anchorIndex ?? (route.nodes[routeCursor]?.id === anchor ? routeCursor : undefined));
        cancelNavigation();
        routeHistory.push(route); route = next;
        const inspectedEdge = selectedEdge;
        render(); setStatus('');
        if (inspectedEdge) inspectEdge(inspectedEdge);
        routeCursor = route.nodes.length - 1;
      } catch (error) { setStatus(error.message); }
    }
    function stableDrawing() {
      if (!globalDrawing) globalDrawing = layout(allData || data);
      for (const node of [...(allData || data).nodes, ...data.nodes]) if (!globalDrawing.places.has(node.id)) {
        globalDrawing.places.set(node.id, { x: 52, y: globalDrawing.height, width: 228, height: 112 }); globalDrawing.height += 154;
      }
      return globalDrawing;
    }
    function drawMinimap() {
      const mini = $('.ag-minimap'); mini.hidden = mode === 'overview' || !drawing;
      if (!drawing || mode === 'overview') return;
      const base = globalDrawing || drawing;
      const sx = 200 / base.width, sy = 120 / base.height;
      const routeIds = new Set(route.nodes.map((node) => node.id));
      let box = { x: -x / zoom, y: -y / zoom, width: viewport.clientWidth / zoom, height: viewport.clientHeight / zoom };
      if (routeView === 'only' || (routeView === 'browse' && data.focus && focusView === 'compact')) {
        const points = graphForView().nodes.map((node) => base.places.get(node.id));
        const left = Math.min(...points.map((p) => p.x)), top = Math.min(...points.map((p) => p.y));
        box = { x: left - 15, y: top - 15, width: Math.max(...points.map((p) => p.x + p.width)) - left + 30, height: Math.max(...points.map((p) => p.y + p.height)) - top + 30 };
      }
      mini.querySelector('span').textContent = routeView === 'only' ? '当前脉络在全图中的位置' : data.focus && focusView === 'compact' ? '直接节点在全图中的位置' : '全图位置';
      mini.querySelector('svg').innerHTML = (allData || data).nodes.map((node) => { const p = base.places.get(node.id); return `<rect x="${p.x*sx}" y="${p.y*sy}" width="${Math.max(2,p.width*sx)}" height="${Math.max(2,p.height*sy)}" rx="1" fill="${node.id === selected ? '#315c87' : routeIds.has(node.id) ? '#208773' : '#bdcddd'}"/>`; }).join('') + `<rect class="ag-minimap-window" x="${box.x*sx}" y="${box.y*sy}" width="${box.width*sx}" height="${box.height*sy}" fill="#315c8710" stroke="#315c87" stroke-width="1"/>`;
    }
    // Selecting an asset never changes the graph's scope or direct-contact center.
    function select(id, revision = null, center = false, cursor) {
      const node = data.nodes.find((n) => n.id === id); if (!node) return;
      const changedSelection = selected !== id || selectedRevision !== revision;
      selected = id; selectedRevision = revision; selectedEdge = null;
      const cursorIndex = cursor ?? route.nodes.findLastIndex((node) => node.id === id);
      if (cursorIndex >= 0) routeCursor = cursorIndex; else if (routeCursor >= route.nodes.length) routeCursor = route.nodes.length - 1;
      const edges = data.edges.filter((e) => (e.target === id && (revision === null || e.target_revision === revision)) || (e.source === id && (revision === null || e.source_revision === revision)));
      const used = bundleEdges(edges.filter((e) => e.target === id)), users = bundleEdges(edges.filter((e) => e.source === id));
      const variants = mergeEdges(edges);
      const viewTitle = revision === null ? node.title : variants.find((e) => e.target === id && e.target_revision === revision)?.target_title || variants.find((e) => e.source === id && e.source_revision === revision)?.source_title || node.title;
      const versions = [...new Set([...node.versions, node.revision])].sort((a, b) => b - a);
      const scopeDescription = routeView !== 'browse' ? '当前突出已选脉络；下方列出这项资产的直接联系。' : data.focus ? (data.focus.id !== id ? `当前范围是 ${short(data.focus.id)} 的直接联系。点击详情顶部“查看 ${short(id)} 的直接联系”可切换。` : revision === null ? '汇集各版本的直接联系；每条联系保留引用双方的版本。' : `只显示第 ${revision} 版的直接联系。`) : revision === null ? '突出经过此资产各版本的完整路径：源头 → 此资产 → 末尾。每条路径按实际引用版本连接。' : `突出经过第 ${revision} 版的完整路径：源头 → 此资产 → 末尾。`;
      const connection = routeConnections(allData, route, id, revision, routeCursor);
      if (connection) {
        const version = (edge, assetId) => edge.source === assetId ? edge.source_revision : edge.target_revision;
        connection.variants.sort((a, b) => version(b, id) - version(a, id) || version(b, connection.anchor.id) - version(a, connection.anchor.id));
      }
      const inRoute = route.nodes.some((item) => item.id === id);
      const join = connection ? `<section class="ag-node-join"><h4>接到当前脉络</h4><p>从 ${badge(connection.anchor.id)} 继续到 ${badge(id)}${connection.index < route.nodes.length - 1 ? ' · 将改选这个位置之后的路线' : ''}</p>${connection.variants.length > 1 ? `<label>选择引用版本<select data-ag-join-version aria-label="加入脉络所用的引用版本"><option value="">请选择版本</option>${connection.variants.map((edge, i) => `<option value="${i}">${escape(short(edge.source))} 第 ${edge.source_revision} 版 → ${escape(short(edge.target))} 第 ${edge.target_revision} 版</option>`).join('')}</select></label>` : `<p>${escape(short(connection.variants[0].source))} 第 ${connection.variants[0].source_revision} 版 → ${escape(short(connection.variants[0].target))} 第 ${connection.variants[0].target_revision} 版</p>`}<p data-ag-join-note>${connection.variants.length === 1 ? escape(connection.variants[0].note) : '请选择要沿用的引用版本，下面会显示具体用途。'}</p><button type="button" class="research-button primary" data-ag-join-node${connection.variants.length > 1 ? ' disabled' : ''}>${connection.index < route.nodes.length - 1 ? '从这里改选后续' : '加入脉络'}</button></section>` : inRoute ? '<p class="ag-route-help">这项资产已在脉络中。点选相连的下一个节点即可继续。</p>' : route.nodes.length ? '<p class="ag-route-help">这项资产与当前脉络没有已记录的直接联系。可以继续查看它的联系，或从它开始一条新脉络。</p>' : '';
      const row = (link, incoming) => {
        const other = data.nodes.find((n) => n.id === (incoming ? link.source : link.target));
        return `<div class="ag-relation-card"><button type="button" class="ag-relation-row" data-ag-edge="${escape(link.id)}" aria-label="审查与 ${escape(short(other.id))} 的联系">${badge(other.id)}<strong>${escape(other.title)}</strong><small>${link.variants.map((e) => `第 ${e.source_revision} 版 → 第 ${e.target_revision} 版`).join('；')}</small></button><button type="button" class="research-button" data-ag-view-node="${escape(other.id)}">查看它的直接联系</button></div>`;
      };
      inspector.innerHTML = `<span class="ag-eyebrow">${node.external ? '项目外资产' : node.outcome ? '★ 已选成果' : '研究资产'}</span> ${badge(id)}<h3>${escape(viewTitle)}</h3><label class="ag-version">联系范围<select aria-label="选择联系范围"><option value="all"${revision === null ? ' selected' : ''}>全部版本</option>${versions.map((v) => `<option value="${v}"${v === revision ? ' selected' : ''}>第 ${v} 版${v === node.revision ? '（当前）' : ''}</option>`).join('')}</select></label><p class="ag-version-description">${scopeDescription}</p><div class="ag-read-actions">${nodeButton(node, revision ?? node.revision, revision === null ? '阅读当前版本' : undefined)}${options.onLocate ? '<button type="button" class="research-button" data-ag-map-location>在资产地图中查看</button>' : ''}<button type="button" class="research-button" data-ag-start-route${route.nodes.some((node) => node.id === id) ? ' hidden' : ''}>${route.nodes.length ? '从此资产开始新脉络' : '从此资产开始脉络'}</button></div>${join}<h4>用到的内容 · ${used.length}</h4>${used.map((e) => row(e, true)).join('') || '<p class="minor">此范围没有已记录的依据。</p>'}<h4>使用它的研究 · ${users.length}</h4>${users.map((e) => row(e, false)).join('') || '<p class="minor">此范围没有已记录的后续引用。</p>'}`;
      if (connection) {
        let choice = connection.variants.length === 1 ? 0 : null;
        const joinButton = inspector.querySelector('[data-ag-join-node]');
        const versionChoice = inspector.querySelector('[data-ag-join-version]');
        if (connection.variants.length > 1) versionChoice.onchange = () => { choice = versionChoice.value === '' ? null : Number(versionChoice.value); joinButton.disabled = choice === null; inspector.querySelector('[data-ag-join-note]').textContent = choice === null ? '请选择引用版本。' : connection.variants[choice].note; };
        joinButton.onclick = () => { if (choice === null) { setStatus('请先选择引用版本。'); return; } return continueRoute(connection.variants[choice], connection.anchor.id, connection.index); };
      }
      inspector.querySelector('select').onchange = (event) => {
        const next = event.target.value === 'all' ? null : Number(event.target.value);
        if (data.focus?.id === id) return fetchFocus(id, next);
        cancelNavigation(); select(id, next);
      };
      inspector.querySelector('[data-ag-start-route]').onclick = startRoute;
      if (options.onLocate) inspector.querySelector('[data-ag-map-location]').onclick = async () => { cancelNavigation(); const next = { kind: 'asset', id, revision: revision ?? node.revision }; dialog.close(); try { await options.onLocate(next, () => { if (!closed) { dialog.showModal(); transform(); } }); } catch (error) { if (!closed) { dialog.showModal(); setStatus(error.message); } } };
      inspector.querySelectorAll('[data-ag-edge]').forEach((button) => { button.onclick = () => inspectEdge(button.dataset.agEdge); }); bindReads(); highlight(); if (center) focusNode(id);
      inspector.querySelectorAll('[data-ag-view-node]').forEach((button) => { button.onclick = () => fetchFocus(button.dataset.agViewNode, null); });
      if (changedSelection) inspector.scrollTop = 0;
    }
    function variantsForView(link, traced = selected ? trace(data, selected, selectedRevision) : null) {
      if (routeView !== 'browse') {
        const chosen = link.variants.filter((edge) => route.steps.some((step) => sameVersionEdge(step.edge, edge)));
        if (chosen.length) return chosen;
      }
      if (!selected) return link.variants;
      const matching = link.variants.filter((edge) => traced.edgeKeys.has(versionEdgeKey(edge)));
      return matching.length || selectedRevision !== null ? matching : link.variants;
    }
    function inspectEdge(id) {
      const bundle = bundleEdges(data.edges).find((e) => e.id === id); if (!bundle) return;
      const link = { ...bundle, variants: variantsForView(bundle) }; if (!link.variants.length) return;
      cancelNavigation();
      selectedEdge = id;
      const a = data.nodes.find((n) => n.id === link.source), b = data.nodes.find((n) => n.id === link.target);
      inspector.innerHTML = `<span class="ag-eyebrow">已记录的使用关系${selected && selectedRevision !== null ? ` · ${escape(short(selected))} 第 ${selectedRevision} 版` : ''}</span><h3>${badge(a.id)} ${escape(a.title)}</h3><div class="ag-down-arrow">↓ 用于</div><h3>${badge(b.id)} ${escape(b.title)}</h3><h4>版本与具体用途 · ${link.variants.length}</h4>${link.variants.map((edge) => `<section class="ag-edge-version"><strong>第 ${edge.source_revision} 版 → 第 ${edge.target_revision} 版</strong><p class="ag-full-note">${escape(edge.note || '尚未填写用途说明。')}</p><div class="ag-read-actions">${nodeButton(a, edge.source_revision, '阅读依据')}${nodeButton(b, edge.target_revision, '阅读后续研究')}<button type="button" class="research-button primary" data-ag-continue="${link.variants.indexOf(edge)}"${route.nodes.length && !route.nodes.some((node) => node.id === routeAnchor(edge)) ? ' disabled' : ''}>${route.nodes.length && (route.nodes[routeCursor]?.id === routeAnchor(edge) ? routeCursor : route.nodes.findLastIndex((node) => node.id === routeAnchor(edge))) < route.nodes.length - 1 ? '从此处改选后续' : '加入脉络并继续'}</button></div></section>`).join('')}<div class="ag-read-actions">${selected ? '<button type="button" class="research-button" data-ag-return-node>返回所选资产</button>' : ''}<button type="button" class="research-button" data-ag-inspect-source>查看依据的联系</button><button type="button" class="research-button" data-ag-follow>查看后续研究的联系</button></div>`;
      const returnNode = inspector.querySelector('[data-ag-return-node]'); if (selected && returnNode) returnNode.onclick = () => { cancelNavigation(); select(selected, selectedRevision, false, routeCursor); };
      inspector.querySelectorAll('[data-ag-continue]').forEach((button) => { button.onclick = () => continueRoute(link.variants[Number(button.dataset.agContinue)]); });
      inspector.querySelector('[data-ag-inspect-source]').onclick = () => fetchFocus(link.source, null);
      inspector.querySelector('[data-ag-follow]').onclick = () => fetchFocus(link.target, null); bindReads(); highlight();
    }
    function highlight() {
      if (!data) return;
      const traced = selected ? trace(data, selected, selectedRevision) : null;
      const topicRecord = topic ? data.topics.find((t) => t.id === topic) : null;
      const topicIds = topicRecord ? new Set(topicRecord.asset_ids) : topic ? new Set(data.nodes.filter((node) => (node.tags || []).includes(topic)).map((node) => node.id)) : null;
      const edge = selectedEdge && bundleEdges(data.edges).find((e) => e.id === selectedEdge);
      const edgesById = new Map(bundleEdges(data.edges).map((value) => [value.id, value]));
      const routeNodes = new Set(route.nodes.map((node) => node.id));
      const onlyRoute = routeView !== 'browse';
      const directEdges = data.focus && selected ? directGraph(data, data.focus.id, data.focus.revision).edges.filter((e) => (e.source === selected && (selectedRevision === null || e.source_revision === selectedRevision)) || (e.target === selected && (selectedRevision === null || e.target_revision === selectedRevision))) : null;
      const directKeys = directEdges && new Set(directEdges.map(versionEdgeKey));
      const directIds = directEdges && new Set([selected, data.focus.id, ...directEdges.flatMap((e) => [e.source,e.target])]);
      const visible = (id) => !onlyRoute && id === data.focus?.id || (onlyRoute ? routeNodes.has(id) : edge ? id === edge.source || id === edge.target : directIds ? directIds.has(id) : traced ? traced.nodes.has(id) : topicIds ? topicIds.has(id) : !route.nodes.length || routeNodes.has(id));
      canvas.querySelectorAll('[data-ag-node]').forEach((element) => { const id = element.dataset.agNode; element.classList.toggle('ag-dim', !visible(id)); element.classList.toggle('ag-route-node', routeNodes.has(id)); element.classList.toggle('ag-focus-center', routeView === 'browse' && id === data.focus?.id); element.classList.toggle('ag-selected', id === selected || Boolean(edge && (id === edge.source || id === edge.target))); });
      canvas.querySelectorAll('[data-ag-edge]').forEach((element) => {
        const link = edgesById.get(element.dataset.agEdge);
        const pathVariants = link.variants.filter((edge) => route.steps.some((step) => sameVersionEdge(step.edge, edge)));
        const variants = onlyRoute && pathVariants.length ? pathVariants : directKeys ? link.variants.filter((e) => directKeys.has(versionEdgeKey(e))) : variantsForView(link, traced);
        const inRoute = link.variants.some((e) => route.steps.some((step) => sameVersionEdge(step.edge, e)));
        const active = onlyRoute ? inRoute : edge ? edge.id === link.id : directKeys ? variants.length > 0 : traced ? link.variants.some((e) => traced.edgeKeys.has(versionEdgeKey(e))) : topicIds ? topicIds.has(link.source) || topicIds.has(link.target) : !route.nodes.length || inRoute;
        const label = relationLabel(variants, Boolean(selected && selectedRevision !== null));
        const description = `${link.source} → ${link.target}：${label || (directKeys ? '不在当前直接联系范围' : '与所选版本无关')}`;
        const text = element.querySelector('text'); if (text) text.textContent = label;
        const title = element.querySelector('title'); if (title) title.textContent = description;
        element.setAttribute('aria-label', description);
        element.classList.toggle('ag-route-edge', inRoute);
        element.classList.toggle('ag-dim', !active); element.classList.toggle('ag-edge-active', Boolean((selected || edge || topic) && active));
      });
      updateFocusControls(); drawMinimap();
    }
    function renderOverview() {
      const groups = projectGroups(allData || data), dataset = allData || data;
      const connections = groupConnections(dataset, groups);
      overview.innerHTML = `<div class="ag-overview-intro"><span class="ag-eyebrow">研究全景</span><h3>${escape(dataset.title)}</h3><p>${dataset.nodes.filter((n) => !n.external).length} 项资产 · ${dataset.edges.length} 条已记录联系</p><p>按专题列出全部资产，点击资产查看上下游联系。${dataset.topics.length ? '' : '项目尚未设置专题，可在研究脉络中按标签筛选。'}</p></div><div class="ag-region-grid">${groups.map((group) => {
        const outcomes = group.nodes.filter((node) => node.outcome);
        const showLink = group.id !== '__other' || dataset.topics.length > 0;
        const linkLabel = group.id === '__other' ? '查看这些资产的联系' : '查看专题联系图';
        return `<section class="ag-region"><h3>${escape(group.title)}</h3><p>${group.nodes.length} 项资产${outcomes.length ? ` · ${outcomes.length} 项已选成果` : ''}</p><div>${group.nodes.map((node) => `<button type="button" data-ag-preview="${escape(node.id)}">${badge(node.id)}<span>${node.outcome ? '★ ' : ''}${escape(node.title)}</span></button>`).join('')}</div>${showLink ? `<button type="button" class="research-button primary" data-ag-region="${escape(group.id)}">${linkLabel}</button>` : ''}</section>`;
      }).join('') || '<p class="minor">此范围还没有保存研究资产。</p>'}</div>${connections.length ? `<details class="ag-topic-connections" open><summary>专题之间的使用关系 · ${connections.length}</summary><p>每项计数对应已记录的资产使用关系。</p>${connections.map((link) => `<button type="button" data-ag-group-link="${escape(link.id)}"><span>${escape(groups.find((g) => g.id === link.source).title)} <b>→</b> ${escape(groups.find((g) => g.id === link.target).title)}</span><small>${link.edge_ids.length} 条联系 · 查看</small></button>`).join('')}</details>` : ''}`;
      overview.querySelectorAll('[data-ag-region]').forEach((button) => { button.onclick = () => {
        cancelNavigation(); remember(); const group = groups.find((g) => g.id === button.dataset.agRegion), ids = new Set(group.asset_ids);
        const edges = dataset.edges.filter((e) => ids.has(e.source) || ids.has(e.target));
        const included = new Set([...ids, ...edges.flatMap((e) => [e.source, e.target])]);
        data = { ...dataset, title: group.title, nodes: dataset.nodes.filter((n) => included.has(n.id)), edges, focus: null, _view: { kind: 'region', id: group.id } };
        mode = 'graph'; selected = null; topic = ''; render(); fit();
        if (zoom < .55 && group.nodes.length) select((group.nodes.find((node) => node.outcome) || group.nodes[0]).id, undefined, true);
      }; });
      overview.querySelectorAll('[data-ag-preview]').forEach((button) => { button.onclick = () => { cancelNavigation(); remember(); data = dataset; mode = 'graph'; render(); select(button.dataset.agPreview, undefined, true); }; });
      overview.querySelectorAll('[data-ag-group-link]').forEach((button) => { button.onclick = () => {
        cancelNavigation(); remember(); const link = connections.find((value) => value.id === button.dataset.agGroupLink), edgeIds = new Set(link.edge_ids);
        const edges = dataset.edges.filter((edge) => edgeIds.has(edge.id)), included = new Set(edges.flatMap((edge) => [edge.source, edge.target]));
        data = { ...dataset, title: '专题之间的使用关系', nodes: dataset.nodes.filter((node) => included.has(node.id)), edges, focus: null, _view: { kind: 'connection', id: link.id } };
        mode = 'graph'; selected = null; topic = ''; render(); fit();
      }; });
    }
    function render() {
      renderRoute();
      const isOverview = mode === 'overview'; overview.hidden = !isOverview; canvas.hidden = isOverview; inspector.hidden = isOverview; viewport.classList.toggle('ag-overview-mode', isOverview); $('.ag-main').classList.toggle('ag-is-overview', isOverview);
      $('.ag-inspector-pane').hidden = isOverview;
      const isAll = !isOverview && !data.focus && !data._view && routeView === 'browse';
      $('[data-ag-overview]').classList.toggle('active', isOverview); $('[data-ag-all]').classList.toggle('active', isAll);
      $('[data-ag-overview]').setAttribute('aria-pressed', String(isOverview)); $('[data-ag-all]').setAttribute('aria-pressed', String(isAll));
      $('[data-ag-back]').hidden = !history.length;
      updateFocusControls();
      $('[data-ag-topic]').closest('label').hidden = isOverview || routeView !== 'browse' || Boolean(data.focus); $('.ag-zoom').hidden = isOverview;
      $('[data-ag-caption]').textContent = isOverview ? `${(allData || data).title} · 项目、专题与成果` : `${data.title}${data.focus ? ` · ${short(data.focus.id)} · ${data.focus.revision == null ? '全部版本' : `第 ${data.focus.revision} 版`}的直接联系` : ''} · ${data.nodes.length} 项资产 · ${data.edges.length} 条联系`;
      if (routeView !== 'browse') $('[data-ag-caption]').textContent = `${allData.title} · 已选脉络 · ${route.nodes.length} 个节点 · ${route.steps.length} 段联系`;
      if (isOverview) { renderOverview(); return; }
      const topicSelect = $('[data-ag-topic]');
      const tagCounts = new Map();
      for (const node of data.nodes) for (const tag of node.tags || []) if (!/audit|verified|verification|novelty|status|unresolved/i.test(tag)) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      const tags = [...tagCounts].filter(([, count]) => count > 1).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 24);
      const hasTopics = data.topics.length > 0;
      $('[data-ag-filter-name]').textContent = hasTopics ? '专题' : '研究标签';
      topicSelect.setAttribute('aria-label', hasTopics ? '突出显示专题' : '按研究标签突出显示');
      topicSelect.innerHTML = hasTopics ? '<option value="">全部专题</option>' + data.topics.map((t) => `<option value="${escape(t.id)}">${escape(t.title)}</option>`).join('') : '<option value="">全部资产</option>' + tags.map(([tag, count]) => `<option value="${escape(tag)}">${escape(tag)} · ${count}</option>`).join('');
      if (topic && ![...topicSelect.options].some((option) => option.value === topic)) topic = '';
      topicSelect.value = topic;
      stableDrawing();
      const viewData = graphForView();
      drawing = routeView === 'only' || (routeView === 'browse' && data.focus && focusView === 'compact') ? layout(viewData) : globalDrawing; canvas.style.width = `${drawing.width}px`; canvas.style.height = `${drawing.height}px`;
      const counts = new Map();
      const paths = bundleEdges(viewData.edges).map((edge) => {
        const a = drawing.places.get(edge.source), b = drawing.places.get(edge.target), pair = `${edge.source}/${edge.target}`, index = counts.get(pair) || 0; counts.set(pair, index + 1);
        const start = { x: a.x + a.width, y: a.y + a.height / 2 + index * 7 }, end = { x: b.x, y: b.y + b.height / 2 + index * 7 };
        const forward = end.x > start.x;
        const path = edge.source === edge.target ? `M ${start.x} ${start.y} C ${start.x + 65} ${a.y - 55},${a.x - 65} ${a.y - 55},${a.x} ${end.y}` : forward ? `M ${start.x} ${start.y} C ${start.x + (end.x - start.x) / 2} ${start.y},${end.x - (end.x - start.x) / 2} ${end.y},${end.x} ${end.y}` : `M ${start.x} ${start.y} C ${start.x + 62 + index * 12} ${start.y},${end.x - 62 - index * 12} ${end.y},${end.x} ${end.y}`;
        const label = `${edge.source} → ${edge.target}：${relationLabel(edge.variants)}`;
        return `<g data-ag-edge="${escape(edge.id)}" role="button" tabindex="0" aria-label="${escape(label)}"><title>${escape(label)}</title><path class="ag-edge-hit" d="${path}"/><path class="ag-edge-line" d="${path}" marker-end="url(#ag-arrow)"/>${forward ? `<text x="${(start.x + end.x) / 2}" y="${(start.y + end.y) / 2 - 8}" text-anchor="middle">${relationLabel(edge.variants)}</text>` : ''}</g>`;
      }).join('');
      canvas.innerHTML = `<svg class="ag-lines" width="${drawing.width}" height="${drawing.height}"><defs><marker id="ag-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#7798b6"/></marker></defs>${paths}</svg>` + viewData.nodes.map((node) => {
        const p = drawing.places.get(node.id), cited = node.versions.filter((v) => v !== node.revision);
        return `<button type="button" class="ag-node${node.external ? ' ag-external' : ''}${node.outcome ? ' ag-outcome' : ''}" style="left:${p.x}px;top:${p.y}px;width:${p.width}px;height:${p.height}px" data-ag-node="${escape(node.id)}" title="${escape(node.title)}"><small>${badge(node.id)}${routeView === 'browse' && node.id === data.focus?.id ? '<span class="ag-center-badge">联系中心</span>' : ''}${node.outcome ? ' ★ 已选成果' : node.external ? ' 项目外资产' : ''}${node.archived ? ' · 在回收站' : ''}</small><strong>${escape(node.title)}</strong><span>${cited.length ? `涉及 ${node.versions.length} 个版本 · ` : ''}当前第 ${node.revision} 版</span></button>`;
      }).join('');
      canvas.querySelectorAll('[data-ag-node]').forEach((button) => { button.onclick = () => { cancelNavigation(); const id = button.dataset.agNode, versions = routeView !== 'browse' ? [...new Set(route.nodes.filter((node) => node.id === id).map((node) => node.revision))] : []; select(id, versions.length === 1 ? versions[0] : null); }; });
      canvas.querySelectorAll('[data-ag-edge]').forEach((element) => { element.onclick = () => inspectEdge(element.dataset.agEdge); element.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); inspectEdge(element.dataset.agEdge); } }; });
      inspector.innerHTML = `<span class="ag-eyebrow">${data.focus ? '直接联系' : '研究脉络'}</span><h3>${data.focus ? '点选资产，查看直接联系' : '点选资产，查看完整路径'}</h3><p>${data.focus ? '只显示所选资产的直接联系。' : '突出从源头经过所选资产到末尾的路径；不经过它的旁支会淡化。'}</p><p>箭头保留实际引用版本，点选连线查看具体用途。</p><p>点击资产默认汇集全部版本；在右侧选择具体版本可进一步聚焦。</p><p>已有脉络时，点选相连的下一个节点，右侧会显示“加入脉络”。</p>${!data.nodes.length ? '<p>还没有保存资产。</p>' : !data.edges.length ? '<p>此范围尚未登记资产之间的使用关系。</p>' : ''}`;
      transform(); if (selected) select(selected, selectedRevision); else highlight();
    }
    async function fetchFocus(id, revision) {
      const origin = snapshot();
      const token = ++serial; beginGraphRead(token, '正在读取直接联系…');
      try {
        const response = await options.fetchGraph({ project_id: options.projectId, asset_id: id, ...(revision == null ? {} : { revision }), all_versions: true });
        if (closed || token !== serial) return;
        history.push(origin);
        if (!directReturn) directReturn = { ...origin, selected: origin.selected || id, selectedRevision: origin.selected ? origin.selectedRevision : revision ?? null, directReturn: null };
        allData = mergeGraph(allData, response); visitedFocusIds.add(id);
        data = { ...allData, focus: response.focus }; routeView = 'browse'; routeBrowseState = null; if (!origin.data?.focus) focusView = 'compact'; mode = 'graph'; selected = id; selectedRevision = response.focus.revision; selectedEdge = null; topic = ''; render(); if (focusView === 'compact') fit(); else focusNode(id); setStatus('');
      } catch (error) { if (!closed && token === serial) setStatus(error.message); }
      finally { if (pendingGraphRead?.token === token) pendingGraphRead = null; }
    }
    $('[data-ag-overview]').onclick = () => { if (!allData) return; cancelNavigation(); setStatus(''); remember(); data = allData; directReturn = null; routeView = 'browse'; routeBrowseState = null; mode = 'overview'; selected = null; render(); };
    $('[data-ag-all]').onclick = () => { if (!allData) return; cancelNavigation(); setStatus(''); remember(); data = allData; directReturn = null; mode = 'graph'; routeView = 'browse'; routeBrowseState = null; selected = null; selectedEdge = null; topic = ''; render(); fit(); };
    $('[data-ag-back]').onclick = () => { if (!history.length) return; const state = history.pop(); restore(state); };
    $('[data-ag-topic]').onchange = (event) => { cancelNavigation(); topic = event.target.value; selected = null; selectedEdge = null; highlight(); };
    $('[data-ag-fit]').onclick = fit;
    dialog.querySelectorAll('[data-ag-zoom]').forEach((button) => { button.onclick = () => magnify(button.dataset.agZoom === 'in' ? 1.3 : 1 / 1.3); });
    function search() {
      if (!allData) return;
      const query = $('[data-ag-search] input').value.trim(), panel = $('.ag-search-results');
      const matches = findAssets(allData.nodes, query);
      panel.hidden = !query;
      panel.innerHTML = query ? `<div class="ag-search-heading"><strong>找到 ${matches.length} 项资产</strong><button type="button" class="research-button" data-ag-clear>清除</button></div><div class="ag-search-list">${matches.map((node) => `<button type="button" data-ag-match="${escape(node.id)}">${badge(node.id)}<span>${escape(node.title)}</span></button>`).join('') || '<p>没有匹配的资产，请输入标题或编号的一部分。</p>'}</div>` : '';
      panel.querySelectorAll('[data-ag-match]').forEach((button) => { button.onclick = () => { cancelNavigation(); remember(); data = allData; directReturn = null; routeView = 'browse'; routeBrowseState = null; mode = 'graph'; selected = null; topic = ''; render(); select(button.dataset.agMatch, null, true); }; });
      const clear = panel.querySelector('[data-ag-clear]'); if (clear) clear.onclick = () => { $('[data-ag-search] input').value = ''; search(); };
    }
    $('[data-ag-search]').onsubmit = (event) => { event.preventDefault(); search(); };
    $('[data-ag-search] input').oninput = search;
    $('.ag-minimap').querySelector('svg').onclick = (event) => { const bounds = event.currentTarget.getBoundingClientRect(); if (routeView === 'only') switchRouteView('global'); else if (data.focus && focusView === 'compact') switchFocusView('global'); x = viewport.clientWidth/2 - (event.clientX-bounds.left)/bounds.width*drawing.width*zoom; y = viewport.clientHeight/2 - (event.clientY-bounds.top)/bounds.height*drawing.height*zoom; transform(); };
    let drag = null;
    viewport.onpointerdown = (event) => { if (event.target.closest('.ag-minimap')) return; if (mode === 'overview' || event.button !== 0 || event.target.closest('button,[data-ag-edge]')) return; drag = { x: event.clientX - x, y: event.clientY - y }; viewport.setPointerCapture(event.pointerId); viewport.classList.add('ag-dragging'); event.preventDefault(); };
    viewport.onpointermove = (event) => { if (drag) { x = event.clientX - drag.x; y = event.clientY - drag.y; transform(); } };
    viewport.onpointerup = viewport.onpointercancel = () => { drag = null; viewport.classList.remove('ag-dragging'); };
    viewport.onwheel = (event) => { if (mode === 'overview') return; event.preventDefault(); const r = viewport.getBoundingClientRect(); if (event.ctrlKey || event.metaKey) magnify(event.deltaY < 0 ? 1.12 : 1 / 1.12, event.clientX - r.left, event.clientY - r.top); else { x -= event.deltaX; y -= event.deltaY; transform(); } };
    viewport.onkeydown = (event) => { if (event.target !== viewport || mode === 'overview') return; const moves = { ArrowLeft: [60, 0], ArrowRight: [-60, 0], ArrowUp: [0, 60], ArrowDown: [0, -60] }; if (moves[event.key]) { event.preventDefault(); x += moves[event.key][0]; y += moves[event.key][1]; transform(); } };
    const resize = new ResizeObserver(() => { if (mode !== 'overview') { transform(); } }); resize.observe(viewport);
    setStatus('正在读取研究资产…');
    (async () => {
      const token = ++serial;
      try {
        allData = await options.fetchGraph({ project_id: options.projectId, all_versions: true }); if (closed || token !== serial) return;
        data = allData; render(); fit(); setStatus('');
        if (options.focus) await fetchFocus(options.focus.id, options.focus.revision ?? null);
      } catch (error) { if (!closed && token === serial) setStatus(`读取失败：${error.message}。请关闭后重试。`); }
    })();
    return dialog;
  }
  function changed() {
    if (typeof document === 'undefined') return;
    document.querySelectorAll('.asset-graph-dialog .ag-notice').forEach((notice) => { notice.textContent = '资产有更新，点击“刷新”查看最新联系。'; });
  }
  const api = { trace, layout, projectGroups, groupConnections, mergeEdges, bundleEdges, findAssets, extendRoute, directGraph, routeGraph, routeConnections, open, changed };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AssetGraph = api;
})(typeof window === 'undefined' ? globalThis : window);
