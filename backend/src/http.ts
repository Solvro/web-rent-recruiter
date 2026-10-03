import { Pubkey, WALLET_HEADER } from "@scout/shared";
import { type Address, address, isSolanaError } from "@solana/kit";
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

/** Caller identity from the x-wallet header (see packages/shared/src/api.ts). */
export function requireWallet(req: FastifyRequest): Address {
	const raw = req.headers[WALLET_HEADER];
	const parsed = Pubkey.safeParse(Array.isArray(raw) ? raw[0] : raw);
	if (!parsed.success) throw new HttpError(401, "UNAUTHORIZED", `missing or invalid ${WALLET_HEADER} header`);
	return address(parsed.data);
}

export function errorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) {
	if (hasZodFastifySchemaValidationErrors(err)) {
		return reply.status(400).send({ error: "VALIDATION", message: err.message, issues: err.validation });
	}
	if (err instanceof HttpError) {
		return reply.status(err.status).send({ error: err.code, message: err.message, ...err.extra });
	}
	if (err instanceof ChainNotReadyError) {
		return reply.status(503).send({ error: "CHAIN_NOT_READY", message: err.message });
	}
	if (err instanceof RelayerPolicyError) {
		req.log.warn({ policy: err.message }, "relayer refused transaction");
		return reply.status(400).send({ error: "RELAYER_POLICY", message: err.message });
	}
	if (err instanceof TxFailedError) {
		req.log.warn({ txError: err.message, logs: err.logs.slice(-15) }, "transaction failed");
		return reply.status(422).send({ error: "TX_FAILED", message: err.message, logs: err.logs.slice(-15) });
	}
	const statusCode = (err as FastifyError).statusCode;
	if (statusCode && statusCode < 500) {
		return reply
			.status(statusCode)
			.send({ error: (err as FastifyError).code ?? "ERROR", message: err.message });
	}
	// kit's SolanaErrors are frozen, which pino's serializer can't tag: log a plain copy.
	const plain = {
		name: err.name,
		message: err.message,
		stack: err.stack,
		context: (err as { context?: unknown }).context,
	};
	if (isSolanaError(err)) {
		req.log.warn({ rpcError: plain }, "solana rpc error");
		return reply.status(502).send({ error: "RPC_ERROR", message: err.message });
	}
	req.log.error({ error: plain }, "unhandled error");
	return reply.status(500).send({ error: "INTERNAL", message: err.message });
}
