/**
 * Manual/cron entry point for the `ENCRYPTION_KEY` rotation sweep
 * (src/server/crypto/key-rotation.ts, docs/SECURITY-CHECKLIST.md's
 * "Secret rotation & storage guidelines"). `GET /api/cron` already calls
 * the same underlying function every night — this script exists for the
 * same reason `sync-crypto-prices.ts`/`sync-exchange-rates.ts` do: an
 * operator who wants to run it right now, watch it happen, and not wait
 * for the next scheduled cron tick.
 *
 * Run with: npm run rotate:encryption-key
 *
 * Does nothing (zero database access) unless `ENCRYPTION_KEY_NEXT` is
 * set — see that env var's own doc comment in src/server/env.ts for the
 * full rotation procedure: set it, run this (or wait for cron) until it
 * reports zero rows remaining, THEN set `ENCRYPTION_KEY` to the same
 * value and remove `ENCRYPTION_KEY_NEXT`.
 *
 * Needs `--conditions=react-server` like every other standalone script
 * that reaches into src/server/** — see AGENTS.md's deviations list.
 */
import "dotenv/config";
import { runEncryptionKeyRotationSweep } from "../src/server/crypto/key-rotation";

async function main() {
  const result = await runEncryptionKeyRotationSweep();

  if (!result.ok) {
    console.error(`Encryption key rotation sweep FAILED: ${result.error}`);
    process.exitCode = 1;
    return;
  }

  if (!result.inProgress) {
    console.log("No rotation in progress (ENCRYPTION_KEY_NEXT is unset) — nothing to do.");
    return;
  }

  console.log(`Re-encrypted ${result.reencrypted} row(s) this run.`);
  if (result.failed > 0) {
    console.error(`${result.failed} row(s) FAILED to re-encrypt — see the log lines above for which ones.`);
  }
  if (result.remaining > 0) {
    console.log(`${result.remaining} row(s) still remain on the old key — run this again (or wait for tonight's cron) to continue.`);
  } else {
    console.log(
      "0 rows remain on the old key. It is now safe to set ENCRYPTION_KEY to the same value as " +
        "ENCRYPTION_KEY_NEXT and remove ENCRYPTION_KEY_NEXT — the rotation is complete.",
    );
  }

  if (result.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
