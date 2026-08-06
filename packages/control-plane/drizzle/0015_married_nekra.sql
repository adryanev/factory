ALTER TABLE "webhook_deliveries" ALTER COLUMN "payload" DROP NOT NULL;--> statement-breakpoint
-- Backfill (issue #23): rows the old sweep already marked purged keep their
-- payload forever — the candidate SELECT only re-selects `purged_at IS NULL`
-- rows, so nothing would ever reclaim their bytes. Clear them now, guarded
-- by the exact predicate the new candidate uses (`processed_at IS NOT NULL`):
-- a delivery that is still unmapped keeps its payload no matter how old.
UPDATE "webhook_deliveries" SET "payload" = NULL WHERE "payload" IS NOT NULL AND "purged_at" IS NOT NULL AND "processed_at" IS NOT NULL;
