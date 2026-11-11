'use strict';

const s = (description) => ({ type: 'string', description });
const n = (description, min = 0, max) => ({ type: 'integer', minimum: min, ...(max === undefined ? {} : { maximum: max }), description });
const strings = (description) => ({ type: 'array', items: { type: 'string' }, description });
const ref = { type: 'object', additionalProperties: false, required: ['asset_id', 'revision', 'relation', 'note'],
  properties: { asset_id: s('Exact target id returned by a read, search or save.'), revision: n('Exact version used.', 1),
    relation: { type: 'string', enum: ['uses', 'related'], description: 'uses declares actual use or dependency; related records another connection. Explain the exact logic in note.' }, note: s('Specific use or connection, including uncertainty and conditions when relevant.') } };
const references = { type: 'array', items: ref, description: 'Declared direct references. Similarity and reading alone do not establish a dependency.' };
const entry = { type: 'object', additionalProperties: false, required: ['target_id', 'note'], properties: {
  target_id: s('Existing map or asset id. Assets remain parallel; this adds a navigational entry.'), note: s('Why this entry belongs in this region.') } };
const assetFields = { title: s('Specific research subject or contribution.'), tags: strings('Optional nonexclusive labels.'),
  body_md: s('Complete flexible Markdown, with exact content, assumptions, evidence, uncertainty and continuation points as relevant.'),
  source_reports: strings('Existing immutable report ids, or an empty list.'), references };
const mapFields = { title: s('Region title.'), body_md: s('Saved overview: subject, principal knowledge, conditions, gaps and useful connections.'),
  entries: { type: 'array', items: entry, description: 'Ordered navigation. Include all desired entries when replacing this list.' }, references };
const page = { offset: n('Continue from the returned next_offset.', 0), limit: n('Number of records per page.', 1, 100) };
const readFields = { revision: n('Read this exact historical version; omit for current.', 1),
  section_id: s('Section id from the returned table of contents; also supply that revision.'), offset: n('Character offset from next_offset.', 0),
  max_chars: n('Maximum body characters in this response. Read subsequent pages for the complete body.', 1, 80000),
  known_revision: n('Only supply when that version is still present in your context; unchanged reads can omit the body.', 1),
  force: { type: 'boolean', description: 'Return content even if known_revision matches. Use after context loss.' } };
readFields.location_offset = n('Continue current map placements from locations.next_offset. Placements are separate from the selected historical body.');
const tool = (name, description, properties, required = []) => ({ type: 'function', name, description,
  inputSchema: { type: 'object', additionalProperties: false, properties, required } });

