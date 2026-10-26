-- Opportunity Finder initial schema (Requirements/ArchitectureProposal.md).
-- Table names are singular. Every company-scoped table carries company_id,
-- and child rows reference their parent by (id, company_id) so a row can
-- never point at another company's run, report or profile (SEC-001).

-- People and access ---------------------------------------------------------

CREATE TABLE app_user (
	id UUID NOT NULL DEFAULT gen_random_uuid(),
	email TEXT NOT NULL,
	display_name TEXT,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	disabled_at TIMESTAMPTZ,
	CONSTRAINT pk_app_user PRIMARY KEY (id),
	CONSTRAINT uq_app_user_email UNIQUE (email),
	-- Stored lower-cased and trimmed so one person is one account.
	CONSTRAINT ck_app_user_email CHECK (email = lower(btrim(email)) AND email LIKE '%_@_%' AND length(email) <= 320)
);

-- Data Innovation Hub staff (DEC-003: run summaries and cost only).
CREATE TABLE programme_admin (
	user_id UUID NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT pk_programme_admin PRIMARY KEY (user_id),
	CONSTRAINT fk_programme_admin_user FOREIGN KEY (user_id) REFERENCES app_user (id) ON DELETE CASCADE
);

CREATE TABLE company (
	id UUID NOT NULL DEFAULT gen_random_uuid(),
	name TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'active',
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	created_by UUID,
	CONSTRAINT pk_company PRIMARY KEY (id),
	CONSTRAINT uq_company_name UNIQUE (name),
	CONSTRAINT ck_company_name CHECK (length(btrim(name)) BETWEEN 1 AND 200),
	CONSTRAINT ck_company_status CHECK (status IN ('active', 'paused')),
	CONSTRAINT fk_company_created_by FOREIGN KEY (created_by) REFERENCES app_user (id) ON DELETE SET NULL
);

-- INF-001/INF-002: users are invited; a company has admins and members.
CREATE TABLE company_membership (
	company_id UUID NOT NULL,
	user_id UUID NOT NULL,
	role TEXT NOT NULL,
	invited_by UUID,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT pk_company_membership PRIMARY KEY (company_id, user_id),
	CONSTRAINT ck_company_membership_role CHECK (role IN ('company_admin', 'company_member')),
	CONSTRAINT fk_company_membership_company FOREIGN KEY (company_id) REFERENCES company (id) ON DELETE CASCADE,
	CONSTRAINT fk_company_membership_user FOREIGN KEY (user_id) REFERENCES app_user (id) ON DELETE CASCADE,
	CONSTRAINT fk_company_membership_invited_by FOREIGN KEY (invited_by) REFERENCES app_user (id) ON DELETE SET NULL
);
CREATE INDEX ix_company_membership_user ON company_membership (user_id);

-- DEC-001: one-time sign-in links. Only a SHA-256 hash of the random token is
-- stored; the token itself exists only in the email.
CREATE TABLE sign_in_token (
	id UUID NOT NULL DEFAULT gen_random_uuid(),
	user_id UUID NOT NULL,
	token_hash BYTEA NOT NULL,
	purpose TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	expires_at TIMESTAMPTZ NOT NULL,
	used_at TIMESTAMPTZ,
	CONSTRAINT pk_sign_in_token PRIMARY KEY (id),
	CONSTRAINT uq_sign_in_token_hash UNIQUE (token_hash),
	CONSTRAINT ck_sign_in_token_purpose CHECK (purpose IN ('sign_in', 'invitation')),
	CONSTRAINT ck_sign_in_token_expiry CHECK (expires_at > created_at),
	CONSTRAINT fk_sign_in_token_user FOREIGN KEY (user_id) REFERENCES app_user (id) ON DELETE CASCADE
);
CREATE INDEX ix_sign_in_token_user ON sign_in_token (user_id, created_at);

CREATE TABLE user_session (
	id UUID NOT NULL DEFAULT gen_random_uuid(),
	user_id UUID NOT NULL,
	token_hash BYTEA NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	expires_at TIMESTAMPTZ NOT NULL,
	revoked_at TIMESTAMPTZ,
	CONSTRAINT pk_user_session PRIMARY KEY (id),
	CONSTRAINT uq_user_session_hash UNIQUE (token_hash),
	CONSTRAINT ck_user_session_expiry CHECK (expires_at > created_at),
	CONSTRAINT fk_user_session_user FOREIGN KEY (user_id) REFERENCES app_user (id) ON DELETE CASCADE
);
CREATE INDEX ix_user_session_user ON user_session (user_id);

-- Company profile (BEH-001, BEH-008, BEH-009) ---------------------------------

