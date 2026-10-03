/** Who reviews a role: our hosted agent, a company's own agent key, or the company itself (no agent). */
import { type Address, address } from "@solana/kit";
import { agentSigner } from "./chain.ts";

type RoleKeys = { agentPubkey: string | null; companyWallet: string };

/** Our hosted agent runs the role (its key is role.agent). */
export async function isHosted(role: Pick<RoleKeys, "agentPubkey">) {
	const ours = await agentSigner().catch(() => null);
	return Boolean(ours && role.agentPubkey === ours.address);
}

/** The key that must co-sign claims and deliveries: role.agent, or the company when there is none. */
export const gatekeeperOf = (role: RoleKeys): Address => address(role.agentPubkey ?? role.companyWallet);

export async function reviewerMode(
	role: Pick<RoleKeys, "agentPubkey">,
): Promise<"scout" | "custom" | "self"> {
	if (!role.agentPubkey) return "self";
	return (await isHosted(role)) ? "scout" : "custom";
}
