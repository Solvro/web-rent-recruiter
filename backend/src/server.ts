import cors from "@fastify/cors";
import { PROJECT_NAME } from "@scout/shared";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { dbKind, runMigrations } from "./db/index.ts";
import { env } from "./env.ts";
import { errorHandler } from "./http.ts";
import { startIndexer } from "./indexer/index.ts";
import { meRoutes } from "./routes/me.ts";
import { roleRoutes } from "./routes/roles.ts";
import { scoutRoutes } from "./routes/scouts.ts";
import { submissionRoutes } from "./routes/submissions.ts";
import { txRoutes } from "./routes/tx.ts";
import { loadDeployment, programAddress, relayer } from "./solana/chain.ts";
import { loadIdl } from "./solana/idl.ts";

export async function buildApp() {
	const app = Fastify({
		logger: { level: process.env.LOG_LEVEL ?? "info" },
	}).withTypeProvider<ZodTypeProvider>();
	app.setValidatorCompiler(validatorCompiler);
	app.setSerializerCompiler(serializerCompiler);
	app.setErrorHandler(errorHandler);
	await app.register(cors, { origin: env.corsOrigins, allowedHeaders: ["content-type", "x-wallet"] });

	app.get("/health", async () => {
		const deployment = loadDeployment();
		return {
			name: PROJECT_NAME,
			db: dbKind,
			cluster: env.cluster,
			rpc: env.rpcUrl,
			idl: loadIdl() !== null,
			deployment: deployment !== null,
			programId: deployment || loadIdl() ? programAddress() : null,
			relayer: (await relayer().catch(() => null))?.address ?? null,
		};
	});

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
	const stopIndexer = startIndexer({ info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) });
	app.addHook("onClose", async () => stopIndexer());
	await app.listen({ port: env.port, host: env.host });
}
