/**
 * tRPC setup: superjson transformer, wallet context, and one error format for the UI.
 *
 * Errors: every failure reaches the client as a TRPCError whose `code` follows the HTTP status (409 → CONFLICT,
 * 422 → UNPROCESSABLE_CONTENT, …) and whose `data` carries `appCode` (DUPLICATE_CANDIDATE, ROLE_NOT_FUNDED,
 * REVIEW_WINDOW_EXPIRED, TX_FAILED, VALIDATION, …) plus `details` (e.g. firstSubmittedAt, logs).
 */
import { initTRPC, TRPCError } from "@trpc/server";
import type { CreateFastifyContextOptions } from "@trpc/server/adapters/fastify";
import superjson from "superjson";
import { ZodError } from "zod";
import { bearer, walletFromToken } from "../auth.ts";
import { type AppError, toAppError } from "../http.ts";

/** The caller's wallet comes ONLY from a verified SIWS session (Authorization: Bearer, or SSE connectionParams). */
export async function createContext({ req, info }: CreateFastifyContextOptions) {
	const token =
		bearer(req.headers.authorization) ?? (info.connectionParams?.token as string | undefined) ?? null;
	return { wallet: await walletFromToken(token), token, log: req.log, ip: req.ip };
}
export type Context = Awaited<ReturnType<typeof createContext>>;

/** Carries the normalized error from the middleware to the formatter. */
class AppErrorCause extends Error {
	constructor(readonly app: AppError) {
		super(app.message);
	}
}

const CODE_BY_STATUS: Record<number, TRPCError["code"]> = {
	400: "BAD_REQUEST",
	401: "UNAUTHORIZED",
	403: "FORBIDDEN",
	404: "NOT_FOUND",
	409: "CONFLICT",
	422: "UNPROCESSABLE_CONTENT",
	429: "TOO_MANY_REQUESTS",
	502: "BAD_GATEWAY",
	503: "SERVICE_UNAVAILABLE",
};

const t = initTRPC.context<Context>().create({
	transformer: superjson,
	sse: { ping: { enabled: true, intervalMs: 15_000 }, client: { reconnectAfterInactivityMs: 30_000 } },
	errorFormatter({ shape, error }) {
		const app = error.cause instanceof AppErrorCause ? error.cause.app : null;
		const zod = error.cause instanceof ZodError ? error.cause : null;
		// Stack traces only with TRPC_DEBUG=1; unexpected errors never carry their raw message.
		const { stack: _stack, ...data } = shape.data;
		const unexpected = shape.data.code === "INTERNAL_SERVER_ERROR" && !app;
		return {
			...shape,
			message: unexpected ? "Something went wrong on our side. Please try again." : shape.message,
			data: {
				...(process.env.TRPC_DEBUG === "1" ? shape.data : data),
				appCode: app?.code ?? (zod ? "VALIDATION" : error.code),
				details: app?.extra ?? (zod ? { issues: zod.issues } : {}),
			},
		};
	},
});

/** Turn use-case errors (HttpError, TxFailedError, kit RPC errors, …) into typed TRPCErrors. */
const appErrors = t.middleware(async ({ ctx, next }) => {
	const result = await next();
	if (result.ok) return result;
	const err = result.error;
	if (err.code !== "INTERNAL_SERVER_ERROR" || !err.cause) return result;
	const app = toAppError(err.cause, ctx.log);
	throw new TRPCError({
		code: CODE_BY_STATUS[app.status] ?? "INTERNAL_SERVER_ERROR",
		message: app.message,
		cause: new AppErrorCause(app),
	});
});

export const router = t.router;
export const publicProcedure = t.procedure.use(appErrors);

/** Requires the x-wallet header (the logged-in embedded wallet). Money still needs the user's own signature. */
export const walletProcedure = publicProcedure.use(({ ctx, next }) => {
	if (!ctx.wallet) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "sign in first (auth.nonce → auth.verify)",
			cause: new AppErrorCause({
				status: 401,
				code: "UNAUTHORIZED",
				message: "sign in first (auth.nonce → auth.verify)",
				extra: {},
			}),
		});
	}
	return next({ ctx: { ...ctx, wallet: ctx.wallet } });
});
