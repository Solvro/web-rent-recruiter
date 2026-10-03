import { BPS_DENOMINATOR } from "@scout/shared";

const bps = (amount: bigint, b: number) => (amount * BigInt(b)) / BigInt(BPS_DENOMINATOR);

/** Split of one accepted bounty, mirroring programs/scout (round down at every step). */
export function splitBounty(bounty: bigint, feeBps: number, operatorFeeBps: number, holdbackBps: number) {
	const platformFee = bps(bounty, feeBps);
	const operatorFee = bps(bounty - platformFee, operatorFeeBps);
	const share = bounty - platformFee - operatorFee;
	const later = bps(share, holdbackBps);
	return { platformFee, operatorFee, later, now: share - later };
}
