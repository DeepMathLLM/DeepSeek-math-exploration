const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { ResearchLibrary } = require('../src/research-store');

test('default map expansion loads every page and nested shared topics once, and respects manual collapse', async (t) => {
  const lib = new ResearchLibrary(':memory:'); t.after(() => lib.close());
  lib.ensureProject({id:'P',name:'项目'});
  const assets = Array.from({length:135}, (_,i) => lib.save('asset', {title:`资产${i}`}, {project_id:'P'}));
  const topic = lib.save('map', {title:'共享专题', entries:assets.map((a)=>({target_id:a.id,note:''}))});
  const branch = lib.save('map', {title:'分支', entries:[{target_id:topic.id,note:''}]});
  const root = lib.get(lib.resolveMap('project','P'));
  lib.save('map', {...root, entries:[{target_id:topic.id,note:''},{target_id:branch.id,note:''}]}, {expected_revision:root.revision});
  const calls=[];
  const sandbox=vm.createContext({window:{addEventListener(){}}, console});
  let source=fs.readFileSync(path.join(__dirname,'../public/research.js'),'utf8').replace(/\r\n/g,'\n');
  source=source.replace('  return {\n    mount(options)', `  window.testPanel = { expandTreeDefaults, assetRelationshipView, readSearch, setContext(value) { context=value; }, setResult(value) {result=value;}, cache:treeCache, expanded:treeExpanded, collapsed:treeCollapsed };\n  return {\n    mount(options)`);
  vm.runInContext(source,sandbox);
  const panel=sandbox.window.testPanel;
  panel.setContext({escapeHtml:(s)=>String(s),api:async (url, request)=>{
    const {name,arguments:args}=JSON.parse(request.body); calls.push(args);
    if(name==='read_map') return lib.readMap(args,'P');
    if(name==='list_research_records') return lib.list(args);
    throw new Error(name);
  }});
  await panel.expandTreeDefaults(root.id,0,0);
  assert.equal(panel.cache.get(topic.id).entries.length,135);
  assert.ok(panel.expanded.has(branch.id)); assert.ok(panel.expanded.has(topic.id));
  assert.equal(calls.filter((a)=>a.map_id===topic.id && !a.entry_offset).length,1);
  panel.collapsed.add(topic.id); panel.expanded.delete(topic.id);
  await panel.expandTreeDefaults(root.id,0,0);
  assert.equal(panel.expanded.has(topic.id),false);
  const found=await panel.readSearch({query:'35'});
  assert.ok(found.items.some((a)=>a.id==='A000035'));
  const base=assets[0], later=lib.save('asset',{title:'后续研究',references:[{asset_id:base.id,revision:1,relation:'uses',note:'依据'}]},{project_id:'P'});
  lib.save('asset',{id:base.id,title:'修订结论'},{expected_revision:1});
  panel.setResult({record:lib.get(base.id),asset_graph:lib.assetGraph({asset_id:base.id,all_versions:true})});
  const html=panel.assetRelationshipView();
  assert.match(html,/全部版本/); assert.match(html,/后续研究/); assert.match(html,/A1/);
});

