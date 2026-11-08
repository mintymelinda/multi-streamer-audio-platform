-- Phase 2 core domain: durable requests, moderation policy, logical queue and transition history.
-- Apply only with platform_migrator. PostgreSQL remains authoritative for all request state.

CREATE TYPE request_source AS ENUM ('twitch_reward', 'dashboard', 'moderator', 'api');
CREATE TYPE request_status AS ENUM (
  'submitted', 'pending', 'held', 'approved', 'queued', 'resolving',
  'ready', 'playing', 'completed', 'rejected', 'cancelled', 'failed', 'skipped'
);
CREATE TYPE moderation_mode AS ENUM ('automatic', 'manual', 'filtered');

CREATE TABLE workspace_request_settings (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  moderation_mode moderation_mode NOT NULL DEFAULT 'automatic',
  queue_limit integer NOT NULL DEFAULT 50 CHECK (queue_limit BETWEEN 1 AND 500),
  per_user_limit integer NOT NULL DEFAULT 5 CHECK (per_user_limit BETWEEN 1 AND 100),
  per_source_limit integer NOT NULL DEFAULT 50 CHECK (per_source_limit BETWEEN 1 AND 500),
  hold_terms text[] NOT NULL DEFAULT '{}',
  reject_terms text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_queue_counters (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  next_sequence bigint NOT NULL DEFAULT 1 CHECK (next_sequence > 0)
);

CREATE TABLE media_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source request_source NOT NULL,
  source_event_id text,
  submitted_by_user_id uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  requester_twitch_user_id text CHECK (requester_twitch_user_id IS NULL OR requester_twitch_user_id ~ '^[0-9]{1,32}$'),
  requester_display_name text,
  provider text,
  media_id text,
  media_url text,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 500),
  artist text,
  album text,
  artwork_url text,
  duration_ms bigint CHECK (duration_ms IS NULL OR duration_ms >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  status request_status NOT NULL DEFAULT 'submitted',
  priority integer NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 100),
  status_reason text,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (source <> 'twitch_reward' OR source_event_id IS NOT NULL)
);

CREATE UNIQUE INDEX media_requests_source_event_dedupe
  ON media_requests (workspace_id, source, source_event_id)
  WHERE source_event_id IS NOT NULL;
CREATE INDEX media_requests_workspace_status_created
  ON media_requests (workspace_id, status, submitted_at DESC);
CREATE INDEX media_requests_requester_active
  ON media_requests (workspace_id, requester_twitch_user_id, submitted_at DESC)
  WHERE status IN ('submitted', 'pending', 'held', 'approved', 'queued', 'resolving', 'ready', 'playing');

CREATE TABLE request_state_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_id uuid NOT NULL REFERENCES media_requests(id) ON DELETE CASCADE,
  from_status request_status,
  to_status request_status NOT NULL,
  actor_user_id uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'moderator', 'system', 'twitch')),
  reason text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX request_state_history_request_created
  ON request_state_history (workspace_id, request_id, created_at, id);

CREATE TABLE logical_queue_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_id uuid NOT NULL UNIQUE REFERENCES media_requests(id) ON DELETE CASCADE,
  priority integer NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 100),
  sequence bigint NOT NULL CHECK (sequence > 0),
  inserted_by_user_id uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  inserted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, sequence)
);
CREATE INDEX logical_queue_order
  ON logical_queue_entries (workspace_id, priority DESC, sequence ASC);

-- Every tenant-owned table uses forced RLS. The request/queue API always runs
-- inside a transaction carrying a guard-verified workspace context.
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'workspace_request_settings',
    'workspace_queue_counters',
    'media_requests',
    'request_state_history',
    'logical_queue_entries'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (
        workspace_id = nullif(current_setting(''app.workspace_id'', true), '''')::uuid
        AND EXISTS (
          SELECT 1 FROM workspace_memberships m
           WHERE m.workspace_id = %I.workspace_id
             AND m.user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid
             AND m.status = ''active''
        )
      ) WITH CHECK (
        workspace_id = nullif(current_setting(''app.workspace_id'', true), '''')::uuid
        AND EXISTS (
          SELECT 1 FROM workspace_memberships m
           WHERE m.workspace_id = %I.workspace_id
             AND m.user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid
             AND m.status = ''active''
        )
      )',
      table_name || '_member_access', table_name, table_name, table_name
    );
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON workspace_request_settings TO platform_runtime;
GRANT SELECT, INSERT, UPDATE ON workspace_queue_counters TO platform_runtime;
GRANT SELECT, INSERT, UPDATE ON media_requests TO platform_runtime;
GRANT SELECT, INSERT ON request_state_history TO platform_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON logical_queue_entries TO platform_runtime;

-- New workspaces receive conservative, usable defaults on first request access;
-- settings are inserted idempotently by the request service.
