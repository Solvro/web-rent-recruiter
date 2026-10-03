/**
 * scout-agent: run your own agent for a Scout role.
 *
 *   scout-agent --role <roleVault> --keypair <agent.json> --api <https://…/trpc> [options]
 *
 * Options:
 *   --rpc <url>            RPC endpoint (default: the platform's, from agent.config)
 *   --fee-payer relayer|self   who pays transaction fees (default: relayer if the platform offers one)
 *   --interval <seconds>   how often to run a step (default 30)
 *   --once                 run one step and exit
 *   --llm offline|openrouter|anthropic|openai   (default offline: deterministic policy, no model calls)
 *   --model <id>           main model (e.g. openai/gpt-6-luna on OpenRouter)
 *   --fast-model <id>      model for one-line summaries
 *   --review jev|offline   per-criterion judgments (default offline; jev needs JEV_API_KEY or OPENROUTER_API_KEY)
 *
 * Keys come from the environment (or a .env file next to where you run it): OPENROUTER_API_KEY,
 * ANTHROPIC_API_KEY, OPENAI_API_KEY, JEV_API_KEY. The agent key never leaves this machine.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { address, createKeyPairSignerFromBytes } from "@solana/kit";
import { providerLabel } from "../llm/index.ts";
import type { AgentEvent } from "../runner/ports.ts";
import { runRemoteAgent } from "./run.ts";

const { values } = parseArgs({
	options: {
		role: { type: "string" },
		keypair: { type: "string" },
		api: { type: "string" },
		rpc: { type: "string" },
		"fee-payer": { type: "string" },
		interval: { type: "string", default: "30" },
		once: { type: "boolean", default: false },
		llm: { type: "string", default: "offline" },
		model: { type: "string" },
		"fast-model": { type: "string" },
		review: { type: "string", default: "offline" },
		help: { type: "boolean", short: "h", default: false },
	},
});

const usage = () => {
	const header = readFileSync(new URL(import.meta.url), "utf-8").match(/\/\*\*([\s\S]*?)\*\//)?.[1] ?? "";
	console.log(header.replace(/^ \* ?/gm, "").trim());
};
if (values.help || !values.role || !values.keypair || !values.api) {
	usage();
	process.exit(values.help ? 0 : 1);
}

// The operator chooses the brain. Offline = the deterministic policy only (no model calls at all).
const llm = values.llm ?? "offline";
if (!["offline", "openrouter", "anthropic", "openai"].includes(llm)) throw new Error(`unknown --llm ${llm}`);
process.env.LLM_PROVIDER = llm;
if (values.model) process.env[`${llm.toUpperCase()}_MODEL`] = values.model;
if (values["fast-model"]) process.env[`${llm.toUpperCase()}_FAST_MODEL`] = values["fast-model"];
process.env.REVIEW_ENGINE = values.review === "jev" ? "jev" : "offline";

const keypairPath = values.keypair.replace(/^~(?=$|\/)/, homedir());
const agent = await createKeyPairSignerFromBytes(
	Uint8Array.from(JSON.parse(readFileSync(keypairPath, "utf-8")) as number[]),
);
const feePayer = values["fee-payer"];
if (feePayer && feePayer !== "relayer" && feePayer !== "self")
	throw new Error("--fee-payer must be relayer or self");

const printEvent = (e: AgentEvent) => {
	if (e.type === "tool-call") console.log(`  → ${e.toolName}`);
	if (e.type === "error") console.log(`  error: ${e.message}`);
};

console.log(`scout-agent · brain: ${providerLabel()} · review: ${process.env.REVIEW_ENGINE}`);
await runRemoteAgent({
	apiUrl: values.api,
	agent,
	roleVault: address(values.role),
	...(values.rpc ? { rpcUrl: values.rpc } : {}),
	...(feePayer ? { feePayer: feePayer as "relayer" | "self" } : {}),
	intervalMs: Number(values.interval) * 1000,
	once: values.once ?? false,
	onEvent: printEvent,
});
