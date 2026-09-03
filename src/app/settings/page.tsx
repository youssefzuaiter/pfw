import { getCurrentUser } from "../../server/auth/current-user";
import { getMfaStatus } from "../../server/dal/mfa";
import { getOrCreateUserSettings } from "../../server/dal/user-settings";
import { EmailVerificationPanel } from "./_components/email-verification-panel";
import { MfaPanel } from "./_components/mfa-panel";
import { PreferencesForm, type PreferencesFormData } from "./_components/preferences-form";
import { RevokeSessionsButton } from "./_components/revoke-sessions-button";

export const instant = false;

/**
 * Account settings (Punch List Tier 2): global preferences
 * (`UserSettings`, item 1), two-factor authentication (`MfaPanel`, item
 * 3), and server-side session revocation (`RevokeSessionsButton`, item
 * 2) — one screen, reachable via a direct link from `TopNav`/`MobileNav`
 * next to `SignOutButton` (account-level functionality, same placement
 * reasoning as sign-out itself) rather than `PRIMARY_NAV_ITEMS`, matching
 * this app's "sub-view, not one of the spec's 9 primary destinations"
 * pattern used for `/vault`, `/analytics`, `/trading/portfolio`, etc.
 */
export default async function SettingsPage() {
  const user = await getCurrentUser();
  const [mfaStatus, settings] = await Promise.all([getMfaStatus(user.id), getOrCreateUserSettings(user.id)]);

  const initialPreferences: PreferencesFormData = {
    taxJurisdiction: settings.taxJurisdiction,
    taxMethod: settings.taxMethod,
    taxOtherOrdinaryIncome: Number(settings.taxOtherOrdinaryIncomeAgorot) / 100,
    taxIncludeNiit: settings.taxIncludeNiit,
    taxChurchTaxRate: settings.taxChurchTaxRate,
    taxAnnualAllowance: settings.taxAnnualAllowanceAgorot === null ? null : Number(settings.taxAnnualAllowanceAgorot) / 100,
    taxFlatRatePercent: settings.taxFlatRatePercent,
    monteCarloRetirementAge: settings.monteCarloRetirementAge,
    monteCarloTargetAnnualSpend:
      settings.monteCarloTargetAnnualSpendAgorot === null ? null : Number(settings.monteCarloTargetAnnualSpendAgorot) / 100,
    monteCarloVolatilityMultiplier: settings.monteCarloVolatilityMultiplier,
    defaultManualAssetLiquidityTier: settings.defaultManualAssetLiquidityTier,
    preferredCurrencyDisplay: settings.preferredCurrencyDisplay,
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6 md:px-6">
      <div>
        <h1 className="font-display text-2xl font-semibold text-fg">Settings</h1>
        <p className="mt-1 text-sm text-muted">{user.displayName} — {user.email}</p>
      </div>

      <div>
        <h2 className="text-base font-semibold text-fg">Security</h2>
        <div className="mt-2 flex flex-col gap-3">
          <EmailVerificationPanel initialVerified={user.emailVerified !== null} />
          <MfaPanel initialEnabled={mfaStatus.enabled} initialPending={mfaStatus.pending} />
          <RevokeSessionsButton />
        </div>
      </div>

      <div>
        <h2 className="text-base font-semibold text-fg">Preferences</h2>
        <div className="mt-2">
          <PreferencesForm initial={initialPreferences} />
        </div>
      </div>
    </div>
  );
}
