import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Approval, ErpSubmission, Issue, RequestRow, State } from '../../schema/contracts.js';

const now = (): string => new Date().toISOString();
export class Repository {
  readonly db: Database.Database;
  constructor(path = resolve('data/prototype.sqlite3')) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(readFileSync(new URL('../../schema/schema.sql', import.meta.url), 'utf8'));
  }
  close(): void { this.db.close(); }
  transaction<T>(fn: () => T): T { return this.db.transaction(fn)(); }
  list(): RequestRow[] { return this.db.prepare('SELECT * FROM requests ORDER BY updated_at DESC').all() as RequestRow[]; }
  get(id: string): RequestRow | undefined { return this.db.prepare('SELECT * FROM requests WHERE id=?').get(id) as RequestRow | undefined; }
  findEmailByHash(hash: string): string | undefined { return (this.db.prepare("SELECT request_id FROM source_documents WHERE kind='email' AND sha256=? LIMIT 1").get(hash) as { request_id: string } | undefined)?.request_id; }
  findEmailByIdentity(sender: string, messageId: string): { request_id: string; content_sha256: string } | undefined {
    return this.db.prepare('SELECT request_id,content_sha256 FROM email_identities WHERE sender=? AND message_id=?').get(sender, messageId) as { request_id: string; content_sha256: string } | undefined;
  }
  recordEmailIdentity(sender: string, messageId: string, contentHash: string, requestId: string, ignoreExisting = false): void {
    this.db.prepare(`INSERT ${ignoreExisting ? 'OR IGNORE ' : ''}INTO email_identities(sender,message_id,content_sha256,request_id) VALUES(?,?,?,?)`)
      .run(sender, messageId, contentHash, requestId);
  }
  storedEmails(): { request_id: string; file_name: string }[] {
    return this.db.prepare("SELECT request_id,file_name FROM source_documents WHERE kind='email' ORDER BY id DESC").all() as { request_id: string; file_name: string }[];
  }
  create(input: { id: string; requester_email: string; subject: string; received_at: string; draft_json: string; state: State }): void {
    const stamp = now();
    this.db.prepare('INSERT INTO requests(id, requester_email, subject, received_at, draft_json, state, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(input.id, input.requester_email, input.subject, input.received_at, input.draft_json, input.state, stamp, stamp);
  }
  update(id: string, revision: number, state: State, draftJson: string, validatedJson: string | null, hash: string | null, totalChfMinor: number | null): void {
    this.db.prepare('UPDATE requests SET revision=?, state=?, draft_json=?, validated_json=?, draft_sha256=?, total_chf_minor=?, updated_at=? WHERE id=?')
      .run(revision, state, draftJson, validatedJson, hash, totalChfMinor, now(), id);
    this.db.prepare('DELETE FROM line_items WHERE request_id=?').run(id);
    if (validatedJson) {
      const lines = (JSON.parse(validatedJson) as { line_items: { item_name: string; quantity: string; unit: string; unit_price: string; item_code?: string }[] }).line_items;
      const insert = this.db.prepare('INSERT INTO line_items(request_id,position,item_name,quantity,unit,unit_price,item_code) VALUES(?,?,?,?,?,?,?)');
      for (const [index, line] of lines.entries()) insert.run(id, index + 1, line.item_name, line.quantity, line.unit, line.unit_price, line.item_code ?? null);
    }
  }
  state(id: string, state: State): void { this.db.prepare('UPDATE requests SET state=?, updated_at=? WHERE id=?').run(state, now(), id); }
  document(requestId: string, kind: string, fileName: string, hash: string, excerpt: string): void {
    this.db.prepare('INSERT OR IGNORE INTO source_documents(request_id, kind, file_name, sha256, text_excerpt, created_at) VALUES(?,?,?,?,?,?)')
      .run(requestId, kind, fileName, hash, excerpt.slice(0, 500), now());
  }
  extraction(requestId: string, revision: number, input: { model: string; status: string; error?: string; prompt_tokens?: number; output_tokens?: number; latency_ms?: number; draft_json?: string }): void {
    this.db.prepare('INSERT INTO extraction_runs(request_id,revision,model,status,error,prompt_tokens,output_tokens,latency_ms,draft_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(requestId, revision, input.model, input.status, input.error ?? null, input.prompt_tokens ?? null, input.output_tokens ?? null, input.latency_ms ?? null, input.draft_json ?? null, now());
  }
  latestExtraction(requestId: string): unknown { return this.db.prepare('SELECT * FROM extraction_runs WHERE request_id=? ORDER BY id DESC LIMIT 1').get(requestId); }
  setIssues(id: string, revision: number, issues: Issue[]): void {
    this.db.prepare('DELETE FROM issues WHERE request_id=?').run(id);
    const insert = this.db.prepare('INSERT INTO issues(request_id,revision,field,code,detail,kind,created_at) VALUES(?,?,?,?,?,?,?)');
    for (const issue of issues) insert.run(id, revision, issue.field, issue.code, issue.detail, issue.kind, now());
  }
  issues(id: string): (Issue & { id: number })[] { return this.db.prepare('SELECT id,field,code,detail,kind FROM issues WHERE request_id=? ORDER BY id').all(id) as (Issue & { id: number })[]; }
  clearDecisions(id: string): void {
    this.db.prepare('DELETE FROM approval_steps WHERE request_id=?').run(id);
    this.db.prepare('DELETE FROM requester_confirmations WHERE request_id=?').run(id);
  }
  confirmation(id: string, revision: number, hash: string, decision: string, note: string): void {
    this.db.prepare('INSERT INTO requester_confirmations(request_id,revision,draft_sha256,decision,note,created_at) VALUES(?,?,?,?,?,?)').run(id, revision, hash, decision, note, now());
  }
  getConfirmation(id: string, revision: number): { decision: string; draft_sha256: string } | undefined {
    return this.db.prepare('SELECT decision,draft_sha256 FROM requester_confirmations WHERE request_id=? AND revision=?').get(id, revision) as { decision: string; draft_sha256: string } | undefined;
  }
  createApprovals(id: string, revision: number, steps: { role: string; employee_id: string }[]): void {
    const insert = this.db.prepare('INSERT INTO approval_steps(request_id,revision,position,role,approver_employee_id) VALUES(?,?,?,?,?)');
    for (const [index, step] of steps.entries()) insert.run(id, revision, index + 1, step.role, step.employee_id);
  }
  approvals(id: string, revision: number): Approval[] { return this.db.prepare('SELECT * FROM approval_steps WHERE request_id=? AND revision=? ORDER BY position').all(id, revision) as Approval[]; }
  decideApproval(id: number, decision: string, note: string): void {
    this.db.prepare('UPDATE approval_steps SET decision=?, note=?, decided_at=? WHERE id=? AND decision=?').run(decision, note, now(), id, 'pending');
  }
  audit(id: string, revision: number, type: string, details: unknown = {}): void {
    this.db.prepare('INSERT INTO audit_events(request_id,revision,event_type,details_json,occurred_at) VALUES(?,?,?,?,?)').run(id, revision, type, JSON.stringify(details), now());
  }
  auditTrail(id: string): unknown[] { return this.db.prepare('SELECT * FROM audit_events WHERE request_id=? ORDER BY id').all(id); }
  outbox(id: string, revision: number, recipient: string, subject: string, body: string): void {
    this.db.prepare('INSERT INTO outbox_messages(request_id,revision,recipient,subject,body,created_at) VALUES(?,?,?,?,?,?)')
      .run(id, revision, recipient, subject, body, now());
  }
  outboxList(): unknown[] { return this.db.prepare('SELECT * FROM outbox_messages ORDER BY id DESC').all(); }
  submission(id: string, revision: number): ErpSubmission | undefined { return this.db.prepare('SELECT * FROM erp_submissions WHERE request_id=? AND revision=?').get(id, revision) as ErpSubmission | undefined; }
  createSubmission(id: string, revision: number, payload: string, payloadHash: string, key: string): void {
    const stamp = now();
    this.db.prepare('INSERT INTO erp_submissions(request_id,revision,payload_json,payload_sha256,idempotency_key,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, revision, payload, payloadHash, key, 'submitting', stamp, stamp);
  }
  finishSubmission(id: string, revision: number, status: string, poNumber: string | null, response: unknown): void {
    this.db.prepare('UPDATE erp_submissions SET status=?, po_number=?, response_json=?, updated_at=? WHERE request_id=? AND revision=?')
      .run(status, poNumber, JSON.stringify(response), now(), id, revision);
  }
}
