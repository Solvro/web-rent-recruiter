/**
 * Client for the platform's agent API (packages/shared/src/agent-api.ts), signed in with SIWS
 * using the agent's own key. Every call is validated against the shared zod schemas on both sides.
 */
import {
	AGENT_API,
	type AgentApiInput,
	type AgentApiOutput,
	type AgentApiPath,
	AuthNonceResponse,
	AuthVerifyResponse,
	SubmitTxResponse,
} from "@scout/shared";
import { getBase64Decoder, type KeyPairSigner, signBytes } from "@solana/kit";
import { createTRPCUntypedClient, httpLink, isTRPCClientError, type TRPCUntypedClient } from "@trpc/client";
import superjson from "superjson";

export class AgentApi {
	private token: string | null = null;
	private readonly client: TRPCUntypedClient<never>;

	constructor(
		readonly url: string,
		readonly signer: KeyPairSigner,
	) {
		this.client = createTRPCUntypedClient<never>({
			links: [
				httpLink({
					url,
					transformer: superjson,
					headers: () => (this.token ? { authorization: `Bearer ${this.token}` } : {}),
				}),
			],
		} as never);
	}

	/** Sign-In-With-Solana: the platform learns the caller is this key (and nothing else). */
	async login(): Promise<string> {
		const nonce = AuthNonceResponse.parse(
			await this.client.mutation("auth.nonce", { wallet: this.signer.address }),
		);
		const sig = await signBytes(this.signer.keyPair.privateKey, new TextEncoder().encode(nonce.message));
		const signature = getBase64Decoder().decode(sig);
		const session = AuthVerifyResponse.parse(
			await this.client.mutation("auth.verify", {
				wallet: this.signer.address,
				message: nonce.message,
				signature,
			}),
		);
		this.token = session.token;
		return session.token;
	}

	/** Calls an agent.* procedure; signs in again once if the session expired. */
	async call<P extends AgentApiPath>(path: P, input?: AgentApiInput<P>): Promise<AgentApiOutput<P>> {
		const def = AGENT_API[path];
		const parsedInput = def.input.parse(input);
		const run = () =>
			def.kind === "query" ? this.client.query(path, parsedInput) : this.client.mutation(path, parsedInput);
		let out: unknown;
		try {
			out = await run();
		} catch (error) {
			if (!(isTRPCClientError(error) && error.data?.code === "UNAUTHORIZED") || path === "agent.config")
				throw error;
			await this.login();
			out = await run();
		}
		return def.output.parse(out) as AgentApiOutput<P>;
	}

	/** Relays a transaction the agent signed (the platform adds the fee payer's signature). */
	async submitTx(signedTx: string): Promise<string> {
		if (!this.token) await this.login();
		return SubmitTxResponse.parse(await this.client.mutation("tx.submit", { signedTx })).signature;
	}
}
