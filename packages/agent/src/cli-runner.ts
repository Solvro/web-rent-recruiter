/**
 * `agent run`: the role agent on in-memory ports with simulated recruiters, then company chat.
 * `agent chat "<message>"`: one chat turn after the simulated run.
 * MODE=deterministic skips the model (advanceRole only).
 */
import { readFileSync } from "node:fs";
import { type Criteria, Criteria as CriteriaSchema, fromBaseUnits, toBaseUnits } from "@scout/shared";
import type { ModelMessage } from "ai";
import { providerLabel } from "./llm/index.ts";
import { type AgentEvent, createMemoryPorts, createRoleAgent } from "./runner/index.ts";

const FIXTURES = new URL("./fixtures/", import.meta.url);
const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(name, FIXTURES), "utf-8")) as T;
const style = (code: number) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;
const bold = style(1);
const dim = style(2);
const cyan = style(36);
const magenta = style(35);

type DemoCandidate = { name: string; profileUrl: string; notes: string };

function printer() {
	let inText = false;
	return (event: AgentEvent) => {
		if (event.type === "text-delta") {
			if (!inText) process.stdout.write(`  ${bold("agent:")} `);
			inText = true;
			process.stdout.write(event.text);
			return;
		}
		if (inText) process.stdout.write("\n");
		inText = false;
		if (event.type === "tool-call") console.log(dim(`  → ${event.toolName}(${JSON.stringify(event.input)})`));
		if (event.type === "tool-result") {
			const out = event.output as { ok?: boolean; message?: string; error?: string } | undefined;
			const line = out?.message ?? out?.error ?? JSON.stringify(event.output).slice(0, 140);
			console.log(dim(`    ← ${out?.ok === false ? "refused: " : ""}${line}`));
		}
		if (event.type === "tool-error") console.log(magenta(`    ✗ ${event.toolName}: ${event.error}`));
		if (event.type === "error") console.log(magenta(`  error: ${event.message}`));
		if (event.type === "finish") console.log(dim(`  ($${event.costUsd.toFixed(4)})`));
	};
}

function setup() {
	const role = fixture<{ title: string; criteria: Criteria; budgetUsd: number }>(
		"demo-role-senior-backend-ts.json",
	);
	const mem = createMemoryPorts({
		title: role.title,
		criteria: CriteriaSchema.parse(role.criteria),
		deposited: toBaseUnits(role.budgetUsd),
		onEvent: printer(),
		onLog: (e) => console.log(cyan(`  [activity] ${e.message}`)),
	});
	if (process.env.MODE === "deterministic") process.env.LLM_PROVIDER = "offline";
	return { mem, agent: createRoleAgent(mem.ports) };
}

const gigOfType = (mem: ReturnType<typeof createMemoryPorts>, type: string, variant = "standard") =>
	mem.state.gigs.find(
		(g) => g.taskType === type && (g.variant ?? "standard") === variant && g.status === "OPEN",
	);

async function step(label: string, agent: ReturnType<typeof createRoleAgent>) {
	console.log(`\n${bold(`▶ ${label}`)}`);
	const started = Date.now();
	const result = await agent.runStep();
	console.log(dim(`  ${result.mode} · ${((Date.now() - started) / 1000).toFixed(1)}s`));
	return result;
}

/** Simulated role from funding to shortlist. Returns the state for chat. */
export async function simulateRun(quietChat = false) {
	console.log(
		dim(`llm: ${providerLabel()}${process.env.MODE === "deterministic" ? " (deterministic)" : ""}`),
	);
	const { mem, agent } = setup();
	let costUsd = 0;
	const track = async (label: string) => {
		costUsd += (await step(label, agent)).costUsd;
	};

	await track(`Role funded with $${fromBaseUnits(mem.state.deposited)}`);

	const sourcing = gigOfType(mem, "SOURCING");
	if (sourcing) {
		for (const file of [
			"demo-candidate-1-strong-karolina.json",
			"demo-candidate-2-medium-tomasz.json",
			"demo-candidate-3-weak-piotr.json",
		]) {
			const c = fixture<DemoCandidate>(file);
			mem.deliver(sourcing.gigId, { candidate: { name: c.name, profileUrl: c.profileUrl, notes: c.notes } });
			console.log(dim(`  recruiter delivered ${c.name}`));
		}
	}
	await track("3 sourced profiles delivered");

	const screening = gigOfType(mem, "SCREENING_CALL");
	if (screening) {
		mem.deliver(screening.gigId, fixture("screening-lazy.json"));
		console.log(dim("  a recruiter delivered lazy screening notes"));
		await track("Screening notes delivered (lazy)");
		mem.deliver(screening.gigId, fixture("screening-karolina-good.json"));
		console.log(dim("  another attempt with real screening notes"));
		await track("Screening notes delivered (good)");
	}

	const reference = gigOfType(mem, "REFERENCE_CHECK");
	if (reference) {
		mem.deliver(reference.gigId, fixture("reference-karolina.json"));
		console.log(dim("  recruiter delivered the reference check"));
		const language = gigOfType(mem, "SCREENING_CALL", "language");
		if (language) {
			mem.deliver(language.gigId, fixture("language-karolina-english.json"));
			console.log(dim("  recruiter delivered the English language check (with transcript)"));
		}
		await track("Reference and language check delivered");
	}

	const role = await mem.ports.getRole();
	console.log(
		`\n${bold("State")}: paid $${fromBaseUnits(role.budget.paid)}, available $${fromBaseUnits(role.budget.available)}, shortlist: ${mem.state.shortlist.map((e) => `${e.rank}. ${e.name} (${e.overall})`).join(", ") || "—"}, escalations: ${mem.state.escalations.length}`,
	);
	if (!quietChat) console.log(dim(`agent cost so far $${costUsd.toFixed(4)}`));
	return { mem, agent, costUsd };
}

export async function runCommand() {
	const { agent } = await simulateRun();
	await chatTurns(agent, [
		"Can you look for a few more people with Go experience?",
		"Pause the screening calls for now.",
		"Why did you reject Piotr?",
	]);
}

export async function chatCommand(message: string) {
	const { agent } = await simulateRun(true);
	await chatTurns(agent, [message]);
}

async function chatTurns(agent: ReturnType<typeof createRoleAgent>, messages: string[]) {
	let history: ModelMessage[] = [];
	for (const message of messages) {
		console.log(`\n${bold("company:")} ${message}`);
		const started = Date.now();
		const result = await agent.chat(message, history, { verifiedCompany: true });
		history = [...history, { role: "user", content: message }, ...result.messages];
		console.log(dim(`  ${result.mode} · ${((Date.now() - started) / 1000).toFixed(1)}s`));
	}
}
