import "server-only";
import { createAdminClient } from "../db/admin-client";

/**
 * The Dead Man's Switch's own narrowly-scoped admin-client exception
 * (AGENTS.md §3t), same shape as src/server/groups/invite-admin-ops.ts
 * (§3s): a beneficiary holding an invite token is, by definition, not
 * the authenticated vault owner and has no row-level standing under
 * `Beneficiary`'s/`RecoveryShareSubmission`'s `tenant_isolation` RLS
 * policies (both scoped to the OWNER's `userId`, not the beneficiary's —
 * a beneficiary usually isn't even a User in this app at all). Looking a
 * beneficiary up by token hash and recording their submitted share both
 * have to happen before any row-level standing could exist, the same
 * bootstrap problem `getCurrentUser()` and the household-invite-accept
 * flow both already solve this way.
 *
 * Isolated into its own file, allowlisted in
 * tests/guards/admin-client-boundary.test.ts, so the actual RLS-bypass
 * surface stays small and auditable — everything else in this feature
 * (src/server/dal/dead-mans-switch.ts) goes through the normal
 * withUserScope path.
 */

export type BeneficiaryWithSwitch = Awaited<ReturnType<typeof adminFindBeneficiaryByTokenHash>>;

export async function adminFindBeneficiaryByTokenHash(tokenHash: string) {
  const admin = createAdminClient();
  return admin.beneficiary.findUnique({
    where: { inviteTokenHash: tokenHash },
    include: { deadMansSwitch: true },
  });
}

export async function adminGetSwitchWithSubmissions(deadMansSwitchId: string) {
  const admin = createAdminClient();
  return admin.deadMansSwitch.findUnique({
    where: { id: deadMansSwitchId },
    include: { shareSubmissions: { include: { beneficiary: true } }, documents: true },
  });
}

export type UpsertShareSubmissionResult = { id: string };

/** Upsert, not create-if-missing — a beneficiary who mistyped their share the first time can correct it by resubmitting before the threshold is reached (see recovery-service.ts's doc comment). */
export async function adminUpsertShareSubmission(params: {
  userId: string;
  deadMansSwitchId: string;
  beneficiaryId: string;
  shareValueCiphertext: string;
}): Promise<UpsertShareSubmissionResult> {
  const admin = createAdminClient();
  const submission = await admin.recoveryShareSubmission.upsert({
    where: { deadMansSwitchId_beneficiaryId: { deadMansSwitchId: params.deadMansSwitchId, beneficiaryId: params.beneficiaryId } },
    create: {
      userId: params.userId,
      deadMansSwitchId: params.deadMansSwitchId,
      beneficiaryId: params.beneficiaryId,
      shareValueCiphertext: params.shareValueCiphertext,
    },
    update: { shareValueCiphertext: params.shareValueCiphertext },
  });
  return { id: submission.id };
}

export async function adminMarkRecovered(deadMansSwitchId: string) {
  const admin = createAdminClient();
  await admin.deadMansSwitch.update({
    where: { id: deadMansSwitchId },
    data: { status: "RECOVERED", recoveredAt: new Date() },
  });
}
