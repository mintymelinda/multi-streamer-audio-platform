-- Store non-secret provider instance configuration separately from encrypted credentials.
ALTER TABLE provider_instances
  ADD COLUMN configuration jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE provider_instances
  ADD CONSTRAINT provider_instances_configuration_object
  CHECK (jsonb_typeof(configuration) = 'object');
