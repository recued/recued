import type Database from 'better-sqlite3';

/** Only identifiers, order and lifecycle flags are indexed. Terms and balances
 * are always read and checked from the original job before returning a card. */
export const customerJobRootSql = (alias = '') => {
  const p = alias ? alias+'.' : '';
  return `(CASE WHEN json_valid(${p}plan_json) AND json_type(${p}plan_json,'$.addition.root_signoff_id')='text'
    THEN json_extract(${p}plan_json,'$.addition.root_signoff_id') ELSE ${p}signoff_id END)`;
};
export const customerJobOriginalSql = (alias = '') => {
  const p = alias ? alias+'.' : '';
  return `(CASE WHEN json_valid(${p}plan_json) THEN json_type(${p}plan_json,'$.addition') IS NULL
    OR json_type(${p}plan_json,'$.addition')='null' ELSE 0 END)`;
};
export const customerJobParentSql = () => `(CASE WHEN json_valid(plan_json)
  THEN json_extract(plan_json,'$.addition.parent_signoff_id') END)`;
const eligible = (p = '') => `(${p}has_original=0 OR ${p}state='released' OR ${p}is_latest=1 OR ${p}has_archive=1)`;
const columns = ['job_id','quote_id','created_at','sort_at','state','has_original','is_latest','has_archive','archived'];
const triggers = ['customer_job_read_insert','customer_job_read_update','customer_job_read_delete'];
const archiveTriggers = ['customer_job_read_archive_insert','customer_job_read_archive_update','customer_job_read_archive_delete'];

/** One transactional backfill; SQL triggers keep the index current for every
 * connection, including deletes, updates and late archive-store creation. */
