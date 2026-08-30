import { agorot } from "../../../lib/money";
import { INTL_DEFAULT_ANNUAL_ALLOWANCE_AGOROT, INTL_DEFAULT_FLAT_RATE } from "../../../lib/tax-rules";
import { getCurrentUser } from "../../../server/auth/current-user";
import { buildTaxSimulation, serializeTaxSimulation } from "../../../server/tax/build-tax-data";
import { TaxSimulator } from "../_components/tax-simulator";
import { TradingNav } from "../_components/trading-nav";

export const instant = false;

export default async function TaxPage() {
  const user = await getCurrentUser();

  const data = await buildTaxSimulation(
    user.id,
    "FIFO",
    "US",
    agorot(0),
    false,
    0,
    INTL_DEFAULT_ANNUAL_ALLOWANCE_AGOROT,
    INTL_DEFAULT_FLAT_RATE,
  );

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-6 md:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-semibold text-fg">Tax &amp; Capital Gains</h1>
        <TradingNav active="tax" />
      </div>

      <p className="text-sm text-muted">
        A cost-basis and holding-period simulator over your simulated trade history — FIFO or LIFO lot accounting,
        short/long-term classification, and a multi-jurisdiction capital-gains tax estimate. This is a simulation
        against your mock trades, not a real tax filing.
      </p>

      <TaxSimulator initialData={serializeTaxSimulation(data)} />
    </div>
  );
}
