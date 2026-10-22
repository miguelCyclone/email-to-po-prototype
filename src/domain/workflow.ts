import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { Draft, Issue, RequestRow, Validated } from '../../schema/contracts.js';
import { Repository } from '../db/repository.js';
import { parseMail } from '../intake/mail.js';
import { PdfLimitError, readPdf } from '../intake/pdfText.js';
import { extract, parseDraft } from '../extraction/ollama.js';
import { reconcileQuote } from '../extraction/quoteFacts.js';
import { hash, issueState, approvalChain, validateDraft, master } from './policy.js';
import { clarification, confirmationSummary } from '../integrations/outbox.js';
import { postPurchaseOrder } from '../integrations/erp.js';
import { publish } from '../live/events.js';

export class FlowError extends Error { constructor(message: string, readonly status = 409) { super(message); } }
const sha = (content: Buffer): string => createHash('sha256').update(content).digest('hex');
const quoteFolder = resolve('docs/quotes-20261022T095543Z-1-001/quotes');
const emptyDraft = (): Draft => ({ supplier_name: null, cost_centre: null, gl_account: null, requested_delivery_date: null, quote_valid_until: null, currency: null, line_items: [], tax_amount: null, freight_amount: null, discount_amount: null, stated_total: null, evidence: [], conflicts: [] });

export class Workflow {
  constructor(readonly repo: Repository, readonly clock: () => Date = () => new Date()) {}

  detail(id: string): Record<string, unknown> {
    const row = this.repo.get(id);
    if (!row) throw new FlowError('Request not found', 404);
    return { ...row, draft: JSON.parse(row.draft_json), validated: row.validated_json ? JSON.parse(row.validated_json) : null,
      issues: this.repo.issues(id), approvals: this.repo.approvals(id, row.revision), confirmation: this.repo.getConfirmation(id, row.revision),
      submission: this.repo.submission(id, row.revision), extraction: this.repo.latestExtraction(id), audit: this.repo.auditTrail(id) };
  }