export const ensureCustomerJobReadIndex = (db: Database.Database): void => {
  const exists = (name: string,type = 'table') => Boolean(db.prepare('SELECT 1 FROM sqlite_master WHERE type=? AND name=?').get(type,name));
  if (!exists('quote_signoffs')) return;
  db.transaction(() => {
    const hadRoots = exists('customer_job_read_roots');const archives = exists('customer_job_archives');
    const missingTriggers = triggers.some(name => !exists(name,'trigger'));
    const missingArchiveTriggers = archives && archiveTriggers.some(name => !exists(name,'trigger'));
    db.exec(`CREATE TABLE IF NOT EXISTS customer_job_read_roots (
      job_id TEXT PRIMARY KEY,quote_id TEXT NOT NULL,created_at INTEGER NOT NULL,sort_at INTEGER NOT NULL,
      state TEXT NOT NULL,has_original INTEGER NOT NULL,is_latest INTEGER NOT NULL,has_archive INTEGER NOT NULL,archived INTEGER NOT NULL
    ); CREATE TABLE IF NOT EXISTS customer_job_read_index_version (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL,archive_wired INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS quote_signoffs_job_root ON quote_signoffs(${customerJobRootSql()});
    CREATE INDEX IF NOT EXISTS quote_signoffs_job_parent ON quote_signoffs(${customerJobParentSql()},state,quote_id);
    CREATE INDEX IF NOT EXISTS quote_signoffs_original_quote ON quote_signoffs(quote_id) WHERE ${customerJobOriginalSql()}=1;
    CREATE INDEX IF NOT EXISTS customer_job_read_quote ON customer_job_read_roots(quote_id,is_latest);
    CREATE INDEX IF NOT EXISTS customer_job_read_page ON customer_job_read_roots(sort_at,job_id) WHERE ${eligible()};
    CREATE INDEX IF NOT EXISTS customer_job_read_archived_page ON customer_job_read_roots(sort_at,job_id) WHERE ${eligible()} AND archived=1;`);
    const version = db.prepare('SELECT version,archive_wired FROM customer_job_read_index_version WHERE singleton=1').get() as { version: number;archive_wired: number } | undefined;
    if (version && version.version !== 1) throw new Error('This server cannot read the saved customer job index. Update Recued.');
    const refreshRoot = (key: string,from = '') => {
      const original = `(SELECT ${customerJobOriginalSql('r')} FROM quote_signoffs r WHERE r.signoff_id=${key})`;
      const quote = `COALESCE((SELECT quote_id FROM quote_signoffs WHERE signoff_id=${key}),
        (SELECT q.quote_id FROM quote_signoffs q WHERE ${customerJobRootSql('q')}=${key} ORDER BY rowid LIMIT 1))`;
      const created = `COALESCE((SELECT created_at FROM quote_signoffs WHERE signoff_id=${key}),
        (SELECT q.created_at FROM quote_signoffs q WHERE ${customerJobRootSql('q')}=${key} ORDER BY rowid LIMIT 1))`;
      const hasArchive = archives ? `EXISTS(SELECT 1 FROM customer_job_archives a WHERE a.job_id=${key})` : '0';
      const archived = archives ? `EXISTS(SELECT 1 FROM customer_job_archives a WHERE a.job_id=${key} AND a.archived_at IS NOT NULL)` : '0';
      return `INSERT INTO customer_job_read_roots (${columns.join(',')}) SELECT ${key},${quote},${created},-(${created}),
        COALESCE((SELECT state FROM quote_signoffs WHERE signoff_id=${key}),'unavailable'),COALESCE(${original},0),
        COALESCE((${key}=(SELECT signoff_id FROM quote_signoffs WHERE quote_id=${quote} AND ${customerJobOriginalSql()}=1 ORDER BY rowid DESC LIMIT 1)),0),${hasArchive},${archived}
        ${from} WHERE EXISTS(SELECT 1 FROM quote_signoffs q WHERE ${customerJobRootSql('q')}=${key})
        ON CONFLICT(job_id) DO UPDATE SET ${columns.slice(1).map(c => `${c}=excluded.${c}`).join(',')};`;
    };
    const removeEmpty = (key: string) => `DELETE FROM customer_job_read_roots WHERE job_id=${key}
      AND NOT EXISTS(SELECT 1 FROM quote_signoffs q WHERE ${customerJobRootSql('q')}=${key});`;
    const refreshQuote = (key: string) => `UPDATE customer_job_read_roots SET is_latest=0 WHERE quote_id=${key} AND is_latest=1;
      UPDATE customer_job_read_roots SET is_latest=1 WHERE job_id=(SELECT signoff_id FROM quote_signoffs
        WHERE quote_id=${key} AND ${customerJobOriginalSql()}=1 ORDER BY rowid DESC LIMIT 1);`;
    const rebuild = !hadRoots || !version || missingTriggers;
    if (rebuild || version?.archive_wired !== Number(archives)) {
      for (const name of triggers) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
      db.exec(`CREATE TRIGGER customer_job_read_insert AFTER INSERT ON quote_signoffs BEGIN
        ${refreshRoot(customerJobRootSql('NEW'))}${refreshQuote('NEW.quote_id')} END;
      CREATE TRIGGER customer_job_read_update AFTER UPDATE ON quote_signoffs BEGIN
        ${refreshRoot(customerJobRootSql('OLD'))}${removeEmpty(customerJobRootSql('OLD'))}
        ${refreshRoot(customerJobRootSql('NEW'))}${refreshQuote('OLD.quote_id')}${refreshQuote('NEW.quote_id')} END;
      CREATE TRIGGER customer_job_read_delete AFTER DELETE ON quote_signoffs BEGIN
        ${refreshRoot(customerJobRootSql('OLD'))}${removeEmpty(customerJobRootSql('OLD'))}${refreshQuote('OLD.quote_id')} END;`);
    }
    if (archives && (rebuild || missingArchiveTriggers)) {
      for (const name of archiveTriggers) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
      db.exec(`CREATE TRIGGER customer_job_read_archive_insert AFTER INSERT ON customer_job_archives BEGIN ${refreshRoot('NEW.job_id')} END;
        CREATE TRIGGER customer_job_read_archive_update AFTER UPDATE ON customer_job_archives BEGIN ${refreshRoot('OLD.job_id')}${refreshRoot('NEW.job_id')} END;
        CREATE TRIGGER customer_job_read_archive_delete AFTER DELETE ON customer_job_archives BEGIN ${refreshRoot('OLD.job_id')} END;`);
    }
    if (rebuild) {
      db.exec(`DELETE FROM customer_job_read_roots;
        ${refreshRoot('roots.job_id',`FROM (SELECT DISTINCT ${customerJobRootSql()} AS job_id FROM quote_signoffs) roots`)}`);
    } else if (version?.archive_wired !== Number(archives) || missingArchiveTriggers) {
      db.exec(`UPDATE customer_job_read_roots SET has_archive=${archives ? 'EXISTS(SELECT 1 FROM customer_job_archives a WHERE a.job_id=customer_job_read_roots.job_id)' : '0'},
        archived=${archives ? 'EXISTS(SELECT 1 FROM customer_job_archives a WHERE a.job_id=customer_job_read_roots.job_id AND a.archived_at IS NOT NULL)' : '0'};`);
    }
    if (!version || version.archive_wired !== Number(archives)) {
      db.prepare('INSERT OR REPLACE INTO customer_job_read_index_version VALUES (1,1,?)').run(Number(archives));
    }
  }).immediate();
};

