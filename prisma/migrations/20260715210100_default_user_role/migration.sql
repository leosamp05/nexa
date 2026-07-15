-- Existing users had ADMIN only because it was the sole enum value. Normalize
-- them before making USER the safe default; the configured seed is promoted on
-- the next web startup.
ALTER TABLE "User" ALTER COLUMN "role" SET DEFAULT 'USER';
UPDATE "User" SET "role" = 'USER';
