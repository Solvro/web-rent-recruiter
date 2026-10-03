import {
	BPS_DENOMINATOR,
	type RoleDetail,
	type RoleSummary,
	type SubmissionPayout,
	type SubmissionView,
	type TaskView,
} from "@scout/shared";
import type { schema } from "../db/index.ts";
import { splitBounty } from "./money.ts";

type RoleRow = typeof schema.roles.$inferSelect;
type SubmissionRow = typeof schema.submissions.$inferSelect;
type AccountRow = typeof schema.accounts.$inferSelect;

export const feeOf = (bounty: bigint, feeBps: number) => (bounty * BigInt(feeBps)) / BigInt(BPS_DENOMINATOR);

/**
 * "Left" = what the agent can still commit: vault − held back − (pending deliverables + open gig slots).
 * One definition for the company UI and the agent's snapshot.
 */
export function availableBudget(role: Pick<RoleRow, "remaining" | "heldBack" | "committed">) {
	const left = role.remaining - role.heldBack - role.committed;
	return left > 0n ? left : 0n;
}

export function roleSummary(role: RoleRow, companyName: string): RoleSummary {
	const available = availableBudget(role);
	return {
		id: role.id,
		onchainRoleId: String(role.onchainRoleId),
		roleVault: role.roleVault,
		title: role.title,
		summary: role.summary,
		companyName,
		status: role.status,
		taskType: role.taskType,
		bounty: role.bounty.toString(),
		feeBps: role.feeBps,
		maxCandidates: role.maxCandidates,
		acceptedCount: role.acceptedCount,
		pendingCount: role.pendingCount,
		reviewWindowSeconds: role.reviewWindowSeconds,
		holdbackBps: role.holdbackBps,
		holdbackWindowSeconds: role.holdbackWindowSeconds,
		budget: {
			deposited: (role.deposited - role.bondsForfeited).toString(),
			bondsForfeited: role.bondsForfeited.toString(),
			paid: role.paid.toString(),
			remaining: role.remaining.toString(),
			available: available.toString(),
			heldBack: role.heldBack.toString(),
		},
		createdAt: role.createdAt.toISOString(),
	};
}

export function submissionView(
	sub: SubmissionRow,
	scout: Pick<AccountRow, "wallet" | "displayName" | "avatarUrl">,
	review: SubmissionView["review"],
	role: Pick<RoleRow, "title" | "bounty" | "feeBps" | "holdbackBps">,
): SubmissionView {
	return {
		id: sub.id,
		roleId: sub.roleId,
		roleTitle: role.title,
		candidateName: sub.candidateName,
		candidate: {
			avatarUrl: sub.candidateAvatarUrl,
			currentTitle: sub.candidateTitle,
			currentCompany: sub.candidateCompany,
			location: sub.candidateLocation,
		},
		profileUrl: sub.profileUrl,
		notes: sub.notes,
		candidateHash: sub.candidateHash,
		onchainAddress: sub.onchainAddress,
		scout: { wallet: scout.wallet, displayName: scout.displayName, avatarUrl: scout.avatarUrl },
		status: sub.status,
		rejectReason: sub.rejectReason,
		submittedAt: sub.submittedAt.toISOString(),
		reviewDeadline: sub.reviewDeadline.toISOString(),
		settlementTx: sub.settlementTx,
		review,
		payout: submissionPayout(sub, role),
	};
}

/** Actual split once accepted (from SubmissionAccepted), projected from the role's terms while pending. */
export function submissionPayout(
	sub: SubmissionRow,
	role: Pick<RoleRow, "bounty" | "feeBps" | "holdbackBps">,
): SubmissionPayout | null {
	if (sub.status === "REJECTED") return null;
	const projected = splitBounty(role.bounty, role.feeBps, sub.operatorFeeBps, role.holdbackBps);
	const now = sub.payoutNow ?? projected.now;
	const later = sub.payoutLater ?? projected.later;
	return {
		now: now.toString(),
		later: later.toString(),
		operatorFee: (sub.operatorFee ?? projected.operatorFee).toString(),
		platformFee: (sub.platformFee ?? projected.platformFee).toString(),
		laterReleasesAt: sub.holdbackDeadline?.toISOString() ?? null,
		outcome: sub.outcome,
		laterStatus: sub.status === "ACCEPTED" ? sub.laterStatus : "NONE",
	};
}

export function roleDetail(role: RoleRow, companyName: string, submissions: SubmissionView[]): RoleDetail {
	return {
		...roleSummary(role, companyName),
		jobDescription: role.jobDescription,
		criteria: role.criteria,
		submissions,
		pipelineSummary: role.pipelineSummary,
	};
}

export function taskView(role: RoleRow, companyName: string): TaskView {
	const slotsLeft = Math.max(0, role.maxCandidates - role.acceptedCount - role.pendingCount);
	return {
		...roleSummary(role, companyName),
		criteria: role.criteria,
		slotsLeft,
		payoutPerCandidate: (role.bounty - feeOf(role.bounty, role.feeBps)).toString(),
	};
}
