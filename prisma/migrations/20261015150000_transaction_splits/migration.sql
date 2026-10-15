-- Split transactions (AGENTS.md §3xxx): one category's share of a
-- transaction whose amount is divided across several categories. The
-- NotableTransaction keeps the money; these rows only say how it divides.

-- CreateTable
CREATE TABLE "TransactionSplit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "nativeAmount" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransactionSplit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TransactionSplit_userId_categoryId_idx" ON "TransactionSplit"("userId", "categoryId");

-- CreateIndex
CREATE INDEX "TransactionSplit_userId_transactionId_idx" ON "TransactionSplit"("userId", "transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "TransactionSplit_transactionId_categoryId_key" ON "TransactionSplit"("transactionId", "categoryId");

-- AddForeignKey
ALTER TABLE "TransactionSplit" ADD CONSTRAINT "TransactionSplit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionSplit" ADD CONSTRAINT "TransactionSplit_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "NotableTransaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionSplit" ADD CONSTRAINT "TransactionSplit_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE NO ACTION ON UPDATE CASCADE;


-- Per-user data: the standard tenant_isolation policy, FORCEd.
ALTER TABLE "TransactionSplit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TransactionSplit" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "TransactionSplit"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

-- Both grants stated outright (default privileges attach only to the role
-- that declared them; see 20261013200000_phone_alerts).
GRANT SELECT, INSERT, UPDATE, DELETE ON "TransactionSplit" TO pfw_runtime;
GRANT SELECT ON "TransactionSplit" TO backup_reader;

-- The invariant, enforced by the database and not only by the app: a
-- transaction has no splits, or at least two that each carry its sign, belong
-- to its owner, and add up to its `amount` and `nativeAmount` exactly.
--
-- DEFERRED to commit time, because replacing a transaction's splits deletes
-- the old rows and inserts the new ones, and every statement in between is
-- legitimately unbalanced. A transaction that no longer exists (deleted with
-- its account) passes: its splits went with it.
CREATE OR REPLACE FUNCTION pfw_check_transaction_splits(target_id TEXT) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  parent RECORD;
  split_count INTEGER;
  amount_sum NUMERIC;
  native_sum NUMERIC;
  bad_rows INTEGER;
BEGIN
  SELECT "userId", "amount", "nativeAmount" INTO parent FROM "NotableTransaction" WHERE "id" = target_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT COUNT(*), COALESCE(SUM("amount"), 0), COALESCE(SUM("nativeAmount"), 0)
    INTO split_count, amount_sum, native_sum
    FROM "TransactionSplit" WHERE "transactionId" = target_id;
  IF split_count = 0 THEN RETURN; END IF;

  SELECT COUNT(*) INTO bad_rows FROM "TransactionSplit"
   WHERE "transactionId" = target_id
     AND ("userId" <> parent."userId"
          OR "amount" = 0 OR "nativeAmount" = 0
          OR sign("amount") <> sign(parent."amount")
          OR sign("nativeAmount") <> sign(parent."nativeAmount"));

  IF split_count < 2 THEN
    RAISE EXCEPTION 'TransactionSplit: transaction % has only one split', target_id USING ERRCODE = 'check_violation';
  END IF;
  IF bad_rows > 0 THEN
    RAISE EXCEPTION 'TransactionSplit: transaction % has a split with the wrong owner, a zero amount, or the wrong sign', target_id USING ERRCODE = 'check_violation';
  END IF;
  IF amount_sum <> parent."amount" OR native_sum <> parent."nativeAmount" THEN
    RAISE EXCEPTION 'TransactionSplit: splits of transaction % add up to % agorot (% native), not % (% native)',
      target_id, amount_sum, native_sum, parent."amount", parent."nativeAmount" USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pfw_transaction_split_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN PERFORM pfw_check_transaction_splits(NEW."transactionId"); END IF;
  IF TG_OP IN ('DELETE', 'UPDATE') THEN PERFORM pfw_check_transaction_splits(OLD."transactionId"); END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION pfw_transaction_amount_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pfw_check_transaction_splits(NEW."id");
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER transaction_split_sum
  AFTER INSERT OR UPDATE OR DELETE ON "TransactionSplit"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION pfw_transaction_split_changed();

CREATE CONSTRAINT TRIGGER transaction_amount_matches_splits
  AFTER UPDATE OF "amount", "nativeAmount" ON "NotableTransaction"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION pfw_transaction_amount_changed();
