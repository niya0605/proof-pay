-- Proof-Pay schema: ten tables. `events` is append-only.
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, title TEXT, brief TEXT,
  client_id TEXT, freelancer_id TEXT, freelancer_email TEXT, created_at TEXT);

CREATE TABLE IF NOT EXISTS milestones (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id),
  title TEXT, amount_cents INTEGER, currency TEXT DEFAULT 'USD',
  state TEXT NOT NULL,
  deadline_at TEXT, review_window_hours INTEGER,
  inbox_token TEXT UNIQUE);

CREATE TABLE IF NOT EXISTS agreements (milestone_id TEXT PRIMARY KEY REFERENCES milestones(id),
  version INTEGER, body_json TEXT,
  hash TEXT, client_approved_at TEXT, freelancer_approved_at TEXT, locked_at TEXT);

CREATE TABLE IF NOT EXISTS authorizations (id TEXT PRIMARY KEY,
  milestone_id TEXT, order_id TEXT, status TEXT, expires_at TEXT,
  replaced_by TEXT, created_at TEXT);

CREATE TABLE IF NOT EXISTS payment_operations (id TEXT PRIMARY KEY, milestone_id TEXT,
  type TEXT CHECK (type IN ('create_order','authorize','reauthorize','capture','void')),
  idempotency_key TEXT UNIQUE, status TEXT CHECK (status IN ('PENDING','SUCCEEDED','FAILED','UNKNOWN')),
  requested_at TEXT, responded_at TEXT, paypal_ref TEXT, error TEXT,
  target_ref TEXT);  -- the order or authorization id the operation acts on

CREATE TABLE IF NOT EXISTS submissions (id TEXT PRIMARY KEY, milestone_id TEXT, url TEXT, submitted_at TEXT);

CREATE TABLE IF NOT EXISTS verification_runs (id TEXT PRIMARY KEY, submission_id TEXT,
  status TEXT CHECK (status IN ('running','finished','error')),
  runner_version TEXT, started_at TEXT, finished_at TEXT, error TEXT);

CREATE TABLE IF NOT EXISTS check_results (id TEXT PRIMARY KEY, run_id TEXT REFERENCES verification_runs(id),
  check_id TEXT, status TEXT CHECK (status IN ('passed','failed','error')),
  expected_json TEXT, measured_json TEXT, evidence_json TEXT, explanation TEXT,
  agent_json TEXT);

CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, milestone_id TEXT,
  at TEXT, actor TEXT, type TEXT, data_json TEXT);

CREATE TABLE IF NOT EXISTS form_inbox (id INTEGER PRIMARY KEY AUTOINCREMENT, inbox_token TEXT,
  run_id TEXT, received_at TEXT, body_json TEXT);

CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