-- Versioned: an edit inserts a new version, so each run records the exact
-- profile it used. The searchable parts are columns; the rest of the
-- profile the model reads is a validated JSON document.
CREATE TABLE company_profile (
	id UUID NOT NULL DEFAULT gen_random_uuid(),
	company_id UUID NOT NULL,
	version INTEGER NOT NULL,
	product_description TEXT NOT NULL,
	regions TEXT[] NOT NULL DEFAULT ARRAY['NI', 'IE', 'UK'],
	sectors TEXT[] NOT NULL DEFAULT '{}',
	tender_keywords TEXT[] NOT NULL DEFAULT '{}',
	cpv_prefixes TEXT[] NOT NULL DEFAULT '{}',
	details JSONB NOT NULL DEFAULT '{}',
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	created_by UUID,
	CONSTRAINT pk_company_profile PRIMARY KEY (id),
	CONSTRAINT uq_company_profile_version UNIQUE (company_id, version),
	CONSTRAINT uq_company_profile_id_company UNIQUE (id, company_id),
	CONSTRAINT ck_company_profile_version CHECK (version >= 1),
	CONSTRAINT ck_company_profile_description CHECK (length(btrim(product_description)) BETWEEN 20 AND 5000),
	CONSTRAINT ck_company_profile_regions CHECK (cardinality(regions) >= 1 AND regions <@ ARRAY['NI', 'IE', 'UK']),
	CONSTRAINT ck_company_profile_details CHECK (jsonb_typeof(details) = 'object'),
	CONSTRAINT fk_company_profile_company FOREIGN KEY (company_id) REFERENCES company (id) ON DELETE CASCADE,
	CONSTRAINT fk_company_profile_created_by FOREIGN KEY (created_by) REFERENCES app_user (id) ON DELETE SET NULL
);

-- Model provider and key (BEH-010, SEC-002) -----------------------------------

CREATE TABLE approved_model (
	provider TEXT NOT NULL,
	model TEXT NOT NULL,
	label TEXT NOT NULL,
	benchmark_coverage INTEGER,
	benchmark_cost_usd NUMERIC(8, 2),
	approved_at TIMESTAMPTZ,
	CONSTRAINT pk_approved_model PRIMARY KEY (provider, model),
	CONSTRAINT ck_approved_model_provider CHECK (provider IN ('anthropic', 'openai', 'google')),
	CONSTRAINT ck_approved_model_coverage CHECK (benchmark_coverage IS NULL OR benchmark_coverage BETWEEN 0 AND 36)
);

-- The key itself lives only in the secret store (Key Vault); this row holds
-- the secret's name and what the settings page may show.
CREATE TABLE company_llm_credential (
	company_id UUID NOT NULL,
	provider TEXT NOT NULL,
	model TEXT NOT NULL,
	secret_name TEXT NOT NULL,
	last_four TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'valid',
	checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	added_by UUID,
	added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT pk_company_llm_credential PRIMARY KEY (company_id),
	CONSTRAINT ck_company_llm_credential_status CHECK (status IN ('valid', 'invalid', 'out_of_credit')),
	CONSTRAINT ck_company_llm_credential_last_four CHECK (length(last_four) = 4),
	CONSTRAINT fk_company_llm_credential_company FOREIGN KEY (company_id) REFERENCES company (id) ON DELETE CASCADE,
	CONSTRAINT fk_company_llm_credential_model FOREIGN KEY (provider, model) REFERENCES approved_model (provider, model),
	CONSTRAINT fk_company_llm_credential_added_by FOREIGN KEY (added_by) REFERENCES app_user (id) ON DELETE SET NULL
);

-- Weekly run (BEH-003) ----------------------------------------------------------

-- The Sunday gather of tenders and funder pages, shared by every company.
-- The gathered data itself is a private blob.
CREATE TABLE weekly_gather (
	week_start DATE NOT NULL,
	status TEXT NOT NULL DEFAULT 'running',
	started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	finished_at TIMESTAMPTZ,
	blob_name TEXT,
	tender_notices INTEGER,
	funder_pages INTEGER,
	competitions INTEGER,
	error_message TEXT,
	CONSTRAINT pk_weekly_gather PRIMARY KEY (week_start),
	CONSTRAINT ck_weekly_gather_status CHECK (status IN ('running', 'succeeded', 'failed')),
	CONSTRAINT ck_weekly_gather_monday CHECK (extract(isodow FROM week_start) = 1)
);

