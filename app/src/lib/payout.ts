import { BPS_DENOMINATOR } from "@scout/shared";

const BPS = BigInt(BPS_DENOMINATOR);

/** Same split as the program (rounding down at each step). See SubmissionPayout in @scout/shared. */
export function splitBounty(
	bounty: bigint | string,
	feeBps: number,
	holdbackBps: number,
	operatorFeeBps = 0,
) {
	const b = BigInt(bounty);
	const platformFee = (b * BigInt(feeBps)) / BPS;
	const operatorFee = ((b - platformFee) * BigInt(operatorFeeBps)) / BPS;
	const net = b - platformFee - operatorFee;
	const later = (net * BigInt(holdbackBps)) / BPS;
	return { platformFee, operatorFee, now: net - later, later, net };
}

/** What this recruiter gets for one accepted candidate on a role, all parts together. */
export function recruiterEarns(
	role: { bounty: string; feeBps: number; holdbackBps: number },
	operatorFeeBps = 0,
) {
	return splitBounty(role.bounty, role.feeBps, role.holdbackBps, operatorFeeBps).net;
}

const CENT = 10_000n;

/**
 * Two parts of one payment, shown in whole cents so they add up to the rounded total:
 * the held part rounds down, "now" takes the remainder ($19.845 + $8.505 → $19.85 + $8.50).
 */
export function inCents(now: bigint | string, later: bigint | string) {
	const total = ((BigInt(now) + BigInt(later) + CENT / 2n) / CENT) * CENT;
	const held = (BigInt(later) / CENT) * CENT;
	return { now: total - held, later: held };
}
