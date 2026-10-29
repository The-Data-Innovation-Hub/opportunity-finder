-- Runtime database roles (least privilege). Run once as the Postgres admin,
-- after the first migration, with psql variables for the two passwords:
--
--   psql "$ADMIN_URL" -v api_password="..." -v worker_password="..." -f Infra/database-roles.sql
--
-- The API never needs DDL; the worker never sees sign-in tokens or sessions
-- beyond deleting expired ones (ArchitectureProposal.md, Identity).

SELECT format('CREATE ROLE of_api LOGIN PASSWORD %L', :'api_password') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'of_api') \gexec
SELECT format('CREATE ROLE of_worker LOGIN PASSWORD %L', :'worker_password') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'of_worker') \gexec

GRANT CONNECT ON DATABASE opportunity_finder TO of_api, of_worker;
GRANT USAGE ON SCHEMA public TO of_api, of_worker;

-- API. Nothing is granted that no API query uses (no DELETE on users or
-- companies; UPDATE limited to the columns the code changes). The UPDATEs on
-- app_user(email) and company_membership(company_id) are the no-op upserts
-- that return an existing row; UPDATE on company(status) also covers the
-- FOR UPDATE lock taken before a profile save.
GRANT SELECT, INSERT ON app_user, company, company_membership, sign_in_token, user_session, company_profile TO of_api;
GRANT UPDATE (email) ON app_user TO of_api;
GRANT UPDATE (status, name, cohort) ON company TO of_api;
GRANT UPDATE (company_id), DELETE ON company_membership TO of_api;
GRANT UPDATE (used_at) ON sign_in_token TO of_api;
GRANT UPDATE (revoked_at) ON user_session TO of_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON company_llm_credential TO of_api;
GRANT SELECT, INSERT ON audit_event TO of_api;
GRANT SELECT, UPDATE (search_enabled, brave_price_per_1000_usd, monthly_query_cap, review_date, free_period_until, programme_model_monthly_cap_usd, updated_by, updated_at) ON service_setting TO of_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON programme_llm_credential TO of_api;
GRANT SELECT, INSERT, UPDATE ON company_billing TO of_api;
GRANT SELECT, INSERT ON stripe_event TO of_api;
GRANT SELECT, INSERT ON access_request TO of_api;
GRANT UPDATE (handled_at, handled_by) ON access_request TO of_api;
GRANT SELECT ON programme_admin, approved_model, weekly_gather, search_run, report, report_row, azure_cost_daily TO of_api;

-- Worker
GRANT SELECT ON company, company_profile, company_membership, approved_model, service_setting TO of_worker;
GRANT SELECT (id, email, disabled_at) ON app_user TO of_worker;
GRANT SELECT, UPDATE (status, checked_at) ON company_llm_credential TO of_worker;
GRANT SELECT, UPDATE (status, checked_at) ON programme_llm_credential TO of_worker;
GRANT SELECT ON company_billing TO of_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON weekly_gather, search_run, report, report_row, notification, azure_cost_daily TO of_worker;
GRANT SELECT (expires_at), DELETE ON sign_in_token TO of_worker;
GRANT SELECT (expires_at, revoked_at), DELETE ON user_session TO of_worker;
GRANT SELECT (created_at), DELETE ON access_request TO of_worker;

-- Tables added by later migrations get no access until a migration grants it
-- explicitly; that is deliberate, so each new table's access is decided.