-- One run per company per week, idempotent on (company_id, week_start).
-- Model cost is the company's own bill; search cost is the programme's.
CREATE TABLE search_run (
	id UUID NOT NULL DEFAULT gen_random_uuid(),
	company_id UUID NOT NULL,
	week_start DATE NOT NULL,
	profile_id UUID,
	status TEXT NOT NULL DEFAULT 'queued',
	skip_reason TEXT,
	provider TEXT,
	model TEXT,
	started_at TIMESTAMPTZ,
	finished_at TIMESTAMPTZ,
	input_tokens BIGINT NOT NULL DEFAULT 0,
	output_tokens BIGINT NOT NULL DEFAULT 0,
	cache_write_tokens BIGINT NOT NULL DEFAULT 0,
	cache_read_tokens BIGINT NOT NULL DEFAULT 0,
	model_cost_usd NUMERIC(10, 4) NOT NULL DEFAULT 0,
	search_queries INTEGER NOT NULL DEFAULT 0,
	search_cost_usd NUMERIC(10, 4) NOT NULL DEFAULT 0,
	page_reads INTEGER NOT NULL DEFAULT 0,
	error_code TEXT,
	CONSTRAINT pk_search_run PRIMARY KEY (id),
	CONSTRAINT uq_search_run_week UNIQUE (company_id, week_start),
	CONSTRAINT uq_search_run_id_company UNIQUE (id, company_id),
	CONSTRAINT ck_search_run_monday CHECK (extract(isodow FROM week_start) = 1),
	CONSTRAINT ck_search_run_status CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'skipped')),
	CONSTRAINT ck_search_run_skip CHECK ((status = 'skipped') = (skip_reason IS NOT NULL)),
	CONSTRAINT ck_search_run_skip_reason CHECK (skip_reason IS NULL OR skip_reason IN ('no_key', 'invalid_key', 'out_of_credit', 'company_paused', 'no_profile')),
	CONSTRAINT ck_search_run_counts CHECK (input_tokens >= 0 AND output_tokens >= 0 AND cache_write_tokens >= 0 AND cache_read_tokens >= 0
		AND model_cost_usd >= 0 AND search_queries >= 0 AND search_cost_usd >= 0 AND page_reads >= 0),
	CONSTRAINT fk_search_run_company FOREIGN KEY (company_id) REFERENCES company (id) ON DELETE CASCADE,
	CONSTRAINT fk_search_run_profile FOREIGN KEY (profile_id, company_id) REFERENCES company_profile (id, company_id),
	CONSTRAINT fk_search_run_gather FOREIGN KEY (week_start) REFERENCES weekly_gather (week_start)
);
CREATE INDEX ix_search_run_week ON search_run (week_start, status);

-- The week's report (BEH-004): rows for on-screen viewing and "New this week",
-- the rendered xlsx in private blob storage.
CREATE TABLE report (
	id UUID NOT NULL DEFAULT gen_random_uuid(),
	company_id UUID NOT NULL,
	search_run_id UUID NOT NULL,
	week_start DATE NOT NULL,
	blob_name TEXT NOT NULL,
	funding_rows INTEGER NOT NULL,
	tender_rows INTEGER NOT NULL,
	new_this_week INTEGER NOT NULL,
	top_five JSONB NOT NULL,
	also_checked JSONB NOT NULL,
	sources JSONB NOT NULL,
	note TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT pk_report PRIMARY KEY (id),
	CONSTRAINT uq_report_run UNIQUE (search_run_id),
	CONSTRAINT uq_report_week UNIQUE (company_id, week_start),
	CONSTRAINT uq_report_id_company UNIQUE (id, company_id),
	CONSTRAINT ck_report_counts CHECK (funding_rows >= 0 AND tender_rows >= 0 AND new_this_week >= 0),
	CONSTRAINT ck_report_json CHECK (jsonb_typeof(top_five) = 'array' AND jsonb_typeof(also_checked) = 'array' AND jsonb_typeof(sources) = 'array'),
	CONSTRAINT fk_report_company FOREIGN KEY (company_id) REFERENCES company (id) ON DELETE CASCADE,
	CONSTRAINT fk_report_run FOREIGN KEY (search_run_id, company_id) REFERENCES search_run (id, company_id) ON DELETE CASCADE
);

