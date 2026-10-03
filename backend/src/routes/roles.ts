/** @deprecated REST transport; the app uses tRPC (src/trpc). Kept for scripts. */
import {
	CreateRoleRequest,
	CreateRoleResponse,
	DraftRoleRequest,
	DraftRoleResponse,
	RoleDetail,
	RoleSummary,
	TaskView,
	TopUpRequest,
	TopUpResponse,
	UnsignedTx,
} from "@scout/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { closeRole, createRole, draftRole, getRole, listRoles, listTasks, topUp } from "../api/roles.ts";
import { requireWallet } from "../http.ts";

const IdParams = z.object({ id: z.string().uuid() });

export const roleRoutes: FastifyPluginAsyncZod = async (app) => {
	app.post(
		"/roles/draft",
		{ schema: { body: DraftRoleRequest, response: { 200: DraftRoleResponse } } },
		(req) => draftRole(req.body),
	);
	app.post(
		"/roles",
		{ schema: { body: CreateRoleRequest, response: { 200: CreateRoleResponse } } },
		async (req) => createRole(await requireWallet(req), req.body),
	);
	app.get("/roles", { schema: { response: { 200: z.array(RoleSummary) } } }, async (req) =>
		listRoles(await requireWallet(req)),
	);
	app.get("/roles/:id", { schema: { params: IdParams, response: { 200: RoleDetail } } }, (req) =>
		getRole(req.params.id),
	);
	app.post(
		"/roles/:id/top-up",
		{ schema: { params: IdParams, body: TopUpRequest, response: { 200: TopUpResponse } } },
		async (req) => topUp(await requireWallet(req), req.params.id, req.body),
	);
	app.post(
		"/roles/:id/close",
		{ schema: { params: IdParams, response: { 200: z.object({ unsignedTx: UnsignedTx }) } } },
		async (req) => closeRole(await requireWallet(req), req.params.id),
	);
	app.get("/tasks", { schema: { response: { 200: z.array(TaskView) } } }, () => listTasks());
};
