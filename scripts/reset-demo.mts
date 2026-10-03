// Puts the demo wallets back into a known state before a live demo:
//  - closes the company's open roles that have no pending submissions (refunds the vaults),
//  - tops the company up to exactly DEMO_COMPANY_USDC (default 1000),
//  - on devnet (or with --fresh-scouts): archives the scout keypairs and generates fresh ones, so the
//    demo starts with a scout whose on-chain reputation is 0/0; then rewrites VITE_DEMO_SCOUT_SECRET /
//    VITE_DEMO_SCOUT2_SECRET in app/.env. Pass --keep-scouts to skip. The company keypair is kept.
//  - makes sure both scouts have USDC token accounts (relayer-paid) and Lucía (unvouched) has 10 USDC
//    for deliverable bonds,
//  - registers Ola's (scout) ScoutProfile vouched by the demo operator, co-signed by the operator
//    authority, so her payouts show the 3-way split. Lucía (scout2) stays unregistered (the app
//    registers her on onboarding).
//  - closes the agent's open tasks without pending deliverables first (closing a role needs that).
// Role ids are never reused; the backend just creates new roles.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Address, getBase58Decoder } from "@solana/kit";
import { getMintToInstruction } from "@solana-program/token";
import {
	fetchMaybeScoutProfile,
	fetchMaybeTask,
	fetchRoleVault,
	findScoutProfilePda,
	findTaskPda,
	getCloseRoleInstruction,
	getCloseTaskInstruction,
	getRegisterScoutInstructionAsync,
	getRoleVaultDecoder,
	ROLE_VAULT_DISCRIMINATOR,
	Status,
} from "../packages/shared/src/generated/index.ts";
import { demoWallets, fundWallet } from "./fund.mts";
import {
	archiveKeypair,
	ata,
	CLUSTER,
	expandHome,
	explorerTx,
	formatUsdc,
	KEYPAIRS,
	loadKeypair,
	loadOrCreateKeypair,
	PROGRAM_ID,
	ROLE_VAULT_SIZE,
	readDeployment,
	rpc,
	send,
	tokenBalance,
	USDC,
} from "./lib.mts";

const freshScouts =
	!process.argv.includes("--keep-scouts") &&
	(CLUSTER === "devnet" || process.argv.includes("--fresh-scouts"));
if (freshScouts) {
	for (const key of ["scout", "scout2"] as const) {
		const archived = archiveKeypair(KEYPAIRS[key]);
		if (archived) console.log(`archived ${key} keypair -> ${archived}`);
	}
}

const target = BigInt(process.env.DEMO_COMPANY_USDC ?? "1000") * USDC;
const deployment = readDeployment();
const deployer = await loadKeypair(KEYPAIRS.deployer); // mock-USDC mint authority
const relayer = await loadKeypair(KEYPAIRS.relayer); // pays fees and rent
const company = await loadKeypair(KEYPAIRS.company);
const agent = await loadOrCreateKeypair(KEYPAIRS.agent);
const wallets = await demoWallets();

if (freshScouts) {
	// Rewrite only the two scout lines; other lines (and comments) stay as they are. Secrets are never printed.
	const envPath = join(import.meta.dirname, "..", "app", ".env");
	const secrets: Record<string, string> = {
		VITE_DEMO_SCOUT_SECRET: readFileSync(expandHome(KEYPAIRS.scout), "utf8").trim(),
		VITE_DEMO_SCOUT2_SECRET: readFileSync(expandHome(KEYPAIRS.scout2), "utf8").trim(),
	};
	const lines = existsSync(envPath) ? readFileSync(envPath, "utf8").split("\n") : [];
	for (const [name, value] of Object.entries(secrets)) {
		const i = lines.findIndex((l) => l.startsWith(`${name}=`));
		if (i >= 0) lines[i] = `${name}=${value}`;
		else lines.splice(lines.at(-1) === "" ? -1 : lines.length, 0, `${name}=${value}`);
	}
	writeFileSync(envPath, lines.join("\n"), { mode: 0o600 });
	console.log(`updated ${Object.keys(secrets).join(", ")} in app/.env (restart Vite to pick them up)`);
}

const companyAta = await ata(company.address, deployment.usdcMint);