-- One row per funding opportunity or tender in a report. Kept per company,
-- not shared: each company's run describes an opportunity for that company
-- (why it fits, eligibility), and one company's run must never change what
-- another company sees.
CREATE TABLE report_row (
	id UUID NOT NULL DEFAULT gen_random_uuid(),
	company_id UUID NOT NULL,
	report_id UUID NOT NULL,
	kind TEXT NOT NULL,
	region TEXT NOT NULL,
	name TEXT NOT NULL,
	website TEXT,
	status TEXT NOT NULL,
	closing_date DATE,
	closed_since DATE,
	new_this_week BOOLEAN NOT NULL,
	row_data JSONB NOT NULL,
	CONSTRAINT pk_report_row PRIMARY KEY (id),
	CONSTRAINT ck_report_row_kind CHECK (kind IN ('funding', 'tender')),
	CONSTRAINT ck_report_row_region CHECK (region IN ('NI', 'IE', 'UK')),
	CONSTRAINT ck_report_row_status CHECK (status IN ('Open', 'Rolling', 'Opening soon', 'Closed')),
	CONSTRAINT ck_report_row_closed CHECK ((status = 'Closed') = (closed_since IS NOT NULL)),
	CONSTRAINT ck_report_row_data CHECK (jsonb_typeof(row_data) = 'object'),
	CONSTRAINT fk_report_row_report FOREIGN KEY (report_id, company_id) REFERENCES report (id, company_id) ON DELETE CASCADE
);
CREATE INDEX ix_report_row_report ON report_row (report_id, kind);

-- BEH-007: one email per report per user, so a retried job never sends twice.
CREATE TABLE notification (
	id UUID NOT NULL DEFAULT gen_random_uuid(),
	company_id UUID NOT NULL,
	report_id UUID NOT NULL,
	user_id UUID NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending',
	sent_at TIMESTAMPTZ,
	attempts INTEGER NOT NULL DEFAULT 0,
	CONSTRAINT pk_notification PRIMARY KEY (id),
	CONSTRAINT uq_notification_report_user UNIQUE (report_id, user_id),
	CONSTRAINT ck_notification_status CHECK (status IN ('pending', 'sent', 'failed')),
	CONSTRAINT ck_notification_sent CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
	CONSTRAINT fk_notification_report FOREIGN KEY (report_id, company_id) REFERENCES report (id, company_id) ON DELETE CASCADE,
	CONSTRAINT fk_notification_user FOREIGN KEY (user_id) REFERENCES app_user (id) ON DELETE CASCADE
);

-- Programme running cost (BEH-012, BEH-013) -----------------------------------

-- Single row (id = 1) of admin-editable service settings.
CREATE TABLE service_setting (
	id SMALLINT NOT NULL DEFAULT 1,
	search_enabled BOOLEAN NOT NULL DEFAULT true,
	brave_price_per_1000_usd NUMERIC(8, 2) NOT NULL DEFAULT 5.00,
	monthly_query_cap INTEGER NOT NULL DEFAULT 10000,
	review_date DATE NOT NULL DEFAULT DATE '2027-01-25',
	updated_by UUID,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT pk_service_setting PRIMARY KEY (id),
	CONSTRAINT ck_service_setting_single CHECK (id = 1),
	CONSTRAINT ck_service_setting_values CHECK (brave_price_per_1000_usd >= 0 AND monthly_query_cap >= 0),
	CONSTRAINT fk_service_setting_updated_by FOREIGN KEY (updated_by) REFERENCES app_user (id) ON DELETE SET NULL
);
INSERT INTO service_setting (id) VALUES (1);

-- Daily Azure hosting cost from Cost Management. Brave cost is summed from
-- search_run, so it is not duplicated here.
CREATE TABLE azure_cost_daily (
	day DATE NOT NULL,
	amount NUMERIC(12, 4) NOT NULL,
	currency CHAR(3) NOT NULL,
	collected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT pk_azure_cost_daily PRIMARY KEY (day),
	CONSTRAINT ck_azure_cost_daily_amount CHECK (amount >= 0),
	CONSTRAINT ck_azure_cost_daily_currency CHECK (currency ~ '^[A-Z]{3}$')
);

-- Audit (SEC-002 key changes, BEH-013 settings changes, admin actions).
CREATE TABLE audit_event (
	id UUID NOT NULL DEFAULT gen_random_uuid(),
	company_id UUID,
	actor_user_id UUID,
	action TEXT NOT NULL,
	detail JSONB NOT NULL DEFAULT '{}',
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT pk_audit_event PRIMARY KEY (id),
	CONSTRAINT ck_audit_event_action CHECK (action ~ '^[a-z_.]+$'),
	CONSTRAINT fk_audit_event_company FOREIGN KEY (company_id) REFERENCES company (id) ON DELETE SET NULL,
	CONSTRAINT fk_audit_event_actor FOREIGN KEY (actor_user_id) REFERENCES app_user (id) ON DELETE SET NULL
);
CREATE INDEX ix_audit_event_company ON audit_event (company_id, created_at);