const readTools = [
  tool('read_evidence', 'Read immutable file evidence returned by a report, with checksum validation and explicit text pagination. Binary evidence returns a saved path for suitable file tools.', { evidence_id: s('Evidence id returned by read_report.'), offset: n('Continue from next_offset.'), max_chars: n('Maximum text characters.', 1, 80000) }, ['evidence_id']),
  tool('read_map', 'Read a saved overview and resolved navigation. Start with map_id=root for the library or project for this project; expand returned ids as needed. This never summarizes content with another model.',
    { map_id: s('Map id, root, or project.'), ...readFields, depth: n('Navigation expansion depth; default 1.', 1, 4),
      entry_offset: n('Continue from next_entry_offset.', 0), limit: n('Direct entries per page.', 1, 100) }, ['map_id']),
  tool('read_asset', 'Read any exact asset id, version or section, including archived assets. Inspect reading.complete and next_offset; the returned body may be a fragment.',
    { asset_id: s('Asset id from the map, inventory, search or references.'), ...readFields }, ['asset_id']),
  tool('read_report', 'Read an immutable full research report, its source Run and reported evidence. Delivered does not mean integrated. Body reads are explicitly paginated.',
    { report_id: s('Report id from the inbox, Run or source_reports.'), ...readFields }, ['report_id']),
  tool('list_research_records', 'Browse the complete library independently of ranked search or map placement. Paginate to cover all records; use unmapped for assets outside maps.',
    { kind: { type: 'string', enum: ['asset', 'map', 'report'] }, project_id: s('Optional project scope; omit for the entire shared library.'),
      tag: s('Exact optional tag.'), query: s('Optional title or id substring for choosing a record.'), unmapped: { type: 'boolean' },
      include_archived: { type: 'boolean' }, archived_only: { type: 'boolean', description: 'List only archived records, with accurate counts and pagination.' }, ...page }),
  tool('search_assets', 'Find candidate assets or maps using Chinese/English full-text and literal formula matching. queries can supply alternative phrasings. Results do not prove equivalence or applicability; use maps and inventory for coverage.',
    { query: s('Research question, terminology or formula to locate.'), queries: strings('Optional additional phrasings.'),
      project_id: s('Optional project scope; omit to search the library.'), include_archived: { type: 'boolean' }, ...page }, ['query']),
  tool('get_asset_links', 'Find direct outgoing references or incoming references to an exact id. Incoming results identify possible impact, not automatic invalidity.',
    { asset_id: s('Asset or map id.'), direction: { type: 'string', enum: ['incoming', 'outgoing'] },
      relation: { type: 'string', enum: ['uses', 'related'] }, ...page }, ['asset_id', 'direction']),
  tool('list_record_versions', 'List immutable historical versions; read the desired version with the corresponding reader.', { record_id: s('Asset, map or report id; project for this project assessment.'), ...page }, ['record_id']),
  tool('read_project_research', 'Read this project’s saved research assessment, outcome assets and pending processing count. Goal resolution and independent outcomes should be judged separately.', { revision: n('Optional exact historical assessment version.', 1) })
];
const editTools = [
  tool('save_asset', 'Create or revise a parallel research asset. Omit asset_id to create; revise with asset_id and expected_revision. No exclusive content type or whole-record proof status is required. Untouched fields are preserved.',
    { asset_id: s('Omit to create; otherwise the existing id.'), expected_revision: n('Required when revising; use the version you read.', 1), ...assetFields }),
  tool('save_map', 'Create or revise a map region. Organize freely with saved prose and entries. References support substantive overview claims; entries only organize navigation. Untouched fields are preserved.',
    { map_id: s('Omit to create; existing map id, root or project to revise.'), expected_revision: n('Required when revising.', 1), ...mapFields }),
  tool('commit_research_updates', 'Commit several existing asset/map edits atomically, useful when reorganizing or integrating related records. Create new records first to obtain ids. Any invalid edit rolls back the whole batch.',
    { updates: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object', additionalProperties: false,
      required: ['id', 'expected_revision', 'changes'], properties: { id: s('Existing asset or map id.'), expected_revision: n('Version read.', 1),
        changes: { type: 'object', additionalProperties: false, properties: { ...assetFields, ...mapFields } } } } } }, ['updates']),
  tool('archive_research_record', 'Archive or restore a curated record while preserving its id, history and readable references. Maps and assets remain readable; root maps and original reports are retained.',
    { record_id: s('Asset or map id.'), expected_revision: n('Current version.', 1), archived: { type: 'boolean' } }, ['record_id', 'expected_revision', 'archived']),
  tool('get_research_inbox', 'Read this project’s pending/deferred reports and recorded asset changes. Use read_report for the full body and review_report to record the disposition. This does not alter proof status.',
    { include_resolved: { type: 'boolean' }, notice_offset: n('Continue recorded changes from next_notice_offset.', 0), ...page }),
  tool('review_report', 'Record how a report was integrated, retained with a reason, or deferred. Explain important side findings and unresolved work in note; integration requires resulting asset ids.',
    { report_id: s('Report belonging to this project.'), disposition: { type: 'string', enum: ['integrated', 'retained', 'deferred'] },
      note: s('What was preserved, checked, left open or deferred, and why.'), asset_ids: strings('Assets receiving this report’s content.') }, ['report_id', 'disposition', 'note']),
  tool('review_asset_changes', 'Acknowledge recorded changes after assessing their relevance. Preserve substantive corrections in assets, maps or the project assessment before clearing the notice.',
    { notice_ids: strings('Notice ids returned by get_research_inbox.'), note: s('Assessment and any resulting action.') }, ['notice_ids', 'note']),
  tool('save_project_research', 'Revise this project’s research assessment and outcome registry. Keep the original goal’s status distinct from independent achievements. Outcomes resolve to current asset records.',
    { expected_revision: n('Version returned by read_project_research.', 1), body_md: s('Current understanding, goals, conditions, blockers and decisions.'),
      outcomes: strings('Complete desired list of outcome asset ids, including valuable side results.') }, ['expected_revision']),
  tool('export_research_record', 'Return a portable JSON snapshot for an exact record and version. It is a generated export; save changes through the editing tools.',
    { record_id: s('Exact record id.'), revision: n('Optional historical version.', 1) }, ['record_id'])
];
const reportTool = tool('submit_report', 'Submit immutable research work to the Controller. Give a final report before ending this execution; intermediate milestones, blockers or material concerns can be reported while working. Preserve detailed checkable content, side findings and uncertainty; summary is a short handoff.',
  { body_md: s('Detailed research report with performed work, findings, evidence, limits and a continuation point as relevant.'),
    summary: s('Brief factual update shown in task progress and sent to the Controller: findings, obstacles or unresolved work. The detailed report belongs in body_md.'),
    phase: { type: 'string', enum: ['checkpoint', 'final', 'blocked', 'concern'], description: 'Default final: this execution is ending, even if the research goal remains open. Use checkpoint for meaningful progress, blocked for an obstacle, concern for a correction or review request.' },
    used_assets: { type: 'array', items: ref, description: 'Assets actually used; their logical relevance is later assessed by the Controller.' },
    concerns: strings('Optional exact asset/map ids whose content may need correction or checking.') }, ['body_md', 'summary']);
