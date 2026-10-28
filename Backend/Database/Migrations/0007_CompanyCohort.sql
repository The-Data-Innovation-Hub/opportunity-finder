-- DEC-015: each company belongs to a group. AI in Healthcare programme
-- members have the free period (DEC-011); Connected Health Cluster members
-- get their first report free, then need a plan (DEC-014). Additive only:
-- existing companies are AI in Healthcare members.
ALTER TABLE company
	ADD COLUMN cohort TEXT NOT NULL DEFAULT 'ai_in_healthcare',
	ADD CONSTRAINT ck_company_cohort CHECK (cohort IN ('ai_in_healthcare', 'connected_health_cluster'));

-- Programme admins set the group when adding a company and can change it.
-- Infra/database-roles.sql repeats this grant for fresh installs; skipped
-- where the role does not exist yet.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'of_api') THEN
		GRANT UPDATE (cohort) ON company TO of_api;
	END IF;
END
$$;