  async importEmail(raw: Buffer, externalPdf?: { name: string; content: Buffer }): Promise<Record<string, unknown>> {
    if (!raw.length || raw.length > 4_000_000) throw new FlowError('Email must be 1 byte to 4 MB', 413);
    const mail = await parseMail(raw);
    const sourceHash = sha(raw);
    const previous = this.repo.findEmailByHash(sourceHash);
    if (previous) return this.detail(previous);
    const replyId = `${mail.subject}\n${mail.body}`.match(/REQ-[A-F0-9]{8}/i)?.[0].toUpperCase();
    if (replyId && this.repo.get(replyId)) return this.importReply(replyId, mail.sender, mail.subject, mail.body, raw, sourceHash);
    const id = `REQ-${randomUUID().slice(0, 8).toUpperCase()}`;
    const folder = resolve('data/uploads', id);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'source.eml'), raw);
    this.repo.transaction(() => {
      this.repo.create({ id, requester_email: mail.sender, subject: mail.subject, received_at: mail.receivedAt, draft_json: JSON.stringify(emptyDraft()), state: 'review' });
      this.repo.document(id, 'email', 'source.eml', sourceHash, mail.body);
      this.repo.audit(id, 1, 'imported', { source_hash: sourceHash });
    });

    const quotes = [...mail.attachments];
    if (externalPdf) quotes.push(externalPdf);
    const missingRefs: string[] = [];
    for (const name of mail.referenceNames) {
      if (quotes.some(q => q.name === name)) continue;
      if (basename(name) !== name) { missingRefs.push(name); continue; }
      try { quotes.push({ name, content: await readFile(join(quoteFolder, name)) }); }
      catch { missingRefs.push(name); }
    }
    if (missingRefs.length) return this.hold(id, 1, [{ field: 'quote', code: 'missing_attachment', detail: `Provide referenced quote: ${missingRefs.join(', ')}.`, kind: 'requester' }]);
    if (raw.length + quotes.reduce((sum, q) => sum + q.content.length, 0) > 4_000_000) return this.hold(id, 1, [{ field: 'documents', code: 'too_large', detail: 'Total upload exceeds 4 MB. Provide a smaller email or relevant quote pages.', kind: 'requester' }]);

    let quoteText = '';
    for (const [index, quote] of quotes.entries()) {
      const safeName = basename(quote.name).replace(/[^a-zA-Z0-9._-]/g, '_');
      try {
        const pdf = await readPdf(quote.content);
        quoteText += `\n--- ${safeName} ---\n${pdf.text}`;
        await writeFile(join(folder, `${index}-${safeName}`), quote.content);
        this.repo.document(id, 'pdf', safeName, sha(quote.content), pdf.text);
      } catch (error) {
        const isLimit = error instanceof PdfLimitError;
        return this.hold(id, 1, [{ field: 'quote', code: isLimit ? 'pdf_limit' : 'pdf_unreadable', detail: error instanceof Error ? error.message : 'PDF could not be read', kind: isLimit ? 'requester' : 'procurement' }]);
      }
    }
    if (mail.body.length + quoteText.length > 12_000) return this.hold(id, 1, [{ field: 'documents', code: 'text_limit', detail: 'Email and quote text exceeds 12,000 characters. Provide relevant pages or fields.', kind: 'requester' }]);

    try {
      const result = await extract(mail.subject, mail.sender, mail.body, quoteText);
      const reconciled = reconcileQuote(result.draft, quoteText, master.suppliers.map(supplier => supplier.name));
      this.repo.extraction(id, 1, { model: result.model, status: 'ok', prompt_tokens: result.promptTokens ?? undefined, output_tokens: result.outputTokens ?? undefined, latency_ms: result.latencyMs, draft_json: JSON.stringify(reconciled) });
      return this.applyDraft(id, 1, reconciled, 'extracted');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown extraction error';
      this.repo.extraction(id, 1, { model: process.env.OLLAMA_MODEL ?? 'qwen3:1.7b', status: 'error', error: message });
      return this.hold(id, 1, [{ field: 'extraction', code: 'model_failure', detail: `Extraction failed: ${message}. Procurement can correct the draft manually.`, kind: 'procurement' }]);
    }
  }

  private async importReply(id: string, sender: string, subject: string, body: string, raw: Buffer, sourceHash: string): Promise<Record<string, unknown>> {
    const row = this.repo.get(id)!;
    if (sender !== row.requester_email) throw new FlowError('Reply sender does not match the original requester; procurement review is required.', 403);
    if (['submitting', 'submit_error', 'po_created'].includes(row.state)) throw new FlowError('This request already has a frozen ERP submission. Start a new request.');
    const revision = row.revision + 1;
    const folder = resolve('data/uploads', id);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, `reply-${revision}.eml`), raw);
    this.repo.transaction(() => {
      const current = this.repo.get(id)!;
      if (current.revision !== row.revision || ['submitting', 'submit_error', 'po_created'].includes(current.state)) throw new FlowError('Request changed while the reply was being imported. Reload before retrying.');
      this.repo.document(id, 'email', `reply-${revision}.eml`, sourceHash, body);
      this.repo.clearDecisions(id);
      this.repo.update(id, revision, 'review', row.draft_json, null, null, null);
      this.repo.audit(id, revision, 'reply_imported', { subject, source_hash: sourceHash });
    });
    try {
      const prior = parseDraft(JSON.parse(row.draft_json));
      const result = await extract(subject, sender, `Previous request draft (retain facts unless corrected):\n${JSON.stringify(prior)}\n\nRequester reply:\n${body}`, '');
      const next = result.draft;
      const merged: Draft = { ...prior, ...Object.fromEntries(Object.entries(next).filter(([key, value]) => !['line_items', 'evidence', 'conflicts'].includes(key) && value !== null)),
        line_items: next.line_items.length ? next.line_items.map((line, index) => ({ ...prior.line_items[index], ...Object.fromEntries(Object.entries(line).filter(([, value]) => value !== null)) })) : prior.line_items,
        evidence: [...prior.evidence, ...next.evidence], conflicts: next.conflicts };
      this.repo.extraction(id, revision, { model: result.model, status: 'ok', prompt_tokens: result.promptTokens ?? undefined, output_tokens: result.outputTokens ?? undefined, latency_ms: result.latencyMs, draft_json: JSON.stringify(merged) });
      return this.applyDraft(id, revision, merged, 'reply_validated');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.repo.extraction(id, revision, { model: process.env.OLLAMA_MODEL ?? 'qwen3:1.7b', status: 'error', error: message });
      return this.hold(id, revision, [{ field: 'reply', code: 'model_failure', detail: `Reply extraction failed: ${message}. Procurement can correct the draft manually.`, kind: 'procurement' }]);
    }
  }

  private hold(id: string, revision: number, issues: Issue[]): Record<string, unknown> {
    const state = issueState(issues);
    const row = this.repo.get(id)!;
    this.repo.transaction(() => {
      this.repo.update(id, revision, state, row.draft_json, null, null, null);
      this.repo.setIssues(id, revision, issues);
      if (state === 'needs_info') this.repo.outbox(id, revision, row.requester_email, `More information needed for ${id}`, clarification(id, issues));
      this.repo.audit(id, revision, 'held', { issues });
    });
    publish(id, revision);
    return this.detail(id);
  }

  private applyDraft(id: string, revision: number, draft: Draft, source: string): Record<string, unknown> {
    const row = this.repo.get(id)!;
    const checked = validateDraft(draft, this.clock());
    const issues = [...checked.issues];
    if (!master.employees.some(employee => employee.email.toLowerCase() === row.requester_email.toLowerCase())) issues.push({ field: 'requester', code: 'unknown_requester', detail: 'Requester email is not in master data; procurement must verify it.', kind: 'procurement' });
    const value = issues.length ? null : checked.value;
    const state = value ? 'awaiting_confirmation' : issueState(issues);
    const digest = value ? hash(value) : null;
    this.repo.transaction(() => {
      this.repo.update(id, revision, state, JSON.stringify(draft), value ? JSON.stringify(value) : null, digest, value?.total_chf_minor ?? null);
      this.repo.setIssues(id, revision, issues);
      if (state === 'needs_info') this.repo.outbox(id, revision, row.requester_email, `More information needed for ${id}`, clarification(id, issues));
      if (value) this.repo.outbox(id, revision, row.requester_email, `Confirm purchase request ${id} revision ${revision}`, confirmationSummary(id, revision, value));
      this.repo.audit(id, revision, source, { state, issue_count: issues.length, draft_hash: digest });
    });
    publish(id, revision);
    return this.detail(id);
  }

  correct(id: string, input: unknown): Record<string, unknown> {
    const row = this.repo.get(id);
    if (!row) throw new FlowError('Request not found', 404);
    if (['submitting', 'submit_error', 'po_created'].includes(row.state)) throw new FlowError('This request already has a frozen ERP submission. Start a new request.');
    const draft = parseDraft(input);
    const revision = row.revision + 1;
    this.repo.transaction(() => {
      this.repo.clearDecisions(id);
      this.repo.audit(id, revision, 'corrected', { previous_revision: row.revision });
    });
    return this.applyDraft(id, revision, draft, 'validated');
  }

  confirm(id: string, revision: number, digest: string, decision: 'confirmed' | 'disputed', note = ''): Record<string, unknown> {
    const row = this.repo.get(id);
    if (!row) throw new FlowError('Request not found', 404);
    if (row.state !== 'awaiting_confirmation' || row.revision !== revision || row.draft_sha256 !== digest || !row.validated_json) throw new FlowError('Confirmation must match the current validated revision and hash.');
    const value = JSON.parse(row.validated_json) as Validated;
    const chain = decision === 'confirmed' ? approvalChain(value, row.requester_email) : { steps: [], conflict: null };
    const state = decision === 'disputed' || chain.conflict ? 'review' : 'awaiting_approval';
    this.repo.transaction(() => {
      this.repo.confirmation(id, revision, digest, decision, note);
      if (chain.conflict) this.repo.setIssues(id, revision, [{ field: 'approvers', code: 'self_approval', detail: chain.conflict, kind: 'procurement' }]);
      else if (decision === 'confirmed') this.repo.createApprovals(id, revision, chain.steps);
      this.repo.state(id, state);
      this.repo.audit(id, revision, decision === 'disputed' ? 'requester_disputed' : chain.conflict ? 'self_approval_hold' : 'requester_confirmed', { note, conflict: chain.conflict });
    });
    publish(id, revision);
    return this.detail(id);
  }

  approve(id: string, stepId: number, decision: 'approved' | 'rejected' | 'needs_info', note = ''): Record<string, unknown> {
    const row = this.repo.get(id);
    if (!row) throw new FlowError('Request not found', 404);
    if (row.state !== 'awaiting_approval') throw new FlowError('Request is not awaiting approval.');
    const confirmation = this.repo.getConfirmation(id, row.revision);
    if (confirmation?.decision !== 'confirmed' || confirmation.draft_sha256 !== row.draft_sha256) throw new FlowError('Current draft is not confirmed.');
    const steps = this.repo.approvals(id, row.revision);
    const next = steps.find(s => s.decision === 'pending');
    if (!next || next.id !== stepId) throw new FlowError('Only the current approval step can be decided.');
    const state = decision === 'rejected' ? 'rejected' : decision === 'needs_info' ? 'review' : steps.every(s => s.id === stepId || s.decision === 'approved') ? 'approved' : 'awaiting_approval';
    this.repo.transaction(() => {
      this.repo.decideApproval(stepId, decision, note);
      this.repo.state(id, state);
      this.repo.audit(id, row.revision, 'approval_decision', { step: next.position, role: next.role, decision, note });
      if (decision === 'rejected') this.repo.outbox(id, row.revision, row.requester_email, `Request ${id} rejected`, `Request ${id} was rejected at ${next.role}. Reason: ${note || 'No reason supplied'}. This is a draft; it was not sent.`);
    });
    publish(id, row.revision);
    return this.detail(id);
  }

  async submit(id: string): Promise<Record<string, unknown>> {
    let row = this.repo.get(id);
    if (!row) throw new FlowError('Request not found', 404);
    if (row.state === 'po_created') return this.detail(id);
    const existing = this.repo.submission(id, row.revision);
    if (!existing) {
      if (row.state !== 'approved' || !row.validated_json || !row.draft_sha256) throw new FlowError('All sequential approvals and requester confirmation are required before PO creation.');
      const confirmation = this.repo.getConfirmation(id, row.revision);
      const approvals = this.repo.approvals(id, row.revision);
      if (confirmation?.decision !== 'confirmed' || confirmation.draft_sha256 !== row.draft_sha256 || !approvals.length || approvals.some(a => a.decision !== 'approved')) throw new FlowError('Approval gate failed.');
      const checked = validateDraft(JSON.parse(row.draft_json) as Draft, this.clock());
      if (!checked.value || hash(checked.value) !== row.draft_sha256) {
        this.hold(id, row.revision, checked.issues.length ? checked.issues : [{ field: 'draft', code: 'changed', detail: 'Validated request has changed. Reconfirm and reapprove.', kind: 'procurement' }]);
        throw new FlowError('Date or draft changed; procurement review required.');
      }
      const value = checked.value;
      const payload = JSON.stringify({ supplier_id: value.supplier_id, currency: value.currency, total: Number(value.total), requested_delivery_date: value.requested_delivery_date,
        cost_centre: value.cost_centre, ...(value.gl_account ? { gl_account: value.gl_account } : {}), tax_amount: Number(value.tax_amount), freight_amount: Number(value.freight_amount), discount_amount: Number(value.discount_amount),
        requisition_reference: id, line_items: value.line_items.map(l => ({ ...l, quantity: Number(l.quantity), unit_price: Number(l.unit_price) })) });
      const payloadHash = hash(JSON.parse(payload));
      const key = `blp-${id}-${row.revision}-${payloadHash.slice(0, 16)}`;
      this.repo.transaction(() => {
        this.repo.createSubmission(id, row!.revision, payload, payloadHash, key);
        this.repo.state(id, 'submitting');
        this.repo.audit(id, row!.revision, 'submission_frozen', { key, payload_hash: payloadHash });
      });
      publish(id, row.revision);
      row = this.repo.get(id)!;
    } else if (!['submitting', 'submit_error'].includes(row.state)) throw new FlowError('Submission is not retryable.');
    const submission = this.repo.submission(id, row.revision)!;
    if (hash(JSON.parse(submission.payload_json)) !== submission.payload_sha256) throw new FlowError('Frozen ERP payload hash mismatch.');
    try {
      const response = await postPurchaseOrder(submission.payload_json, submission.idempotency_key);
      const poNumber = typeof response.po_number === 'string' ? response.po_number : null;
      if (!poNumber) throw new Error('Mock ERP returned no PO number');
      this.repo.transaction(() => {
        this.repo.finishSubmission(id, row!.revision, 'created', poNumber, response);
        this.repo.state(id, 'po_created');
        this.repo.audit(id, row!.revision, 'po_created', { po_number: poNumber });
      });
    } catch (error) {
      this.repo.transaction(() => {
        this.repo.finishSubmission(id, row!.revision, 'error', null, { error: error instanceof Error ? error.message : String(error) });
        this.repo.state(id, 'submit_error');
        this.repo.audit(id, row!.revision, 'submission_error', { error: error instanceof Error ? error.message : String(error) });
      });
    }
    publish(id, row.revision);
    return this.detail(id);
  }
}
