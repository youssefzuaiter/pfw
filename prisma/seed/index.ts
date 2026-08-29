import "dotenv/config";
import { agorot, multiplyAgorot, subtractAgorot } from "../../src/lib/money";
import { multiplyNativeAmount, nativeAmount } from "../../src/lib/currency";
import { convertNativeAmountToAgorot } from "../../src/lib/exchange-rate";
import { getMockDividendSchedule, getMockInstrument, listMockInstruments } from "../../src/lib/mock-market-data";
import { accrueInterest, bps } from "../../src/lib/apr";
import { createAdminClient } from "../../src/server/db/admin-client";
import { encryptField } from "../../src/server/crypto/field-encryption";
import {
  BANKS,
  CATEGORIES,
  EMPLOYER_NAME,
  MERCHANTS_BY_CATEGORY,
  MOCK_USD_TO_ILS_RATE,
  SEED_USER,
} from "./israeli-data";
import { SeededRng, getMonthlySeed, monthKeyFor } from "./rng";

/**
 * Deterministic mock-data generator. Re-running this script within the
 * same calendar month always makes the same random choices (amounts,
 * merchants, which categories, trade prices, ...) via the monthly-seeded
 * RNG — see rng.ts. Transaction/snapshot *dates* are still anchored to the
 * real "now" (a rolling window ending today), so a long-running demo
 * deployment always shows recent-looking activity; only the RNG-driven
 * choices are frozen for the month, not the calendar itself.
 *
 * Idempotent by wiping-and-regenerating: every run deletes any previously
 * seeded data for SEED_USER.email first, so the end state after a run is
 * fully determined by (this script + the current month), never by
 * whatever was left over from a previous run.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Shekels -> Agorot (the branded number type money.ts/apr.ts operate on). */
function ilsToAgorot(shekels: number) {
  return agorot(Math.round(shekels * 100));
}

/** Shekels -> bigint, ready to hand straight to a Prisma BigInt column. */
function ils(shekels: number): bigint {
  return BigInt(ilsToAgorot(shekels));
}

function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

const SPENDING_RANGES_ILS: Record<string, [number, number]> = {
  groceries: [30, 450],
  transport: [10, 150],
  dining: [25, 220],
  entertainment: [15, 300],
  utilities: [80, 450],
  health: [20, 600],
  shopping: [40, 900],
};

