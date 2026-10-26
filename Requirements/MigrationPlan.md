# Migration Plan

## Identification

- Migration/version: `0001_InitialSchema.sql`
- Requirement IDs: INF-001, INF-002, BEH-003, BEH-008, BEH-012, BEH-013, BEH-014, DAT-001, DAT-004, SEC-001, SEC-002, DEC-008, DEC-009
- Current schema version: none (new database)
- Target schema version: 1
- Target environment: new Azure Database for PostgreSQL Flexible Server for Opportunity Finder (not yet created). Locally, disposable test databases only.
- Approval to generate: architecture approved 23 Oct 2026 ("go ahead, start the platform build")
- Approval to execute: disposable local test databases only. Running against the Azure database needs separate approval when it exists.

## Changes

| Operation | Compatibility | Lock/rewrite risk | Data-loss risk | Validation |
|---|---|---|---|---|
| Create 17 tables, constraints, indexes | New database; nothing depends on it | None (empty tables) | None | `Tests/Db/schema.test.js` on a clean database |
| Insert the single `service_setting` row | New | None | None | STR-001 test checks one row |
| Seed `approved_model` (separate script, upsert) | Idempotent | None | None | `Tests/Db/seed.test.js` runs it twice |

## Data movement/backfill

- Volume estimate: none. The trial outputs under `Backend/Output/` are not imported.
- Batch and restart strategy: not applicable.
- Idempotency: the runner records each file in `schema_migration` with a SHA-256 hash and skips applied files; an edited file is refused.
- Completion checks: `npm run migrate -- --status` shows 0001 applied and nothing pending.

## Deployment sequence

1. Create the Flexible Server and database (Bicep), with Entra or a migration role that owns the schema.
2. Run `npm run migrate` as the deployment job, never from API startup.
3. Run `npm run seed`.
4. Grant the runtime role SELECT/INSERT/UPDATE/DELETE only.
5. Deploy the API and worker.

## Rollback or roll-forward

- Strategy: new database with no data, so rollback is dropping and recreating it before go-live. After go-live, roll forward with a new numbered migration; never edit 0001.
- Point of no return: the first company invitation (real personal data then exists).
- Backup/restore prerequisite: Flexible Server automated backups switched on before the first invitation.

## Monitoring and stop conditions

- Metrics/logs: migration job exit code and its `[migrate]` lines (no connection string is printed).
- Stop conditions: any failed statement (the file's transaction rolls back), a hash mismatch, or the advisory lock held by another runner.
- Responsible person: Unassigned

## 0002_ProgrammeKey.sql (DEC-011)

| Operation | Compatibility | Lock/rewrite risk | Data-loss risk | Validation |
|---|---|---|---|---|
| Create `programme_llm_credential` (single row, FK to `approved_model`) | New table; old code ignores it | None | None | `api.test.js` DEC-011 key test |
| Add `service_setting.free_period_until` (nullable) and `programme_model_monthly_cap_usd` (default 100) | Old code ignores both; NULL means no free period | Brief ACCESS EXCLUSIVE on a one-row table; no rewrite (constant default) | None | `weekly.test.js` DEC-011 tests |
| Add `search_run.paid_by` (default `'company'`) | Existing runs read as company-paid, which they were | Brief lock; no rewrite (constant default) | None | Cost card test |
| Replace `ck_search_run_skip_reason` with a wider list | Every existing value still passes | Validates existing rows under a short lock | None | Free period skip tests |

- Order: run the migrations, then deploy the new image. `0003_ProgrammeKeyGrants.sql` grants `of_api` and `of_worker` the new table and columns when those roles exist (skipped on a fresh install, where `Infra/database-roles.sql` grants them). Old code keeps working between the two.
- `0003` was added rather than editing `0002`, which was already applied to the dev database and is checked by hash.
- The header comments of `0002` and `0003` say DEC-010; the free period is DEC-011 (DEC-010 is the email sender). They are left as written because applied migrations are checked by hash.
- Rollback: forward-only. If needed, clear `free_period_until` on the admin page; the columns and table can stay.
- Execution: applied to the local `opportunity_finder_dev` database and disposable test databases only, 23 Oct 2026.

## 0004_RegionScopes.sql (DEC-013)

| Operation | Compatibility | Lock/rewrite risk | Data-loss risk | Validation |
|---|---|---|---|---|
| Rewrite `company_profile.regions` that are not one of the three scopes to the smallest scope covering them | The worker and profile form already read older values this way (`scopeRegions`), so no company's searches change | Row updates on a table of one row per saved profile version; small | Earlier versions lose their exact original combination (for example `{UK}` becomes `{NI,UK}`). Accepted: no deployed data exists, and the old value had no remaining effect | `schema.test.js` "DEC-013 upgrading…" (applies 0001 to 0003, inserts seven older combinations, applies 0004) |
| Replace `ck_company_profile_regions` with the three canonical arrays | Every row passes after the rewrite | Validates existing rows under a short ACCESS EXCLUSIVE lock | None | `schema.test.js` "DEC-013 regions must be one of the three scopes…" |

- Order: deploy the new image first, then run the migration. The old API accepts combinations the new check rejects (for example `{NI}`), so running the migration first would turn those saves into errors until the image is updated. The new code works with the old check.
- Rollback: forward-only. To relax it, a later migration can restore the old check; the rewritten rows stay valid under it.
- Execution: applied to the local `opportunity_finder_dev` database and disposable test databases only, 24 Oct 2026.

## 0005_CompanyRename.sql (INF-001)

| Operation | Compatibility | Lock/rewrite risk | Data-loss risk | Validation |
|---|---|---|---|---|
| `GRANT UPDATE (name) ON company TO of_api` (skipped where the role does not exist) | Additive; the old image never updates `name` | Catalog change only | None | `api.test.js` "INF-001 a programme admin can rename a company…" (via `Infra/database-roles.sql`, which repeats it) |

- Order: either. Run the migration before using Rename on the admin page, otherwise the rename returns an error.
- Rollback: `REVOKE UPDATE (name) ON company FROM of_api`.
- Execution: applied to local `opportunity_finder_dev` and test databases, 26 Oct 2026.

## Verification evidence

- Clean install result: passed on a disposable local PostgreSQL 16.15 database, 23 Oct 2026 (`npm run test:db`, 7 pass).
- Upgrade test result: 0004 tested as an upgrade from 0003 with older profile rows (DEC-013 test). Re-running applies nothing (STR-001 test).
- Representative-data validation: synthetic tenants in the tests; tenant-safe foreign keys reject cross-company rows.
- Execution result: not run against any non-disposable database.
