/**
 * Mock mode as a terminating tRPC link: every procedure path is answered by the in-browser mock handlers,
 * so `?data=mock` uses exactly the same hooks and types as the real backend.
 */
import type { AppRouter } from "@scout/backend/router";
import { TRPCClientError, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { gigProcedures, MockError, startMockAgentClock, tick } from "./gigs";
import { mockTransport } from "./handler";
import { mockEvents } from "./store";

type Input = Record<string, unknown> & { id?: string };
type Route = { method: "GET" | "POST" | "PUT"; path: string; body?: unknown; nullOn404?: boolean };

/** tRPC procedure path → the equivalent mock REST call. */
const ROUTES: Record<string, (input: Input) => Route> = {
	"me.get": () => ({ method: "GET", path: "/me", nullOn404: true }),
	"me.upsert": (i) => ({ method: "PUT", path: "/me", body: i }),
	"roles.draft": (i) => ({ method: "POST", path: "/roles/draft", body: i }),
	"roles.create": (i) => ({ method: "POST", path: "/roles", body: i }),
	"roles.list": () => ({ method: "GET", path: "/roles" }),
	"roles.byId": (i) => ({ method: "GET", path: `/roles/${i.id}` }),
	"roles.topUp": ({ id, ...body }) => ({ method: "POST", path: `/roles/${id}/top-up`, body }),
	"roles.close": (i) => ({ method: "POST", path: `/roles/${i.id}/close` }),
	"tasks.list": () => ({ method: "GET", path: "/tasks" }),
	"submissions.create": ({ roleId, ...body }) => ({
		method: "POST",
		path: `/roles/${roleId}/submissions`,
		body,
	}),
	"submissions.mine": () => ({ method: "GET", path: "/submissions/mine" }),
	"submissions.review": (i) => ({ method: "POST", path: `/submissions/${i.id}/review` }),
	"submissions.decide": ({ id, ...body }) => ({ method: "POST", path: `/submissions/${id}/decision`, body }),
	"submissions.settle": (i) => ({ method: "POST", path: `/submissions/${i.id}/settle` }),
	"submissions.outcome": ({ id, ...body }) => ({ method: "POST", path: `/submissions/${id}/outcome`, body }),
	"submissions.release": (i) => ({ method: "POST", path: `/submissions/${i.id}/release` }),
	"scouts.register": () => ({ method: "POST", path: "/scouts/register" }),
	"scouts.profile": (i) => ({
		method: "GET",
		path: `/scouts/${encodeURIComponent(String(i.wallet ?? i.slug))}`,
	}),
	"submissions.checkDuplicate": ({ roleId, profileUrl }) => ({
		method: "POST",
		path: `/roles/${roleId}/submissions/check`,
		body: { profileUrl },
	}),
	"tx.submit": (i) => ({ method: "POST", path: "/tx/submit", body: i }),
};

const STATUS_CODE: Record<number, string> = {
	400: "BAD_REQUEST",
	401: "UNAUTHORIZED",
	404: "NOT_FOUND",
	409: "CONFLICT",
	422: "UNPROCESSABLE_CONTENT",
};

/** Same error shape the backend's errorFormatter produces: data.appCode + data.details. */
function toClientError(status: number, data: unknown) {
	const body = (data ?? {}) as { error?: string; message?: string } & Record<string, unknown>;
	const { error, message, ...details } = body;
	const code = STATUS_CODE[status] ?? "INTERNAL_SERVER_ERROR";
	return TRPCClientError.from<AppRouter>({
		error: {
			message: message ?? error ?? "Request failed",
			code: -32000,
			data: { code, httpStatus: status, appCode: error ?? code, details },
		},
	});
}

export function mockLink(getWallet: () => string | null): TRPCLink<AppRouter> {
	return () =>
		({ op }) =>
			observable((observer) => {
				if (op.type === "subscription") {
					// Live events: the mock store emits the same LiveEvent shape the indexer sends.
					return mockEvents.subscribe((e) => observer.next({ result: { type: "data", data: e } }));
				}
				startMockAgentClock();
				const direct = gigProcedures[op.path];
				if (direct) {
					let cancelled = false;
					tick()
						.then(() => direct({ wallet: getWallet(), input: (op.input ?? {}) as Record<string, unknown> }))
						.then((data) => {
							if (cancelled) return;
							observer.next({ result: { type: "data", data } });
							observer.complete();
						})
						.catch((e) => {
							if (cancelled) return;
							observer.error(
								e instanceof MockError
									? toClientError(e.status, { error: e.code, message: e.message, ...e.details })
									: TRPCClientError.from(e),
							);
						});
					return () => {
						cancelled = true;
					};
				}
				const route = ROUTES[op.path];
				if (!route) {
					observer.error(toClientError(404, { error: "NOT_FOUND", message: `No mock for ${op.path}` }));
					return;
				}
				const r = route((op.input ?? {}) as Input);
				let cancelled = false;
				mockTransport({ method: r.method, path: r.path, body: r.body, wallet: getWallet() })
					.then(({ status, data }) => {
						if (cancelled) return;
						if (status === 404 && r.nullOn404) {
							observer.next({ result: { type: "data", data: null } });
							observer.complete();
						} else if (status >= 400) {
							observer.error(toClientError(status, data));
						} else {
							observer.next({ result: { type: "data", data } });
							observer.complete();
						}
					})
					.catch((e) => observer.error(TRPCClientError.from(e)));
				return () => {
					cancelled = true;
				};
			});
}
