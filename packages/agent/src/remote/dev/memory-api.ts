/**
 * Reference implementation of the agent API (packages/shared/src/agent-api.ts) in memory: a real
 * tRPC server (superjson, same wire format as the backend) for local runs and tests of the
 * self-hosted runner, and an executable spec for the backend's `agent.*` procedures.
 *
 * Not for production: no persistence, a single process, and only the checks the spec requires
 * (SIWS sessions, caller == role.agent, relayer only pays fees).
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import {
	AGENT_API,
	type AgentApiPath,
	type AgentConfig,
	type AgentDeliverable,
	type AgentRoleSnapshot,
	AuthNonceRequest,
	AuthVerifyRequest,
	type Json,
	type PendingCosignItem,
	SubmitTxRequest,
} from "@scout/shared";
import {
	type Address,
	address,
	getBase58Encoder,
	getBase64EncodedWireTransaction,
	getPublicKeyFromAddress,
	getSignatureFromTransaction,
	getTransactionDecoder,
	type KeyPairSigner,
	partiallySignTransaction,
	type Rpc,
	type SolanaRpcApi,
	verifySignature,
} from "@solana/kit";
import { initTRPC, TRPCError } from "@trpc/server";
import { createHTTPServer } from "@trpc/server/adapters/standalone";
import superjson from "superjson";
import { z } from "zod";

export interface MemoryRole {
	snapshot: AgentRoleSnapshot;
	/** role_vault.agent: the only wallet allowed to call agent.* for this role. */
	agent: Address;
}

export interface MemoryState {
	roles: Map<string, MemoryRole>;
	deliverables: Map<string, AgentDeliverable>;
	reviews: Map<string, Json>;
	decisions: {
		deliverableId: string;
		action: string;
		reason: string;
		signature: string | null;
		at: string;
	}[];
	log: { roleId: string; kind: string; message: string; at: string }[];
	escalations: { roleId: string; question: string; delivery: string }[];
	shortlists: Map<string, Json[]>;
	cosign: Map<
		string,
		PendingCosignItem & { resolve: (signature: string) => void; reject: (e: Error) => void }
	>;
	relayed: string[];
}

