CREATE EXTENSION IF NOT EXISTS vector;

CREATE ROLE support_app_user LOGIN PASSWORD 'support_app_user';

CREATE TABLE support_orgs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE support_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES support_orgs(id),
  external_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE support_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES support_orgs(id),
  user_id text NOT NULL,
  slot_key text NOT NULL,
  subject text NOT NULL,
  predicate text NOT NULL,
  object_value text NOT NULL,
  canonical_text text NOT NULL,
  embedding vector(384),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'retracted')),
  supersedes uuid REFERENCES support_facts(id),
  content_hash char(64) NOT NULL,
  source_role text NOT NULL,
  conv_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX support_one_active_per_slot
  ON support_facts (org_id, user_id, slot_key)
  WHERE status = 'active';

CREATE UNIQUE INDEX support_uniq_content
  ON support_facts (org_id, user_id, content_hash);

CREATE INDEX support_facts_org_user_status_idx ON support_facts (org_id, user_id, status);
CREATE INDEX support_facts_embedding_hnsw ON support_facts USING hnsw (embedding vector_cosine_ops);

CREATE TABLE support_episodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES support_orgs(id),
  user_id text NOT NULL,
  summary text NOT NULL,
  fact_ids jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE support_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES support_orgs(id),
  user_id text NOT NULL,
  kind text NOT NULL,
  content jsonb NOT NULL,
  source_fact_ids jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE support_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES support_orgs(id),
  actor_id text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE support_api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES support_orgs(id),
  key_hash char(64) NOT NULL UNIQUE,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE support_ingest_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES support_orgs(id),
  user_id text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  payload jsonb NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE support_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_episodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_ingest_jobs ENABLE ROW LEVEL SECURITY;

ALTER TABLE support_users FORCE ROW LEVEL SECURITY;
ALTER TABLE support_facts FORCE ROW LEVEL SECURITY;
ALTER TABLE support_episodes FORCE ROW LEVEL SECURITY;
ALTER TABLE support_artifacts FORCE ROW LEVEL SECURITY;
ALTER TABLE support_audit_logs FORCE ROW LEVEL SECURITY;
ALTER TABLE support_api_keys FORCE ROW LEVEL SECURITY;
ALTER TABLE support_ingest_jobs FORCE ROW LEVEL SECURITY;

CREATE POLICY org_isolation ON support_users
  AS PERMISSIVE FOR ALL TO support_app_user
  USING (org_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);

CREATE POLICY org_isolation ON support_facts
  AS PERMISSIVE FOR ALL TO support_app_user
  USING (org_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);

CREATE POLICY org_isolation ON support_episodes
  AS PERMISSIVE FOR ALL TO support_app_user
  USING (org_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);

CREATE POLICY org_isolation ON support_artifacts
  AS PERMISSIVE FOR ALL TO support_app_user
  USING (org_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);

CREATE POLICY org_isolation ON support_audit_logs
  AS PERMISSIVE FOR ALL TO support_app_user
  USING (org_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);

CREATE POLICY org_isolation ON support_api_keys
  AS PERMISSIVE FOR ALL TO support_app_user
  USING (org_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);

CREATE POLICY org_isolation ON support_ingest_jobs
  AS PERMISSIVE FOR ALL TO support_app_user
  USING (org_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON support_orgs, support_users, support_facts, support_episodes, support_artifacts, support_audit_logs, support_api_keys, support_ingest_jobs TO support_app_user;
GRANT REFERENCES ON support_orgs, support_facts TO support_app_user;