reportTool.inputSchema.properties.evidence_files = { type: 'array', maxItems: 30, items: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: s('File inside this workspace to preserve as immutable evidence, relative or absolute.') } }, description: 'Optional scripts, calculations, figures or other supporting files to snapshot with the report.' };
const researchControllerTools = [...readTools, ...editTools];
const researchAgentTools = [...readTools, reportTool];
const names = new Set([...researchControllerTools, reportTool].map((item) => item.name));
const readNames = new Set(readTools.map((item) => item.name));

async function executeResearchTool({ name, args, kind, store, manager, run, actor = 'controller' }) {
  const library = store.research;
  if (!library) throw new Error('Research library is not attached to this project');
  const projectId = store.project.id;
  const context = { project_id: projectId, actor };
  if (kind !== 'controller' && !readNames.has(name) && name !== 'submit_report') throw new Error('Only the Controller can maintain official research records');
  if (name === 'read_map') return library.readMap(args, projectId);
  if (name === 'read_evidence') {
    const evidence = library.readEvidence(args);
    if (!evidence.text_available) {
      const relative = library.materializeEvidence(args.evidence_id, store.project.workspacePath);
      evidence.file_path = `/workspace/${relative}`;
      evidence.download_url = `/api/files/download?projectId=${encodeURIComponent(store.project.id)}&path=${encodeURIComponent(relative)}`;
      evidence.note = 'Checksum-verified snapshot copied into the current project; file_path is accessible to project file/image tools.';
    }
    return evidence;
  }
  if (name === 'read_asset') {
    if (library.row(args.asset_id)?.kind !== 'asset') throw new Error('Asset not found');
    return library.read(args);
  }
  if (name === 'read_report') {
    if (library.row(args.report_id)?.kind !== 'report') throw new Error('Report not found');
    const result = library.read(args);
    result.processing = library.reportProcessing(args.report_id);
    if (kind === 'controller' && actor === 'controller') manager?.acknowledgeResearchReports?.([args.report_id]);
    return result;
  }
  if (name === 'list_research_records') return library.list(args);
  if (name === 'search_assets') return library.search(args);
  if (name === 'get_asset_links') return library.links(args);
  if (name === 'list_record_versions') return args.record_id === 'project' ? library.projectHistory(projectId, args) : library.history(args.record_id, args);
  if (name === 'read_project_research') return { ...library.readProject(projectId, args.revision), goal: store.project.automation?.goal || '', execution_state: store.project.automation?.state };
  if (name === 'save_project_research') return library.saveProject(projectId, args, context);
  if (name === 'save_asset' || name === 'save_map') {
    const type = name === 'save_asset' ? 'asset' : 'map';
    const { asset_id, map_id, expected_revision, ...fields } = args;
    const target = type === 'map' && map_id ? library.resolveMap(map_id, projectId) : asset_id;
    const record = library.save(type, { ...fields, ...(target ? { id: target } : {}) }, { ...context, expected_revision });
    return { record: library.card(record.id), saved_fields: Object.keys(fields), revision: record.revision };
  }
  if (name === 'commit_research_updates') return { records: library.commit(args.updates, context).map((record) => library.card(record.id)) };
  if (name === 'archive_research_record') return library.archive(args.record_id, args.expected_revision, args.archived, context);
  if (name === 'get_research_inbox') return library.inbox(projectId, args);
  if (name === 'review_report') return library.processReport(projectId, args, context);
  if (name === 'review_asset_changes') return library.resolveNotices(projectId, args.notice_ids, args.note);
  if (name === 'export_research_record') return library.exportRecord(args.record_id, args.revision);
  if (name === 'submit_report') return store.submitResearchReport(run, args, manager);
  throw new Error(`Unknown research tool: ${name}`);
}

module.exports = { researchControllerTools, researchAgentTools, researchToolNames: names, researchReadNames: readNames, executeResearchTool };
