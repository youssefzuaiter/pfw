"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type MouseEvent } from "react";
import { Badge } from "../badge/badge";
import { Spinner } from "../spinner/spinner";

export type HouseholdMemberRow = {
  userId: string;
  displayName: string;
  role: "OWNER" | "MEMBER";
  permission: "READ" | "WRITE";
};

export type HouseholdInviteRow = {
  id: string;
  invitedEmail: string;
  permission: "READ" | "WRITE";
  status: "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";
  expiresAt: string;
};

/**
 * The household-management surface for one Household Space (AGENTS.md
 * §3s) — invite/revoke and per-member permission editing when the caller
 * is the group's OWNER; a read-only roster + "leave household" view
 * otherwise. `members` always contains the full roster regardless of the
 * caller's role (`listGroupMembers`'s DAL doc comment) — only the
 * ability to *edit* permissions or invite is gated on `myRole`.
 */
export function HouseholdAdminPanel({
  sharedGroupId,
  myUserId,
  myRole,
  members,
  pendingInvites,
}: {
  sharedGroupId: string;
  myUserId: string;
  myRole: "OWNER" | "MEMBER";
  members: HouseholdMemberRow[];
  pendingInvites: HouseholdInviteRow[];
}) {
  const router = useRouter();
  const [inviteEmail, setInviteEmail] = useState("");
  const [invitePermission, setInvitePermission] = useState<"READ" | "WRITE">("READ");
  const [issuedLink, setIssuedLink] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleInviteSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!inviteEmail.trim()) return;

    setIsSubmitting(true);
    setError(null);
    setIssuedLink(null);
    try {
      const response = await fetch(`/api/groups/${sharedGroupId}/invites`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: inviteEmail.trim(), permission: invitePermission }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Failed to create invite");

      setIssuedLink(body.token);
      setInviteEmail("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create invite");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleRevoke(inviteId: string) {
    setError(null);
    try {
      const response = await fetch(`/api/groups/${sharedGroupId}/invites/${inviteId}`, { method: "DELETE" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to revoke invite");
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke invite");
    }
  }

  async function handlePermissionChange(memberUserId: string, permission: "READ" | "WRITE") {
    setError(null);
    try {
      const response = await fetch(`/api/groups/${sharedGroupId}/members/${memberUserId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permission }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to update permission");
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update permission");
    }
  }

  async function handleRemoveOrLeave(memberUserId: string) {
    setError(null);
    try {
      const response = await fetch(`/api/groups/${sharedGroupId}/members/${memberUserId}`, { method: "DELETE" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to remove member");
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove member");
    }
  }

  // Named handlers reading a `data-*` attribute, not inline arrow
  // functions on a button element — an inline arrow prop there would
  // trip tests/guards/focus-visible.test.ts's regex-based heuristic (the
  // literal `>` inside the arrow syntax truncates its attribute capture
  // before `className`), same trap documented in AGENTS.md §3c/§3d.
  function handleRemoveOrLeaveClick(event: MouseEvent<HTMLButtonElement>) {
    const memberUserId = event.currentTarget.dataset.memberUserId;
    if (memberUserId) handleRemoveOrLeave(memberUserId);
  }

  function handleRevokeClick(event: MouseEvent<HTMLButtonElement>) {
    const inviteId = event.currentTarget.dataset.inviteId;
    if (inviteId) handleRevoke(inviteId);
  }

  if (myRole !== "OWNER") {
    const mine = members.find((m) => m.userId === myUserId);
    return (
      <div className="rounded-lg border border-border bg-surface p-4">
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-muted">Members</h2>
        <ul className="mb-3 flex flex-col gap-1">
          {members.map((member) => (
            <li key={member.userId} className="flex items-center gap-2 text-sm text-fg">
              {member.displayName}
              {member.userId === myUserId && " (you)"}
              {member.role === "OWNER" ? (
                <Badge variant="neutral">Owner</Badge>
              ) : (
                <Badge variant={member.permission === "WRITE" ? "positive" : "neutral"}>{member.permission}</Badge>
              )}
            </li>
          ))}
        </ul>
        <p className="text-sm text-fg">
          <Badge variant={mine?.permission === "WRITE" ? "positive" : "neutral"}>{mine?.permission ?? "READ"}</Badge>{" "}
          access in this household.
        </p>
        <button
          type="button"
          data-member-user-id={myUserId}
          onClick={handleRemoveOrLeaveClick}
          className="uv-btn-press mt-3 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-negative hover:bg-negative/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Leave household
        </button>
        {error && <p className="mt-2 text-xs text-negative">{error}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted">Members</h2>
        <ul className="flex flex-col gap-2">
          {members.map((member) => (
            <li key={member.userId} className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2 first:border-t-0 first:pt-0">
              <span className="text-sm text-fg">
                {member.displayName} {member.role === "OWNER" && <Badge variant="neutral">Owner</Badge>}
              </span>
              {member.role === "OWNER" ? (
                <Badge variant="positive">WRITE</Badge>
              ) : (
                <div className="flex items-center gap-2">
                  <select
                    value={member.permission}
                    onChange={(event) => handlePermissionChange(member.userId, event.target.value as "READ" | "WRITE")}
                    className="rounded-md border border-border bg-bg px-2 py-1 text-xs text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option value="READ">READ</option>
                    <option value="WRITE">WRITE</option>
                  </select>
                  <button
                    type="button"
                    data-member-user-id={member.userId}
                    onClick={handleRemoveOrLeaveClick}
                    className="uv-btn-press rounded-md border border-border px-2 py-1 text-xs font-medium text-negative hover:bg-negative/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Remove
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted">Invite a member</h2>
        <form onSubmit={handleInviteSubmit} className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="invite-email" className="text-xs font-medium text-muted">
              Email
            </label>
            <input
              id="invite-email"
              type="email"
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
              placeholder="name@example.com"
              className="min-w-[200px] rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="invite-permission" className="text-xs font-medium text-muted">
              Access
            </label>
            <select
              id="invite-permission"
              value={invitePermission}
              onChange={(event) => setInvitePermission(event.target.value as "READ" | "WRITE")}
              className="rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="READ">Read only</option>
              <option value="WRITE">Read &amp; write</option>
            </select>
          </div>
          <button
            type="submit"
            disabled={isSubmitting || !inviteEmail.trim()}
            className="uv-btn-press flex items-center gap-1.5 rounded-md border border-accent bg-accent px-4 py-2 text-sm font-medium text-bg transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            {isSubmitting && <Spinner />}
            Create invite
          </button>
        </form>
        {issuedLink && (
          <p className="mt-3 break-all rounded-md border border-border bg-bg p-2 text-xs text-fg">
            Invite token (shown once — copy it now, this app has no email delivery): <br />
            <span className="font-tabular-figures">{issuedLink}</span>
          </p>
        )}
        {error && <p className="mt-2 text-xs text-negative">{error}</p>}
      </section>

      {pendingInvites.length > 0 && (
        <section className="rounded-lg border border-border bg-surface p-4">
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted">Invites</h2>
          <ul className="flex flex-col gap-2">
            {pendingInvites.map((invite) => (
              <li key={invite.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2 first:border-t-0 first:pt-0 text-sm">
                <span className="text-fg">
                  {invite.invitedEmail} <Badge variant={invite.permission === "WRITE" ? "positive" : "neutral"}>{invite.permission}</Badge>
                </span>
                <span className="flex items-center gap-2">
                  <Badge
                    variant={
                      invite.status === "PENDING" ? "warning" : invite.status === "ACCEPTED" ? "positive" : "critical"
                    }
                  >
                    {invite.status}
                  </Badge>
                  {invite.status === "PENDING" && (
                    <button
                      type="button"
                      data-invite-id={invite.id}
                      onClick={handleRevokeClick}
                      className="uv-btn-press rounded-md border border-border px-2 py-1 text-xs font-medium text-negative hover:bg-negative/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      Revoke
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