export function createMemoryAgentApi(opts: {
	config: AgentConfig;
	rpc: Rpc<SolanaRpcApi>;
	/** Pays fees for relayed transactions (tx.submit). */
	relayer: KeyPairSigner;
	port?: number;
}) {
	const state: MemoryState = {
		roles: new Map(),
		deliverables: new Map(),
		reviews: new Map(),
		decisions: [],
		log: [],
		escalations: [],
		shortlists: new Map(),
		cosign: new Map(),
		relayed: [],
	};
	const nonces = new Map<string, { wallet: string; message: string }>();
	const sessions = new Map<string, Address>();
	const now = () => new Date().toISOString();

	const t = initTRPC.context<{ wallet: Address | null }>().create({ transformer: superjson });
	const authed = t.procedure.use(({ ctx, next }) => {
		if (!ctx.wallet) throw new TRPCError({ code: "UNAUTHORIZED", message: "sign in first" });
		return next({ ctx: { wallet: ctx.wallet } });
	});
	const roleOf = (roleId: string, wallet: Address) => {
		const r = state.roles.get(roleId);
		if (!r) throw new TRPCError({ code: "NOT_FOUND", message: `role ${roleId}` });
		if (r.agent !== wallet) throw new TRPCError({ code: "FORBIDDEN", message: "only role.agent" });
		return r;
	};
	const deliverableOf = (id: string, wallet: Address) => {
		const d = state.deliverables.get(id);
		if (!d) throw new TRPCError({ code: "NOT_FOUND", message: `deliverable ${id}` });
		roleOf(d.roleId, wallet);
		return d;
	};

	/** Sign with the relayer as fee payer and send; the caller must have signed already. */
	async function relay(wire: string, caller: Address): Promise<string> {
		const tx = getTransactionDecoder().decode(Buffer.from(wire, "base64"));
		if (!(caller in tx.signatures) || !tx.signatures[caller as keyof typeof tx.signatures])
			throw new TRPCError({ code: "FORBIDDEN", message: "the transaction must be signed by the caller" });
		const signed = await partiallySignTransaction([opts.relayer.keyPair], tx);
		const missing = Object.entries(signed.signatures).filter(([, v]) => v === null);
		if (missing.length)
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: `missing signatures: ${missing.map(([k]) => k).join(", ")}`,
			});
		await opts.rpc
			.sendTransaction(getBase64EncodedWireTransaction(signed), {
				encoding: "base64",
				preflightCommitment: "confirmed",
			})
			.send();
		const signature = getSignatureFromTransaction(signed);
		for (let i = 0; i < 75; i++) {
			const { value } = await opts.rpc.getSignatureStatuses([signature]).send();
			if (value[0]?.err) throw new TRPCError({ code: "BAD_REQUEST", message: JSON.stringify(value[0].err) });
			if (value[0]?.confirmationStatus === "confirmed" || value[0]?.confirmationStatus === "finalized") break;
			await new Promise((r) => setTimeout(r, 400));
		}
		state.relayed.push(signature);
		return signature;
	}

	type Handler = (input: never, wallet: Address) => unknown;
	const handlers: Record<AgentApiPath, Handler> = {
		"agent.config": () => opts.config,
		"agent.roles": (_i, w) =>
			[...state.roles.values()]
				.filter((r) => r.agent === w)
				.map((r) => ({
					roleId: r.snapshot.roleId,
					title: r.snapshot.title,
					roleVault: r.snapshot.roleVault,
					status: "OPEN",
				})),
		"agent.role": (i: { roleId: string }, w) => roleOf(i.roleId, w).snapshot,
		"agent.deliverables": (i: { roleId: string }, w) => {
			roleOf(i.roleId, w);
			return [...state.deliverables.values()].filter((d) => d.roleId === i.roleId);
		},
		"agent.deliverable": (i: { deliverableId: string }, w) => {
			const d = state.deliverables.get(i.deliverableId);
			if (!d) return null;
			roleOf(d.roleId, w);
			return d;
		},
		"agent.review.get": (i: { deliverableId: string }, w) => {
			deliverableOf(i.deliverableId, w);
			return state.reviews.get(i.deliverableId) ?? null;
		},
		"agent.review.save": (i: { deliverableId: string; review: Json }, w) => {
			deliverableOf(i.deliverableId, w);
			state.reviews.set(i.deliverableId, i.review);
			return { ok: true };
		},
		"agent.sourcingReviews": (i: { roleId: string }, w) => {
			roleOf(i.roleId, w);
			return [...state.deliverables.values()]
				.filter((d) => d.roleId === i.roleId && d.kind === "sourcing")
				.flatMap((d) => {
					const r = state.reviews.get(d.id) as { sourcing?: Json } | undefined;
					return r?.sourcing ? [r.sourcing] : [];
				});
		},
		"agent.gig.register": (
			i: { roleId: string; taskAddress: string; signature: string; gig: Record<string, unknown> },
			w,
		) => {
			const r = roleOf(i.roleId, w);
			const gigId = `gig-${r.snapshot.gigs.length + 1}`;
			const gig = i.gig as { taskType: never; variant: never; title: string; candidateId: string | null };
			r.snapshot.gigs.push({
				gigId,
				taskAddress: i.taskAddress,
				onchainTaskId: r.snapshot.gigs.length,
				taskType: gig.taskType,
				variant: gig.variant,
				title: gig.title,
				status: "OPEN",
				candidateId: gig.candidateId,
				postedAt: now(),
				lastRepricedAt: null,
				claims: 0,
				deliveries: 0,
			});
			return { gigId };
		},
		"agent.gig.setStatus": (i: { roleId: string; gigIds: string[]; status: "OPEN" | "PAUSED" }, w) => {
			for (const g of roleOf(i.roleId, w).snapshot.gigs) if (i.gigIds.includes(g.gigId)) g.status = i.status;
			return { ok: true };
		},
		"agent.gig.pauseTypes": (i: { roleId: string; taskTypes: never[]; paused: boolean }, w) => {
			const s = roleOf(i.roleId, w).snapshot;
			s.pausedTaskTypes = i.paused
				? [...new Set([...s.pausedTaskTypes, ...i.taskTypes])]
				: s.pausedTaskTypes.filter((x) => !i.taskTypes.includes(x as never));
			return { ok: true };
		},
		"agent.decision": (
			i: { deliverableId: string; action: string; reason: string; signature: string | null },
			w,
		) => {
			const d = deliverableOf(i.deliverableId, w);
			state.decisions.push({ ...i, at: now() });
			if (i.action === "pre_accept") d.stage = "pre_accepted";
			else state.deliverables.delete(d.id); // settled on-chain: no longer pending
			if (i.action === "accept" && d.kind === "sourcing") {
				const r = roleOf(d.roleId, w);
				const review = state.reviews.get(d.id) as { sourcing?: Json } | undefined;
				const payload = d.payload as { candidate: { name: string; profileUrl: string; notes: string } };
				r.snapshot.candidates.push({
					id: d.id,
					...payload.candidate,
					stage: "sourced",
					sourcing: review?.sourcing ?? null,
					sourcer: d.scout,
				});
			}
			return { ok: true };
		},
		"agent.escalate": (i: { roleId: string; question: string; delivery: string }, w) => {
			roleOf(i.roleId, w);
			state.escalations.push(i);
			return { ok: true };
		},
		"agent.askRecruiter": (i: { deliverableId: string }, w) => {
			deliverableOf(i.deliverableId, w);
			return { ok: true };
		},
		"agent.criteria": (i: { roleId: string; criteria: never }, w) => {
			roleOf(i.roleId, w).snapshot.criteria = i.criteria;
			return { ok: true };
		},
		"agent.shortlist": (i: { roleId: string; entries: Json[] }, w) => {
			roleOf(i.roleId, w);
			state.shortlists.set(i.roleId, i.entries);
			return { ok: true };
		},
		"agent.decisionLog": (i: { roleId: string; limit: number }, w) => {
			roleOf(i.roleId, w);
			return state.decisions.slice(-i.limit).map((d) => ({ ...d, reason: d.reason }));
		},
		"agent.log": (i: { roleId: string; kind: string; message: string }, w) => {
			roleOf(i.roleId, w);
			state.log.push({ ...i, at: now() });
			return { ok: true };
		},
		"agent.cosign.list": (i: { roleId: string }, w) => {
			roleOf(i.roleId, w);
			return [...state.cosign.values()]
				.filter((c) => c.roleId === i.roleId)
				.map(({ resolve: _r, reject: _j, ...c }) => c);
		},
		"agent.cosign.submit": async (i: { id: string; signedTx: string }, w) => {
			const c = state.cosign.get(i.id);
			if (!c) throw new TRPCError({ code: "NOT_FOUND", message: `cosign ${i.id}` });
			roleOf(c.roleId, w);
			state.cosign.delete(i.id);
			try {
				c.resolve(await relay(i.signedTx, w));
			} catch (e) {
				c.reject(e as Error);
				throw e;
			}
			return { ok: true };
		},
		"agent.cosign.decline": (i: { id: string; reason: string }, w) => {
			const c = state.cosign.get(i.id);
			if (c) {
				roleOf(c.roleId, w);
				state.cosign.delete(i.id);
				c.reject(new Error(`declined: ${i.reason}`));
			}
			return { ok: true };
		},
	};

	// agent.* as nested routers ("agent.review.get" → agent.review.get).
	type Tree = { [k: string]: Tree | ReturnType<typeof t.procedure.query> };
	const tree: Tree = {};
	for (const [path, def] of Object.entries(AGENT_API) as [AgentApiPath, (typeof AGENT_API)[AgentApiPath]][]) {
		const parts = path.split(".");
		let node = tree;
		for (const p of parts.slice(0, -1)) {
			node[p] ??= {};
			node = node[p] as Tree;
		}
		const base = path === "agent.config" ? t.procedure : authed;
		const proc = base.input(def.input).output(def.output);
		const run = (async ({ input, ctx }: { input: unknown; ctx: { wallet: Address | null } }) =>
			handlers[path](input as never, ctx.wallet as Address)) as never;
		node[parts.at(-1) as string] = (def.kind === "query" ? proc.query(run) : proc.mutation(run)) as never;
	}
	const toRouter = (n: Tree): ReturnType<typeof t.router> =>
		t.router(
			Object.fromEntries(
				Object.entries(n).map(([k, v]) => [
					k,
					typeof v === "function" || "_def" in (v as object) ? v : toRouter(v as Tree),
				]),
			) as never,
		);

	const router = t.router({
		...(toRouter(tree)._def.record as object),
		auth: t.router({
			nonce: t.procedure.input(AuthNonceRequest).mutation(({ input }) => {
				const nonce = randomBytes(16).toString("hex");
				const message = `scout-agent dev API wants you to sign in with your Solana account:\n${input.wallet}\n\nNonce: ${nonce}`;
				nonces.set(nonce, { wallet: input.wallet, message });
				return { message, expiresAt: new Date(Date.now() + 300_000).toISOString() };
			}),
			verify: t.procedure.input(AuthVerifyRequest).mutation(async ({ input }) => {
				const nonce = input.message.match(/^Nonce: ([0-9a-f]{32})$/m)?.[1] ?? "";
				const issued = nonces.get(nonce);
				if (!issued || issued.message !== input.message || issued.wallet !== input.wallet)
					throw new TRPCError({ code: "UNAUTHORIZED", message: "unknown sign-in message" });
				const raw = Buffer.from(input.signature, "base64");
				const sig = raw.length === 64 ? raw : Buffer.from(getBase58Encoder().encode(input.signature));
				const ok = await verifySignature(
					await getPublicKeyFromAddress(address(input.wallet)),
					new Uint8Array(sig) as never,
					new TextEncoder().encode(input.message),
				);
				if (!ok) throw new TRPCError({ code: "UNAUTHORIZED", message: "bad signature" });
				nonces.delete(nonce);
				const token = randomBytes(24).toString("base64url");
				sessions.set(token, address(input.wallet));
				return { token, wallet: input.wallet, expiresAt: new Date(Date.now() + 3600_000).toISOString() };
			}),
		}),
		tx: t.router({
			submit: authed.input(SubmitTxRequest).mutation(async ({ input, ctx }) => {
				const signature = await relay(input.signedTx, ctx.wallet);
				return { signature, explorerUrl: "" };
			}),
		}),
	});

	let server: Server | null = null;
	return {
		state,
		router,
		/** For the harness: what a recruiter's app would put in the co-sign queue. */
		requestCosign(item: Omit<PendingCosignItem, "id" | "createdAt">): Promise<string> {
			const id = randomUUID();
			return new Promise((resolve, reject) => {
				state.cosign.set(id, { ...item, id, createdAt: now(), resolve, reject });
			});
		},
		addRole(role: MemoryRole) {
			state.roles.set(role.snapshot.roleId, role);
		},
		addDeliverable(d: AgentDeliverable) {
			state.deliverables.set(d.id, d);
		},
		async listen(): Promise<string> {
			const http = createHTTPServer({
				router,
				createContext: ({ req }) => {
					const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
					return { wallet: (token && sessions.get(token)) || null };
				},
			});
			server = http as unknown as Server;
			await new Promise<void>((r) => (http as unknown as Server).listen(opts.port ?? 0, "127.0.0.1", r));
			const port = ((http as unknown as Server).address() as { port: number }).port;
			return `http://127.0.0.1:${port}`;
		},
		close() {
			server?.close();
		},
	};
}

/** Keeps zod in the bundle for the dynamic router (schemas come from @scout/shared). */
export const _z = z;
