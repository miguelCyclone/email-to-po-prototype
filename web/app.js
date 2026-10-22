const statusLine = document.querySelector('#action-status');
const show = (message, error = false) => { const target = statusLine || document.querySelector('#import-status'); if (target) { target.textContent = message; target.style.color = error ? '#a23232' : '#17634b'; } };
async function send(path, data) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}
const base64 = file => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(file); });
document.querySelector('#import-form')?.addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const email = form.elements.namedItem('email').files[0]; const pdf = form.elements.namedItem('pdf').files[0];
  if (!email) return;
  show('Importing and extracting…');
  try { const data = { email_base64: await base64(email), ...(pdf ? { pdf_base64: await base64(pdf), pdf_name: pdf.name } : {}) }; const result = await send('/imports', data); location.href = `/requests/${encodeURIComponent(result.id)}`; }
  catch (error) { show(error.message, true); }
});
document.querySelector('#correction-form')?.addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget;
  try { const draft = JSON.parse(form.draft.value); await send(`/requests/${form.dataset.id}/corrections`, { draft }); location.reload(); }
  catch (error) { show(error.message, true); }
});
document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', async () => {
  const box = button.closest('.actions'); const id = box.dataset.id; const revision = Number(box.dataset.revision); const hash = box.dataset.hash;
  button.disabled = true; show('Saving…');
  try {
    let path, data;
    if (button.dataset.action === 'confirm' || button.dataset.action === 'dispute') { path = `/requests/${id}/confirmation`; data = { revision, draft_sha256: hash, decision: button.dataset.action === 'confirm' ? 'confirmed' : 'disputed' }; }
    else if (['approve', 'reject', 'needs-info'].includes(button.dataset.action)) { path = `/requests/${id}/approvals`; data = { step_id: Number(box.dataset.step), decision: { approve: 'approved', reject: 'rejected', 'needs-info': 'needs_info' }[button.dataset.action], note: button.dataset.action === 'approve' ? '' : (prompt('Reason / information needed:') || '') }; }
    else { path = `/requests/${id}/submit`; data = {}; }
    await send(path, data); location.reload();
  } catch (error) { button.disabled = false; show(error.message, true); }
}));
let lastActivity = Date.now(); let stream = null; let retryAfter = 0;
function connect() { if (stream || document.hidden || Date.now() - lastActivity > 300000 || Date.now() < retryAfter) return; stream = new EventSource('/events'); stream.addEventListener('change', () => location.reload()); stream.onerror = () => { stream?.close(); stream = null; retryAfter = Date.now() + 30000; }; }
function wake() { lastActivity = Date.now(); connect(); }
for (const name of ['pointerdown', 'keydown']) document.addEventListener(name, wake, { passive: true });
document.addEventListener('visibilitychange', () => { if (document.hidden) { stream?.close(); stream = null; } else { wake(); location.reload(); } });
connect();
setInterval(() => { if (stream && Date.now() - lastActivity > 300000) { stream.close(); stream = null; } else if (!stream) connect(); }, 30000);