class Element {
    constructor(){this.elements=new Map();this.dataset={};this.style={};this.clientWidth=1000;this.clientHeight=650;this.hidden=false;this.value='';this.classes=new Set();this.classList={toggle:(name,active)=>active?this.classes.add(name):this.classes.delete(name),add:(name)=>this.classes.add(name),remove:(name)=>this.classes.delete(name)};}
    set innerHTML(value){this.html=value;this.elements.clear();}
    get innerHTML(){return this.html||'';}
    get options(){return [...this.innerHTML.matchAll(/<option value="([^"]*)"/g)].map((m)=>({value:m[1]}));}
    querySelector(selector){if(!this.elements.has(selector))this.elements.set(selector,new Element());return this.elements.get(selector);}
    querySelectorAll(selector){
      const match=selector.match(/^\[([^\]=]+)\]$/); if(!match)return [];
      const attr=match[1], name=attr.replace(/^data-/,'').replace(/-([a-z])/g,(_,c)=>c.toUpperCase());
      return [...this.innerHTML.matchAll(new RegExp(`<[^>]*\\b${attr}="([^"]*)"[^>]*>`,'g'))].map((m)=>{const el=this.querySelector(`[${attr}="${m[1]}"]`);el.dataset[name]=m[1];for(const field of m[0].matchAll(/data-([a-z-]+)="([^"]*)"/g))el.dataset[field[1].replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=field[2];return el;});
    }
    closest(){return this.querySelector('parent');} setAttribute(){} append(){} showModal(){this.open=true;} addEventListener(){} close(){this.open=false;} remove(){}
}

async function graphScenario(t, options={}) {
  const graph=require('../public/asset-graph'), dialogs=[], requests=[];
  const id=(n)=>`A${String(n).padStart(6,'0')}`;
  let data={title:'项目',topics:[],focus:null,nodes:Array.from({length:5},(_,i)=>({id:id(i+1),title:`研究 ${i+1}`,revision:1,versions:[1]})),edges:[[1,2],[2,3],[3,4],[1,5]].map(([a,b],i)=>({id:`e${i}`,source:id(a),source_revision:1,target:id(b),target_revision:1,note:`研究 ${a} 用于研究 ${b}`}))};
  global.document={createElement:()=>new Element(),body:{append(dialog){dialogs.push(dialog);}}};
  global.ResizeObserver=class{observe(){}disconnect(){}};
  t.after(()=>{dialogs.forEach((dialog)=>dialog.closePanel());delete global.document;delete global.ResizeObserver;});
  const dialog=graph.open({...options,fetchGraph:async(args)=>{
    requests.push(args);
    if(options.fetchGraph){const response=await options.fetchGraph(args,data);if(response)return response;}
    return args.asset_id?{...data,focus:{id:args.asset_id,revision:args.revision??null}}:data;
  }});
  await new Promise(setImmediate);
  const canvas=dialog.querySelector('.ag-canvas'), inspector=dialog.querySelector('.ag-inspector');
  const select=(n)=>canvas.querySelectorAll('[data-ag-node]').find((node)=>node.dataset.agNode===id(n)).onclick();
  const routeView=(view)=>{
    const bar=dialog.querySelector('.ag-route-bar');
    if(view==='browse')view=bar.innerHTML.match(/class="research-button active" data-ag-route-view="([^"]+)"/)[1];
    return bar.querySelectorAll('[data-ag-route-view]').find((button)=>button.dataset.agRouteView===view).onclick();
  };
  const view=()=>({nodes:canvas.querySelectorAll('[data-ag-node]').map((node)=>node.dataset.agNode),camera:canvas.style.transform,caption:dialog.querySelector('[data-ag-caption]').textContent});
  const start=()=>inspector.querySelector('[data-ag-start-route]').onclick();
  const join=(n)=>{select(n);return inspector.querySelector('[data-ag-join-node]').onclick();};
  return {id,dialog,dialogs,canvas,inspector,requests,select,start,join,routeView,view,get data(){return data;},set data(next){data=next;}};
}

test('graph UI defaults to all nodes, lists every overview asset, and searches without jumping to the first match', async (t) => {
  const graph=require('../public/asset-graph');
  global.document={createElement:()=>new Element(),body:{append(){}}};
  global.ResizeObserver=class{observe(){}disconnect(){}};
  t.after(()=>{delete global.document;delete global.ResizeObserver;});
  const data={title:'项目',topics:[],focus:null,edges:[{id:'e1',source:'A000001',source_revision:1,target:'A000002',target_revision:1,source_title:'依据',target_title:'成果',note:'旧版依据'}],nodes:Array.from({length:12},(_,i)=>({id:`A${String(i+1).padStart(6,'0')}`,title:`研究 ${i+1}`,revision:2,versions:[1,2]}))};
  data.edges.push({ ...data.edges[0], id:'e2', source_revision:2, target_revision:2, note:'新版依据' }, { ...data.edges[0], id:'e3', source_revision:2, note:'新版的另一处使用' });
  data.edges.push({id:'e4',source:'A000002',source_revision:1,target:'A000003',target_revision:1,source_title:'成果',target_title:'下一项成果',note:'继续推导'});
  const requests=[];
  let resumeFromMap, located;
  const reads=[];
  const dialog=graph.open({fetchGraph:async(args)=>{requests.push(args);return args.asset_id ? {...data,focus:{id:args.asset_id,revision:args.revision??null,title:'所选资产'}} : data;},onOpen(){},onLocate:(next,resume)=>{located=next;resumeFromMap=resume;},readRecord:async(next,offset)=>{reads.push({...next,offset});return {record:{id:next.id,revision:next.revision,title:'资产正文',body_md:offset ? '后续正文' : '第一部分',references:[]},reading:{next_offset:offset>=8?null:(offset||0)+4}};}});
  await new Promise(setImmediate);
  assert.equal(requests[0].all_versions,true);
  assert.equal(dialog.querySelector('.ag-canvas').querySelectorAll('[data-ag-node]').length,12);
  const first=dialog.querySelector('.ag-canvas').querySelectorAll('[data-ag-node]')[0];first.onclick();
  assert.match(dialog.querySelector('.ag-inspector').innerHTML,/value="all" selected/);
  assert.match(dialog.querySelector('.ag-inspector').innerHTML,/使用它的研究 · 1/);
  const arrow=dialog.querySelector('.ag-canvas').querySelectorAll('[data-ag-edge]')[0];
  assert.equal(arrow.querySelector('text').textContent,'3 组版本联系');
  dialog.querySelector('.ag-inspector').querySelector('select').onchange({target:{value:'1'}});
  assert.equal(arrow.querySelector('text').textContent,'第 1 版 → 第 1 版');
  arrow.onclick();
  assert.match(dialog.querySelector('.ag-inspector').innerHTML,/旧版依据/);
  assert.doesNotMatch(dialog.querySelector('.ag-inspector').innerHTML,/新版依据/);
  assert.equal(arrow.querySelector('text').textContent,'第 1 版 → 第 1 版');
  dialog.querySelector('.ag-inspector').querySelector('[data-ag-return-node]').onclick();
  dialog.querySelector('.ag-inspector').querySelector('select').onchange({target:{value:'2'}});
  assert.equal(arrow.querySelector('text').textContent,'第 2 版 → 第 1、2 版');
  arrow.onclick();
  assert.doesNotMatch(dialog.querySelector('.ag-inspector').innerHTML,/旧版依据/);
  assert.match(dialog.querySelector('.ag-inspector').innerHTML,/新版依据/);
  dialog.querySelector('.ag-inspector').querySelector('[data-ag-return-node]').onclick();
  dialog.querySelector('.ag-inspector').querySelector('select').onchange({target:{value:'all'}});
  assert.equal(arrow.querySelector('text').textContent,'3 组版本联系');
  dialog.querySelector('[data-ag-overview]').onclick();
  assert.equal(dialog.querySelector('.ag-overview').querySelectorAll('[data-ag-preview]').length,12);
  dialog.querySelector('[data-ag-search] input').value='1';dialog.querySelector('[data-ag-search] input').oninput();
  assert.equal(dialog.querySelector('.ag-search-results').querySelectorAll('[data-ag-match]').length,4);
  assert.match(dialog.querySelector('.ag-search-results').innerHTML,/A12/);
  dialog.querySelector('[data-ag-all]').onclick();
  dialog.querySelector('.ag-canvas').querySelectorAll('[data-ag-node]')[0].onclick();
  const beforePosition=dialog.querySelector('.ag-canvas').innerHTML.match(/left:([\d.]+)px;top:([\d.]+)px/)[0];
  await dialog.querySelector('[data-ag-local]').onclick();
  assert.equal(dialog.querySelector('[data-ag-focus-label]').textContent,'A1 的直接联系');
  assert.equal(dialog.querySelector('.ag-canvas').querySelectorAll('[data-ag-node]').length,2);
  const focusButtons=()=>dialog.querySelectorAll('[data-ag-focus-view]');
  focusButtons().find((button)=>button.dataset.agFocusView==='global').onclick();
  assert.equal(dialog.querySelector('.ag-canvas').querySelectorAll('[data-ag-node]').length,12);
  assert.equal(dialog.querySelector('.ag-canvas').innerHTML.match(/left:([\d.]+)px;top:([\d.]+)px/)[0],beforePosition);
  const globalCamera=dialog.querySelector('.ag-canvas').style.transform;
  focusButtons().find((button)=>button.dataset.agFocusView==='compact').onclick();
  assert.equal(dialog.querySelector('.ag-canvas').querySelectorAll('[data-ag-node]').length,2);
  focusButtons().find((button)=>button.dataset.agFocusView==='global').onclick();
  assert.equal(dialog.querySelector('.ag-canvas').style.transform,globalCamera);
  focusButtons().find((button)=>button.dataset.agFocusView==='compact').onclick();
  await dialog.querySelector('.ag-inspector').querySelectorAll('[data-ag-view-node]')[0].onclick();
  assert.equal(requests.at(-1).asset_id,'A000002');
  assert.equal(dialog.querySelector('.ag-canvas').querySelectorAll('[data-ag-node]').length,3);
  await dialog.querySelector('.ag-canvas').querySelectorAll('[data-ag-node]').find((button)=>button.dataset.agNode==='A000003').onclick();
  assert.equal(requests.at(-1).asset_id,'A000002');
  assert.equal(dialog.querySelector('.ag-canvas').querySelectorAll('[data-ag-node]').length,3);
  await dialog.querySelector('[data-ag-local]').onclick();
  assert.equal(requests.at(-1).asset_id,'A000003');
  assert.deepEqual(dialog.querySelector('.ag-canvas').querySelectorAll('[data-ag-node]').map((button)=>button.dataset.agNode),['A000002','A000003']);
  assert.match(dialog.querySelector('.ag-minimap').querySelector('svg').innerHTML,/ag-minimap-window/);
  dialog.querySelector('[data-ag-exit-direct]').onclick();
  dialog.querySelector('.ag-canvas').querySelectorAll('[data-ag-node]').find((button)=>button.dataset.agNode==='A000001').onclick();
  assert.match(dialog.querySelector('.ag-inspector').innerHTML,/A1/);
  dialog.querySelector('.ag-inspector').querySelector('[data-ag-start-route]').onclick();
  dialog.querySelector('.ag-canvas').querySelectorAll('[data-ag-node]').find((button)=>button.dataset.agNode==='A000002').onclick();
  assert.match(dialog.querySelector('.ag-inspector').innerHTML,/接到当前脉络/);
  assert.match(dialog.querySelector('.ag-inspector').innerHTML,/请选择版本/);
  assert.match(dialog.querySelector('.ag-inspector').innerHTML,/data-ag-join-node disabled/);
  dialog.querySelector('.ag-inspector').querySelector('[data-ag-join-node]').onclick();
  assert.doesNotMatch(dialog.querySelector('.ag-route-bar').innerHTML,/data-ag-route-node="1"/);
  const chooseVersion=dialog.querySelector('.ag-inspector').querySelector('[data-ag-join-version]');
  chooseVersion.value='0';chooseVersion.onchange();
  const viewState=()=>({
    requests:requests.length,
    nodes:dialog.querySelector('.ag-canvas').querySelectorAll('[data-ag-node]').map((node)=>node.dataset.agNode),
    camera:dialog.querySelector('.ag-canvas').style.transform,
    directHidden:dialog.querySelector('[data-ag-focus-views]').hidden,
    caption:dialog.querySelector('[data-ag-caption]').textContent,
  });
  const beforeGlobalJoin=viewState();
  await dialog.querySelector('.ag-inspector').querySelector('[data-ag-join-node]').onclick();
  assert.match(dialog.querySelector('.ag-route-bar').innerHTML,/data-ag-route-node="1"/);
  assert.deepEqual(viewState(),beforeGlobalJoin,'joining from the full graph must preserve its scope and camera without fetching direct links');
  assert.match(dialog.querySelector('.ag-inspector').innerHTML,/value="all" selected/);
  await dialog.querySelector('.ag-inspector').querySelectorAll('[data-ag-view-node]').find((button)=>button.dataset.agViewNode==='A000003').onclick();
  assert.doesNotMatch(dialog.querySelector('.ag-route-bar').innerHTML,/data-ag-route-node="2"/);
  const beforeDirectJoin=viewState();
  await dialog.querySelector('.ag-inspector').querySelector('[data-ag-join-node]').onclick();
  assert.match(dialog.querySelector('.ag-route-bar').innerHTML,/data-ag-route-node="2"/);
  assert.deepEqual(viewState(),beforeDirectJoin,'joining while viewing direct links must preserve the existing focus and camera');
  assert.match(dialog.querySelector('.ag-inspector').innerHTML,/value="all" selected/);
  const routeView=(view)=>dialog.querySelector('.ag-route-bar').querySelectorAll('[data-ag-route-view]').find((button)=>button.dataset.agRouteView===view).onclick();
  routeView('only');
  assert.equal(dialog.querySelector('.ag-canvas').querySelectorAll('[data-ag-node]').length,3);
  assert.equal(dialog.querySelector('.ag-canvas').querySelectorAll('[data-ag-edge]').length,2);
  routeView('global');
  assert.equal(dialog.querySelector('.ag-canvas').querySelectorAll('[data-ag-node]').length,12);
  const dimmed=dialog.querySelector('.ag-canvas').querySelectorAll('[data-ag-node]').find((node)=>node.dataset.agNode==='A000004');
  assert.equal(dimmed.classes.has('ag-dim'),true);
  const pinned=dialog.querySelector('.ag-canvas').querySelectorAll('[data-ag-node]').find((node)=>node.dataset.agNode==='A000001');
  assert.equal(pinned.classes.has('ag-dim'),false);
  routeView('global');
  assert.equal(dialog.querySelector('.ag-canvas').querySelectorAll('[data-ag-node]').length,2);
  await dialog.querySelector('.ag-inspector').querySelector('select').onchange({target:{value:'1'}});
  const routeBeforeRead=dialog.querySelector('.ag-route-bar').innerHTML;
  const inspectorBeforeRead=dialog.querySelector('.ag-inspector').innerHTML;
  const transformBeforeRead=dialog.querySelector('.ag-canvas').style.transform;
  dialog.querySelector('.ag-inspector').querySelectorAll('[data-ag-read]')[0].onclick();
  await new Promise(setImmediate);
  assert.match(dialog.querySelector('.ag-reader').innerHTML,/第一部分/);
  await dialog.querySelector('.ag-reader').querySelector('[data-ag-reader-more]').onclick();
  assert.equal(dialog.querySelector('.ag-reader').querySelector('.markdown-body').innerHTML,'<pre>第一部分后续正文</pre>');
  await dialog.querySelector('.ag-reader').querySelector('[data-ag-reader-more]').onclick();
  assert.equal(reads.at(-1).offset,8); assert.equal(reads.at(-1).revision,1);
  dialog.querySelector('.ag-reader').querySelector('[data-ag-reader-close]').onclick();
  assert.equal(dialog.querySelector('.ag-reader').hidden,true);
  assert.equal(dialog.querySelector('.ag-route-bar').innerHTML,routeBeforeRead);
  assert.equal(dialog.querySelector('.ag-inspector').innerHTML,inspectorBeforeRead);
  assert.equal(dialog.querySelector('.ag-canvas').style.transform,transformBeforeRead);
  await dialog.querySelector('.ag-inspector').querySelector('[data-ag-map-location]').onclick();
  assert.equal(located.id,'A000003'); assert.equal(dialog.open,false);
  resumeFromMap(); assert.equal(dialog.open,true);
  assert.equal(dialog.querySelector('.ag-route-bar').innerHTML,routeBeforeRead);
  dialog.querySelector('[data-ag-exit-direct]').onclick();
  assert.equal(dialog.querySelector('[data-ag-focus-views]').hidden,true);
  assert.equal(dialog.querySelector('.ag-canvas').querySelectorAll('[data-ag-node]').length,12);
  assert.match(dialog.querySelector('.ag-route-bar').innerHTML,/data-ag-route-node="2"/);
  dialog.querySelector('[data-ag-back]').onclick();
  assert.equal(dialog.querySelector('[data-ag-focus-views]').hidden,false);
  assert.equal(dialog.querySelector('.ag-canvas').querySelectorAll('[data-ag-node]').length,2);
  dialog.querySelector('.ag-route-bar').querySelector('[data-ag-route-undo]').onclick();
  assert.match(dialog.querySelector('.ag-route-bar').innerHTML,/data-ag-route-node="1"/);
  assert.doesNotMatch(dialog.querySelector('.ag-route-bar').innerHTML,/data-ag-route-node="2"/);
  dialog.querySelector('.ag-route-bar').querySelector('[data-ag-route-clear]').onclick();
  dialog.querySelector('.ag-canvas').querySelectorAll('[data-ag-node]')[0].onclick();
  dialog.querySelector('.ag-inspector').querySelector('[data-ag-start-route]').onclick();
  dialog.querySelector('.ag-canvas').querySelectorAll('[data-ag-edge]')[0].onclick();
  const beforeEdgeJoin=viewState();
  await dialog.querySelector('.ag-inspector').querySelectorAll('[data-ag-continue]')[0].onclick();
  assert.match(dialog.querySelector('.ag-route-bar').innerHTML,/data-ag-route-node="1"/);
  assert.deepEqual(viewState(),beforeEdgeJoin,'adding an inspected connection must also preserve the full graph');
  assert.match(dialog.querySelector('.ag-inspector').innerHTML,/版本与具体用途/);
  dialog.closePanel();
});

test('node selection highlights complete paths through it, filters bundled versions and dims unrelated saved routes', async (t) => {
  const graph=require('../public/asset-graph');
  global.document={createElement:()=>new Element(),body:{append(){}}};
  global.ResizeObserver=class{observe(){}disconnect(){}};
  t.after(()=>{delete global.document;delete global.ResizeObserver;});
  const id=(n)=>`A${String(n).padStart(6,'0')}`;
  const edge=(a,b,source_revision=1,target_revision=1,note='用途')=>({source:id(a),target:id(b),source_revision,target_revision,note});
  const data={title:'完整路径',topics:[],focus:null,nodes:Array.from({length:8},(_,i)=>({id:id(i+1),title:`研究 ${i+1}`,revision:3,versions:[1,2,3]})),edges:[
    edge(1,2),edge(2,3),edge(3,4),edge(4,5,1,1,'第一版路径'),
    edge(1,6),edge(6,5),edge(2,4),edge(7,4),
    edge(3,4,2,2),edge(4,5,2,2,'第二版路径'),edge(4,5,3,3,'未经过所选资产的第三版'),
  ].map((e,i)=>({...e,id:`e${i}`}))};
  const dialog=graph.open({fetchGraph:async(args)=>args.asset_id?{...data,focus:{id:args.asset_id,revision:args.revision??null}}:data});
  t.after(()=>dialog.closePanel()); await new Promise(setImmediate);
  const canvas=dialog.querySelector('.ag-canvas'), inspector=dialog.querySelector('.ag-inspector');
  const selectNode=(n)=>canvas.querySelectorAll('[data-ag-node]').find((node)=>node.dataset.agNode===id(n)).onclick();
  const link=(a,b)=>canvas.querySelectorAll('[data-ag-edge]').find((item)=>item.dataset.agEdge===`${id(a)}/${id(b)}`);
  selectNode(6); inspector.querySelector('[data-ag-start-route]').onclick(); selectNode(5);
  inspector.querySelector('[data-ag-join-node]').onclick();
  selectNode(3);
  assert.deepEqual(canvas.querySelectorAll('[data-ag-node]').filter((node)=>!node.classes.has('ag-dim')).map((node)=>node.dataset.agNode),[1,2,3,4,5].map(id));
  assert.deepEqual(canvas.querySelectorAll('[data-ag-edge]').filter((item)=>!item.classes.has('ag-dim')).map((item)=>item.dataset.agEdge),[[1,2],[2,3],[3,4],[4,5]].map(([a,b])=>`${id(a)}/${id(b)}`));
  assert.equal(link(6,5).classes.has('ag-route-edge'),true);
  assert.equal(link(6,5).classes.has('ag-dim'),true,'the saved route must not override the selected asset paths');
  assert.equal(link(4,5).querySelector('text').textContent,'2 组版本联系');
  link(4,5).onclick();
  assert.match(inspector.innerHTML,/第一版路径/); assert.match(inspector.innerHTML,/第二版路径/);
  assert.doesNotMatch(inspector.innerHTML,/未经过所选资产的第三版/);
  inspector.querySelector('[data-ag-return-node]').onclick();
  inspector.querySelector('select').onchange({target:{value:'1'}});
  assert.equal(link(4,5).querySelector('text').textContent,'第 1 版 → 第 1 版');
  link(4,5).onclick(); assert.doesNotMatch(inspector.innerHTML,/第二版路径/);
  inspector.querySelector('[data-ag-return-node]').onclick();
  inspector.querySelector('select').onchange({target:{value:'2'}});
  assert.equal(link(4,5).querySelector('text').textContent,'第 2 版 → 第 2 版');
  assert.equal(link(1,2).classes.has('ag-dim'),true);
  assert.equal(link(2,4).classes.has('ag-dim'),true);
  const routeView=(view)=>dialog.querySelector('.ag-route-bar').querySelectorAll('[data-ag-route-view]').find((button)=>button.dataset.agRouteView===view).onclick();
  routeView('global');
  assert.equal(link(6,5).classes.has('ag-dim'),false);
  assert.equal(link(3,4).classes.has('ag-dim'),true);
  routeView('global'); assert.equal(link(6,5).classes.has('ag-dim'),true);
  await dialog.querySelector('[data-ag-local]').onclick();
  assert.equal(canvas.querySelectorAll('[data-ag-node]').length,2,'explicit direct views remain limited to one hop');
});

test('building a route from an asset entry keeps the view through node selection, joining and starting another route', async (t) => {
  const graph=require('../public/asset-graph');
  global.document={createElement:()=>new Element(),body:{append(){}}};
  global.ResizeObserver=class{observe(){}disconnect(){}};
  t.after(()=>{delete global.document;delete global.ResizeObserver;});
  const id=(n)=>`A${String(n).padStart(6,'0')}`;
  const data={title:'项目',topics:[],focus:null,nodes:Array.from({length:6},(_,i)=>({id:id(i+1),title:`研究 ${i+1}`,revision:1,versions:[1]})),edges:[[1,2],[2,3],[3,4],[1,5]].map(([a,b],i)=>({id:`e${i}`,source:id(a),source_revision:1,target:id(b),target_revision:1,note:'依据'}))};
  const requests=[];
  const dialog=graph.open({focus:{id:id(1)},fetchGraph:async(args)=>{requests.push(args);return args.asset_id?{...data,focus:{id:args.asset_id,revision:args.revision??null}}:data;}});
  t.after(()=>dialog.closePanel()); await new Promise(setImmediate);
  const canvas=dialog.querySelector('.ag-canvas'), inspector=dialog.querySelector('.ag-inspector');
  const selectNode=(n)=>canvas.querySelectorAll('[data-ag-node]').find((node)=>node.dataset.agNode===id(n)).onclick();
  const viewState=()=>({requests:requests.length,nodes:canvas.querySelectorAll('[data-ag-node]').map((node)=>node.dataset.agNode),camera:canvas.style.transform,caption:dialog.querySelector('[data-ag-caption]').textContent});
  inspector.querySelector('[data-ag-start-route]').onclick();
  const beforeSecond=viewState();
  await selectNode(2);
  assert.deepEqual(viewState(),beforeSecond,'selecting the second node must not change the direct-contact center or camera');
  await inspector.querySelector('[data-ag-join-node]').onclick();
  assert.deepEqual(viewState(),beforeSecond,'joining must not silently move the center during the following render');
  assert.match(dialog.querySelector('.ag-route-bar').innerHTML,/data-ag-route-node="1"/);
  dialog.querySelector('.ag-route-bar').querySelectorAll('[data-ag-route-node]').find((button)=>button.dataset.agRouteNode==='1').onclick();
  assert.equal(requests.length,beforeSecond.requests,'route breadcrumbs select assets without opening another direct view');
  assert.deepEqual(viewState().nodes,beforeSecond.nodes);
  assert.equal(viewState().caption,beforeSecond.caption);
  dialog.querySelectorAll('[data-ag-focus-view]').find((button)=>button.dataset.agFocusView==='global').onclick();
  const beforeThird=viewState();
  await selectNode(3); await inspector.querySelector('[data-ag-join-node]').onclick();
  assert.deepEqual(viewState(),beforeThird,'the full-map direct view must remain unchanged while a route grows');
  assert.equal(canvas.querySelectorAll('[data-ag-edge]').filter((edge)=>!edge.classes.has('ag-dim')).length,0,'selecting an asset outside the fixed direct scope must not highlight another direct neighborhood');
  assert.match(dialog.querySelector('.ag-route-bar').innerHTML,/data-ag-route-node="2"/);
  await dialog.querySelector('[data-ag-local]').onclick();
  assert.equal(requests.length,beforeThird.requests+1,'the explicit direct-contact button can change the view');
  assert.equal(requests.at(-1).asset_id,id(3));
  assert.match(viewState().caption,/A3/);
  const routeView=(view)=>dialog.querySelector('.ag-route-bar').querySelectorAll('[data-ag-route-view]').find((button)=>button.dataset.agRouteView===view);
  routeView('global').onclick();
  await selectNode(6);
  const beforeRestart=viewState();
  inspector.querySelector('[data-ag-start-route]').onclick();
  assert.deepEqual(viewState(),{...beforeRestart,caption:'项目 · 已选脉络 · 1 个节点 · 0 段联系'});
  assert.match(dialog.querySelector('.ag-route-bar').innerHTML,/active" data-ag-route-view="global"/,'starting a new route must preserve the chosen route view');
});

test('route-only views can inspect and add a next connection from the sidebar, then undo and return to the original view', async (t) => {
  const ui=await graphScenario(t);
  ui.select(1);ui.start();ui.join(2);
  const browse=ui.view();ui.routeView('only');ui.select(2);
  const camera=ui.view().camera;
  ui.inspector.querySelectorAll('[data-ag-edge]').find((button)=>button.dataset.agEdge===`${ui.id(2)}/${ui.id(3)}`).onclick();
  assert.match(ui.inspector.innerHTML,/版本与具体用途/,'sidebar connections must remain inspectable when the next asset is outside the route');
  ui.inspector.querySelectorAll('[data-ag-continue]')[0].onclick();
  assert.deepEqual(ui.view().nodes,[1,2,3].map(ui.id));
  assert.equal(ui.view().camera,camera);
  ui.dialog.querySelector('.ag-route-bar').querySelector('[data-ag-route-undo]').onclick();
  assert.deepEqual(ui.view().nodes,[1,2].map(ui.id));
  ui.dialog.querySelector('.ag-route-bar').querySelector('[data-ag-route-clear]').onclick();
  assert.deepEqual(ui.view(),browse,'clearing from a route view should restore its browsing context');
});

test('undoing the first route step and clearing a route keep a direct view and its camera', async (t) => {
  const ui=await graphScenario(t,{focus:{id:'A000001'}});
  const initial=ui.view();ui.start();
  ui.dialog.querySelector('.ag-route-bar').querySelector('[data-ag-route-undo]').onclick();
  assert.deepEqual(ui.view(),initial);
  ui.start();ui.join(2);
  ui.dialog.querySelector('.ag-route-bar').querySelector('[data-ag-route-clear]').onclick();
  assert.deepEqual(ui.view(),initial);
  assert.equal(ui.requests.length,2);
});

test('returning through view history restores the original browsing context of a route', async (t) => {
  const ui=await graphScenario(t,{focus:{id:'A000001'}});
  ui.start();ui.join(2);
  const browse=ui.view();ui.routeView('only');ui.select(2);
  await ui.dialog.querySelector('[data-ag-local]').onclick();
  assert.match(ui.view().caption,/A2/);
  ui.dialog.querySelector('[data-ag-back]').onclick();
  assert.deepEqual(ui.view().nodes,[1,2].map(ui.id));
  ui.routeView('browse');
  assert.deepEqual(ui.view(),browse,'returning from the route should restore the A1 direct view');
  ui.dialog.querySelector('[data-ag-back]').onclick();
  assert.deepEqual(ui.view().nodes,[1,2].map(ui.id),'back should return to the route view just left');
});

test('refresh updates the same graph dialog while preserving a pinned route, its view and reading layer', async (t) => {
  let closed=0;
  const ui=await graphScenario(t,{onClosed(){closed++;},readRecord:async(next)=>({record:{id:next.id,revision:next.revision,title:'精确版本',body_md:'正文',references:[]}})});
  ui.select(1);ui.start();ui.join(2);
  const browseCamera=ui.view().camera;
  ui.routeView('only');ui.select(2);
  const camera=ui.view().camera, route=ui.dialog.querySelector('.ag-route-bar').innerHTML;
  await ui.inspector.querySelectorAll('[data-ag-read]')[0].onclick();await new Promise(setImmediate);
  ui.data={...ui.data,nodes:[...ui.data.nodes.map((node)=>node.id===ui.id(2)?{...node,revision:2,versions:[1,2]}:node),{id:ui.id(6),title:'新增资产',revision:1,versions:[1]}],edges:[...ui.data.edges,{id:'new',source:ui.id(1),source_revision:1,target:ui.id(2),target_revision:2,note:'新版引用'}]};
  await ui.dialog.querySelector('[data-ag-refresh]').onclick();await new Promise(setImmediate);
  assert.equal(ui.dialog.open,true);assert.equal(ui.dialogs.length,1);assert.equal(closed,0);
  assert.deepEqual(ui.view().nodes,[1,2].map(ui.id));assert.equal(ui.view().camera,camera);
  assert.equal(ui.dialog.querySelector('.ag-route-bar').innerHTML,route);
  assert.match(ui.canvas.innerHTML,/当前第 2 版/);
  assert.equal(ui.dialog.querySelector('.ag-reader').hidden,false);
  assert.match(ui.dialog.querySelector('.ag-reader').innerHTML,/精确版本/);
  ui.dialog.querySelector('.ag-reader').querySelector('[data-ag-reader-close]').onclick();
  ui.routeView('browse');assert.equal(ui.view().nodes.length,6);assert.equal(ui.view().camera,browseCamera);
});

test('late direct-contact responses cannot replace a route view chosen while the request was running', async (t) => {
  let finish;
  const ui=await graphScenario(t,{fetchGraph:(args,data)=>args.asset_id==='A000002'?new Promise((resolve)=>{finish=()=>resolve({...data,focus:{id:args.asset_id,revision:null}});}):null});
  ui.select(1);ui.start();ui.join(2);
  const pending=ui.dialog.querySelector('[data-ag-local]').onclick();
  ui.routeView('only');const routeView=ui.view();finish();await pending;
  assert.deepEqual(ui.view(),routeView);
  assert.equal(ui.dialog.querySelector('.ag-notice').textContent,'');
});

test('continuing after adding an inspected edge uses the end of the route unless an earlier node is explicitly selected', async (t) => {
  const ui=await graphScenario(t);
  ui.data={...ui.data,edges:[...ui.data.edges,{id:'shortcut',source:ui.id(1),source_revision:1,target:ui.id(3),target_revision:1,note:'另一条路线'}]};
  await ui.dialog.querySelector('[data-ag-refresh]').onclick();
  ui.select(1);ui.start();
  ui.canvas.querySelectorAll('[data-ag-edge]').find((edge)=>edge.dataset.agEdge===`${ui.id(1)}/${ui.id(2)}`).onclick();
  ui.inspector.querySelectorAll('[data-ag-continue]')[0].onclick();
  ui.select(3);
  assert.doesNotMatch(ui.inspector.innerHTML,/将改选这个位置之后的路线/);
  ui.inspector.querySelector('[data-ag-join-node]').onclick();
  assert.match(ui.dialog.querySelector('.ag-route-bar').innerHTML,/data-ag-route-node="2"/);
  ui.select(1);ui.select(5);
  assert.match(ui.inspector.innerHTML,/将改选这个位置之后的路线/);
  ui.inspector.querySelector('[data-ag-join-node]').onclick();
  assert.doesNotMatch(ui.dialog.querySelector('.ag-route-bar').innerHTML,/data-ag-route-node="2"/);
  ui.dialog.querySelector('.ag-route-bar').querySelector('[data-ag-route-undo]').onclick();
  assert.match(ui.dialog.querySelector('.ag-route-bar').innerHTML,/data-ag-route-node="2"/);
});

test('refresh preserves a topic scope, follows membership updates and returns to that scope from direct contacts', async (t) => {
  const ui=await graphScenario(t);
  ui.data={...ui.data,topics:[{id:'M1',title:'专题甲',asset_ids:[ui.id(1)]},{id:'M2',title:'专题乙',asset_ids:[ui.id(3),ui.id(4)]}]};
  await ui.dialog.querySelector('[data-ag-refresh]').onclick();
  ui.dialog.querySelector('[data-ag-overview]').onclick();
  ui.dialog.querySelector('.ag-overview').querySelectorAll('[data-ag-region]').find((button)=>button.dataset.agRegion==='M1').onclick();
  assert.deepEqual(ui.view().nodes,[1,2,5].map(ui.id));
  const camera=ui.view().camera;
  ui.data={...ui.data,topics:ui.data.topics.map((topic)=>topic.id==='M1'?{...topic,title:'专题甲更新',asset_ids:[ui.id(1),ui.id(4)]}:topic)};
  await ui.dialog.querySelector('[data-ag-refresh]').onclick();
  assert.equal(ui.view().nodes.length,5);assert.equal(ui.view().camera,camera);assert.match(ui.view().caption,/专题甲更新/);
  ui.select(1);await ui.dialog.querySelector('[data-ag-local]').onclick();
  ui.dialog.querySelector('[data-ag-exit-direct]').onclick();
  assert.match(ui.view().caption,/专题甲更新/);assert.equal(ui.view().nodes.length,5);
});

test('a failed refresh preserves the current route and a canceled direct read clears its loading message', async (t) => {
  let failRefresh=false, finish;
  const ui=await graphScenario(t,{fetchGraph:(args,data)=>{
    if(!args.asset_id && failRefresh)throw new Error('读取失败');
    if(args.asset_id==='A000002')return new Promise((resolve)=>{finish=()=>resolve({...data,focus:{id:args.asset_id,revision:null}});});
    return null;
  }});
  ui.select(1);ui.start();ui.join(2);const before=ui.view(), route=ui.dialog.querySelector('.ag-route-bar').innerHTML;
  failRefresh=true;await ui.dialog.querySelector('[data-ag-refresh]').onclick();
  assert.deepEqual(ui.view(),before);assert.equal(ui.dialog.querySelector('.ag-route-bar').innerHTML,route);
  assert.match(ui.dialog.querySelector('.ag-notice').textContent,/刷新失败/);
  assert.equal(ui.dialog.querySelector('[data-ag-refresh]').disabled,false);
  const pending=ui.dialog.querySelector('[data-ag-local]').onclick();
  ui.select(1);finish();await pending;
  assert.equal(ui.dialog.querySelector('.ag-notice').textContent,'');
  assert.deepEqual(ui.view(),before);
});

test('refresh retains exact route links to outside assets even when the main project response omits them', async (t) => {
  let outsideGraph;
  const ui=await graphScenario(t,{fetchGraph:(args)=>args.asset_id && outsideGraph?{...outsideGraph,focus:{id:args.asset_id,revision:null}}:null});
  const outside={id:ui.id(6),title:'外部依据',revision:1,versions:[1],external:true};
  const use={id:'external',source:outside.id,source_revision:1,target:ui.id(2),target_revision:1,note:'精确的外部依据'};
  const main=ui.data;
  ui.data={...main,nodes:[...main.nodes,outside],edges:[...main.edges,use]};
  await ui.dialog.querySelector('[data-ag-refresh]').onclick();
  ui.select(6);ui.start();ui.join(2);ui.routeView('only');
  const before=ui.view(), route=ui.dialog.querySelector('.ag-route-bar').innerHTML;
  outsideGraph={...main,nodes:[...main.nodes,outside],edges:[...main.edges,use]};
  ui.data=main;
  await ui.dialog.querySelector('[data-ag-refresh]').onclick();
  assert.deepEqual(ui.view(),before);assert.equal(ui.dialog.querySelector('.ag-route-bar').innerHTML,route);
  ui.canvas.querySelectorAll('[data-ag-edge]')[0].onclick();
  assert.match(ui.inspector.innerHTML,/精确的外部依据/);
  assert.ok(ui.requests.some((request)=>request.asset_id===outside.id));
});

test('refresh does not undo zoom changes made while waiting for the new graph', async (t) => {
  let pause=false, finish;
  const ui=await graphScenario(t,{fetchGraph:(args,data)=>!args.asset_id && pause?new Promise((resolve)=>{finish=()=>resolve(data);}):null});
  ui.select(1);ui.start();ui.join(2);pause=true;
  const pending=ui.dialog.querySelector('[data-ag-refresh]').onclick();
  ui.dialog.querySelectorAll('[data-ag-zoom]').find((button)=>button.dataset.agZoom==='in').onclick();
  const camera=ui.view().camera;finish();await pending;
  assert.equal(ui.view().camera,camera);
  assert.match(ui.dialog.querySelector('.ag-route-bar').innerHTML,/data-ag-route-node="1"/);
});

test('route view buttons toggle off to the original view without a separate browsing button', async (t) => {
  const ui=await graphScenario(t);ui.select(1);ui.start();ui.join(2);
  const original=ui.view(), route=ui.dialog.querySelector('.ag-route-bar').innerHTML;
  assert.doesNotMatch(route,/data-ag-route-view="browse"/);
  assert.equal(ui.dialog.querySelector('.ag-route-bar').querySelectorAll('[data-ag-route-view]').length,2);
  for(const mode of ['global','only']) {
    ui.routeView(mode);
    assert.match(ui.dialog.querySelector('.ag-route-bar').innerHTML,new RegExp(`active" data-ag-route-view="${mode}"`));
    ui.routeView(mode);
    assert.deepEqual(ui.view(),original);
    assert.equal(ui.dialog.querySelector('.ag-route-bar').innerHTML,route);
  }
  ui.routeView('global');ui.routeView('only');ui.routeView('only');
  assert.deepEqual(ui.view(),original,'switching between focused views keeps the same original return context');
});

test('the selected-asset entry and current direct-contact exit stay distinct while inspecting other assets or edges', async (t) => {
  const ui=await graphScenario(t);ui.select(1);
  assert.equal((ui.dialog.innerHTML.match(/data-ag-local\b/g)||[]).length,1,'the selected-asset entry has one fixed location');
  assert.match(ui.dialog.innerHTML,/class="ag-inspector-pane"[^]*?data-ag-selected-actions[^]*?data-ag-local/,'the entry belongs next to the selected asset details');
  assert.doesNotMatch(ui.dialog.innerHTML.split('<div class="ag-tools">')[1].split('</form>')[0],/data-ag-local/,'general navigation does not contain the selected-asset action');
  assert.doesNotMatch(ui.inspector.innerHTML,/data-ag-local/);
  assert.doesNotMatch(ui.dialog.innerHTML,/data-ag-return-focus|data-ag-locate-global|data-ag-reset/);
  assert.match(ui.dialog.innerHTML,/class="ag-focus-scope"[^]*?data-ag-exit-direct/,'the exit is attached to the current-scope label');
  const original=ui.view(), button=ui.dialog.querySelector('[data-ag-local]');
  await button.onclick();assert.equal(button.hidden,true);
  assert.equal(ui.dialog.querySelector('[data-ag-focus-label]').textContent,'A1 的直接联系');
  ui.select(2);assert.equal(button.hidden,false);assert.equal(button.textContent,'查看 A2 的直接联系');
  assert.equal(ui.dialog.querySelector('[data-ag-focus-label]').textContent,'A1 的直接联系','selecting another node leaves the active scope unchanged');
  await button.onclick();assert.equal(ui.requests.at(-1).asset_id,ui.id(2));
  assert.equal(ui.dialog.querySelector('[data-ag-focus-label]').textContent,'A2 的直接联系');
  assert.equal(button.hidden,true);
  ui.select(3);
  ui.inspector.querySelectorAll('[data-ag-edge]').find((edge)=>edge.dataset.agEdge===`${ui.id(2)}/${ui.id(3)}`).onclick();
  assert.match(ui.inspector.innerHTML,/版本与具体用途/);
  await ui.dialog.querySelector('[data-ag-exit-direct]').onclick();assert.deepEqual(ui.view(),original);
  assert.equal(button.textContent,'查看 A3 的直接联系');
  assert.match(ui.inspector.innerHTML,/title="A000003"/,'exiting keeps the newly selected asset when it belongs to the restored view');
  await button.onclick();assert.equal(ui.requests.at(-1).asset_id,ui.id(3));
});

test('the map shows the active direct scope and marks its center independently of the selected asset', async (t) => {
  const ui=await graphScenario(t);
  assert.match(ui.dialog.innerHTML,/class="ag-map-panel"[^]*?data-ag-focus-views[^]*?class="ag-viewport"/,'the status band belongs to the map area and leaves the canvas unobstructed');
  assert.equal(ui.dialog.querySelector('.ag-viewport').classes.has('ag-direct-view'),false);
  ui.select(1);assert.equal(ui.dialog.querySelector('[data-ag-selected-actions]').hidden,false);
  await ui.dialog.querySelector('[data-ag-local]').onclick();
  assert.equal(ui.dialog.querySelector('.ag-viewport').classes.has('ag-direct-view'),true);
  assert.match(ui.dialog.querySelector('[data-ag-focus-detail]').textContent,/研究 1.*全部版本/);
  const center=()=>ui.canvas.querySelectorAll('[data-ag-node]').find((node)=>node.dataset.agNode===ui.id(1));
  assert.equal(center().classes.has('ag-focus-center'),true);assert.match(ui.canvas.innerHTML,/联系中心/);
  ui.select(2);
  assert.equal(center().classes.has('ag-focus-center'),true);
  assert.equal(ui.dialog.querySelector('[data-ag-focus-label]').textContent,'A1 的直接联系');
  assert.equal(ui.dialog.querySelector('[data-ag-local]').textContent,'查看 A2 的直接联系');
  await ui.dialog.querySelector('[data-ag-local]').onclick();
  assert.equal(ui.dialog.querySelector('[data-ag-focus-label]').textContent,'A2 的直接联系');
  assert.equal(ui.canvas.querySelectorAll('[data-ag-node]').find((node)=>node.dataset.agNode===ui.id(2)).classes.has('ag-focus-center'),true);
  ui.start();ui.join(3);ui.routeView('global');
  assert.equal(ui.dialog.querySelector('[data-ag-focus-views]').hidden,true);
  assert.equal(ui.dialog.querySelector('.ag-viewport').classes.has('ag-direct-view'),false);
  ui.routeView('global');
  assert.equal(ui.dialog.querySelector('[data-ag-focus-label]').textContent,'A2 的直接联系');
  assert.equal(ui.dialog.querySelector('.ag-viewport').classes.has('ag-direct-view'),true);
  ui.dialog.querySelector('[data-ag-exit-direct]').onclick();
  assert.equal(ui.dialog.querySelector('.ag-viewport').classes.has('ag-direct-view'),false);
  assert.equal(ui.canvas.querySelectorAll('[data-ag-node]').some((node)=>node.classes.has('ag-focus-center')),false);
  assert.equal(ui.dialog.querySelector('[data-ag-focus-views]').hidden,true);
});

test('exiting the current direct scope restores a route-only view and its camera', async (t) => {
  const ui=await graphScenario(t);ui.select(1);ui.start();ui.join(2);ui.routeView('only');ui.select(2);
  const original=ui.view(), route=ui.dialog.querySelector('.ag-route-bar').innerHTML;
  await ui.dialog.querySelector('[data-ag-local]').onclick();
  assert.match(ui.view().caption,/A2.*直接联系/);
  await ui.dialog.querySelector('[data-ag-exit-direct]').onclick();
  assert.deepEqual(ui.view(),original);assert.equal(ui.dialog.querySelector('.ag-route-bar').innerHTML,route);
  ui.routeView('only');assert.equal(ui.view().nodes.length,5);
});

test('exiting the current direct scope cancels an unfinished switch to another selected asset', async (t) => {
  let finish;
  const ui=await graphScenario(t,{focus:{id:'A000001'},fetchGraph:(args,data)=>args.asset_id==='A000002'?new Promise((resolve)=>{finish=()=>resolve({...data,focus:{id:args.asset_id,revision:null}});}):null});
  ui.start();ui.select(2);
  const pending=ui.dialog.querySelector('[data-ag-local]').onclick();
  ui.dialog.querySelector('[data-ag-exit-direct]').onclick();
  const restored=ui.view();finish();await pending;
  assert.deepEqual(ui.view(),restored);assert.equal(restored.nodes.length,5);
  assert.equal(ui.dialog.querySelector('[data-ag-focus-views]').hidden,true);
  assert.equal(ui.dialog.querySelector('[data-ag-local]').textContent,'查看 A2 的直接联系');
  assert.equal(ui.dialog.querySelector('.ag-notice').textContent,'');
});
