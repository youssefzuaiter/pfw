import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convertWeiToAgorot, etherStringToWei, weiToEtherString } from "../../src/lib/crypto/token-units";
import { createAdminClient } from "../../src/server/db/admin-client";
import { createCryptoWallet, deleteCryptoWallet, getCryptoWalletById, listCryptoWallets } from "../../src/server/dal/crypto-wallets";
import { getLatestCryptoRate, upsertCryptoRate } from "../../src/server/dal/crypto-prices";

/**
 * Integration coverage for the Advanced Crypto & On-Chain Asset Tracking
 * module's server-side wiring (AGENTS.md §3w). The pure 18-decimal
 * precision math (`src/lib/crypto/token-units.ts`) already has thorough
 * unit coverage — what THIS suite specifically targets (per the task's
 * own explicit ask) is that precision survives a REAL round trip through
 * Postgres: a `BigInt` column (`CryptoWallet.cumulativeGasFeesWei`), a
 * widened `Decimal(30, 18)` column (`PortfolioHolding.quantity`,
 * `Trade.quantity`), and a `Decimal(20, 6)` rate column
 * (`CryptoAssetPrice.rate`) feeding the real wei-to-agorot conversion —
 * none of which a pure unit test touching only JS `bigint`/`number`
 * values can prove on its own.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("Advanced Crypto & On-Chain Asset Tracking", () => {
  let admin: ReturnType<typeof createAdminClient>;
  let userA: { id: string };
  let userB: { id: string };

  beforeAll(async () => {
    admin = createAdminClient();
    userA = await admin.user.create({
      data: { email: `crypto-wallet-test-a-${Date.now()}@pfw.local`, displayName: "Crypto Test A" },
    });
    userB = await admin.user.create({
      data: { email: `crypto-wallet-test-b-${Date.now()}@pfw.local`, displayName: "Crypto Test B" },
    });
  });

  afterAll(async () => {
    await admin.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
    await admin.cryptoAssetPrice.deleteMany({ where: { symbol: "PFWTEST" } });
    await admin.$disconnect();
  });

  describe("18-decimal precision through a real Postgres round trip", () => {
    it("CryptoWallet.cumulativeGasFeesWei (BigInt) preserves an 18-decimal-derived wei value exactly", async () => {
      // A genuinely fractional-ETH gas amount, carried all the way to the 18th decimal digit.
      const wei = etherStringToWei("0.123456789012345678");
      const result = await createCryptoWallet(userA.id, {
        // All-lowercase, not the fixture's original all-uppercase form —
        // §3w's amendment (EIP-55 checksum validation, Punch List Phase 3
        // item 3) verified live that `viem`'s strict `isAddress` accepts
        // all-lowercase (no checksum info to violate) but genuinely
        // REJECTS an all-uppercase address unless it happens to equal its
        // own true (mixed-case) checksum, which this one never did — this
        // test's own subject (wei precision) has nothing to do with
        // address casing, so lowercase is the simplest correct fixture.
        address: "0x1ad7c10de6a97ad325ef1bff74f5b47a448885c7",
        label: "Precision Test Wallet",
        cumulativeGasFeesWei: wei,
      });
      expect(result.ok).toBe(true);

      const raw = await admin.$queryRaw<{ cumulativeGasFeesWei: bigint }[]>`
        SELECT "cumulativeGasFeesWei" FROM "CryptoWallet" WHERE "userId" = ${userA.id} AND label = 'Precision Test Wallet'
      `;
      expect(raw[0].cumulativeGasFeesWei).toBe(wei);
      expect(weiToEtherString(raw[0].cumulativeGasFeesWei)).toBe("0.123456789012345678");
    });

    it("PortfolioHolding.quantity (Decimal(30,18)) stores and reads back an 18-fractional-digit quantity with zero truncation", async () => {
      const holding = await admin.portfolioHolding.create({
        data: {
          userId: userA.id,
          symbol: "PFWTEST",
          assetClass: "CRYPTO",
          quantity: "0.123456789012345678",
          totalCostBasis: 100_00n,
          nativeCostBasis: 100_00n,
        },
      });

      const reread = await admin.portfolioHolding.findUniqueOrThrow({ where: { id: holding.id } });
      expect(reread.quantity.toString()).toBe("0.123456789012345678");

      await admin.portfolioHolding.delete({ where: { id: holding.id } });
    });

    it("convertWeiToAgorot, fed a REAL Decimal(20,6) rate read back from Postgres, produces the exact expected agorot figure", async () => {
      await upsertCryptoRate({ symbol: "PFWTEST", rate: 12_345.678901, asOfDate: new Date(), source: "test" });
      const rate = await getLatestCryptoRate("PFWTEST");

      // 2.5 ETH-equivalent at the real stored rate.
      const wei = etherStringToWei("2.5");
      const result = convertWeiToAgorot(wei, rate);

      // Hand-computed expectation: 2.5 * 12345.678901 = 30864.1972525 ILS -> 3,086,419.72525 agorot -> rounds to 3,086,420.
      expect(result).toBe(3_086_420);
    });

    it("a whale-sized wei balance survives the full DB-rate-then-conversion pipeline without precision loss", async () => {
      // `asOfDate` is a `@db.Date` column (date only, no time component),
      // so upserting with "now" again on the same calendar day the
      // previous test already used correctly OVERWRITES that same row
      // (@@unique([symbol, asOfDate])) rather than creating a second
      // one — exactly the real "syncing again today updates today's
      // rate" behavior. An earlier draft used tomorrow's date instead,
      // intending to avoid that overwrite, which instead tripped
      // `getLatestCryptoRate`'s `asOfDate: { lte: now }` filter (a
      // future-dated rate is correctly excluded — you can't have
      // "today's" rate be one dated tomorrow) and silently read back
      // the PREVIOUS test's rate instead, caught by this test's own
      // assertion failing, not by inspection.
      await upsertCryptoRate({ symbol: "PFWTEST", rate: 10_000, asOfDate: new Date(), source: "test" });
      const rate = await getLatestCryptoRate("PFWTEST");

      const wei = 50_000n * 10n ** 18n; // 50,000 whole units — far beyond Number.MAX_SAFE_INTEGER in wei form
      const result = convertWeiToAgorot(wei, rate);
      expect(result).toBe(50_000 * 10_000 * 100); // 50,000 units * ₪10,000 * 100 agorot/ILS
    });
  });

  describe("createCryptoWallet / listCryptoWallets / deleteCryptoWallet", () => {
    it("creates a wallet with a normalized (lowercased) address", async () => {
      // The REAL EIP-55 checksum casing for this address (verified via
      // `toChecksumEvmAddress`, not hand-typed) — an all-uppercase input
      // (this fixture's form before §3w's amendment added checksum
      // validation) is now correctly REJECTED rather than accepted, so a
      // genuinely valid mixed-case address is what actually exercises
      // "accept a validly-checksummed address, then normalize it."
      const result = await createCryptoWallet(userA.id, {
        address: "0xabCDEF1234567890ABcDEF1234567890aBCDeF12",
        label: "Mixed Case Wallet",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.wallet?.address).toBe("0xabcdef1234567890abcdef1234567890abcdef12");
      }
    });

    it("rejects a malformed address without writing anything", async () => {
      const before = await listCryptoWallets(userA.id);
      const result = await createCryptoWallet(userA.id, { address: "not-an-address", label: "Bad" });
      expect(result).toEqual({ ok: false, error: "invalid_address" });
      const after = await listCryptoWallets(userA.id);
      expect(after).toHaveLength(before.length);
    });

    it("rejects tracking the same (address, chainId) twice for the same user", async () => {
      const address = "0x222222222222222222222222222222222222222b";
      await createCryptoWallet(userA.id, { address, label: "First" });
      const second = await createCryptoWallet(userA.id, { address, label: "Duplicate" });
      expect(second).toEqual({ ok: false, error: "already_tracked" });
    });

    it("the SAME address can be tracked independently by two different users", async () => {
      const address = "0x333333333333333333333333333333333333333c";
      const resultA = await createCryptoWallet(userA.id, { address, label: "User A copy" });
      const resultB = await createCryptoWallet(userB.id, { address, label: "User B copy" });
      expect(resultA.ok).toBe(true);
      expect(resultB.ok).toBe(true);
    });

    it("does not leak user A's wallets into user B's list (IDOR)", async () => {
      const walletsA = await listCryptoWallets(userA.id);
      const walletsB = await listCryptoWallets(userB.id);
      const addressesA = new Set(walletsA.map((w) => w.id));
      const addressesB = new Set(walletsB.map((w) => w.id));
      expect([...addressesA].some((id) => addressesB.has(id))).toBe(false);
    });

    it("deleteCryptoWallet on another user's wallet returns not_found rather than deleting it (IDOR)", async () => {
      const created = await createCryptoWallet(userA.id, {
        address: "0x444444444444444444444444444444444444444d",
        label: "Protected",
      });
      expect(created.ok).toBe(true);
      const walletId = created.ok ? created.wallet?.id : undefined;
      expect(walletId).toBeDefined();

      const deleteAttempt = await deleteCryptoWallet(userB.id, walletId!);
      expect(deleteAttempt).toEqual({ ok: false, error: "not_found" });

      const stillThere = await getCryptoWalletById(userA.id, walletId!);
      expect(stillThere).not.toBeNull();
    });

    it("deleteCryptoWallet by the real owner actually removes it", async () => {
      const created = await createCryptoWallet(userA.id, {
        address: "0x555555555555555555555555555555555555555e",
        label: "To Delete",
      });
      const walletId = created.ok ? created.wallet?.id : undefined;
      expect(walletId).toBeDefined();

      const result = await deleteCryptoWallet(userA.id, walletId!);
      expect(result).toEqual({ ok: true });

      const gone = await getCryptoWalletById(userA.id, walletId!);
      expect(gone).toBeNull();
    });
  });
});
