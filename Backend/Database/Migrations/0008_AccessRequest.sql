-- BEH-019: a company that is not on the platform yet asks for access from the
-- public landing page. Programme admins read the requests and onboard the
-- company as before (INF-001: companies do not register themselves). Holds a
-- contact's name and work email, so requests are deleted 180 days after they
-- were made (cleanup job). Additive only: one new table.
CREATE TABLE access_request (
	id UUID NOT NULL DEFAULT gen_random_uuid(),
	company_name TEXT NOT NULL,
	contact_name TEXT NOT NULL,
	email TEXT NOT NULL,
	cohort TEXT NOT NULL,
	message TEXT,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	handled_at TIMESTAMPTZ,
	handled_by UUID,
	CONSTRAINT pk_access_request PRIMARY KEY (id),
	CONSTRAINT ck_access_request_company_name CHECK (length(btrim(company_name)) BETWEEN 1 AND 200),
	CONSTRAINT ck_access_request_contact_name CHECK (length(btrim(contact_name)) BETWEEN 1 AND 200),
	CONSTRAINT ck_access_request_email CHECK (length(email) BETWEEN 3 AND 320),
	CONSTRAINT ck_access_request_cohort CHECK (cohort IN ('ai_in_healthcare', 'connected_health_cluster', 'not_sure')),
	CONSTRAINT ck_access_request_message CHECK (message IS NULL OR length(message) <= 2000),
	CONSTRAINT fk_access_request_handled_by FOREIGN KEY (handled_by) REFERENCES app_user (id) ON DELETE SET NULL
);
CREATE INDEX ix_access_request_created ON access_request (created_at);

-- Infra/database-roles.sql repeats these grants for fresh installs; skipped
-- where a role does not exist yet.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'of_api') THEN
		GRANT SELECT, INSERT ON access_request TO of_api;
		GRANT UPDATE (handled_at, handled_by) ON access_request TO of_api;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'of_worker') THEN
		GRANT SELECT (created_at), DELETE ON access_request TO of_worker;
	END IF;
END
$$;
