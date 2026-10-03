import {
	BPS_DENOMINATOR,
	type RoleDetail,
	type RoleSummary,
	type SubmissionView,
	type TaskView,
} from "@scout/shared";
import type { schema } from "../db/index.ts";

type RoleRow = typeof schema.roles.$inferSelect;
type SubmissionRow = typeof schema.submissions.$inferSelect;
type AccountRow = typeof schema.accounts.$inferSelect;

export const feeOf = (bounty: bigint, feeBps: number) => (bounty * BigInt(feeBps)) / BigInt(BPS_DENOMINATOR);

export function roleSummary(role: RoleRow, companyName: string): RoleSummary {
	const reserved = role.bounty * BigInt(role.pendingCount);
	const available = role.remaining > reserved ? role.remaining - reserved : 0n;
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
		budget: {
			deposited: role.deposited.toString(),
			paid: role.paid.toString(),
			remaining: role.remaining.toString(),
			available: available.toString(),
		},
		createdAt: role.createdAt.toISOString(),
	};
}

export function submissionView(
	sub: SubmissionRow,
	scout: Pick<AccountRow, "wallet" | "displayName" | "avatarUrl">,
	review: SubmissionView["review"],
	roleTitle: string,
): SubmissionView {
	return {
		id: sub.id,
		roleId: sub.roleId,
		roleTitle,
		candidateName: sub.candidateName,
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
