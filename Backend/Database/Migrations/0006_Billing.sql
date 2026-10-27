-- DEC-014: after the free period a company keeps its weekly runs with a paid
-- plan, bought through Stripe Checkout: a subscription (the programme key
-- pays the AI) or the own-key platform fee (the company's key does). Additive
-- only: two new tables and a wider skip reason list.

-- One row per company that has started a checkout. Stripe holds the card and
-- the invoices; this row holds only the ids and the subscription's state,
-- copied from Stripe whenever a webhook arrives.
CREATE TABLE company_billing (
	company_id UUID NOT NULL,
	stripe_customer_id TEXT NOT NULL,
	stripe_subscription_id TEXT,
	plan TEXT,
	billing_interval TEXT,
	status TEXT,
	current_period_end TIMESTAMPTZ,
	cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT pk_company_billing PRIMARY KEY (company_id),
	CONSTRAINT fk_company_billing_company FOREIGN KEY (company_id) REFERENCES company (id) ON DELETE RESTRICT,
	CONSTRAINT uq_company_billing_customer UNIQUE (stripe_customer_id),
	CONSTRAINT uq_company_billing_subscription UNIQUE (stripe_subscription_id),
	CONSTRAINT ck_company_billing_plan CHECK (plan IS NULL OR plan IN ('subscription', 'own_key')),
	CONSTRAINT ck_company_billing_interval CHECK (billing_interval IS NULL OR billing_interval IN ('month', 'year')),
	CONSTRAINT ck_company_billing_subscription CHECK ((stripe_subscription_id IS NULL) = (plan IS NULL AND status IS NULL))
);

-- Each Stripe event is acted on once, however often Stripe delivers it.
CREATE TABLE stripe_event (
	id TEXT NOT NULL,
	type TEXT NOT NULL,
	received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT pk_stripe_event PRIMARY KEY (id)
);

ALTER TABLE search_run DROP CONSTRAINT ck_search_run_skip_reason;
ALTER TABLE search_run ADD CONSTRAINT ck_search_run_skip_reason CHECK (skip_reason IS NULL OR skip_reason IN
	('no_key', 'invalid_key', 'out_of_credit', 'company_paused', 'no_profile', 'programme_key_problem', 'programme_budget_reached', 'no_plan'));

-- Runtime grants, repeated in Infra/database-roles.sql for fresh installs;
-- skipped where the roles do not exist yet.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'of_api') THEN
		GRANT SELECT, INSERT, UPDATE ON company_billing TO of_api;
		GRANT SELECT, INSERT ON stripe_event TO of_api;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'of_worker') THEN
		GRANT SELECT ON company_billing TO of_worker;
	END IF;
END
$$;
