-- INF-001: a programme admin can archive a company that is finished with,
-- such as a test company, when it has records of its own and so cannot be
-- deleted. Archived companies are left out of the weekly run (no run row at
-- all) and listed apart on the admin page; nothing of theirs is removed.
-- The company table is small, so re-checking the constraint is instant.
ALTER TABLE company DROP CONSTRAINT ck_company_status;
ALTER TABLE company ADD CONSTRAINT ck_company_status CHECK (status IN ('active', 'paused', 'archived'));
