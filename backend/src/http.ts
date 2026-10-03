import { type Address, isSolanaError } from "@solana/kit";
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";
import { ChainNotReadyError } from "./solana/chain.ts";
import { RelayerPolicyError, TxFailedError } from "./solana/tx.ts";

export class HttpError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly extra: Record<string, unknown> = {},
	) {
		super(message);
	}
}

export const notFound = (what: string) => new HttpError(404, "NOT_FOUND", `${what} not found`);
export const forbidden = (message: string) => new HttpError(403, "FORBIDDEN", message);
export const badRequest = (message: string) => new HttpError(400, "BAD_REQUEST", message);

/** Caller identity from the SIWS session (Authorization: Bearer <token>). The x-wallet header is not trusted. */
export async function requireWallet(req: FastifyRequest): Promise<Address> {
	const { bearer, walletFromToken } = await import("./auth.ts");
	const wallet = await walletFromToken(bearer(req.headers.authorization));
	if (!wallet) throw new HttpError(401, "UNAUTHORIZED", "sign in first (auth.nonce → auth.verify)");
	return wallet;
}

/** Program errors surfaced as their own app codes (snake-cased). */
const PROGRAM_ERRORS = new Set([
	"ReputationTooLow",
	"SelfReview",
	"InvalidBond",
	"SelfDealing",
	"NotUpgradeAuthority",
	"InvariantViolated",
	"InsufficientBudget",
	"RoleFull",
	"NotClaimant",
	"TaskClosed",
	"ReviewWindowExpired",
	"HoldbackWindowExpired",
	"MissingEvidence",
	"NotGatekeeper",
	"AgentCapExceeded",
	"BountyTooSmall",
	"WindowOutOfRange",
	"InvalidConfig",
	"NotAttestor",
]);

/** Transport-neutral error: HTTP status + app code the UI switches on (+ extra fields like firstSubmittedAt). */
export type AppError = { status: number; code: string; message: string; extra: Record<string, unknown> };

type Log = { warn: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };

/** Normalize anything a use-case can throw. Shared by the REST error handler and the tRPC error formatter. */
export function toAppError(err: unknown, log?: Log): AppError {
	const e = err as Error;
	if (err instanceof HttpError)
		return { status: err.status, code: err.code, message: err.message, extra: err.extra };
	if (err instanceof ChainNotReadyError)
		return { status: 503, code: "CHAIN_NOT_READY", message: e.message, extra: {} };
	if (err instanceof RelayerPolicyError) {
		log?.warn({ policy: e.message }, "relayer refused transaction");
		return { status: 400, code: "RELAYER_POLICY", message: e.message, extra: {} };
	}
	if (err instanceof TxFailedError) {
		const logs = err.logs.slice(-15);
		log?.warn({ txError: e.message, logs }, "transaction failed");
		// Anchor errors the UI cares about get their own app code (e.g. ReputationTooLow → REPUTATION_TOO_LOW).
		const all = [e.message, ...logs].join("\n");
		if (/Instruction: SubmitDeliverable/.test(all) && /insufficient funds/i.test(all)) {
			return {
				status: 422,
				code: "BOND_INSUFFICIENT_FUNDS",
				message: "Not enough USDC for this gig's deliverable bond (refunded when the work is accepted).",
				extra: { logs },
			};
		}
		const name = all.match(/Error Code: (\w+)/)?.[1];
		const code =
			name && PROGRAM_ERRORS.has(name) ? name.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase() : "TX_FAILED";
		return {
			status: 422,
			code,
			message: e.message,
			extra: { logs, ...(name ? { programError: name } : {}) },
		};
	}
	// kit's SolanaErrors are frozen, which pino's serializer can't tag: log a plain copy.
	const plain = {
		name: e?.name,
		message: e?.message,
		stack: e?.stack,
		context: (err as { context?: unknown })?.context,
	};
	if (isSolanaError(err)) {
		log?.warn({ rpcError: plain }, "solana rpc error");
		return { status: 502, code: "RPC_ERROR", message: e.message, extra: {} };
	}
	log?.error({ error: plain }, "unhandled error");
	// Never show internals (SQL, stack) to the client: they're in the server log.
	return {
		status: 500,
		code: "INTERNAL",
		message: "Something went wrong on our side. Please try again.",
		extra: {},
	};
}

export function errorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) {
	if (hasZodFastifySchemaValidationErrors(err)) {
		return reply.status(400).send({ error: "VALIDATION", message: err.message, issues: err.validation });
	}
	const statusCode = (err as FastifyError).statusCode;
	if (statusCode && statusCode < 500 && !(err instanceof HttpError)) {
		return reply
			.status(statusCode)
			.send({ error: (err as FastifyError).code ?? "ERROR", message: err.message });
	}
	const app = toAppError(err, req.log);
	return reply.status(app.status).send({ error: app.code, message: app.message, ...app.extra });
}
