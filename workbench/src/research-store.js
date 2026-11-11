const projectFiles = require('./project-files');
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { isDeepStrictEqual } = require('node:util');

const ASSET_FIELDS = ['id', 'revision', 'title', 'tags', 'body_md', 'source_reports', 'references'];
const timestamp = () => new Date().toISOString();
const clone = (value) => JSON.parse(JSON.stringify(value));
const sameContent = (a, b) => {
  const { revision: aRevision, ...aContent } = a;
  const { revision: bRevision, ...bContent } = b;
  return isDeepStrictEqual(aContent, bContent);
};
const string = (value, name, allowEmpty = false) => {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new Error(`${name} must be a string${allowEmpty ? '' : ' with content'}`);
  return value.replace(/\r\n?/g, '\n');
};
const integer = (value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error('Invalid numeric parameter');
  return number;
};
const tokenize = (text) => {
  const normalized = String(text).normalize('NFKC').toLowerCase();
  const words = normalized.match(/[a-z0-9_]+|[\p{Script=Han}]+/gu) || [];
  return [...new Set(words.flatMap((word) => /\p{Script=Han}/u.test(word) && word.length > 2
    ? [word, ...Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2))] : [word]))];
};

class ResearchLibrary extends EventEmitter {
  constructor(filename) {
    super();
    this.setMaxListeners(0);
    this.filename = filename;
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename, { timeout: 5000 });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, revision INTEGER NOT NULL,
        document TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
        owner_project TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS versions (
        id TEXT NOT NULL REFERENCES records(id), revision INTEGER NOT NULL,
        document TEXT NOT NULL, archived INTEGER NOT NULL, at TEXT NOT NULL,
        PRIMARY KEY(id, revision)
      );
      CREATE TABLE IF NOT EXISTS links (
        source_id TEXT NOT NULL REFERENCES records(id), target_id TEXT NOT NULL REFERENCES records(id),
        target_revision INTEGER NOT NULL, relation TEXT NOT NULL, note TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS links_target ON links(target_id, target_revision);
      CREATE TABLE IF NOT EXISTS entries (
        map_id TEXT NOT NULL REFERENCES records(id), target_id TEXT NOT NULL REFERENCES records(id),
        position INTEGER NOT NULL, note TEXT NOT NULL, PRIMARY KEY(map_id, target_id)
      );
      CREATE INDEX IF NOT EXISTS entries_target ON entries(target_id);
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, map_id TEXT NOT NULL, revision INTEGER NOT NULL,
        body_md TEXT NOT NULL, outcomes TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS scopes (record_id TEXT NOT NULL REFERENCES records(id), project_id TEXT NOT NULL,
        PRIMARY KEY(record_id, project_id));
      CREATE TABLE IF NOT EXISTS reports (
        report_id TEXT PRIMARY KEY REFERENCES records(id), project_id TEXT NOT NULL, run_id TEXT NOT NULL,
        agent_id TEXT NOT NULL, phase TEXT NOT NULL, seen INTEGER NOT NULL DEFAULT 0,
        disposition TEXT NOT NULL DEFAULT 'pending', note TEXT NOT NULL DEFAULT '', asset_ids TEXT NOT NULL DEFAULT '[]',
        dedup_key TEXT NOT NULL UNIQUE
      );
      CREATE INDEX IF NOT EXISTS reports_pending ON reports(project_id, seen, disposition);
      CREATE TABLE IF NOT EXISTS notices (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, target_id TEXT NOT NULL,
        message TEXT NOT NULL, resolved INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS counters (prefix TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS project_versions (project_id TEXT NOT NULL,revision INTEGER NOT NULL,document TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(project_id,revision));
      CREATE TABLE IF NOT EXISTS report_reviews (report_id TEXT NOT NULL,document TEXT NOT NULL,at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS record_order (record_id TEXT PRIMARY KEY REFERENCES records(id),change_seq INTEGER NOT NULL,overview_seq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS evidence (id TEXT PRIMARY KEY,hash TEXT NOT NULL,path TEXT NOT NULL,name TEXT NOT NULL,size INTEGER NOT NULL,project_id TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS research_fts USING fts5(id UNINDEXED, title, body, tags);
    `);
    this.transaction(() => {
      // Earlier local V3 snapshots lacked the monotonic overview baseline.
      // Mark their overviews conservatively until the Controller saves prose again.
      for (const row of this.db.prepare('SELECT r.id FROM records r LEFT JOIN record_order o ON o.record_id=r.id WHERE o.record_id IS NULL ORDER BY r.updated_at,r.id').all()) {
        const seq = Number(this.nextId('S').slice(1)); this.db.prepare('INSERT INTO record_order VALUES(?,?,0)').run(row.id, seq);
      }
      if (!this.row('MROOT')) this.insert('map', { id: 'MROOT', revision: 1, title: '研究资产总览',
        body_md: '从项目或专题入口逐层查看研究内容。未归类资产、待处理汇报及完整目录可独立浏览。', entries: [], references: [] }, null);
    });
  }
  close() { if (!this.closed) { this.db.close(); this.closed = true; } }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  row(id) { return this.db.prepare('SELECT * FROM records WHERE id=?').get(id); }
  nextId(prefix) {
    this.db.prepare('INSERT INTO counters(prefix,value) VALUES(?,1) ON CONFLICT(prefix) DO UPDATE SET value=value+1').run(prefix);
    const value = this.db.prepare('SELECT value FROM counters WHERE prefix=?').get(prefix).value;
    return `${prefix}${String(value).padStart(6, '0')}`;
  }
  get(id, revision) {
    const current = this.row(id);
    if (!current) throw new Error(`Record not found: ${id}`);
    if (revision === undefined || Number(revision) === current.revision) return JSON.parse(current.document);
    const old = this.db.prepare('SELECT document FROM versions WHERE id=? AND revision=?').get(id, integer(revision, undefined, 1));
    if (!old) throw new Error(`Revision not found: ${id}@${revision}`);
    return JSON.parse(old.document);
  }
  card(id) {
    const row = this.db.prepare("SELECT id,kind,revision,archived,updated_at,json_extract(document,'$.title') AS title,json_extract(document,'$.tags') AS tags,substr(json_extract(document,'$.body_md'),1,320) AS excerpt,EXISTS(SELECT 1 FROM projects p WHERE p.map_id=records.id) AS project_map,(SELECT count(*) FROM entries e JOIN records m ON m.id=e.map_id WHERE e.target_id=records.id AND m.archived=0) AS locations_count FROM records WHERE id=?").get(id);
    if (!row) throw new Error(`Record not found: ${id}`);
    return { id, kind: row.kind, revision: row.revision, title: row.title, archived: Boolean(row.archived),
      updated_at: row.updated_at, tags: row.tags ? JSON.parse(row.tags) : [], excerpt: row.excerpt || '', project_map: Boolean(row.project_map), locations_count: row.locations_count };
  }
  references(input, deferVersionCheck = false) {
    if (!Array.isArray(input)) throw new Error('references must be an array');
    return input.map((item) => {
      if (!item || Object.keys(item).some((key) => !['asset_id', 'revision', 'relation', 'note'].includes(key))) throw new Error('Invalid reference fields');
      const asset_id = string(item.asset_id, 'asset_id');
      const revision = integer(item.revision, undefined, 1);
      if (revision === undefined) throw new Error('A reference requires revision');
      if (!['uses', 'related'].includes(item.relation)) throw new Error('relation must be uses or related; describe its exact meaning in note');
      const target = this.row(asset_id);
      if (!target || !['asset', 'map'].includes(target.kind)) throw new Error(`Reference target must be an asset or map: ${asset_id}`);
      if (!deferVersionCheck) this.get(asset_id, revision);
      return { asset_id, revision, relation: item.relation, note: string(item.note, 'reference note') };
    });
  }
  normalize(kind, input, existing, recordId, deferVersionCheck = false) {
    const allowed = kind === 'asset' ? ASSET_FIELDS : ['id', 'revision', 'title', 'body_md', 'entries', 'references'];
    for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new Error(`Unsupported ${kind} field: ${key}`);
    const merged = { ...(existing || {}), ...input, id: recordId, revision: (existing?.revision || 0) + 1 };
    const result = { id: recordId, revision: merged.revision, title: string(merged.title, 'title'),
      body_md: string(merged.body_md ?? '', 'body_md', true) };
    result.references = this.references(merged.references || [], deferVersionCheck);
    if (kind === 'asset') {
      if (!Array.isArray(merged.tags || [])) throw new Error('tags must be an array');
      result.tags = [...new Set((merged.tags || []).map((tag) => string(tag, 'tag').trim()))];
      if (!Array.isArray(merged.source_reports || [])) throw new Error('source_reports must be an array');
      result.source_reports = [...new Set((merged.source_reports || []).map((reportId) => {
        if (this.row(reportId)?.kind !== 'report') throw new Error(`Source report not found: ${reportId}`);
        return reportId;
      }))];
      return Object.fromEntries(ASSET_FIELDS.map((field) => [field, result[field]]));
    }
    if (!Array.isArray(merged.entries || [])) throw new Error('entries must be an array');
    const seen = new Set();
    result.entries = (merged.entries || []).map((entry) => {
      if (!entry || Object.keys(entry).some((key) => !['target_id', 'note'].includes(key))) throw new Error('Invalid map entry');
      const target_id = string(entry.target_id, 'target_id');
      if (!['map', 'asset'].includes(this.row(target_id)?.kind)) throw new Error(`Map target not found: ${target_id}`);
      if (target_id === recordId || seen.has(target_id)) throw new Error('Map entries must be unique and cannot contain the map itself');
      seen.add(target_id);
      return { target_id, note: string(entry.note || '', 'entry note', true) };
    });
    return result;
  }
  index(kind, doc) {
    this.db.prepare('DELETE FROM links WHERE source_id=?').run(doc.id);
    for (const reference of doc.references || []) this.db.prepare('INSERT INTO links VALUES(?,?,?,?,?)')
      .run(doc.id, reference.asset_id, reference.revision, reference.relation, reference.note);
    this.db.prepare('DELETE FROM entries WHERE map_id=?').run(doc.id);
    for (const [position, entry] of (doc.entries || []).entries()) this.db.prepare('INSERT INTO entries VALUES(?,?,?,?)')
      .run(doc.id, entry.target_id, position, entry.note);
    this.db.prepare('DELETE FROM research_fts WHERE id=?').run(doc.id);
    if (['asset', 'map'].includes(kind)) this.db.prepare('INSERT INTO research_fts(id,title,body,tags) VALUES(?,?,?,?)')
      .run(doc.id, tokenize(doc.title).join(' '), tokenize(doc.body_md).join(' '), tokenize((doc.tags || []).join(' ')).join(' '));
  }
  insert(kind, doc, projectId, archived = 0) {
    const at = timestamp();
    this.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?)').run(doc.id, kind, doc.revision, JSON.stringify(doc), archived, projectId || null, at, at);
    this.db.prepare('INSERT INTO versions VALUES(?,?,?,?,?)').run(doc.id, doc.revision, JSON.stringify(doc), archived, at);
    const seq = Number(this.nextId('S').slice(1));
    this.db.prepare('INSERT INTO record_order VALUES(?,?,?)').run(doc.id, seq, seq);
    if (projectId) this.db.prepare('INSERT OR IGNORE INTO scopes VALUES(?,?)').run(doc.id, projectId);
    this.index(kind, doc);
  }
  update(kind, doc, archived, reviewOverview = true) {
    const at = timestamp();
    this.db.prepare('UPDATE records SET revision=?,document=?,archived=?,updated_at=? WHERE id=?')
      .run(doc.revision, JSON.stringify(doc), archived, at, doc.id);
    this.db.prepare('INSERT INTO versions VALUES(?,?,?,?,?)').run(doc.id, doc.revision, JSON.stringify(doc), archived, at);
    const seq = Number(this.nextId('S').slice(1));
    this.db.prepare('INSERT INTO record_order VALUES(?,?,?) ON CONFLICT(record_id) DO UPDATE SET change_seq=excluded.change_seq,overview_seq=CASE WHEN ? THEN excluded.overview_seq ELSE overview_seq END')
      .run(doc.id, seq, seq, reviewOverview ? 1 : 0);
    this.index(kind, doc);
  }
  assertMapAcyclic() {
    const edges = new Map();
    for (const row of this.db.prepare("SELECT e.map_id,e.target_id FROM entries e JOIN records r ON r.id=e.target_id WHERE r.kind='map'").all()) {
      if (!edges.has(row.map_id)) edges.set(row.map_id, []);
      edges.get(row.map_id).push(row.target_id);
    }
    const finished = new Set();
    for (const start of edges.keys()) {
      const stack = [[start, false]]; const active = new Set();
      while (stack.length) {
        const [node, exit] = stack.pop();
        if (exit) { active.delete(node); finished.add(node); continue; }
        if (active.has(node)) throw new Error('Map containment would create a cycle');
        if (finished.has(node)) continue;
        active.add(node); stack.push([node, true]);
        for (const child of edges.get(node) || []) stack.push([child, false]);
      }
    }
  }
  save(kind, input, context = {}) {
    if (!['asset', 'map'].includes(kind)) throw new Error('Editable record not found; original reports are immutable');
    let saved, changed = false;
    const changes = this.transaction(() => {
      const recordId = input.id || this.nextId(kind === 'asset' ? 'A' : 'M');
      const old = this.row(recordId);
      if (input.id && (!old || old.kind !== kind)) throw new Error(`${kind} not found: ${recordId}`);
      if (old && integer(context.expected_revision, undefined, 1) !== old.revision) throw new Error(`Version conflict for ${recordId}; current revision is ${old.revision}`);
      saved = this.normalize(kind, input, old && JSON.parse(old.document), recordId);
      if (old && sameContent(saved, JSON.parse(old.document))) { saved = JSON.parse(old.document); return []; }
      changed = true;
      if (old) this.update(kind, saved, old.archived, kind !== 'map' || Object.hasOwn(input, 'body_md')); else this.insert(kind, saved, context.project_id);
      if (kind === 'map') this.assertMapAcyclic();
      return old ? this.createChangeNotices(recordId, context) : [];
    });
    if (changed) this.emit('changed', { record_id: saved.id, project_id: context.project_id, actor: context.actor || 'controller', notices: changes });
    return clone(saved);
  }
  commit(updates, context = {}) {
    if (!Array.isArray(updates) || !updates.length || updates.length > 50) throw new Error('Provide 1 to 50 record updates');
    let records; let notices = [];
    this.transaction(() => {
      const ids = new Set();
      records = updates.map((item) => {
        if (ids.has(item.id)) throw new Error('A batch can update each record only once'); ids.add(item.id);
        const old = this.row(item.id);
        if (!old || !['asset', 'map'].includes(old.kind)) throw new Error(`Editable record not found: ${item.id}`);
        if (old.revision !== integer(item.expected_revision, undefined, 1)) throw new Error(`Version conflict for ${item.id}`);
        const previous = JSON.parse(old.document), normalized = this.normalize(old.kind, item.changes || {}, previous, item.id, true);
        const changed = !sameContent(previous, normalized);
        return { kind: old.kind, archived: old.archived, changed, reviewOverview: old.kind !== 'map' || Object.hasOwn(item.changes || {}, 'body_md'), doc: changed ? normalized : previous };
      });
      for (const record of records) if (record.changed) this.update(record.kind, record.doc, record.archived, record.reviewOverview);
      for (const record of records) this.references(record.doc.references);
      this.assertMapAcyclic();
      for (const record of records) if (record.changed) notices.push(...this.createChangeNotices(record.doc.id, context));
    });
    if (records.some((record) => record.changed)) this.emit('changed', { project_id: context.project_id, actor: context.actor || 'controller', notices });
    return records.map((record) => clone(record.doc));
  }
  createChangeNotices(recordId, context) {
    const projects = this.db.prepare(`WITH RECURSIVE edges(source,target) AS (
      SELECT source_id,target_id FROM links WHERE relation='uses' UNION SELECT map_id,target_id FROM entries
    ), affected(id) AS (SELECT ? UNION SELECT e.source FROM edges e JOIN affected a ON e.target=a.id)
    SELECT DISTINCT s.project_id FROM scopes s JOIN affected a ON a.id=s.record_id`).all(recordId);
    if (context.actor === 'user' && context.project_id && !projects.some((item) => item.project_id === context.project_id)) projects.push({ project_id: context.project_id });
    const notices = [];
    for (const { project_id } of projects) {
      if (project_id === context.project_id && context.actor !== 'user') continue;
      const notice = { id: this.nextId('N'), project_id, target_id: recordId,
        message: `${recordId} has a new revision. Check relevant references or map overviews before relying on them.`, at: timestamp() };
      this.db.prepare('INSERT INTO notices VALUES(?,?,?,?,0,?)').run(notice.id, project_id, recordId, notice.message, notice.at);
      notices.push(notice);
    }
    return notices;
  }
  ensureProject(project) {
    const existing = this.db.prepare('SELECT * FROM projects WHERE id=?').get(project.id);
    if (existing) return { root_map_id: 'MROOT', project_map_id: existing.map_id };
    return this.transaction(() => {
      const map = { id: this.nextId('M'), revision: 1, title: project.name,
        body_md: '此项目的成果、探索和待澄清问题尚待 controller 整理。', entries: [], references: [] };
      this.insert('map', map, project.id);
      this.db.prepare('INSERT INTO projects(id,title,map_id,revision,body_md,outcomes) VALUES(?,?,?,1,?,?)')
        .run(project.id, project.name, map.id, '', '[]');
      const root = this.get('MROOT'); root.revision += 1;
      root.entries.push({ target_id: map.id, note: `项目：${project.name}` }); this.update('map', root, 0, false);
      return { root_map_id: root.id, project_map_id: map.id };
    });
  }
  resolveMap(id, projectId) {
    if (id === 'root') return 'MROOT';
    if (id === 'project') {
      const project = this.db.prepare('SELECT map_id FROM projects WHERE id=?').get(projectId);
      if (!project) throw new Error('Project map is not registered');
      return project.map_id;
    }
    return id;
  }
  readMap(args = {}, projectId, budget = { entries: 160, maps: 8 }) {
    const mapId = this.resolveMap(args.map_id || 'root', projectId);
    if (this.row(mapId)?.kind !== 'map') throw new Error(`Map not found: ${mapId}`);
    const reading = this.read({ ...args, record_id: mapId });
    if (reading.record) { delete reading.record.entries; }
    const doc = this.get(mapId, args.revision);
    const offset = integer(args.entry_offset, 0); const limit = integer(args.limit, 30, 1, 100);
    const depth = integer(args.depth, 1, 1, 4);
    const taken = Math.min(limit, budget.entries);
    budget.entries -= taken; budget.maps -= 1;
    const entries = doc.entries.slice(offset, offset + taken).map((entry) => ({ ...entry, target: this.card(entry.target_id) }));
    if (depth > 1) for (const entry of entries) if (entry.target.kind === 'map') {
      if (budget.entries > 0 && budget.maps > 0) entry.expanded = this.readMap({ map_id: entry.target.id, depth: depth - 1, limit, max_chars: 3000 }, projectId, budget);
      else entry.expansion_deferred = { map_id: entry.target.id, reason: 'Response budget reached; read this map directly.' };
    }
    const entry_counts = { projects: 0, topics: 0, assets: 0, archived: 0 };
    const counts = this.db.prepare(`SELECT r.kind,r.archived,EXISTS(SELECT 1 FROM projects p WHERE p.map_id=r.id) AS project_map,count(*) AS total
      FROM json_each(?) e JOIN records r ON r.id=json_extract(e.value,'$.target_id') GROUP BY r.kind,r.archived,project_map`).all(JSON.stringify(doc.entries));
    for (const row of counts) entry_counts[row.archived ? 'archived' : row.kind === 'asset' ? 'assets' : row.project_map ? 'projects' : 'topics'] += row.total;
    const containingProject = this.db.prepare('SELECT id FROM projects WHERE map_id=?').get(mapId);
    return { ...reading, entries, entry_count: doc.entries.length, entry_counts,
      project_map: Boolean(containingProject), project_id: containingProject?.id || null,
      project_assets_total: containingProject ? this.list({ kind: 'asset', project_id: containingProject.id, limit: 1 }).total : undefined,
      next_entry_offset: offset + entries.length < doc.entries.length ? offset + entries.length : null,
      parents: reading.locations.items.map((item) => item.map),
      related: this.links({ asset_id: mapId, direction: 'outgoing', limit: 30 }).items,
      coverage: this.coverage(mapId) };
  }
  sections(body) {
    const headings = [...body.matchAll(/^#{1,6}\s+(.+)$/gm)];
    return headings.map((match, i) => ({ section_id: `s${i + 1}`, title: match[1], offset: match.index,
      end: headings[i + 1]?.index ?? body.length }));
  }
  read(args = {}) {
    const id = args.record_id || args.asset_id || args.report_id;
    const row = this.row(id); if (!row) throw new Error(`Record not found: ${id}`);
    const doc = this.get(id, args.revision);
    const locations = this.locations(id, args.location_offset);
    if (args.known_revision !== undefined && Number(args.known_revision) === doc.revision && !args.force) return {
      unchanged: true, id, revision: doc.revision, current_revision: row.revision, locations, warnings: this.warnings(id, doc) };
    let body = doc.body_md || ''; let base = 0;
    const sections = this.sections(body);
    if (args.section_id) {
      if (!args.revision) throw new Error('Section reads require the revision returned with the table of contents');
      const section = sections.find((item) => item.section_id === args.section_id);
      if (!section) throw new Error('Section not found in this revision');
      base = section.offset; body = body.slice(base, section.end);
    }
    const offset = integer(args.offset, 0); const max = integer(args.max_chars, 16000, 1, 80000);
    const text = body.slice(offset, offset + max);
    const reference_records = (doc.references || doc.used_assets || []).map((ref) => ({ ...this.card(ref.asset_id),
      revision: ref.revision, title: this.get(ref.asset_id, ref.revision).title }));
    return { record: { ...doc, body_md: text }, kind: row.kind, archived: Boolean(row.archived), current_revision: row.revision,
      reference_records, source_report_records: (doc.source_reports || []).map((reportId) => this.card(reportId)),
      reading: { offset, total_chars: body.length, next_offset: offset + text.length < body.length ? offset + text.length : null,
        complete: offset === 0 && text.length === body.length, section_id: args.section_id || null, source_offset: base + offset },
      sections, locations, warnings: this.warnings(id, doc) };
  }
  locations(id, locationOffset) {
    const offset = integer(locationOffset, 0), limit = 30;
    const total = this.db.prepare('SELECT count(*) AS n FROM entries WHERE target_id=?').get(id).n;
    const rows = this.db.prepare('SELECT map_id,note FROM entries WHERE target_id=? ORDER BY map_id LIMIT ? OFFSET ?').all(id, limit, offset);
    return { items: rows.map((row) => ({ map: this.card(row.map_id), note: row.note })), total,
      next_offset: offset + rows.length < total ? offset + rows.length : null, note: 'Current navigation locations; assets remain parallel, including when reading historical content.' };
  }
  warnings(id, doc = this.get(id)) {
    const references = (doc.references || []).filter((item) => this.row(item.asset_id)?.revision !== item.revision)
      .map((item) => ({ type: 'referenced_record_updated', asset_id: item.asset_id, referenced_revision: item.revision, current_revision: this.row(item.asset_id)?.revision }));
    const notices = this.db.prepare('SELECT id,message FROM notices WHERE target_id=? AND resolved=0 LIMIT 100').all(id);
    return [...references, ...notices.map((notice) => ({ type: 'pending_review', ...notice }))];
  }
  coverage(mapId) {
    const changes = this.db.prepare(`WITH RECURSIVE region(id) AS (
      SELECT target_id FROM entries WHERE map_id=? UNION SELECT e.target_id FROM entries e JOIN region r ON e.map_id=r.id
    ) SELECT r.id,r.revision,r.updated_at FROM records r JOIN region g ON r.id=g.id JOIN record_order o ON o.record_id=r.id
      WHERE o.change_seq>(SELECT overview_seq FROM record_order WHERE record_id=?) LIMIT 101`).all(mapId, mapId);
    return { descendants_changed_since_map_save: Math.min(changes.length, 100), more: changes.length > 100,
      note: 'Revision changes indicate material to inspect; they do not determine whether the overview is incorrect.' };
  }
  scopeCondition() {
    return `(EXISTS(SELECT 1 FROM scopes s WHERE s.record_id=r.id AND s.project_id=?) OR r.id IN (
      WITH RECURSIVE region(id) AS (SELECT map_id FROM projects WHERE id=? UNION SELECT e.target_id FROM entries e JOIN region g ON e.map_id=g.id)
      SELECT id FROM region))`;
  }
  list(args = {}) {
    const conditions = []; const params = [];
    if (args.kind) { conditions.push('r.kind=?'); params.push(args.kind); }
    if (args.archived_only) conditions.push('r.archived=1');
    else if (!args.include_archived) conditions.push('r.archived=0');
    if (args.project_id) { conditions.push(this.scopeCondition()); params.push(args.project_id, args.project_id); }
    if (args.unmapped) conditions.push("r.kind='asset' AND NOT EXISTS(SELECT 1 FROM entries e JOIN records m ON m.id=e.map_id WHERE e.target_id=r.id AND m.archived=0)");
    if (args.query) { conditions.push("(instr(lower(json_extract(r.document,'$.title')),lower(?))>0 OR instr(lower(r.id),lower(?))>0 OR instr(lower(substr(r.id,1,1)||ltrim(substr(r.id,2),'0')),lower(?))>0)"); params.push(...Array(3).fill(String(args.query).trim())); }
    if (args.tag) { conditions.push("EXISTS(SELECT 1 FROM json_each(json_extract(r.document,'$.tags')) WHERE value=?)"); params.push(args.tag); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = integer(args.offset, 0); const limit = integer(args.limit, 30, 1, 100);
    const total = this.db.prepare(`SELECT count(*) AS n FROM records r ${where}`).get(...params).n;
    const rows = this.db.prepare(`SELECT r.id FROM records r ${where} ORDER BY r.updated_at DESC,r.id LIMIT ? OFFSET ?`).all(...params, limit, offset);
    return { items: rows.map((item) => this.card(item.id)), total, next_offset: offset + rows.length < total ? offset + rows.length : null };
  }
  search(args = {}) {
    const queries = [string(args.query, 'query'), ...(args.queries || [])].map((value) => string(value, 'query'));
    const terms = [...new Set(queries.flatMap(tokenize))].slice(0, 100);
    const match = terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' OR ');
    const conditions = ['research_fts MATCH ?']; const params = [match || '"__empty__"'];
    if (!args.include_archived) conditions.push('r.archived=0');
    if (args.project_id) { conditions.push(this.scopeCondition()); params.push(args.project_id, args.project_id); }
    const ranked = this.db.prepare(`SELECT r.id,bm25(research_fts,0,6,1,4) AS score FROM research_fts JOIN records r ON r.id=research_fts.id WHERE ${conditions.join(' AND ')} ORDER BY score LIMIT 500`).all(...params);
    // Literal matching also preserves formulas and punctuation stripped by the lexical tokenizer.
    const literal = this.db.prepare(`SELECT r.id FROM records r WHERE r.kind IN ('asset','map') ${args.include_archived ? '' : 'AND r.archived=0'}
      ${args.project_id ? 'AND ' + this.scopeCondition() : ''}
      AND (${queries.map(() => "(json_extract(r.document,'$.title') || char(10) || json_extract(r.document,'$.body_md')) LIKE ? ESCAPE '\\'").join(' OR ')}) LIMIT 100`).all(...(args.project_id ? [args.project_id, args.project_id] : []), ...queries.map((query) => `%${query.replace(/[\\%_]/g, '\\$&')}%`));
    const ids = [...new Set([...literal.map((row) => row.id), ...ranked.map((row) => row.id)])];
    const offset = integer(args.offset, 0); const limit = integer(args.limit, 15, 1, 100);
    return { items: ids.slice(offset, offset + limit).map((recordId) => this.card(recordId)), total_candidates: ids.length,
      next_offset: offset + limit < ids.length ? offset + limit : null, retrieval: 'lexical_fts_and_literal',
      candidate_limit: 600, note: 'Candidates are not mathematical equivalence or applicability judgments. Use the complete inventory to inspect beyond ranked retrieval.' };
  }
  links(args = {}) {
    if (!this.row(args.asset_id)) throw new Error('Record not found');
    const incoming = args.direction === 'incoming';
    const offset = integer(args.offset, 0); const limit = integer(args.limit, 30, 1, 100);
    const where = `${incoming ? 'target_id' : 'source_id'}=?${args.relation ? ' AND relation=?' : ''}`;
    const params = [args.asset_id, ...(args.relation ? [args.relation] : [])];
    const total = this.db.prepare(`SELECT count(*) AS n FROM links WHERE ${where}`).get(...params).n;
    const items = this.db.prepare(`SELECT * FROM links WHERE ${where} ORDER BY source_id,target_id LIMIT ? OFFSET ?`).all(...params, limit, offset)
      .map((item) => ({ ...item, target: this.card(incoming ? item.source_id : item.target_id) }));
    return { items, total, next_offset: offset + items.length < total ? offset + items.length : null };
  }
  // A read-only snapshot. Arrows run from the cited version to the asset using it.
  // Project views use current source documents; focus views use the selected version.
  assetGraph(args = {}) {
    this.db.exec('BEGIN');
    try {
      const data = this.buildAssetGraph(args);
      this.db.exec('COMMIT');
      return data;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  buildAssetGraph(args) {
    const projectId = args.project_id || null;
    const project = projectId && this.db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
    if (projectId && !project) throw new Error('Project not found');
    const rows = this.db.prepare(`SELECT id,revision,archived,json_extract(document,'$.title') AS title,
      substr(json_extract(document,'$.body_md'),1,240) AS excerpt,
      json_extract(document,'$.tags') AS tags,
      json_extract(document,'$.references') AS refs FROM records WHERE kind='asset' ORDER BY id`).all();
    const all = new Map(rows.map((row) => [row.id, { ...row, references: JSON.parse(row.refs || '[]') }]));
    const scoped = new Set(projectId ? this.db.prepare(`SELECT r.id FROM records r WHERE r.kind='asset' AND r.archived=0 AND ${this.scopeCondition()}`).all(projectId, projectId).map((row) => row.id) : rows.filter((row) => !row.archived).map((row) => row.id));
    const outcomes = new Set(JSON.parse(project?.outcomes || '[]'));
    const versions = new Map(), nodes = new Map(), edges = [];
    const version = (id, revision) => {
      const key = `${id}@${revision}`;
      if (!versions.has(key)) versions.set(key, this.get(id, revision));
      return versions.get(key);
    };
    const add = (id, revision) => {
      const row = all.get(id); if (!row) return;
      if (!nodes.has(id)) nodes.set(id, { id, title: row.title, revision: row.revision, excerpt: row.excerpt || '',
        tags: JSON.parse(row.tags || '[]'), archived: Boolean(row.archived), external: !scoped.has(id), outcome: outcomes.has(id), versions: [] });
      const node = nodes.get(id);
      if (!node.versions.includes(revision)) node.versions.push(revision);
      return node;
    };
    const connect = (doc) => {
      for (const ref of doc.references || []) {
        if (ref.relation !== 'uses' || !all.has(ref.asset_id)) continue;
        add(ref.asset_id, ref.revision); add(doc.id, doc.revision);
        edges.push({ id: `e${edges.length}`, source: ref.asset_id, source_revision: ref.revision,
          target: doc.id, target_revision: doc.revision, note: ref.note,
          source_title: version(ref.asset_id, ref.revision).title, target_title: doc.title });
      }
    };
    const allVersions = args.all_versions === true;
    const historical = allVersions ? this.db.prepare(`SELECT v.id,v.revision,json_extract(v.document,'$.title') AS title,
      json_extract(v.document,'$.references') AS refs FROM versions v JOIN records r ON r.id=v.id
      WHERE r.kind='asset' ORDER BY v.id,v.revision`).all().map((row) => ({ ...row, references: JSON.parse(row.refs || '[]') })) : [];
    let focus = null;
    if (args.asset_id) {
      if (!all.has(args.asset_id)) throw new Error('Asset not found');
      const doc = version(args.asset_id, args.revision === undefined ? all.get(args.asset_id).revision : integer(args.revision, undefined, 1));
      const selectedRevision = allVersions && args.revision === undefined ? null : doc.revision;
      focus = { id: doc.id, revision: selectedRevision, title: doc.title };
      add(doc.id, doc.revision);
      if (selectedRevision === null) {
        for (const item of historical.filter((item) => item.id === doc.id)) { add(item.id, item.revision); connect(item); }
      } else connect(doc);
      for (const row of allVersions ? historical : all.values()) {
        if (all.get(row.id).archived || row.id === doc.id) continue;
        for (const ref of row.references) {
          if (ref.relation !== 'uses' || ref.asset_id !== doc.id || (selectedRevision !== null && ref.revision !== selectedRevision)) continue;
          add(doc.id, ref.revision);
          add(row.id, row.revision);
          edges.push({ id: `e${edges.length}`, source: doc.id, source_revision: ref.revision,
            target: row.id, target_revision: row.revision, note: ref.note, source_title: version(doc.id, ref.revision).title, target_title: row.title });
        }
      }
    } else {
      for (const id of scoped) { const row = all.get(id); add(id, row.revision); if (!allVersions) connect(row); }
      if (allVersions) for (const doc of historical) if (scoped.has(doc.id)) { add(doc.id, doc.revision); connect(doc); }
    }
    const topicRows = this.db.prepare(`SELECT r.id,json_extract(r.document,'$.title') AS title FROM records r
      WHERE r.kind='map' AND r.archived=0 AND r.id!='MROOT' AND NOT EXISTS(SELECT 1 FROM projects p WHERE p.map_id=r.id)
      ${projectId ? `AND ${this.scopeCondition()}` : ''} ORDER BY r.id`).all(...(projectId ? [projectId, projectId] : []));
    const members = this.db.prepare(`WITH RECURSIVE region(id) AS (SELECT target_id FROM entries WHERE map_id=?
      UNION SELECT e.target_id FROM entries e JOIN region g ON e.map_id=g.id JOIN records r ON r.id=g.id WHERE r.archived=0)
      SELECT id FROM region`);
    const topics = topicRows.map((topic) => ({ ...topic, asset_ids: members.all(topic.id).map((row) => row.id).filter((id) => nodes.has(id)) })).filter((topic) => topic.asset_ids.length);
    for (const node of nodes.values()) node.versions.sort((a, b) => a - b);
    return { project_id: projectId, title: project?.title || '全库', focus, nodes: [...nodes.values()], edges, topics,
      basis: allVersions ? 'all_version_references' : focus ? 'selected_version_and_current_users' : 'current_asset_references' };
  }
  history(id, args = {}) {
    if (!this.row(id)) throw new Error('Record not found');
    const offset = integer(args.offset, 0); const limit = integer(args.limit, 30, 1, 100);
    const total = this.db.prepare('SELECT count(*) AS n FROM versions WHERE id=?').get(id).n;
    const items = this.db.prepare('SELECT revision,archived,at FROM versions WHERE id=? ORDER BY revision DESC LIMIT ? OFFSET ?').all(id, limit, offset);
    return { items, total, next_offset: offset + items.length < total ? offset + items.length : null };
  }
  archive(id, expectedRevision, archived, context = {}) {
    if (id === 'MROOT' || this.db.prepare('SELECT id FROM projects WHERE map_id=?').get(id)) throw new Error('Root maps cannot be archived');
    let doc; let notices;
    this.transaction(() => {
      const row = this.row(id);
      if (!row || !['asset', 'map'].includes(row.kind)) throw new Error('Only curated assets and maps can be archived');
      if (row.revision !== expectedRevision) throw new Error('Version conflict');
      doc = JSON.parse(row.document); doc.revision += 1;
      this.update(row.kind, doc, archived ? 1 : 0, false); notices = this.createChangeNotices(id, context);
    });
    this.emit('changed', { record_id: id, project_id: context.project_id, actor: context.actor || 'controller', notices });
    return { record: doc, archived: Boolean(archived) };
  }
  addReport(input, key) {
    if (!Array.isArray(input.used_assets || []) || !Array.isArray(input.concerns || [])) throw new Error('used_assets and concerns must be arrays');
    const old = this.db.prepare('SELECT report_id FROM reports WHERE dedup_key=?').get(key);
    if (old) return this.get(old.report_id);
    let doc;
    this.transaction(() => {
      const used_assets = this.references((input.used_assets || []).map((item) => ({ relation: 'uses', note: 'Reported use; controller must assess the actual dependency.', ...item })));
      doc = { id: this.nextId('R'), revision: 1, title: input.title || `Report from ${input.agent_name || input.agent_id}`,
        body_md: string(input.body_md, 'report body'), project_id: input.project_id, run_id: input.run_id,
        agent_id: input.agent_id, phase: input.phase || 'final', generated: Boolean(input.generated),
        used_assets, concerns: input.concerns || [], instruction_count: input.instruction_count || 0,
        evidence: (input.evidence || []).map((item) => this.evidenceCard(item.evidence_id)), submitted_at: timestamp() };
      if (!['checkpoint', 'final', 'blocked', 'concern', 'incomplete'].includes(doc.phase)) throw new Error('Invalid report phase');
      for (const concern of doc.concerns) if (!this.row(concern)) throw new Error(`Concern record not found: ${concern}`);
      this.insert('report', doc, input.project_id);
      this.db.prepare('INSERT INTO reports(report_id,project_id,run_id,agent_id,phase,dedup_key) VALUES(?,?,?,?,?,?)')
        .run(doc.id, doc.project_id, doc.run_id, doc.agent_id, doc.phase, key);
    });
    this.emit('report', { report_id: doc.id, project_id: doc.project_id, run_id: doc.run_id });
    return clone(doc);
  }
  reportsForRun(projectId, runId, unseen = false) {
    return this.db.prepare(`SELECT p.report_id,p.phase,p.seen,p.disposition,json_extract(r.document,'$.title') AS title,
      json_extract(r.document,'$.generated') AS generated,COALESCE(json_extract(r.document,'$.instruction_count'),0) AS instruction_count
      FROM reports p JOIN records r ON r.id=p.report_id WHERE p.project_id=? AND p.run_id=? ${unseen ? 'AND p.seen=0' : ''} ORDER BY p.report_id`).all(projectId, runId)
      .map((row) => ({ ...row, id: row.report_id, generated: Boolean(row.generated) }));
  }
  markSeen(reportIds) {
    for (const id of reportIds) this.db.prepare('UPDATE reports SET seen=1 WHERE report_id=?').run(id);
  }
  inbox(projectId, args = {}) {
    const offset = integer(args.offset, 0); const limit = integer(args.limit, 30, 1, 100);
    const filter = args.include_resolved ? '' : "AND disposition IN ('pending','deferred')";
    const total = this.db.prepare(`SELECT count(*) AS n FROM reports WHERE project_id=? ${filter}`).get(projectId).n;
    const rows = this.db.prepare(`SELECT * FROM reports WHERE project_id=? ${filter} ORDER BY report_id LIMIT ? OFFSET ?`).all(projectId, limit, offset);
    return { reports: rows.map((row) => ({ ...row, asset_ids: JSON.parse(row.asset_ids), report: this.card(row.report_id) })),
      total, next_offset: offset + rows.length < total ? offset + rows.length : null,
      notice_total: this.db.prepare('SELECT count(*) AS n FROM notices WHERE project_id=? AND resolved=0').get(projectId).n,
      notices: this.db.prepare('SELECT * FROM notices WHERE project_id=? AND resolved=0 ORDER BY id LIMIT ? OFFSET ?').all(projectId, limit, integer(args.notice_offset, 0)).map((notice) => ({ ...notice, target: this.card(notice.target_id) })),
      next_notice_offset: integer(args.notice_offset, 0) + limit < this.db.prepare('SELECT count(*) AS n FROM notices WHERE project_id=? AND resolved=0').get(projectId).n ? integer(args.notice_offset, 0) + limit : null };
  }
  processReport(projectId, args, context = {}) {
    if (!['integrated', 'retained', 'deferred'].includes(args.disposition)) throw new Error('Use integrated, retained or deferred');
    const row = this.db.prepare('SELECT * FROM reports WHERE report_id=? AND project_id=?').get(args.report_id, projectId);
    if (!row) throw new Error('Report does not belong to this project');
    const note = string(args.note, 'processing note');
    const assets = args.asset_ids || [];
    if (!Array.isArray(assets)) throw new Error('asset_ids must be an array');
    for (const id of assets) if (this.row(id)?.kind !== 'asset') throw new Error(`Asset not found: ${id}`);
    if (args.disposition === 'integrated' && !assets.length) throw new Error('Integrated reports require asset_ids; use retained with a reason when no asset is warranted');
    if (args.disposition === 'integrated' && !assets.some((id) => this.get(id).source_reports.includes(args.report_id))) throw new Error('An integrated report must appear in source_reports of a resulting asset');
    const asset_versions = assets.map((id) => ({ asset_id: id, revision: this.row(id).revision }));
    this.transaction(() => {
      this.db.prepare('UPDATE reports SET disposition=?,note=?,asset_ids=? WHERE report_id=?').run(args.disposition, note, JSON.stringify(assets), args.report_id);
      this.db.prepare('INSERT INTO report_reviews VALUES(?,?,?)').run(args.report_id, JSON.stringify({ disposition: args.disposition, note, asset_ids: assets, asset_versions, actor: context.actor || 'controller' }), timestamp());
    });
    this.emit('changed', { project_id: projectId, actor: 'controller', notices: [] });
    return { report_id: args.report_id, disposition: args.disposition, note, asset_ids: assets, asset_versions };
  }
  reportProcessing(reportId) {
    const current = this.db.prepare('SELECT disposition,note,asset_ids FROM reports WHERE report_id=?').get(reportId);
    if (!current) throw new Error('Report not found');
    const review = this.db.prepare('SELECT document,at FROM report_reviews WHERE report_id=? ORDER BY rowid DESC LIMIT 1').get(reportId);
    return review ? { ...JSON.parse(review.document), at: review.at } : { ...current, asset_ids: JSON.parse(current.asset_ids) };
  }
  resolveNotices(projectId, ids, note) {
    if (!Array.isArray(ids)) throw new Error('notice_ids must be an array');
    string(note, 'review note');
    this.transaction(() => {
      for (const id of ids) {
        if (!this.db.prepare('SELECT id FROM notices WHERE id=? AND project_id=?').get(id, projectId)) throw new Error('Notice does not belong to this project');
        this.db.prepare('UPDATE notices SET resolved=1,message=message || ? WHERE id=?').run(`\nController review: ${note}`, id);
      }
    });
    this.emit('changed', { project_id: projectId, actor: 'controller', notices: [] });
    return { reviewed_notice_ids: ids };
  }
  readProject(projectId, revision) {
    const row = this.db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
    if (!row) throw new Error('Project is not registered');
    if (revision !== undefined && Number(revision) !== row.revision) {
      const old = this.db.prepare('SELECT document FROM project_versions WHERE project_id=? AND revision=?').get(projectId, integer(revision, undefined, 1));
      if (!old) throw new Error('Project assessment revision not found');
      return { ...JSON.parse(old.document), current_revision: row.revision, pending: this.inbox(projectId).total };
    }
    return { id: row.id, revision: row.revision, title: row.title, map_id: row.map_id, body_md: row.body_md,
      outcomes: JSON.parse(row.outcomes).map((id) => this.card(id)), pending: this.inbox(projectId, { limit: 5 }).total };
  }
  saveProject(projectId, args, context = {}) {
    const notices = [];
    const result = this.transaction(() => {
      const previousRevision = this.db.prepare('SELECT revision FROM projects WHERE id=?').get(projectId)?.revision;
      const saved = this.saveProjectInTransaction(projectId, args);
      if (context.actor === 'user' && saved.revision !== previousRevision) {
        const notice = { id: this.nextId('N'), project_id: projectId, target_id: saved.map_id, message: 'Project assessment changed. Reread read_project_research before planning.', at: timestamp() };
        this.db.prepare('INSERT INTO notices VALUES(?,?,?,?,0,?)').run(notice.id, projectId, saved.map_id, notice.message, notice.at); notices.push(notice);
      }
      return saved;
    });
    if (!result.unchanged) this.emit('changed', { project_id: projectId, actor: context.actor || 'controller', notices });
    return result;
  }
  projectHistory(projectId, args = {}) {
    const offset = integer(args.offset, 0), limit = integer(args.limit, 30, 1, 100);
    const total = this.db.prepare('SELECT count(*) AS n FROM project_versions WHERE project_id=?').get(projectId).n;
    const items = this.db.prepare('SELECT revision,at FROM project_versions WHERE project_id=? ORDER BY revision DESC LIMIT ? OFFSET ?').all(projectId, limit, offset);
    return { items, total, next_offset: offset + items.length < total ? offset + items.length : null };
  }
  saveProjectInTransaction(projectId, args) {
    const row = this.db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
    if (!row || row.revision !== args.expected_revision) throw new Error('Project assessment version conflict');
    const outcomes = args.outcomes === undefined ? JSON.parse(row.outcomes) : args.outcomes;
    if (!Array.isArray(outcomes)) throw new Error('outcomes must be asset ids');
    for (const id of outcomes) if (this.row(id)?.kind !== 'asset') throw new Error(`Outcome asset not found: ${id}`);
    const body = args.body_md === undefined ? row.body_md : string(args.body_md, 'body_md', true);
    const outcomeIds = [...new Set(outcomes)];
    if (body === row.body_md && JSON.stringify(outcomeIds) === row.outcomes) return { ...this.readProject(projectId), unchanged: true };
    this.db.prepare('INSERT OR IGNORE INTO project_versions VALUES(?,?,?,?)').run(projectId, row.revision, JSON.stringify(this.readProject(projectId)), timestamp());
    this.db.prepare('UPDATE projects SET revision=revision+1,body_md=?,outcomes=? WHERE id=?')
      .run(body, JSON.stringify(outcomeIds), projectId);
    this.db.prepare('INSERT INTO project_versions VALUES(?,?,?,?)').run(projectId, row.revision + 1, JSON.stringify(this.readProject(projectId)), timestamp());
    return this.readProject(projectId);
  }
  evidenceCard(id) {
    const row = this.db.prepare('SELECT * FROM evidence WHERE id=?').get(id);
    if (!row) throw new Error(`Evidence not found: ${id}`);
    return { evidence_id: row.id, name: row.name, sha256: row.hash, size: row.size };
  }
  snapshotEvidence(projectId, workspace, files = []) {
    if (!Array.isArray(files) || files.length > 30) throw new Error('Provide up to 30 evidence files');
    if (!files.length) return [];
    if (this.filename === ':memory:') throw new Error('File evidence requires a persisted library');
    const root = fs.realpathSync.native(workspace), folder = path.join(path.dirname(this.filename), 'evidence');
    fs.mkdirSync(folder, { recursive: true });
    return files.map((file) => {
      const requested = string(file.path, 'evidence path');
      const original = requested.startsWith('/workspace/') ? path.join(root, requested.slice(11)) : path.resolve(root, requested);
      const relative = path.relative(root, original).replace(/\\/g, '/');
      const bytes = projectFiles.readFile(root, relative), hash = crypto.createHash('sha256').update(bytes).digest('hex');
      const target = path.join(folder, hash);
      try { fs.writeFileSync(target, bytes, { flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const prior = this.db.prepare('SELECT id FROM evidence WHERE hash=? AND project_id=? AND name=?').get(hash, projectId, relative);
      const evidenceId = prior?.id || this.transaction(() => { const id = this.nextId('E'); this.db.prepare('INSERT INTO evidence VALUES(?,?,?,?,?,?)').run(id, hash, target, relative, bytes.length, projectId); return id; });
      return this.evidenceCard(evidenceId);
    });
  }
  readEvidence(args) {
    const row = this.db.prepare('SELECT * FROM evidence WHERE id=?').get(args.evidence_id); if (!row) throw new Error('Evidence not found');
    const bytes = fs.readFileSync(row.path);
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== row.hash) throw new Error('Saved evidence failed its integrity check');
    let body;
    try { body = new TextDecoder('utf-8', { fatal: true }).decode(bytes); if (body.includes('\0')) body = undefined; } catch {}
    const card = this.evidenceCard(row.id);
    if (body === undefined) return { ...card, text_available: false, note: 'Immutable binary evidence; use the original project file with file/image tools.' };
    const offset = integer(args.offset, 0), limit = integer(args.max_chars, 16000, 1, 80000), content = body.slice(offset, offset + limit);
    return { ...card, text_available: true, content, total_chars: body.length, next_offset: offset + content.length < body.length ? offset + content.length : null };
  }
  materializeEvidence(id, workspace) {
    const row = this.db.prepare('SELECT * FROM evidence WHERE id=?').get(id);
    if (!row) throw new Error('Evidence not found');
    const bytes = fs.readFileSync(row.path);
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== row.hash) throw new Error('Saved evidence failed its integrity check');
    return projectFiles.writeSnapshot(workspace, bytes, row.name);
  }
  exportRecord(id, revision) { return { filename: `${id}-v${revision || this.row(id)?.revision}.json`, content: JSON.stringify(this.get(id, revision), null, 2) }; }
}

module.exports = { ResearchLibrary, ASSET_FIELDS, tokenize };
