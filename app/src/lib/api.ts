import {
	AgentReview,
	type CreateRoleRequest,
	CreateRoleResponse,
	type CreateSubmissionRequest,
	CreateSubmissionResponse,
	type DecisionRequest,
	DecisionResponse,
	type DraftRoleRequest,
	DraftRoleResponse,
	DuplicateCandidateError,
	Me,
	RegisterScoutResponse,
	RoleDetail,
	RoleSummary,
	ScoutPublicProfile,
	SettleResponse,
	SubmissionView,
	type SubmitTxRequest,
	SubmitTxResponse,
	TaskView,
	type TopUpRequest,
	TopUpResponse,
	UnsignedTx,
	type UpsertMeRequest,
	WALLET_HEADER,
} from "@scout/shared";
import { z } from "zod";
import { API_MOCK, API_URL } from "./env";
import { mockTransport } from "./mock/handler";
import { mockEvents } from "./mock/store";

export type Method = "GET" | "POST" | "PUT";
export type TransportResponse = { status: number; data: unknown };
export type Transport = (req: {
	method: Method;
	path: string;
	body?: unknown;
	wallet: string | null;
}) => Promise<TransportResponse>;

export class ApiError extends Error {
	constructor(
		public status: number,
		public code: string,
		message: string,
		public data?: unknown,
	) {
		super(message);
	}
}

const httpTransport: Transport = async ({ method, path, body, wallet }) => {
	const headers: Record<string, string> = {};
	if (body !== undefined) headers["content-type"] = "application/json";
	if (wallet) headers[WALLET_HEADER] = wallet;
	const res = await fetch(`${API_URL}${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	let data: unknown = null;
	try {
		data = text ? JSON.parse(text) : null;
	} catch {
		data = { error: "BAD_RESPONSE", message: text.slice(0, 200) };
	}
	return { status: res.status, data };
};

const transport: Transport = API_MOCK ? mockTransport : httpTransport;

/** Set by the wallet layer whenever the active identity changes. */
let currentWallet: string | null = null;
export function setApiWallet(wallet: string | null) {
	currentWallet = wallet;
}

async function call<T extends z.ZodType>(schema: T, method: Method, path: string, body?: unknown) {
	const { status, data } = await transport({ method, path, body, wallet: currentWallet });
	if (status >= 400) {
		const err = z.object({ error: z.string(), message: z.string().optional() }).safeParse(data);
		throw new ApiError(
			status,
			err.success ? err.data.error : "HTTP_ERROR",
			err.success ? (err.data.message ?? err.data.error) : `Request failed (${status})`,
			data,
		);
	}
	return schema.parse(data) as z.infer<T>;
}

export const api = {
	me: async () => {
		try {
			return await call(Me, "GET", "/me");
		} catch (e) {
			if (e instanceof ApiError && e.status === 404) return null;
			throw e;
		}
	},
	upsertMe: (body: z.input<typeof UpsertMeRequest>) => call(Me, "PUT", "/me", body),

	draftRole: (body: z.input<typeof DraftRoleRequest>) =>
		call(DraftRoleResponse, "POST", "/roles/draft", body),
	createRole: (body: z.input<typeof CreateRoleRequest>) => call(CreateRoleResponse, "POST", "/roles", body),
	roles: () => call(z.array(RoleSummary), "GET", "/roles"),
	role: (id: string) => call(RoleDetail, "GET", `/roles/${id}`),
	topUp: (id: string, body: z.input<typeof TopUpRequest>) =>
		call(TopUpResponse, "POST", `/roles/${id}/top-up`, body),
	closeRole: (id: string) => call(z.object({ unsignedTx: UnsignedTx }), "POST", `/roles/${id}/close`),

	tasks: () => call(z.array(TaskView), "GET", "/tasks"),
	submitCandidate: (roleId: string, body: z.input<typeof CreateSubmissionRequest>) =>
		call(CreateSubmissionResponse, "POST", `/roles/${roleId}/submissions`, body),
	mySubmissions: () => call(z.array(SubmissionView), "GET", "/submissions/mine"),
	review: (id: string) => call(AgentReview, "POST", `/submissions/${id}/review`),
	decide: (id: string, body: z.input<typeof DecisionRequest>) =>
		call(DecisionResponse, "POST", `/submissions/${id}/decision`, body),
	settle: (id: string) => call(SettleResponse, "POST", `/submissions/${id}/settle`),

	registerScout: () => call(RegisterScoutResponse, "POST", "/scouts/register"),
	scout: (pubkey: string) => call(ScoutPublicProfile, "GET", `/scouts/${pubkey}`),

	submitTx: (body: z.input<typeof SubmitTxRequest>) => call(SubmitTxResponse, "POST", "/tx/submit", body),
};

export function asDuplicate(e: unknown) {
	if (!(e instanceof ApiError) || e.status !== 409) return null;
	const parsed = DuplicateCandidateError.safeParse(e.data);
	return parsed.success ? parsed.data : null;
}

export function errorMessage(e: unknown) {
	if (e instanceof ApiError) return e.message;
	if (e instanceof Error) return e.message;
	return "Something went wrong";
}

/** Server-sent events from the indexer. In mock mode the mock store emits the same shape. */
export type ChainEvent = { type: string; roleId?: string; submissionId?: string; signature?: string };
export function subscribeEvents(onEvent: (e: ChainEvent) => void): () => void {
	if (API_MOCK) return mockEvents.subscribe(onEvent);
	const source = new EventSource(`${API_URL}/events`);
	source.onmessage = (msg) => {
		try {
			onEvent(JSON.parse(msg.data) as ChainEvent);
		} catch {
			// ignore malformed frames
		}
	};
	return () => source.close();
}
