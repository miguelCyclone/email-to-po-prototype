import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
import { Repository } from './db/repository.js';
import { Workflow, FlowError } from './domain/workflow.js';
import { events } from './live/events.js';
import { listPage, requestPage, outboxPage } from './views/pages.js';

const app = Fastify({ logger: true, bodyLimit: 6_000_000 });
const repo = new Repository();
const flow = new Workflow(repo);
app.addHook('onRequest', async (request, reply) => {
  if (request.method !== 'POST') return;
  const origin = request.headers.origin;
  if (origin && origin !== `http://${request.headers.host}`) return reply.code(403).send({ error: 'Cross-origin write blocked' });
});
app.setErrorHandler((error, _request, reply) => {
  const known = error as { validation?: unknown; code?: string };
  const code = error instanceof FlowError ? error.status : known?.validation || known?.code === 'FST_ERR_CTP_INVALID_JSON_BODY' ? 400 : 500;
  app.log.error(error);
  reply.code(code).send({ error: code === 500 ? 'Unexpected server error; see local log' : error instanceof Error ? error.message : 'Invalid request' });
});
const decode = (input: unknown, label: string): Buffer => {
  if (typeof input !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input)) throw new FlowError(`${label} must be base64`, 400);
  return Buffer.from(input, 'base64');
};
const id = (request: { params: unknown }): string => String((request.params as { id: string }).id);

app.get('/health', async () => ({ status: 'ok', app: 'procurement-prototype' }));
app.get('/', async (_request, reply) => reply.type('text/html').send(listPage(repo.list())));
app.get('/requests', async (_request, reply) => reply.type('text/html').send(listPage(repo.list())));
app.get('/requests/:id', async (request, reply) => reply.type('text/html').send(requestPage(flow.detail(id(request)))));
app.get('/outbox', async (_request, reply) => reply.type('text/html').send(outboxPage(repo.outboxList() as Record<string, unknown>[])));
app.get('/api/requests', async () => repo.list());
app.get('/api/requests/:id', async request => flow.detail(id(request)));
app.get('/api/outbox', async () => repo.outboxList());
app.get('/app.css', async (_request, reply) => reply.type('text/css').send(readFileSync(new URL('../web/app.css', import.meta.url))));
app.get('/app.js', async (_request, reply) => reply.type('application/javascript').send(readFileSync(new URL('../web/app.js', import.meta.url))));

app.post('/imports', async request => {
  const body = request.body as { email_base64?: string; pdf_base64?: string; pdf_name?: string };
  const raw = decode(body?.email_base64, 'email_base64');
  const pdf = body?.pdf_base64 === undefined ? undefined : { name: body.pdf_name || 'quote.pdf', content: decode(body.pdf_base64, 'pdf_base64') };
  return flow.importEmail(raw, pdf);
});
app.post('/requests/:id/corrections', async request => {
  const body = request.body as { draft?: unknown };
  if (!body || !body.draft) throw new FlowError('draft is required', 400);
  return flow.correct(id(request), body.draft);
});
app.post('/requests/:id/confirmation', async request => {
  const body = request.body as { revision?: number; draft_sha256?: string; decision?: string; note?: string };
  if (body?.decision !== 'confirmed' && body?.decision !== 'disputed') throw new FlowError('decision must be confirmed or disputed', 400);
  if (!Number.isInteger(body.revision) || typeof body.draft_sha256 !== 'string') throw new FlowError('revision and draft_sha256 are required', 400);
  return flow.confirm(id(request), body.revision!, body.draft_sha256, body.decision, body.note ?? '');
});
app.post('/requests/:id/approvals', async request => {
  const body = request.body as { step_id?: number; decision?: string; note?: string };
  if (!Number.isInteger(body?.step_id) || !['approved', 'rejected', 'needs_info'].includes(body?.decision ?? '')) throw new FlowError('step_id and valid decision are required', 400);
  return flow.approve(id(request), body.step_id!, body.decision as 'approved' | 'rejected' | 'needs_info', body.note ?? '');
});
app.post('/requests/:id/submit', async request => flow.submit(id(request)));

app.get('/events', async (request, reply) => {
  reply.hijack();
  reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  reply.raw.write(': connected\n\n');
  const onChange = (payload: string): void => { reply.raw.write(`event: change\ndata: ${payload}\n\n`); };
  events.on('change', onChange);
  const heartbeat = setInterval(() => { reply.raw.write(': ping\n\n'); }, 30_000);
  request.raw.on('close', () => { clearInterval(heartbeat); events.off('change', onChange); });
});

const port = Number(process.env.PORT ?? '3000');
app.listen({ host: '127.0.0.1', port }).catch(error => { app.log.error(error); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void app.close().then(() => repo.close()); });
