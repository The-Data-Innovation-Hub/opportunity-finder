-- DEC-013: a profile's regions are one of three scopes, each including
-- Northern Ireland, stored in this canonical order:
--   UK and Ireland {NI,IE,UK}, UK only {NI,UK}, Ireland and NI only {NI,IE}.
--
-- Profiles saved before DEC-013 may hold any combination. Each is rewritten
-- to the smallest scope that covers it, which is how the worker and the
-- profile form already read them (scopeRegions in Worker/Research/search.js),
-- so no company's searches change. The table is one row per saved profile
-- version, so the rewrite and the check's scan are small.
UPDATE company_profile SET regions = CASE
		WHEN 'UK' = ANY(regions) AND 'IE' = ANY(regions) THEN ARRAY['NI', 'IE', 'UK']
		WHEN 'UK' = ANY(regions) THEN ARRAY['NI', 'UK']
		ELSE ARRAY['NI', 'IE']
	END
WHERE regions NOT IN (ARRAY['NI', 'IE', 'UK'], ARRAY['NI', 'UK'], ARRAY['NI', 'IE']);

ALTER TABLE company_profile DROP CONSTRAINT ck_company_profile_regions;
ALTER TABLE company_profile ADD CONSTRAINT ck_company_profile_regions
	CHECK (regions IN (ARRAY['NI', 'IE', 'UK'], ARRAY['NI', 'UK'], ARRAY['NI', 'IE']));
