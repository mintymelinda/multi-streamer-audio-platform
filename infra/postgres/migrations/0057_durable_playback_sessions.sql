-- Durable playback-session identity, separate from provider track identity.
-- A session binds one confirmed coordinator play operation to one logical request
-- and output generation. Provider observations may update it, but never infer the
-- request from a matching media URL.

ALTER TABLE public.provider_execution_states
  ADD CONSTRAINT provider_execution_states_session_identity_key
  UNIQUE (workspace_id, request_id, provider_instance_id, dispatch_generation, id);

ALTER TABLE public.playback_operations
  ADD CONSTRAINT playback_operations_session_identity_key
  UNIQUE (workspace_id, request_id, provider_instance_id, player_id, output_id, command, id);

CREATE TABLE public.playback_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  request_id uuid NOT NULL,
  provider_instance_id uuid NOT NULL,
  execution_state_id uuid NOT NULL,
  dispatch_generation integer NOT NULL CHECK (dispatch_generation > 0),
  playback_operation_id uuid NOT NULL,
  command text NOT NULL DEFAULT 'play' CHECK (command = 'play'),
  actor_user_id uuid REFERENCES public.platform_users(id) ON DELETE SET NULL,
  output_id text NOT NULL CHECK (length(output_id) BETWEEN 1 AND 200),
  player_id text NOT NULL CHECK (length(player_id) BETWEEN 1 AND 200),
  provider_playback_id text CHECK (
    provider_playback_id IS NULL OR length(provider_playback_id) <= 500
  ),
  expected_duration_ms bigint CHECK (
    expected_duration_ms IS NULL OR expected_duration_ms >= 0
  ),
  observed_position_ms bigint CHECK (
    observed_position_ms IS NULL OR observed_position_ms >= 0
  ),
  observed_duration_ms bigint CHECK (
    observed_duration_ms IS NULL OR observed_duration_ms >= 0
  ),
  observed_status text CHECK (
    observed_status IS NULL OR observed_status IN ('playing', 'paused', 'stopped', 'idle', 'unavailable')
  ),
  observed_at timestamptz,
  status text NOT NULL DEFAULT 'playing' CHECK (
    status IN ('playing', 'paused', 'completed', 'interrupted', 'uncertain')
  ),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, playback_operation_id),
  FOREIGN KEY (workspace_id, request_id)
    REFERENCES public.media_requests(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, request_id, provider_instance_id, dispatch_generation, execution_state_id)
    REFERENCES public.provider_execution_states(
      workspace_id, request_id, provider_instance_id, dispatch_generation, id
    ) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, request_id, provider_instance_id, player_id, output_id, command, playback_operation_id)
    REFERENCES public.playback_operations(
      workspace_id, request_id, provider_instance_id, player_id, output_id, command, id
    ) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, provider_instance_id)
    REFERENCES public.provider_instances(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX playback_sessions_monitor
  ON public.playback_sessions (status, observed_at, started_at)
  WHERE status IN ('playing', 'paused', 'uncertain');

CREATE INDEX playback_sessions_request_history
  ON public.playback_sessions (workspace_id, request_id, started_at DESC);

ALTER TABLE public.playback_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.playback_sessions FORCE ROW LEVEL SECURITY;

CREATE POLICY playback_sessions_member_access
  ON public.playback_sessions
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM public.workspace_memberships m
      WHERE m.workspace_id = playback_sessions.workspace_id
        AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND m.status = 'active'
    )
  )
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM public.workspace_memberships m
      WHERE m.workspace_id = playback_sessions.workspace_id
        AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
        AND m.status = 'active'
    )
  );

GRANT SELECT, INSERT, UPDATE ON public.playback_sessions TO platform_runtime;