export interface CustomerJobCandidate { job_id: string;created_at: number }
export const readCustomerJobCandidates = (db: Database.Database,input: {
  limit: number;after?: CustomerJobCandidate;search: string;archive: 'active' | 'archived' | 'all';
}) => {
  const where = [eligible('r.')];const values: Array<string | number> = [];
  if (input.archive === 'archived') where.push('r.archived=1');
  if (input.after) { where.push('(r.sort_at,r.job_id)>(?,?)');values.push(-input.after.created_at,input.after.job_id); }
  // A multiline term can span fields in the public card's joined haystack.
  // Keep those terms in the bounded semantic filter instead of narrowing them.
  if (input.search && !input.search.includes('\n')) {
    const fields = [`CASE WHEN json_valid(q.quote_json) THEN json_extract(q.quote_json,'$.customer') END`,
      `CASE WHEN json_valid(q.quote_json) THEN json_extract(q.quote_json,'$.label') END`,
      `CASE WHEN json_valid(q.quote_json) THEN json_extract(q.quote_json,'$.reference') END`,
      `CASE WHEN json_valid(q.plan_json) THEN json_extract(q.plan_json,'$.invoice_ref') END`];
    // ⛔ `+r.job_id`, NOT `r.job_id`. job_id is a TEXT column, so a bare comparison gives it
    // TEXT affinity, and SQLite cannot then look the expression index quote_signoffs_job_root
    // up (it has none): it scanned every sign-off for every root, 2,101 jobs x 10,505
    // requests in ~55 s (2026-10-23). The unary plus drops the affinity; the root
    // expression is always text, so the same rows match.
    where.push(`EXISTS(SELECT 1 FROM quote_signoffs q WHERE ${customerJobRootSql('q')}=+r.job_id
      AND (${fields.map(f => `instr(customer_job_search_text(${f}),?)>0`).join(' OR ')}))`);
    values.push(...fields.map(() => input.search));
  }
  const rows = db.prepare(`SELECT r.job_id,r.created_at FROM customer_job_read_roots r
    INDEXED BY ${input.archive === 'archived' ? 'customer_job_read_archived_page' : 'customer_job_read_page'}
    WHERE ${where.join(' AND ')} ORDER BY r.sort_at,r.job_id LIMIT ?`).all(...values,input.limit+1) as CustomerJobCandidate[];
  return { candidates: rows.slice(0,input.limit),has_more: rows.length > input.limit };
};
