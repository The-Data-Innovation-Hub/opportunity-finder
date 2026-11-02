-- BEH-019: a programme admin accepts an access request in one step. The
-- request records the company it became, and the contact's name from the
-- request is kept as their display name. Additive only: one nullable column
-- and two column grants.
ALTER TABLE access_request ADD COLUMN company_id UUID;
ALTER TABLE access_request ADD CONSTRAINT fk_access_request_company FOREIGN KEY (company_id) REFERENCES company (id) ON DELETE SET NULL;

-- Infra/database-roles.sql repeats these grants for fresh installs; skipped
-- where a role does not exist yet.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'of_api') THEN
		GRANT UPDATE (company_id) ON access_request TO of_api;
		GRANT UPDATE (display_name) ON app_user TO of_api;
	END IF;
END
$$;
