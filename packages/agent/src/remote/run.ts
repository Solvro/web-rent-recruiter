/**
 * The self-hosted runner: signs in to the platform as the role's agent, checks on-chain that this
 * key really is role_vault.agent, then loops: co-sign claims/deliveries, settle confirmed
 * candidates, and run one agent step (deterministic policy, or the AI agent if a model is set).
 */
import { fetchRoleVault } from "@scout/shared/program";
import { type Address, address, type KeyPairSigner } from "@solana/kit";
import type { AgentEvent } from "../runner/ports.ts";
import { createRoleAgent } from "../runner/role-agent.ts";
import { AgentApi } from "./api.ts";
import { createChain } from "./chain.ts";
import { cosignPending } from "./cosign.ts";
import { createRemotePorts } from "./remote-ports.ts";

export interface RunOptions {
	apiUrl: string;
	agent: KeyPairSigner;
	/** RoleVault address (the on-chain role). */
	roleVault: Address;
	rpcUrl?: string;
	feePayer?: "relayer" | "self";
	intervalMs?: number;
	once?: boolean;
	onEvent?: (event: AgentEvent) => void;
	log?: (line: string) => void;
	signal?: AbortSignal;
}

export async function connect(opts: RunOptions) {
	const log = opts.log ?? ((l: string) => console.log(l));
	const api = new AgentApi(opts.apiUrl, opts.agent);
	const config = await api.call("agent.config");
	const chain = createChain({
		config,
		agent: opts.agent,
		feePayer: opts.feePayer ?? (config.relayer ? "relayer" : "self"),
		api,
		...(opts.rpcUrl ? { rpcUrl: opts.rpcUrl } : {}),
	});
	// The chain is the source of truth for who may act on this role.
	const vault = (await fetchRoleVault(chain.rpc, opts.roleVault)).data;
	const onchainAgent = vault.agent.__option === "Some" ? vault.agent.value : null;
	if (onchainAgent !== opts.agent.address) {
		throw new Error(
			`this key (${opts.agent.address}) isn't the agent of role ${opts.roleVault} (on-chain agent: ${onchainAgent ?? "none"}). The company sets it with set_agent.`,
		);
	}
	await api.login();
	const roles = await api.call("agent.roles");
	const role = roles.find((r) => r.roleVault === opts.roleVault);
	if (!role) throw new Error(`the platform doesn't list role ${opts.roleVault} for this agent`);
	log(`signed in as ${opts.agent.address}; role "${role.title}" (${role.roleId}) on ${config.cluster}`);
	const ports = createRemotePorts({
		api,
		chain,
		roleId: role.roleId,
		roleVault: opts.roleVault,
		...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
	});
	return { api, chain, config, role, ports, agent: createRoleAgent(ports), log };
}

/** One pass: gatekeeping, settlements, then the agent's step. */
export async function tick(conn: Awaited<ReturnType<typeof connect>>): Promise<string[]> {
	const { api, chain, config, role, ports, agent } = conn;
	const done: string[] = [];
	const pending = await api.call("agent.cosign.list", { roleId: role.roleId });
	done.push(
		...(await cosignPending(
			pending,
			{
				programId: config.programId,
				roleVault: address(role.roleVault ?? ""),
				agent: chain.agent.address,
				relayer: config.relayer,
			},
			chain.agent,
			(id, signedTx) => api.call("agent.cosign.submit", { id, signedTx }),
			(id, reason) => api.call("agent.cosign.decline", { id, reason }),
		)),
	);
	done.push(...(await ports.settleConfirmed()));
	const step = await agent.runStep();
	done.push(...step.text.split("\n").filter(Boolean));
	return done;
}

export async function runRemoteAgent(opts: RunOptions): Promise<void> {
	const conn = await connect(opts);
	const interval = opts.intervalMs ?? 30_000;
	for (;;) {
		try {
			for (const line of await tick(conn)) conn.log(`  ${line}`);
		} catch (error) {
			conn.log(`step failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (opts.once || opts.signal?.aborted) return;
		await new Promise((r) => setTimeout(r, interval));
		if (opts.signal?.aborted) return;
	}
}
