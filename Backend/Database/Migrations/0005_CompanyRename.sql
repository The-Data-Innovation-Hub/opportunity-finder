-- INF-001: programme admins can rename a company (PATCH /admin/companies/:id),
-- so the API role may update company.name as well as status. Infra/database-roles.sql
-- repeats this grant for fresh installs; skipped where the role does not exist yet.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'of_api') THEN
		GRANT UPDATE (name) ON company TO of_api;
	END IF;
END
$$;
