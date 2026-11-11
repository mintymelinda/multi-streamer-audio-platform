-- Phase 6 item 58: public service status and audited incident communications.
BEGIN;

CREATE TYPE service_incident_status AS ENUM (
  'investigating',
  'identified',
  'monitoring',
  'resolved'
);

CREATE TYPE service_incident_impact AS ENUM (
  'degraded',
  'partial_outage',
  'major_outage'
);

ALTER TABLE platform_administrators
  DROP CONSTRAINT platform_administrators_permissions_check;

ALTER TABLE platform_administrators
  ADD CONSTRAINT platform_administrators_permissions_check
  CHECK (permissions <@ ARRAY[
    'accounts.read',
    'accounts.suspend',
    'workspaces.read',
    'workspaces.restrict',
    'settings.read',
    'settings.write',
    'support_access.manage',
    'administrators.read',
    'administrators.manage',
    'rights_reports.manage',
    'status.manage'
  ]::text[]);

CREATE TABLE platform_service_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 5 AND 160),
  summary text NOT NULL CHECK (length(btrim(summary)) BETWEEN 10 AND 2000),
  status service_incident_status NOT NULL DEFAULT 'investigating',
  impact service_incident_impact NOT NULL,
  affected_services text[] NOT NULL CHECK (
    cardinality(affected_services) BETWEEN 1 AND 9
    AND affected_services <@ ARRAY[
      'all', 'api', 'dashboard', 'overlay', 'playback',
      'authentication', 'twitch', 'spotify', 'lyrion'
    ]::text[]
  ),
  created_by_user_id uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  updated_by_user_id uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))
);

CREATE INDEX platform_service_incidents_public_order
  ON platform_service_incidents (updated_at DESC);

REVOKE ALL ON platform_service_incidents FROM PUBLIC, platform_runtime, platform_worker;

CREATE FUNCTION list_public_service_incidents()
RETURNS TABLE (
  id uuid,
  title text,
  summary text,
  status service_incident_status,
  impact service_incident_impact,
  affected_services text[],
  created_at timestamptz,
  updated_at timestamptz,
  resolved_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $public_status$
  SELECT incident.id, incident.title, incident.summary, incident.status,
         incident.impact, incident.affected_services, incident.created_at,
         incident.updated_at, incident.resolved_at
    FROM public.platform_service_incidents incident
   WHERE incident.status <> 'resolved'
      OR incident.resolved_at >= now() - interval '30 days'
   ORDER BY (incident.status = 'resolved') ASC, incident.updated_at DESC
   LIMIT 100
$public_status$;

CREATE FUNCTION list_platform_service_incidents()
RETURNS TABLE (
  id uuid,
  title text,
  summary text,
  status service_incident_status,
  impact service_incident_impact,
  affected_services text[],
  created_at timestamptz,
  updated_at timestamptz,
  resolved_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $platform_status$
BEGIN
  PERFORM public.require_platform_permission('status.manage');
  RETURN QUERY
    SELECT incident.id, incident.title, incident.summary, incident.status,
           incident.impact, incident.affected_services, incident.created_at,
           incident.updated_at, incident.resolved_at
      FROM public.platform_service_incidents incident
     ORDER BY (incident.status = 'resolved') ASC, incident.updated_at DESC
     LIMIT 200;
END;
$platform_status$;

CREATE FUNCTION set_platform_service_incident(
  target_incident_id uuid,
  incident_title text,
  incident_summary text,
  desired_status service_incident_status,
  desired_impact service_incident_impact,
  desired_services text[]
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $platform_status$
DECLARE
  actor_id uuid := public.require_platform_permission('status.manage');
  saved_id uuid;
  previous_status service_incident_status;
  action_name text;
BEGIN
  IF incident_title IS NULL OR length(btrim(incident_title)) NOT BETWEEN 5 AND 160
     OR incident_summary IS NULL OR length(btrim(incident_summary)) NOT BETWEEN 10 AND 2000
     OR desired_status IS NULL OR desired_impact IS NULL
     OR desired_services IS NULL OR cardinality(desired_services) NOT BETWEEN 1 AND 9
     OR NOT (desired_services <@ ARRAY[
       'all', 'api', 'dashboard', 'overlay', 'playback',
       'authentication', 'twitch', 'spotify', 'lyrion'
     ]::text[]) THEN
    RAISE EXCEPTION 'valid incident title, summary, state, impact, and affected services are required'
      USING ERRCODE = '22023';
  END IF;

  IF target_incident_id IS NULL THEN
    INSERT INTO public.platform_service_incidents (
      title, summary, status, impact, affected_services,
      created_by_user_id, updated_by_user_id, resolved_at
    )
    VALUES (
      btrim(incident_title), btrim(incident_summary), desired_status, desired_impact,
      desired_services, actor_id, actor_id,
      CASE WHEN desired_status = 'resolved' THEN now() ELSE NULL END
    )
    RETURNING id INTO saved_id;
    action_name := 'service_incident.created';
    previous_status := NULL;
  ELSE
    SELECT incident.status INTO previous_status
      FROM public.platform_service_incidents incident
     WHERE incident.id = target_incident_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'service incident was not found' USING ERRCODE = 'P0002';
    END IF;

    UPDATE public.platform_service_incidents
       SET title = btrim(incident_title),
           summary = btrim(incident_summary),
           status = desired_status,
           impact = desired_impact,
           affected_services = desired_services,
           updated_by_user_id = actor_id,
           updated_at = now(),
           resolved_at = CASE WHEN desired_status = 'resolved'
             THEN COALESCE(resolved_at, now()) ELSE NULL END
     WHERE id = target_incident_id
     RETURNING id INTO saved_id;
    action_name := 'service_incident.updated';
  END IF;

  INSERT INTO public.platform_administration_audit (
    actor_user_id, action, reason, details
  )
  VALUES (
    actor_id, action_name,
    CASE WHEN target_incident_id IS NULL THEN 'Public service incident created'
         ELSE 'Public service incident updated' END,
    jsonb_build_object(
      'incident_id', saved_id,
      'title', btrim(incident_title),
      'previous_status', previous_status,
      'new_status', desired_status,
      'impact', desired_impact,
      'affected_services', desired_services
    )
  );

  RETURN saved_id;
END;
$platform_status$;

REVOKE ALL ON FUNCTION list_public_service_incidents() FROM PUBLIC;
REVOKE ALL ON FUNCTION list_platform_service_incidents() FROM PUBLIC;
REVOKE ALL ON FUNCTION set_platform_service_incident(uuid, text, text, service_incident_status, service_incident_impact, text[]) FROM PUBLIC;

GRANT USAGE ON TYPE service_incident_status TO platform_runtime;
GRANT USAGE ON TYPE service_incident_impact TO platform_runtime;
GRANT EXECUTE ON FUNCTION list_public_service_incidents() TO platform_runtime;
GRANT EXECUTE ON FUNCTION list_platform_service_incidents() TO platform_runtime;
GRANT EXECUTE ON FUNCTION set_platform_service_incident(uuid, text, text, service_incident_status, service_incident_impact, text[]) TO platform_runtime;

COMMIT;
