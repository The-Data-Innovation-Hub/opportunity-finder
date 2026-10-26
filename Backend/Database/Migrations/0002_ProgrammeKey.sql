-- DEC-010: a free period in which every company's weekly search runs on the
-- programme's own AI key, under a monthly model-spend cap. Additive only:
-- one new table, nullable or defaulted columns, and a wider skip reason list.

-- The programme's key lives only in the keys vault, like the companies'
-- keys; this single row holds its secret name and what the admin page shows.
CREATE TABLE programme_llm_credential (
	id SMALLINT NOT NULL DEFAULT 1,
	provider TEXT NOT NULL,
	model TEXT NOT NULL,
	secret_name TEXT NOT NULL,
	last_four TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'valid',
	checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	added_by UUID,
	added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT pk_programme_llm_credential PRIMARY KEY (id),
	CONSTRAINT ck_programme_llm_credential_single CHECK (id = 1),
	CONSTRAINT ck_programme_llm_credential_status CHECK (status IN ('valid', 'invalid', 'out_of_credit')),
	CONSTRAINT ck_programme_llm_credential_last_four CHECK (length(last_four) = 4),
	CONSTRAINT fk_programme_llm_credential_model FOREIGN KEY (provider, model) REFERENCES approved_model (provider, model),
	CONSTRAINT fk_programme_llm_credential_added_by FOREIGN KEY (added_by) REFERENCES app_user (id) ON DELETE SET NULL
);

-- Weeks starting on or before free_period_until run on the programme key.
-- NULL means no free period.
ALTER TABLE service_setting
	ADD COLUMN free_period_until DATE,
	ADD COLUMN programme_model_monthly_cap_usd NUMERIC(10, 2) NOT NULL DEFAULT 100.00,
	ADD CONSTRAINT ck_service_setting_programme_cap CHECK (programme_model_monthly_cap_usd >= 0);

-- Who paid for a run's model work: the cost card sums the programme's share.
ALTER TABLE search_run
	ADD COLUMN paid_by TEXT NOT NULL DEFAULT 'company',
	ADD CONSTRAINT ck_search_run_paid_by CHECK (paid_by IN ('company', 'programme'));

ALTER TABLE search_run DROP CONSTRAINT ck_search_run_skip_reason;
ALTER TABLE search_run ADD CONSTRAINT ck_search_run_skip_reason CHECK (skip_reason IS NULL OR skip_reason IN
	('no_key', 'invalid_key', 'out_of_credit', 'company_paused', 'no_profile', 'programme_key_problem', 'programme_budget_reached'));
