-- Administration A2-A: business profile (docs/administration-a2.md §3.2, §4). Additive only: new nullable
-- columns on businesses, a version for optimistic concurrency, format checks, a time-zone guard and
-- column grants so tenant code can edit the profile. Row-Level Security on businesses is unchanged
-- (tenant_isolation binds every row to app.business_id). Runs as bos_owner.

-- AlterTable
ALTER TABLE "businesses" ADD COLUMN     "address_city" TEXT,
ADD COLUMN     "address_country_code" CHAR(2),
ADD COLUMN     "address_line1" TEXT,
ADD COLUMN     "address_line2" TEXT,
ADD COLUMN     "address_postal_code" TEXT,
ADD COLUMN     "address_region" TEXT,
ADD COLUMN     "contact_email" TEXT,
ADD COLUMN     "contact_phone" TEXT,
ADD COLUMN     "fiscal_year_start_month" SMALLINT,
ADD COLUMN     "trading_name" TEXT,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "website" TEXT;

-- ---------------------------------------------------------------------------------------------
-- Integrity checks that hold whatever code writes. The API checks the same rules first and answers
-- 400 with field names; these are the backstops.
ALTER TABLE "businesses"
  ADD CONSTRAINT businesses_legal_name_length CHECK ("legal_name" IS NULL OR char_length("legal_name") BETWEEN 1 AND 200),
  ADD CONSTRAINT businesses_trading_name_length CHECK ("trading_name" IS NULL OR char_length("trading_name") BETWEEN 1 AND 200),
  ADD CONSTRAINT businesses_contact_email_format CHECK ("contact_email" IS NULL OR (char_length("contact_email") <= 254 AND "contact_email" ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  ADD CONSTRAINT businesses_contact_phone_length CHECK ("contact_phone" IS NULL OR char_length("contact_phone") BETWEEN 1 AND 50),
  ADD CONSTRAINT businesses_website_format CHECK ("website" IS NULL OR (char_length("website") <= 300 AND "website" ~ '^https?://[^\s/$.?#][^\s]*$')),
  ADD CONSTRAINT businesses_address_lengths CHECK (
    ("address_line1" IS NULL OR char_length("address_line1") BETWEEN 1 AND 200)
    AND ("address_line2" IS NULL OR char_length("address_line2") BETWEEN 1 AND 200)
    AND ("address_city" IS NULL OR char_length("address_city") BETWEEN 1 AND 100)
    AND ("address_region" IS NULL OR char_length("address_region") BETWEEN 1 AND 100)
    AND ("address_postal_code" IS NULL OR char_length("address_postal_code") BETWEEN 1 AND 20)),
  ADD CONSTRAINT businesses_address_country_format CHECK ("address_country_code" IS NULL OR "address_country_code" ~ '^[A-Z]{2}$'),
  ADD CONSTRAINT businesses_fiscal_year_start_month_range CHECK ("fiscal_year_start_month" IS NULL OR "fiscal_year_start_month" BETWEEN 1 AND 12),
  ADD CONSTRAINT businesses_version_positive CHECK ("version" > 0);

-- The time zone must be one PostgreSQL knows (the same rule app_private.create_business applies at
-- creation). A CHECK cannot read pg_timezone_names, so this is a trigger, and only on change.
CREATE FUNCTION public.businesses_time_zone_known() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.time_zone IS DISTINCT FROM OLD.time_zone
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names t WHERE t.name = NEW.time_zone) THEN
    RAISE EXCEPTION 'unknown time zone' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER businesses_time_zone_known BEFORE UPDATE OF "time_zone" ON "businesses"
  FOR EACH ROW EXECUTE FUNCTION public.businesses_time_zone_known();

-- ---------------------------------------------------------------------------------------------
-- Least privilege: tenant code may edit the profile and regional settings, nothing else. The slug,
-- home region, archive state and id stay out of reach (no grant). business:manage is checked in
-- the API; RLS keeps every update inside the current business.
GRANT UPDATE (
  "trading_name", "contact_email", "contact_phone", "website",
  "address_line1", "address_line2", "address_city", "address_region", "address_postal_code", "address_country_code",
  "country_code", "time_zone", "locale", "currency", "fiscal_year_start_month", "version"
) ON "businesses" TO bos_app;
