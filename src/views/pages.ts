import type { RequestRow } from '../../schema/contracts.js';

export function escapeHtml(value: unknown): string { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!); }
const head = (title: string): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · Procurement demo</title><link rel="stylesheet" href="/app.css"></head><body><header><a href="/">Procurement prototype</a><nav><a href="/">Requests</a><a href="/outbox">Outbox</a></nav></header><main>`;
const foot = `</main><footer>Local demo · requester and approver actions are simulated, not authenticated</footer><script src="/app.js" defer></script></body></html>`;
const stateLabels: Record<string, string> = {
  needs_info: 'Requester info needed', review: 'Needs resolution',
  awaiting_confirmation: 'Requester confirmation', awaiting_approval: 'Approver decision',
  approved: 'Ready to create PO', rejected: 'Rejected', submitting: 'Creating PO',
  submit_error: 'ERP submission error', po_created: 'PO created'
};
const badge = (state: string): string => `<span class="badge ${escapeHtml(state)}">${escapeHtml(stateLabels[state] ?? state.replaceAll('_', ' '))}</span>`;
export function listPage(rows: RequestRow[]): string {
  return head('Requests') + `<section class="hero"><div><h1>Purchase requests</h1><p>Import an email, review the extracted draft, confirm it, then approve in order.</p></div><div class="pill">Demo only · no verified identity</div></section>
    <section class="card"><h2>Import email</h2><form id="import-form"><label>Email (.eml)<input name="email" type="file" accept=".eml,message/rfc822" required></label><label>Optional quote PDF<input name="pdf" type="file" accept=".pdf,application/pdf"></label><button type="submit">Import and extract</button><p id="import-status" class="muted">Local Ollama may take a minute. The sample quotes are resolved by exact attachment name.</p></form></section>
    <section class="card"><h2>Queue</h2><p class="muted">Each row is a separate request. Email follow-ups are drafts in Outbox; none are sent.</p><div class="status-guide">
      <div>${badge('review')}<span>Procurement action required before approval.</span></div>
      <div>${badge('needs_info')}<span>Requester supplies missing or corrected facts.</span></div>
      <div>${badge('awaiting_approval')}<span>The next approver decides; no PO yet.</span></div>
      <div>${badge('po_created')}<span>Mock ERP returned a PO number.</span></div>
    </div><div class="table-wrap"><table><thead><tr><th>Request</th><th>Subject</th><th>Requester</th><th>State</th><th>Updated</th></tr></thead><tbody>${rows.map(r => `<tr><td><a href="/requests/${escapeHtml(r.id)}">${escapeHtml(r.id)}</a></td><td>${escapeHtml(r.subject)}</td><td>${escapeHtml(r.requester_email)}</td><td>${badge(r.state)}</td><td>${escapeHtml(r.updated_at.slice(0, 16).replace('T', ' '))}</td></tr>`).join('') || '<tr><td colspan="5">No requests yet.</td></tr>'}</tbody></table></div></section>` + foot;
}
function jsonPretty(text: string): string { try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; } }
type UiIssue = { field: string; code: string; detail: string; kind: string };
const issueLabel = (field: string): string => ({ requested_delivery_date: 'Delivery date', quote_valid_until: 'Quote validity' })[field] ?? field.replaceAll('_', ' ');
function requiredAction(issue: UiIssue, draft: Record<string, unknown>): { owner: string; action: string } {
  if (issue.field === 'requested_delivery_date') return {
    owner: 'Requester', action: 'Provide the date the goods or service must arrive (YYYY-MM-DD), not an approval deadline.'
  };
  if (issue.code === 'expired_quote') return {
    owner: 'Procurement', action: `Obtain a renewed supplier quote; the current quote expired on ${draft.quote_valid_until ?? 'an unknown date'}. Verify its prices and validity before updating the draft. Do not change the old quote date without new evidence.`
  };
  if (issue.code === 'self_approval') return {
    owner: 'Procurement', action: 'Resolve the approver conflict with a different authorized approver before continuing.'
  };
  if (issue.kind === 'requester') return { owner: 'Requester', action: `Provide or correct ${issue.field.replaceAll('_', ' ')}: ${issue.detail}` };
  if (issue.kind === 'reject') return { owner: 'Procurement', action: `Stop this request: ${issue.detail}` };
  return { owner: 'Procurement', action: `Investigate ${issue.field.replaceAll('_', ' ')} against the source documents: ${issue.detail}` };
}
export function requestPage(detail: Record<string, unknown>): string {
  const row = detail as unknown as RequestRow;
  const issues = detail.issues as UiIssue[];
  const approvals = detail.approvals as { id: number; position: number; role: string; approver_employee_id: string; decision: string }[];
  const confirmation = detail.confirmation as { decision: string } | null;
  const submission = detail.submission as { po_number: string | null; status: string; response_json: string | null } | null;
  const validated = detail.validated as Record<string, unknown> | null;
  const draft = detail.draft as Record<string, unknown>;
  const current = approvals.find(a => a.decision === 'pending');
  const scriptData = `data-id="${escapeHtml(row.id)}" data-revision="${row.revision}" data-hash="${escapeHtml(row.draft_sha256 ?? '')}"`;
  return head(row.id) + `<section class="hero"><div><a href="/" class="back">← Queue</a><h1>${escapeHtml(row.id)} ${badge(row.state)}</h1><p>${escapeHtml(row.subject)} · ${escapeHtml(row.requester_email)}</p></div><div class="pill">Revision ${row.revision}</div></section>
    <div class="grid"><section class="card"><h2>Validation</h2>${issues.length ? `<ul class="issues">${issues.map(i => `<li><strong>${escapeHtml(issueLabel(i.field))}</strong> · ${escapeHtml(i.detail)} <small>(${escapeHtml(i.kind)})</small></li>`).join('')}</ul>` : `<p class="good">No open data issues.</p>`}
    ${validated ? `<h3>Validated requisition</h3><dl>${Object.entries(validated).filter(([k]) => k !== 'line_items').map(([k, v]) => `<dt>${escapeHtml(k.replaceAll('_', ' '))}</dt><dd>${escapeHtml(v)}</dd>`).join('')}</dl><h3>Items</h3><div class="table-wrap"><table><thead><tr><th>Item</th><th>Quantity</th><th>Unit</th><th>Unit price</th></tr></thead><tbody>${((validated.line_items as Record<string, unknown>[]) ?? []).map(l => `<tr><td>${escapeHtml(l.item_name)}</td><td>${escapeHtml(l.quantity)}</td><td>${escapeHtml(l.unit)}</td><td>${escapeHtml(l.unit_price)}</td></tr>`).join('')}</tbody></table></div>` : `<p class="muted">A validated requisition is not available yet.</p>`}</section>
    <section class="card"><h2>Next action</h2>${row.state === 'awaiting_confirmation' ? `<p>Requester: check the exact draft. This click simulates the requester; identity is not verified.</p><div class="actions" ${scriptData}><button data-action="confirm">Confirm draft</button><button class="secondary" data-action="dispute">Dispute draft</button></div>` : ''}
    ${row.state === 'awaiting_approval' && current ? `<p>Current step: <strong>${escapeHtml(current.role)}</strong> (${escapeHtml(current.approver_employee_id)}). This click simulates that role.</p><div class="actions" ${scriptData} data-step="${current.id}"><button data-action="approve">Approve</button><button class="secondary" data-action="reject">Reject</button><button class="secondary" data-action="needs-info">Request information</button></div>` : ''}
    ${row.state === 'approved' || row.state === 'submit_error' ? `<p>All approvals recorded. Create or retry the PO with the frozen payload and idempotency key.</p><div class="actions" ${scriptData}><button data-action="submit">${row.state === 'approved' ? 'Create PO' : 'Retry same PO'}</button></div>` : ''}
    ${row.state === 'po_created' ? `<p class="good">PO created: <strong>${escapeHtml(submission?.po_number)}</strong></p>` : ''}
    ${['review', 'needs_info', 'rejected'].includes(row.state) ? `<p>These issues block approval and PO creation:</p>${issues.length ? `<ol class="steps">${issues.map(i => { const next = requiredAction(i, draft); return `<li><strong>${escapeHtml(next.owner)}:</strong> ${escapeHtml(next.action)}</li>`; }).join('')}</ol>` : '<p>Procurement must resolve the hold before continuing.</p>'}<p class="muted">This demo does not send email. Enter verified corrections in the draft below; replacement PDF upload to an existing request is not available.</p>` : ''}
    ${confirmation ? `<p class="muted">Requester decision: ${escapeHtml(confirmation.decision)} (simulated)</p>` : ''}
    <h3>Approval chain</h3>${approvals.length ? `<ol class="steps">${approvals.map(a => `<li><strong>${escapeHtml(a.role)}</strong> · ${escapeHtml(a.approver_employee_id)} — ${escapeHtml(a.decision)}</li>`).join('')}</ol>` : '<p class="muted">Created only after requester confirmation.</p>'}
    ${submission ? `<h3>ERP submission</h3><p>${escapeHtml(submission.status)} ${submission.po_number ? `· ${escapeHtml(submission.po_number)}` : ''}</p>` : ''}</section></div>
    <section class="card"><h2>Draft and procurement correction</h2><p class="muted">Enter facts only after checking the requester reply or updated quote. Each save creates a new revision and clears prior decisions. Data entry is a demo action.</p><form id="correction-form" ${scriptData}><textarea name="draft" spellcheck="false" rows="17">${escapeHtml(jsonPretty(JSON.stringify(draft)))}</textarea><button type="submit" ${['submitting', 'submit_error', 'po_created'].includes(row.state) ? 'disabled' : ''}>Save corrected draft</button></form><p id="action-status" class="muted"></p></section>
    <section class="card"><details><summary>Extraction and audit</summary><pre>${escapeHtml(JSON.stringify({ extraction: detail.extraction, audit: detail.audit }, null, 2))}</pre></details></section>` + foot;
}
export function outboxPage(messages: Record<string, unknown>[]): string {
  return head('Outbox') + `<section class="hero"><div><h1>Draft outbox</h1><p>Messages are previews. No email is sent.</p></div></section>${messages.map(m => `<section class="card"><p><a href="/requests/${escapeHtml(m.request_id)}">${escapeHtml(m.request_id)}</a> · revision ${escapeHtml(m.revision)} · ${escapeHtml(m.created_at)}</p><h2>${escapeHtml(m.subject)}</h2><p>To: ${escapeHtml(m.recipient)}</p><pre>${escapeHtml(m.body)}</pre></section>`).join('') || '<section class="card">No drafts yet.</section>'}` + foot;
}
