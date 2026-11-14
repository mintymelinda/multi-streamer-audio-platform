-- Bootstrap the application roles with deployment-provided credentials.
-- Local Compose supplies explicitly local-only defaults; staging must override
-- every password with a unique secret before starting a persistent database.
\getenv platform_migrator_password PLATFORM_MIGRATOR_PASSWORD
\getenv platform_runtime_password PLATFORM_RUNTIME_PASSWORD
\getenv platform_worker_password PLATFORM_WORKER_PASSWORD
\getenv platform_provider_worker_password PLATFORM_PROVIDER_WORKER_PASSWORD

CREATE ROLE platform_migrator LOGIN PASSWORD :'platform_migrator_password';
CREATE ROLE platform_runtime LOGIN PASSWORD :'platform_runtime_password';
CREATE ROLE platform_worker LOGIN PASSWORD :'platform_worker_password';
CREATE ROLE platform_provider_worker NOINHERIT NOBYPASSRLS PASSWORD :'platform_provider_worker_password';
CREATE ROLE platform_provider_execution_owner NOLOGIN BYPASSRLS;
GRANT platform_provider_execution_owner TO platform_migrator;

GRANT CONNECT ON DATABASE platform TO platform_migrator, platform_runtime, platform_worker;
ALTER SCHEMA public OWNER TO platform_migrator;
GRANT USAGE ON SCHEMA public TO platform_runtime;

ALTER DEFAULT PRIVILEGES FOR ROLE platform_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO platform_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE platform_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO platform_runtime;
