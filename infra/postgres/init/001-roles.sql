-- Local-development bootstrap only. Production credentials must be provisioned
-- through the deployment secret-management process, never copied from this file.
CREATE ROLE platform_migrator LOGIN PASSWORD 'local-migration-only';
CREATE ROLE platform_runtime LOGIN PASSWORD 'local-runtime-only';
CREATE ROLE platform_worker LOGIN PASSWORD 'local-worker-only';

GRANT CONNECT ON DATABASE platform TO platform_migrator, platform_runtime, platform_worker;
ALTER SCHEMA public OWNER TO platform_migrator;
GRANT USAGE ON SCHEMA public TO platform_runtime;

ALTER DEFAULT PRIVILEGES FOR ROLE platform_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO platform_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE platform_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO platform_runtime;
