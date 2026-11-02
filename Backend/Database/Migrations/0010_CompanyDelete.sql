-- INF-001: a programme admin can delete a company added by mistake (such as a
-- duplicate), but only while it has nothing of its own: no profile, AI key,
-- run, report or plan. The API checks that first; the foreign keys back it
-- up (company_billing restricts; memberships cascade). Grant only.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'of_api') THEN
		GRANT DELETE ON company TO of_api;
	END IF;
END
$$;