const roles = await rpc
	.getProgramAccounts(PROGRAM_ID, {
		encoding: "base64",
		filters: [
			// Only the current (v3.1) layout; older RoleVaults can't be closed by this program and are abandoned.
			{ dataSize: ROLE_VAULT_SIZE },
			{
				memcmp: {
					offset: 0n,
					bytes: getBase58Decoder().decode(ROLE_VAULT_DISCRIMINATOR) as never,
					encoding: "base58",
				},
			},
			{ memcmp: { offset: 8n, bytes: company.address as never, encoding: "base58" } },
		],
	})
	.send();

for (const { pubkey, account } of roles) {
	const roleVault = pubkey as Address;
	const role = getRoleVaultDecoder().decode(Buffer.from(account.data[0], "base64"));
	if (role.status !== Status.Open) continue;
	// Tasks are closed by the agent if the role has one we hold the key for, else by the company.
	const agentKey = role.agent.__option === "Some" && role.agent.value === agent.address ? agent : company;
	for (let taskId = 0; taskId < role.taskCount; taskId++) {
		const [taskAddress] = await findTaskPda({ roleVault, taskId });
		const task = await fetchMaybeTask(rpc, taskAddress).catch(() => undefined); // undefined = old layout
		if (!task?.exists || task.data.status !== Status.Open || task.data.pendingCount > 0) continue;
		try {
			await send(relayer, [
				getCloseTaskInstruction({ payer: relayer, authority: agentKey, roleVault, task: taskAddress }),
			]);
		} catch {
			// Tasks from before a layout change (e.g. v3.2) can't be closed by the current program: abandoned.
			console.log(`task ${taskAddress} can't be closed (old layout?); skipped`);
		}
	}
	const fresh = (await fetchRoleVault(rpc, roleVault)).data;
	if (fresh.openTaskCount > 0 || fresh.pendingCount > 0 || fresh.heldBackTotal > 0n) {
		console.log(
			`role ${pubkey}: ${fresh.pendingCount} pending, ${formatUsdc(fresh.heldBackTotal)} held back; leaving it open`,
		);
		continue;
	}
	const sig = await send(relayer, [
		getCloseRoleInstruction({
			payer: relayer,
			company,
			roleVault,
			vaultTokenAccount: role.vaultTokenAccount,
			companyTokenAccount: companyAta,
			mint: deployment.usdcMint,
		}),
	]);
	console.log(`closed role ${pubkey} (id ${role.roleId})  ${explorerTx(sig)}`);
}

const balance = await tokenBalance(companyAta);
if (balance < target) {
	await send(relayer, [
		getMintToInstruction({
			mint: deployment.usdcMint,
			token: companyAta,
			mintAuthority: deployer,
			amount: target - balance,
		}),
	]);
}
console.log(
	`company: ${formatUsdc(await tokenBalance(companyAta))}${balance > target ? " (above target, left as is)" : ""}`,
);
await fundWallet(wallets.scout, 0n, "scout");
// Lucía isn't vouched by an operator, so she posts deliverable bonds: keep 10 USDC on her account.
const luciaUsdc = await tokenBalance(await ata(wallets.scout2, deployment.usdcMint));
await fundWallet(wallets.scout2, luciaUsdc < 10n * USDC ? 10n - luciaUsdc / USDC : 0n, "scout2");

if (deployment.operator) {
	const ola = await loadKeypair(KEYPAIRS.scout);
	const [profile] = await findScoutProfilePda({ scout: ola.address });
	const existing = await fetchMaybeScoutProfile(rpc, profile);
	if (existing.exists) {
		const vouched = existing.data.operator.__option === "Some" ? "vouched" : "not vouched";
		console.log(`scout profile ${profile} already exists (${vouched}); use fresh scouts to re-vouch`);
	} else {
		const operatorAuthority = await loadKeypair(KEYPAIRS.operator);
		const sig = await send(relayer, [
			await getRegisterScoutInstructionAsync({
				payer: relayer,
				scout: ola,
				operator: deployment.operator.address,
				operatorAuthority,
				mint: deployment.usdcMint,
			}),
		]);
		console.log(`registered Ola vouched by ${deployment.operator.name}  ${explorerTx(sig)}`);
	}
} else {
	console.log("no demo operator in the deployment file; run pnpm setup:<cluster> first");
}
