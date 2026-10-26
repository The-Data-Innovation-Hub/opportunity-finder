-- DEC-010: runtime role grants for 0002's new table and columns, so an upgrade does not
-- depend on re-running Infra/database-roles.sql (which repeats them). Skipped
-- where the roles do not exist yet, as in a fresh install or test database.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'of_api') THEN
		GRANT UPDATE (free_period_until, programme_model_monthly_cap_usd) ON service_setting TO of_api;
		GRANT SELECT, INSERT, UPDATE, DELETE ON programme_llm_credential TO of_api;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'of_worker') THEN
		GRANT SELECT, UPDATE (status, checked_at) ON programme_llm_credential TO of_worker;
	END IF;
END
$$;
