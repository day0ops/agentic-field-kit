-- Pre-creates the "enterprise" schema kagent-enterprise's controller migrates on startup
-- (kagent >= 2026.11.2), owned by the same kagent_owner role postgres-setup.sql already
-- created. Adapted from solo-io/enterprise-kagent's own
-- enterprise/services/solo-enterprise/migrations/postgres/setup/setup.sql, dropped to just the
-- schema part -- the agentevals-login part of that script is for agentevals.storage.backend:
-- postgres, which this addon doesn't use (agentevals keeps its default in-memory storage).
--
-- The controller runs its enterprise migrations as kagent_owner (the role, via SET ROLE --
-- confirmed live, 2026-11-24, via pg_hba.conf's log_connections: the session authenticates as
-- kagent_owner_user but the DDL fails under kagent_owner's own privileges), and kagent_owner
-- deliberately holds no CREATE on the database -- see postgres-setup.sql's own REVOKE. So it
-- can create tables inside a schema it already owns, but never the schema itself: without this
-- script, the controller exits on "create schema enterprise: permission denied for database".
-- Idempotent -- safe to re-run on every install.
BEGIN;

SELECT
    set_config('kagent_enterprise.setup_owner_role', :'enterprise_owner_role', true) AS owner_role,
    set_config('kagent_enterprise.setup_readwrite_role', :'enterprise_readwrite_role', true) AS readwrite_role,
    set_config('kagent_enterprise.setup_schema', :'enterprise_schema', true) AS schema
\gset

DO $setup$
DECLARE
    owner_role text := current_setting('kagent_enterprise.setup_owner_role');
    readwrite_role text := current_setting('kagent_enterprise.setup_readwrite_role');
    schema_name text := current_setting('kagent_enterprise.setup_schema');
    schema_owner text;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('kagent-enterprise:setup:' || schema_name, 0));

    SELECT pg_get_userbyid(nspowner) INTO schema_owner FROM pg_namespace WHERE nspname = schema_name;
    IF NOT FOUND THEN
        EXECUTE format('CREATE SCHEMA %I AUTHORIZATION %I', schema_name, owner_role);
    ELSIF schema_owner <> owner_role THEN
        RAISE EXCEPTION 'PostgreSQL schema "%" is owned by "%", not "%"', schema_name, schema_owner, owner_role;
    END IF;

    EXECUTE format('REVOKE ALL ON SCHEMA %I FROM PUBLIC', schema_name);
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', schema_name, readwrite_role);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', owner_role, schema_name, readwrite_role);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO %I', owner_role, schema_name, readwrite_role);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT EXECUTE ON ROUTINES TO %I', owner_role, schema_name, readwrite_role);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT USAGE ON TYPES TO %I', owner_role, schema_name, readwrite_role);
END
$setup$;

COMMIT;
