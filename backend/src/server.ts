import cors from "@fastify/cors";
import { PROJECT_NAME } from "@scout/shared";
import { type FastifyTRPCPluginOptions, fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { startAgentRunner } from "./agent-runner/runner.ts";
import { dbKind, runMigrations } from "./db/index.ts";
import { env } from "./env.ts";
import { errorHandler } from "./http.ts";
import { startIndexer } from "./indexer/index.ts";
import { runRepairs } from "./indexer/repairs.ts";
import { startRecallPoller } from "./recall/service.ts";
import { meRoutes } from "./routes/me.ts";
import { roleRoutes } from "./routes/roles.ts";
import { scoutRoutes } from "./routes/scouts.ts";
import { submissionRoutes } from "./routes/submissions.ts";
import { txRoutes } from "./routes/tx.ts";
import { loadDeployment, programAddress, relayer, rpcRequestsLastMinute } from "./solana/chain.ts";
import { loadIdl } from "./solana/idl.ts";
import { createContext } from "./trpc/init.ts";
import { type AppRouter, appRouter } from "./trpc/router.ts";

export async function buildApp() {
	const app = Fastify({
		logger: { level: process.env.LOG_LEVEL ?? "info" },
		// tRPC batches put many procedure names in one path segment.
		routerOptions: { maxParamLength: 5000 },
	}).withTypeProvider<ZodTypeProvider>();
	app.setValidatorCompiler(validatorCompiler);
	app.setSerializerCompiler(serializerCompiler);
	app.setErrorHandler(errorHandler);
	await app.register(cors, {
		origin: env.corsOrigins,
		allowedHeaders: ["content-type", "x-wallet", "trpc-accept"],
	});

	app.get("/health", async () => {
		const deployment = loadDeployment();
		return {
			name: PROJECT_NAME,
			db: dbKind,
			cluster: env.cluster,
			rpc: env.rpcUrl.replace(/\?.*$/, ""), // never expose API keys
			idl: loadIdl() !== null,
			deployment: deployment !== null,
			programId: deployment || loadIdl() ? programAddress() : null,
			relayer: (await relayer().catch(() => null))?.address ?? null,
			rpcRequestsLastMinute: rpcRequestsLastMinute(),
		};
	});

	await app.register(fastifyTRPCPlugin, {
		prefix: "/trpc",
		trpcOptions: {
			router: appRouter,
			createContext,
			onError({ path, error }) {
				if (error.code === "INTERNAL_SERVER_ERROR") app.log.error({ path, err: error.message }, "trpc error");
			},
		} satisfies FastifyTRPCPluginOptions<AppRouter>["trpcOptions"],
	});

	// Deprecated REST transport (scripts only); same use-cases as the tRPC router.
	await app.register(
		async (api) => {
			await api.register(meRoutes);
			await api.register(roleRoutes);
			await api.register(submissionRoutes);
			await api.register(scoutRoutes);
			await api.register(txRoutes);
		},
		{ prefix: "/api" },
	);
	return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	await runMigrations();
	const app = await buildApp();
	void runRepairs({ info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) });
	const stopIndexer = startIndexer({ info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) });
	const stopRecall = startRecallPoller({ info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) });
	const stopAgents =
		process.env.AGENT_RUNNER === "off"
			? () => {}
			: startAgentRunner({ info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) });
	app.addHook("onClose", async () => {
		stopIndexer();
		stopAgents();
		stopRecall();
	});
	await app.listen({ port: env.port, host: env.host });
}
