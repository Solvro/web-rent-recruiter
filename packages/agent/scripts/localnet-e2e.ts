/**
 * Self-hosted agent on a real chain, end to end:
 *   - starts its own Surfpool (port 18899, nothing shared touched) with the Scout program,
 *   - sets up a mock USDC mint, Config, a company role delegated to a FRESH agent key,
 *   - serves the agent API from the in-memory reference server (the platform),
 *   - runs the scout-agent runner (remote ports, offline policy) step by step:
 *       1. it plans and posts the sourcing gig, signing create_task with its own key;
 *       2. two recruiters deliver (Karolina, Piotr); the runner co-signs as gatekeeper;
 *       3. it reviews both: Karolina pre-accepted, Piotr rejected on-chain (agent signs);
 *       4. Karolina confirms; the runner settles accept_submission on-chain, the sourcer is paid,
 *          and it books a screening call for her (create_task with the sourcer excluded).
 * Usage: pnpm --filter @scout/agent exec tsx scripts/localnet-e2e.ts
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

process.env.LLM_PROVIDER = "offline";
process.env.REVIEW_ENGINE = "offline";

const { Criteria } = await import("@scout/shared");
const P = await import("@scout/shared/program");
const kit = await import("@solana/kit");
const { getCreateAccountInstruction } = await import("@solana-program/system");
const T = await import("@solana-program/token");
const { createMemoryAgentApi } = await import("../src/remote/dev/memory-api.ts");
const { connect, tick } = await import("../src/remote/run.ts");

const PORT = 18899;
const RPC_URL = `http://127.0.0.1:${PORT}`;
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const USDC = 1_000_000n;
const say = (s: string) => console.log(s);
const ok = (cond: unknown, what: string) => {
	if (!cond) throw new Error(`FAILED: ${what}`);
	say(`  ✓ ${what}`);
};

// ---- 1. An isolated validator with the Scout program ---------------------------------------
let surfpool: ChildProcess | null = null;
const rpc = kit.createSolanaRpc(RPC_URL);
async function programReady() {
	try {
		const { value } = await rpc.getAccountInfo(P.SCOUT_PROGRAM_ADDRESS, { encoding: "base64" }).send();
		return Boolean(value?.executable);
	} catch {
		return false;
	}
}
async function rpcUp() {
	try {
		await rpc.getSlot().send();
		return true;
	} catch {
		return false;
	}
}
const run = (cmd: string, args: string[]) =>
	new Promise<void>((resolve, reject) => {
		const p = spawn(cmd, args, { cwd: REPO, stdio: ["ignore", "ignore", "pipe"] });
		let err = "";
		p.stderr?.on("data", (d) => (err += d));
		p.on("exit", (code) =>
			code === 0 ? resolve() : reject(new Error(`${cmd} ${args[0]} failed: ${err.slice(-500)}`)),
		);
	});
if (!(await programReady())) {
	if (!(await rpcUp())) {
		say(`starting Surfpool on ${RPC_URL}…`);
		surfpool = spawn(
			"surfpool",
			[
				"start",
				"--host",
				"127.0.0.1",
				"--port",
				String(PORT),
				"--ws-port",
				String(PORT + 1),
				"--offline",
				"--block-production-mode",
				"clock",
				"--no-deploy",
				"--no-tui",
				"--yes",
				"--log-level",
				"none",
			],
			{ cwd: REPO, stdio: "ignore" },
		);
		for (let i = 0; i < 60 && !(await rpcUp()); i++) await new Promise((r) => setTimeout(r, 500));
	}
	// Deploy the built program ourselves (deployer = upgrade authority = Config admin).
	say("deploying target/deploy/scout.so…");
	const deployerKey = `${homedir()}/.config/solana/id.json`;
	await run("solana", ["airdrop", "100", "--url", RPC_URL, "--keypair", deployerKey]);
	await run("solana", [
		"program",
		"deploy",
		"target/deploy/scout.so",
		"--program-id",
		"target/deploy/scout-keypair.json",
		"--url",
		RPC_URL,
		"--keypair",
		deployerKey,
		"--upgrade-authority",
		deployerKey,
	]);
	for (let i = 0; i < 40 && !(await programReady()); i++) await new Promise((r) => setTimeout(r, 500));
	if (!(await programReady())) throw new Error("the Scout program didn't deploy");
}
const cleanup = () => surfpool?.kill();
process.on("exit", cleanup);

try {
	// ---- 2. Keys, mint, Config -----------------------------------------------------------------
	const loadKey = async (path: string) =>
		kit.createKeyPairSignerFromBytes(
			Uint8Array.from(JSON.parse(readFileSync(path.replace(/^~/, homedir()), "utf-8")) as number[]),
		);
	const deployer = await loadKey("~/.config/solana/id.json");
	const [relayer, company, agent, sourcer, sourcer2, treasury] = await Promise.all(
		Array.from({ length: 6 }, () => kit.generateKeyPairSigner()),
	);
	for (const k of [relayer, deployer]) {
		await rpc.requestAirdrop(k.address, kit.lamports(10_000_000_000n)).send();
	}
	await new Promise((r) => setTimeout(r, 1500));

	async function send(ixs: Parameters<typeof kit.appendTransactionMessageInstructions>[0], signer = relayer) {
		const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
		const msg = kit.pipe(
			kit.createTransactionMessage({ version: 0 }),
			(m) => kit.setTransactionMessageFeePayerSigner(signer, m),
			(m) => kit.setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
			(m) => kit.appendTransactionMessageInstructions(ixs, m),
		);
		const tx = await kit.signTransactionMessageWithSigners(msg);
		await rpc.sendTransaction(kit.getBase64EncodedWireTransaction(tx), { encoding: "base64" }).send();
		const sig = kit.getSignatureFromTransaction(tx);
		for (let i = 0; i < 75; i++) {
			const { value } = await rpc.getSignatureStatuses([sig]).send();
			if (value[0]?.err) throw new Error(`tx failed: ${JSON.stringify(value[0].err)}`);
			if (value[0]?.confirmationStatus === "confirmed" || value[0]?.confirmationStatus === "finalized")
				return sig;
			await new Promise((r) => setTimeout(r, 300));
		}
		throw new Error("tx not confirmed");
	}
	const tokenProgram = T.TOKEN_PROGRAM_ADDRESS;
	const ata = async (owner: kit.Address) =>
		(await T.findAssociatedTokenPda({ owner, mint: mint.address, tokenProgram }))[0];
	const balance = async (account: kit.Address) =>
		BigInt((await rpc.getTokenAccountBalance(account).send()).value.amount);

	const mint = await kit.generateKeyPairSigner();
	const space = BigInt(T.getMintSize());
	const rent = await rpc.getMinimumBalanceForRentExemption(space).send();
	await send([
		getCreateAccountInstruction({
			payer: relayer,
			newAccount: mint,
			lamports: rent,
			space,
			programAddress: tokenProgram,
		}),
		T.getInitializeMint2Instruction({
			mint: mint.address,
			decimals: 6,
			mintAuthority: deployer.address,
			freezeAuthority: null,
		}),
	]);
	const [config] = await P.findConfigPda();
	if (!(await P.fetchMaybeConfig(rpc, config)).exists) {
		await send([
			await P.getInitializeConfigInstructionAsync({
				payer: relayer,
				admin: deployer,
				treasuryWallet: treasury.address,
				usdcMint: mint.address,
				treasury: treasury.address,
				params: {
					feeBps: 1000,
					minBounty: 500_000n,
					minReputableBounty: USDC,
					minWindowSeconds: 1n,
					maxWindowSeconds: 7_776_000n,
				},
			}),
		]);
	}
	const cfg = (await P.fetchConfig(rpc, config)).data;
	if (cfg.usdcMint !== mint.address) {
		// A previous run on this validator: reuse its mint (mint authority is the deployer either way).
		Object.assign(mint, { address: cfg.usdcMint });
	}
	say(`config ${config}, mint ${cfg.usdcMint}`);

	// ---- 3. The company funds a role and delegates it to the self-hosted agent --------------------
	const fund = async (owner: kit.Address, usdc: bigint) => {
		const account = await ata(owner);
		await send([
			await T.getCreateAssociatedTokenIdempotentInstructionAsync({
				payer: relayer,
				owner,
				mint: cfg.usdcMint,
			}),
			T.getMintToInstruction({
				mint: cfg.usdcMint,
				token: account,
				mintAuthority: deployer,
				amount: usdc * USDC,
			}),
		]);
		return account;
	};
	const companyAta = await fund(company.address, 1000n);
	const roleId = BigInt(Date.now());
	const [roleVault] = await P.findRoleVaultPda({ company: company.address, roleId });
	await send([
		await P.getCreateRoleInstructionAsync({
			payer: relayer,
			company,
			companyTokenAccount: companyAta,
			mint: cfg.usdcMint,
			roleId,
			agent: agent.address,
			reviewWindowSeconds: 3600n,
			claimTimeoutSeconds: 3600n,
			holdbackWindowSeconds: 3600n,
			initialDeposit: 750n * USDC,
			agentMaxBounty: 80n * USDC,
			agentMaxCommitment: 750n * USDC,
		}),
	]);
	say(`role ${roleVault}: $750, agent = self-hosted key ${agent.address}`);

	// ---- 4. The platform (reference agent API) ------------------------------------------------
	const demo = JSON.parse(
		readFileSync(new URL("../src/fixtures/demo-role-senior-backend-ts.json", import.meta.url), "utf-8"),
	);
	const api = createMemoryAgentApi({
		rpc,
		relayer,
		config: {
			apiVersion: 1,
			cluster: "localnet",
			rpcUrl: RPC_URL,
			programId: P.SCOUT_PROGRAM_ADDRESS,
			usdcMint: cfg.usdcMint,
			tokenProgram,
			config,
			treasuryTokenAccount: cfg.treasuryTokenAccount,
			relayer: relayer.address,
			// Like the real platform: an attestor exists, but the agent still settles confirmed candidates itself.
			confirmationAttestor: relayer.address,
		},
	});
	const roleUuid = randomUUID();
	api.addRole({
		agent: agent.address,
		snapshot: {
			roleId: roleUuid,
			roleVault,
			company: company.address,
			title: demo.title,
			criteria: Criteria.parse(demo.criteria),
			paused: false,
			pausedTaskTypes: [],
			holdbackBps: 0,
			gigs: [],
			candidates: [],
		},
	});
	const apiUrl = await api.listen();
	say(`agent API (reference server) on ${apiUrl}`);

	// ---- 5. The self-hosted runner ---------------------------------------------------------------
	const conn = await connect({ apiUrl, agent, roleVault, rpcUrl: RPC_URL, log: say });
	const step = async (label: string) => {
		say(`\n▶ ${label}`);
		for (const line of await tick(conn)) say(`  ${line}`);
	};

	await step("Role funded");
	const sourcingGig = api.state.roles.get(roleUuid)?.snapshot.gigs[0];
	ok(sourcingGig?.taskAddress, "the runner posted the sourcing gig");
	const task = kit.address(sourcingGig?.taskAddress as string);
	const taskData = (await P.fetchTask(rpc, task)).data;
	ok(taskData.createdByAgent, "create_task was signed by the agent's own key (created_by_agent)");
	ok(taskData.bounty === 25n * USDC, `bounty $${Number(taskData.bounty) / 1e6} per profile (market +25%)`);

	// Recruiters deliver; the platform queues each tx for the gatekeeper's co-signature.
	const vault = (await P.fetchRoleVault(rpc, roleVault)).data;
	async function deliver(scout: kit.KeyPairSigner, file: string) {
		const c = JSON.parse(readFileSync(new URL(`../src/fixtures/${file}`, import.meta.url), "utf-8"));
		const scoutAta = await fund(scout.address, 10n); // pays the 10% bond
		await send([await P.getRegisterScoutInstructionAsync({ payer: relayer, scout, mint: cfg.usdcMint })]);
		const deliverableHash = new Uint8Array(createHash("sha256").update(`salt|${c.profileUrl}`).digest());
		const ix = await P.getSubmitDeliverableInstructionAsync({
			payer: kit.createNoopSigner(relayer.address),
			scout,
			gatekeeper: kit.createNoopSigner(agent.address),
			roleVault,
			task,
			vaultTokenAccount: vault.vaultTokenAccount,
			scoutTokenAccount: scoutAta,
			mint: cfg.usdcMint,
			deliverableHash,
			evidenceHash: new Uint8Array(32),
		});
		const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
		const msg = kit.pipe(
			kit.createTransactionMessage({ version: 0 }),
			(m) => kit.setTransactionMessageFeePayerSigner(kit.createNoopSigner(relayer.address), m),
			(m) => kit.setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
			(m) => kit.appendTransactionMessageInstructions([ix], m),
		);
		const signedByScout = await kit.partiallySignTransactionMessageWithSigners(msg);
		const relayed = api.requestCosign({
			roleId: roleUuid,
			gigId: sourcingGig?.gigId ?? null,
			kind: "deliver",
			summary: `${c.name} for ${demo.title}`,
			transaction: kit.getBase64EncodedWireTransaction(signedByScout),
		});
		const [submission] = await P.findSubmissionPda({ task, deliverableHash });
		return { c, scoutAta, submission, relayed };
	}
	const karolina = await deliver(sourcer, "demo-candidate-1-strong-karolina.json");
	const piotr = await deliver(sourcer2, "demo-candidate-3-weak-piotr.json");
	await step("Two deliveries waiting for the gatekeeper");
	await Promise.all([karolina.relayed, piotr.relayed]);
	ok(
		(await P.fetchMaybeSubmission(rpc, karolina.submission)).exists,
		"Karolina's submission is on-chain (agent co-signed)",
	);
	ok(
		(await P.fetchMaybeSubmission(rpc, piotr.submission)).exists,
		"Piotr's submission is on-chain (agent co-signed)",
	);

	// The platform lists the payloads for the agent.
	for (const [d, scout, id] of [
		[karolina, sourcer, "del-karolina"],
		[piotr, sourcer2, "del-piotr"],
	] as const) {
		api.addDeliverable({
			id,
			roleId: roleUuid,
			gigId: sourcingGig?.gigId as string,
			kind: "sourcing",
			stage: "pending",
			submission: d.submission,
			task,
			scout: scout.address,
			recruiter: { wallet: scout.address, displayName: id === "del-karolina" ? "Ola" : "Marek" },
			submittedAt: new Date().toISOString(),
			updatedAt: null,
			payload: { candidate: { name: d.c.name, profileUrl: d.c.profileUrl, notes: d.c.notes } },
		});
	}
	const piotrBefore = await balance(piotr.scoutAta);
	await step("Deliverables listed by the platform");
	ok(
		api.state.deliverables.get("del-karolina")?.stage === "pre_accepted",
		"Karolina pre-accepted (waiting for her confirmation)",
	);
	ok(
		!(await P.fetchMaybeSubmission(rpc, piotr.submission)).exists,
		"Piotr rejected on-chain by the agent (submission closed)",
	);
	const rejectSig = api.state.decisions.find((d) => d.deliverableId === "del-piotr")?.signature;
	ok(rejectSig, `reject_submission signature ${rejectSig}`);
	const piotrLeft = await balance(piotr.scoutAta);
	ok(
		piotrLeft === piotrBefore && piotrLeft < 10n * USDC,
		`Piotr's ${Number(10n * USDC - piotrLeft) / 1e6} USDC bond stays in the role budget (forfeited on reject)`,
	);

	// The candidate confirms interest on the platform's page.
	const k = api.state.deliverables.get("del-karolina");
	if (k) k.stage = "candidate_confirmed";
	const before = await balance(karolina.scoutAta);
	await step("Karolina confirmed interest");
	const paid = (await balance(karolina.scoutAta)) - before;
	const sub = (await P.fetchSubmission(rpc, karolina.submission)).data;
	ok(sub.status === P.SubmissionStatus.Accepted, "accept_submission confirmed on-chain, signed by the agent");
	ok(paid > 0n, `the sourcer received ${Number(paid) / 1e6} USDC (bounty − 10% fee, + bond back)`);
	const screening = api.state.roles.get(roleUuid)?.snapshot.gigs.find((g) => g.taskType === "SCREENING_CALL");
	ok(screening?.taskAddress, "the runner booked a screening call for Karolina");
	const screeningTask = (await P.fetchTask(rpc, kit.address(screening?.taskAddress as string))).data;
	ok(
		screeningTask.subjectScout.__option === "Some" && screeningTask.subjectScout.value === sourcer.address,
		"the screening task excludes the sourcer on-chain (subject_scout)",
	);
	say(`\nactivity:\n${api.state.log.map((l) => `  [${l.kind}] ${l.message}`).join("\n")}`);
	say("\nSELF-HOSTED AGENT E2E: OK");
	api.close();
} finally {
	cleanup();
}
process.exit(0);
