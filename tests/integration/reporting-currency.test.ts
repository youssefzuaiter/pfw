import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminClient } from "../../src/server/db/admin-client";
import { getReportingCurrency, updateUserSettings } from "../../src/server/dal/user-settings";
import { getReportingContext, getReportingFormatter } from "../../src/server/reporting/reporting-context";
import { FALLBACK_RATES } from "../../src/lib/exchange-rate";
import { formatReportingAmount } from "../../src/lib/reporting-currency";
import { agorot } from "../../src/lib/money";

/**
 * The reporting currency against real Postgres with RLS (AGENTS.md §3nnn):
 * the setting's default, one user's choice never reaching another's, and the
 * rate the context carries being the newest stored one (or the fallback, said
 * to be one). `ExchangeRate` is a shared table, so the expected rate is read
 * from it rather than written into it.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.APP_DATABASE_URL)("reporting currency", () => {
  let admin: ReturnType<typeof createAdminClient>;
  let shekelUser: { id: string };
  let dollarUser: { id: string };

  beforeAll(async () => {
    admin = createAdminClient();
    const stamp = Date.now();
    shekelUser = await admin.user.create({ data: { email: `reporting-ils-${stamp}@pfw.local`, displayName: "Shekels" } });
    dollarUser = await admin.user.create({ data: { email: `reporting-usd-${stamp}@pfw.local`, displayName: "Dollars" } });
    await updateUserSettings(dollarUser.id, { reportingCurrency: "USD" });
  });

  afterAll(async () => {
    await admin.user.deleteMany({ where: { id: { in: [shekelUser.id, dollarUser.id] } } });
    await admin.$disconnect();
  });

  it("is shekels for a user who never chose, with no settings row created by asking", async () => {
    expect(await getReportingCurrency(shekelUser.id)).toBe("ILS");
    expect(await getReportingContext(shekelUser.id)).toEqual({ currency: "ILS", ilsPerUnit: 1, rateDay: null });
    expect(await admin.userSettings.count({ where: { userId: shekelUser.id } })).toBe(0);
  });

  it("is the chosen currency at the newest stored rate, and never another user's choice", async () => {
    expect(await getReportingCurrency(dollarUser.id)).toBe("USD");
    expect(await getReportingCurrency(shekelUser.id)).toBe("ILS");

    const latest = await admin.exchangeRate.findFirst({
      where: { currency: "USD", asOfDate: { lte: new Date() } },
      orderBy: { asOfDate: "desc" },
    });
    const context = await getReportingContext(dollarUser.id);
    expect(context.currency).toBe("USD");
    if (latest) {
      expect(context.ilsPerUnit).toBe(Number(latest.rate));
      expect(context.rateDay).toBe(latest.asOfDate.toISOString().slice(0, 10));
    } else {
      expect(context.ilsPerUnit).toBe(FALLBACK_RATES.USD);
      expect(context.rateDay).toBeNull();
    }

    const format = await getReportingFormatter(dollarUser.id);
    expect(format(agorot(123_456))).toBe(formatReportingAmount(agorot(123_456), context));
    expect(format(agorot(123_456))).toMatch(/^\$/);
  });

  it("cannot read another user's choice through row-level security", async () => {
    // The DAL scopes by the caller; asking as one user for the other's row finds nothing and falls back.
    const rowSeenByStranger = await admin.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_user_id', ${shekelUser.id}, true)`;
      await tx.$executeRaw`SET LOCAL ROLE pfw_runtime`;
      return tx.userSettings.findUnique({ where: { userId: dollarUser.id } });
    });
    expect(rowSeenByStranger).toBeNull();
  });
});