async function main() {
  const now = new Date();
  const seed = getMonthlySeed(now);
  const rng = new SeededRng(seed);
  const prisma = createAdminClient();

  console.log(`Seeding PFW mock data — month key ${monthKeyFor(now)}, RNG seed ${seed}`);

  // --- Reset: wipe any previously seeded data for this user -------------
  // AuditLog's append-only trigger blocks the cascade delete from User,
  // so it's disabled for the duration of the reset. This script runs as
  // the admin (superuser) role and is dev/seed tooling, not an
  // application-facing "delete my account" flow — see AGENTS.md.
  await prisma.$executeRaw`ALTER TABLE "AuditLog" DISABLE TRIGGER audit_log_append_only`;
  await prisma.user.deleteMany({ where: { email: SEED_USER.email } });
  await prisma.$executeRaw`ALTER TABLE "AuditLog" ENABLE TRIGGER audit_log_append_only`;

  const user = await prisma.user.create({
    data: { email: SEED_USER.email, displayName: SEED_USER.displayName },
  });

  // --- Categories ---------------------------------------------------------
  const categoryBySlug = new Map<string, { id: string }>();
  for (const def of CATEGORIES) {
    const category = await prisma.category.create({
      data: {
        userId: user.id,
        slug: def.slug,
        name: def.name,
        isUncategorized: def.slug === "uncategorized",
      },
    });
    categoryBySlug.set(def.slug, category);
  }
  const categoryId = (slug: string) => {
    const category = categoryBySlug.get(slug);
    if (!category) throw new Error(`Unknown seed category slug: ${slug}`);
    return category.id;
  };

  // --- Bank accounts --------------------------------------------------------
  const checking = await prisma.bankAccount.create({
    data: {
      userId: user.id,
      institutionName: BANKS.hapoalim,
      last4: String(rng.int(1000, 9999)),
      accountType: "CHECKING",
      nickname: 'Current Account [עו"ש]',
      nativeBalance: ils(rng.int(5_000, 25_000)),
    },
  });
  const savings = await prisma.bankAccount.create({
    data: {
      userId: user.id,
      institutionName: BANKS.leumi,
      last4: String(rng.int(1000, 9999)),
      accountType: "SAVINGS",
      nickname: "Savings [חיסכון]",
      nativeBalance: ils(rng.int(20_000, 150_000)),
    },
  });
  const creditCard = await prisma.bankAccount.create({
    data: {
      userId: user.id,
      institutionName: BANKS.isracard,
      last4: String(rng.int(1000, 9999)),
      accountType: "CREDIT_CARD",
      nickname: "Visa Cal [ויזה כאל]",
      // Credit balances are stored positive = money owed.
      nativeBalance: ils(rng.int(500, 8_000)),
    },
  });

  // --- Transactions: salary + rent (last 3 months) -------------------------
  for (let m = 0; m < 3; m++) {
    const occurredAt = daysAgo(now, m * 30);
    occurredAt.setUTCDate(1);
    // Hoisted, not inlined twice: `amount` and `nativeAmount` must be the
    // same value for an ILS-native row, and calling rng.int() a second
    // time would both desync them and consume an extra RNG draw, breaking
    // the monthly-seeded determinism every later value depends on.
    const salaryAmount = ils(rng.int(12_000, 18_000));
    await prisma.notableTransaction.create({
      data: {
        userId: user.id,
        bankAccountId: checking.id,
        categoryId: categoryId("salary"),
        providerTransactionId: `seed-salary-${m}`,
        occurredAt,
        currency: "ILS",
        amount: salaryAmount,
        nativeAmount: salaryAmount,
        description: EMPLOYER_NAME,
        merchantName: EMPLOYER_NAME,
        isManual: false,
      },
    });

    const rentDate = daysAgo(now, m * 30);
    rentDate.setUTCDate(3);
    const rentAmount = ils(-rng.int(3_500, 5_500));
    await prisma.notableTransaction.create({
      data: {
        userId: user.id,
        bankAccountId: checking.id,
        categoryId: categoryId("rent"),
        providerTransactionId: `seed-rent-${m}`,
        occurredAt: rentDate,
        currency: "ILS",
        amount: rentAmount,
        nativeAmount: rentAmount,
        description: "Monthly rent [שכירות חודשית]",
        isManual: false,
      },
    });
  }

  // --- Transactions: discretionary spending over the past 90 days --------
  const spendingCategories = CATEGORIES.filter(
    (c) => !c.isIncome && c.slug !== "uncategorized" && c.slug !== "rent",
  );
  const spendCount = rng.int(50, 70);
  let providerCounter = 1;

  for (let i = 0; i < spendCount; i++) {
    const occurredAt = daysAgo(now, rng.int(0, 89));
    const categoryDef = rng.pick(spendingCategories);
    const merchants = MERCHANTS_BY_CATEGORY[categoryDef.slug] ?? [categoryDef.name];
    const merchant = rng.pick(merchants);
    const account = rng.bool(0.6) ? creditCard : checking;
    const [min, max] = SPENDING_RANGES_ILS[categoryDef.slug] ?? [20, 200];
    const isManual = rng.bool(0.1);
    const needsReview = i < 3;
    const spendAmount = ils(-rng.int(min, max));

    await prisma.notableTransaction.create({
      data: {
        userId: user.id,
        bankAccountId: account.id,
        categoryId: needsReview ? categoryId("uncategorized") : categoryId(categoryDef.slug),
        providerTransactionId: isManual ? null : `seed-txn-${providerCounter++}`,
        occurredAt,
        currency: "ILS",
        amount: spendAmount,
        nativeAmount: spendAmount,
        description: merchant,
        merchantName: merchant,
        isManual,
        needsReview,
      },
    });
  }

  // --- Budgets --------------------------------------------------------------
  const budgetLimitsIls: Record<string, number> = {
    groceries: 2_200,
    dining: 900,
    transport: 500,
    entertainment: 400,
  };
  for (const [slug, limit] of Object.entries(budgetLimitsIls)) {
    await prisma.budget.create({
      data: { userId: user.id, categoryId: categoryId(slug), monthlyLimit: ils(limit) },
    });
  }

  // --- Goals + contributions -------------------------------------------------
  const emergencyFund = await prisma.goal.create({
    data: { userId: user.id, name: "Emergency fund [קרן חירום]", targetAmount: ils(30_000) },
  });
  for (let m = 5; m >= 1; m--) {
    await prisma.goalContribution.create({
      data: {
        userId: user.id,
        goalId: emergencyFund.id,
        amount: ils(rng.int(800, 2_000)),
        contributedAt: daysAgo(now, m * 30),
        // Deliberately seeded in the OLD server-side field-encryption
        // format, not left as plaintext or re-encrypted via zk-crypto.ts
        // (which can't run here anyway — it's browser/WebCrypto-only and
        // guarded against server-side use, tests/guards/zk-client-only.test.ts).
        // GoalContribution.note left the Prisma encrypted-fields extension
        // when the zero-knowledge vault shipped (AGENTS.md §3m), so this
        // is now the one realistic "legacy note" the seeded demo user has
        // — exactly what /goals' "Migrate N legacy note(s)" flow exists
        // to demonstrate.
        note: m === 5 ? encryptField("First deposit [הפקדה ראשונה]") : undefined,
      },
    });
  }

  const vacationGoal = await prisma.goal.create({
    data: { userId: user.id, name: 'Vacation abroad [חופשה בחו"ל]', targetAmount: ils(12_000) },
  });
  for (let m = 4; m >= 1; m--) {
    await prisma.goalContribution.create({
      data: {
        userId: user.id,
        goalId: vacationGoal.id,
        amount: ils(rng.int(500, 1_200)),
        contributedAt: daysAgo(now, m * 30),
      },
    });
  }

  // --- Debts + payments ----------------------------------------------------
  const mortgageBalanceIls = rng.int(800_000, 950_000);
  const mortgageBalance = ilsToAgorot(mortgageBalanceIls);
  const mortgageAprBps = bps(rng.int(300, 380));
  const mortgage = await prisma.debt.create({
    data: {
      userId: user.id,
      name: "Mortgage [משכנתא]",
      debtType: "MORTGAGE",
      currentBalance: BigInt(mortgageBalance),
      aprBps: mortgageAprBps,
      minimumPayment: ils(rng.int(4_000, 4_800)),
    },
  });
  for (let m = 2; m >= 0; m--) {
    const payment = ilsToAgorot(rng.int(4_000, 4_800));
    const interest = accrueInterest(mortgageBalance, mortgageAprBps);
    const principal = payment > interest ? subtractAgorot(payment, interest) : agorot(0);
    await prisma.debtPayment.create({
      data: {
        userId: user.id,
        debtId: mortgage.id,
        amount: BigInt(payment),
        interestPortion: BigInt(interest),
        principalPortion: BigInt(principal),
        paidAt: daysAgo(now, m * 30),
      },
    });
  }

  const ccDebt = await prisma.debt.create({
    data: {
      userId: user.id,
      name: "Credit card debt [חוב כרטיס אשראי]",
      debtType: "CREDIT_CARD",
      currentBalance: ils(rng.int(3_000, 9_000)),
      aprBps: bps(rng.int(1_800, 2_400)),
      minimumPayment: ils(rng.int(250, 450)),
    },
  });
  for (let m = 1; m >= 0; m--) {
    await prisma.debtPayment.create({
      data: {
        userId: user.id,
        debtId: ccDebt.id,
        amount: ils(rng.int(300, 600)),
        paidAt: daysAgo(now, m * 30),
      },
    });
  }

  // --- Manual assets ----------------------------------------------------------
  await prisma.manualAsset.create({
    data: {
      userId: user.id,
      name: "Private car [רכב פרטי]",
      assetType: "VEHICLE",
      currentValue: ils(rng.int(60_000, 110_000)),
      valuedAt: daysAgo(now, rng.int(120, 200)),
    },
  });
  const kerenLiquidityDate = new Date(now);
  kerenLiquidityDate.setUTCFullYear(kerenLiquidityDate.getUTCFullYear() + 3);
  await prisma.manualAsset.create({
    data: {
      userId: user.id,
      name: "Keren Hishtalmut [קרן השתלמות]",
      assetType: "KEREN_HISHTALMUT",
      currentValue: ils(rng.int(35_000, 60_000)),
      valuedAt: daysAgo(now, rng.int(5, 15)),
      taxAdvantaged: true,
      liquidityDate: kerenLiquidityDate,
    },
  });
  await prisma.manualAsset.create({
    data: {
      userId: user.id,
      name: "Bitcoin [ביטקוין]",
      assetType: "CRYPTO",
      currentValue: ils(rng.int(5_000, 25_000)),
      valuedAt: daysAgo(now, rng.int(0, 3)),
    },
  });

  // --- Portfolio holdings + trades --------------------------------------------
  // Deliberately spans all three asset classes so the portfolio screen's
  // allocation breakdown and dividend schedule have something real to
  // show — including a crypto position that correctly pays nothing.
  const instruments = listMockInstruments();
  const pickByClass = (assetClass: "STOCK" | "ETF" | "CRYPTO", count: number) =>
    rng.shuffle(instruments.filter((i) => i.assetClass === assetClass).map((i) => i.symbol)).slice(0, count);

  const symbols = [...pickByClass("STOCK", 3), ...pickByClass("ETF", 1), ...pickByClass("CRYPTO", 1)];

  // The rate the seeded purchases are priced at. Prefer the latest really-
  // synced rate over the fixed MOCK_USD_TO_ILS_RATE: with a fictional
  // historical rate, every seeded position shows the gap between that
  // number and today's real rate as a uniform double-digit "loss" that has
  // nothing to do with price movement — technically correct FX math, but
  // it buries the actual per-instrument performance the portfolio screen
  // exists to show. Falls back to the fixed constant when no rate has been
  // synced (offline, fresh install), so seeding never depends on network.
  const latestUsdRate = await prisma.exchangeRate.findFirst({
    where: { currency: "USD" },
    orderBy: { asOfDate: "desc" },
  });
  const purchaseRate = latestUsdRate ? Number(latestUsdRate.rate) : MOCK_USD_TO_ILS_RATE;

  for (const symbol of symbols) {
    const instrument = getMockInstrument(symbol);
    const usdBase = instrument.usdBasePrice;

    // These are US-listed instruments, natively priced in USD cents; the
    // ILS figures are that native price converted at `purchaseRate`,
    // frozen onto each Trade row as exchangeRateAtEntry.
    //
    // Crypto is bought in fractional units, not whole coins — a whole-unit
    // BTC position would be worth more than every other holding combined
    // and flatten the allocation chart into a single bar.
    const buy1Qty =
      instrument.assetClass === "CRYPTO" ? Number((rng.int(5, 40) / 100).toFixed(2)) : rng.int(2, 10);
    const buy1NativePrice = nativeAmount(Math.round(usdBase * 100));
    const buy1PriceAgorot = convertNativeAmountToAgorot(buy1NativePrice, "USD", purchaseRate);
    const buy1Total = multiplyAgorot(buy1PriceAgorot, buy1Qty);
    const buy1NativeTotal = multiplyNativeAmount(buy1NativePrice, buy1Qty);
    // Opened over a year ago on purpose: a position younger than one
    // dividend cycle would have no *paid* dividends at all, leaving the
    // portfolio screen's income and trailing-yield figures empty and the
    // feature effectively undemonstrated.
    const buy1Date = daysAgo(now, 400);

    const buy2Qty =
      instrument.assetClass === "CRYPTO" ? Number((rng.int(3, 20) / 100).toFixed(2)) : rng.int(1, 5);
    const priceDrift = 1 + (rng.float() - 0.5) * 0.1; // +/-5%
    const buy2NativePrice = nativeAmount(Math.round(usdBase * priceDrift * 100));
    const buy2PriceAgorot = convertNativeAmountToAgorot(buy2NativePrice, "USD", purchaseRate);
    const buy2Total = multiplyAgorot(buy2PriceAgorot, buy2Qty);
    const buy2NativeTotal = multiplyNativeAmount(buy2NativePrice, buy2Qty);
    const buy2Date = daysAgo(now, 120);

    const holdingQuantity = buy1Qty + buy2Qty;
    const holding = await prisma.portfolioHolding.create({
      data: {
        userId: user.id,
        symbol,
        assetClass: instrument.assetClass,
        currency: "USD",
        quantity: String(holdingQuantity),
        totalCostBasis: BigInt(buy1Total) + BigInt(buy2Total),
        nativeCostBasis: BigInt(buy1NativeTotal) + BigInt(buy2NativeTotal),
      },
    });

    await prisma.trade.create({
      data: {
        userId: user.id,
        portfolioHoldingId: holding.id,
        symbol,
        side: "BUY",
        currency: "USD",
        quantity: String(buy1Qty),
        priceAgorot: BigInt(buy1PriceAgorot),
        totalAgorot: BigInt(buy1Total),
        nativePriceAmount: BigInt(buy1NativePrice),
        nativeTotalAmount: BigInt(buy1NativeTotal),
        exchangeRateAtEntry: String(purchaseRate),
        executedAt: buy1Date,
        idempotencyKey: `seed-trade-${symbol}-1`,
      },
    });
    await prisma.trade.create({
      data: {
        userId: user.id,
        portfolioHoldingId: holding.id,
        symbol,
        side: "BUY",
        currency: "USD",
        quantity: String(buy2Qty),
        priceAgorot: BigInt(buy2PriceAgorot),
        totalAgorot: BigInt(buy2Total),
        nativePriceAmount: BigInt(buy2NativePrice),
        nativeTotalAmount: BigInt(buy2NativeTotal),
        exchangeRateAtEntry: String(purchaseRate),
        executedAt: buy2Date,
        idempotencyKey: `seed-trade-${symbol}-2`,
      },
    });

    // --- Dividends for this holding ------------------------------------
    // Only dividends whose ex-date falls after the position was actually
    // opened count — a payout the user wasn't holding for never happened
    // to them, and seeding one would inflate reported dividend income.
    for (const event of getMockDividendSchedule(symbol, now)) {
      if (event.exDate.getTime() < buy1Date.getTime()) continue;

      const alreadyPaid = event.payDate.getTime() <= now.getTime();
      if (!alreadyPaid) {
        // Announced: the payout amount is derived live from the position
        // and rate at read time, so nothing is frozen here.
        await prisma.dividend.create({
          data: {
            userId: user.id,
            portfolioHoldingId: holding.id,
            symbol,
            currency: "USD",
            amountPerShareNative: BigInt(event.amountPerShareNative),
            exDate: event.exDate,
            payDate: event.payDate,
            status: "ANNOUNCED",
          },
        });
        continue;
      }

      // Paid: freeze what was actually received, at the historical seed
      // rate — same treatment as the seeded trades above.
      const totalNative = multiplyNativeAmount(event.amountPerShareNative, holdingQuantity);
      const totalAgorot = convertNativeAmountToAgorot(totalNative, "USD", purchaseRate);
      await prisma.dividend.create({
        data: {
          userId: user.id,
          portfolioHoldingId: holding.id,
          symbol,
          currency: "USD",
          amountPerShareNative: BigInt(event.amountPerShareNative),
          exDate: event.exDate,
          payDate: event.payDate,
          status: "PAID",
          quantityAtPayment: String(holdingQuantity),
          totalNativeAmount: BigInt(totalNative),
          totalAgorot: BigInt(totalAgorot),
          exchangeRateAtEntry: String(purchaseRate),
        },
      });
    }
  }

  // --- Net worth snapshots: 90-day illustrative trend -------------------------
  // A smooth synthetic series, not reconciled to the cent with the ledger
  // above — NetWorthSnapshot is historical/illustrative; "today" is always
  // computed live by the DAL from real data (see the model's doc comment).
  let assets = rng.int(900_000, 1_100_000);
  let liabilities = rng.int(800_000, 950_000);
  for (let d = 89; d >= 0; d--) {
    assets += rng.int(-2_000, 3_000);
    liabilities += rng.int(-1_500, 500);
    const snapshotDate = daysAgo(now, d);
    await prisma.netWorthSnapshot.create({
      data: {
        userId: user.id,
        snapshotDate,
        totalAssetsAgorot: ils(assets),
        totalLiabilitiesAgorot: ils(liabilities),
        netWorthAgorot: ils(assets - liabilities),
      },
    });
  }

  console.log("Seed complete:", {
    user: user.email,
    checking: checking.id,
    savings: savings.id,
    creditCard: creditCard.id,
  });

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
});
