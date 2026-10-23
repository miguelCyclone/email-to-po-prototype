PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL,
  requester_email TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  received_at TEXT NOT NULL,
  draft_json TEXT NOT NULL DEFAULT '{}',
  validated_json TEXT,
  draft_sha256 TEXT,
  total_chf_minor INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS requests_state_updated ON requests(state, updated_at);
CREATE TABLE IF NOT EXISTS email_identities (
  sender TEXT NOT NULL,
  message_id TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  request_id TEXT NOT NULL REFERENCES requests(id),
  PRIMARY KEY(sender, message_id)
);
CREATE TABLE IF NOT EXISTS source_documents (
  id INTEGER PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id),
  kind TEXT NOT NULL,
  file_name TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  text_excerpt TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(request_id, sha256)
);
CREATE TABLE IF NOT EXISTS extraction_runs (
  id INTEGER PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id),
  revision INTEGER NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  prompt_tokens INTEGER,
  output_tokens INTEGER,
  latency_ms INTEGER,
  draft_json TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS line_items (
  id INTEGER PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id),
  position INTEGER NOT NULL,
  item_name TEXT NOT NULL,
  quantity TEXT NOT NULL,
  unit TEXT NOT NULL,
  unit_price TEXT NOT NULL,
  item_code TEXT,
  UNIQUE(request_id, position)
);
CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id),
  revision INTEGER NOT NULL,
  field TEXT NOT NULL,
  code TEXT NOT NULL,
  detail TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS requester_confirmations (
  id INTEGER PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id),
  revision INTEGER NOT NULL,
  draft_sha256 TEXT NOT NULL,
  decision TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(request_id, revision)
);
CREATE TABLE IF NOT EXISTS approval_steps (
  id INTEGER PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id),
  revision INTEGER NOT NULL,
  position INTEGER NOT NULL,
  role TEXT NOT NULL,
  approver_employee_id TEXT NOT NULL,
  decision TEXT NOT NULL DEFAULT 'pending',
  note TEXT NOT NULL DEFAULT '',
  decided_at TEXT,
  UNIQUE(request_id, revision, position)
);
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id),
  revision INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox_messages (
  id INTEGER PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id),
  revision INTEGER NOT NULL,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS erp_submissions (
  id INTEGER PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id),
  revision INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  po_number TEXT,
  response_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(request_id, revision)
);
