// Puts the demo wallets back into a known state before a live demo:
//  - closes the company's open roles that have no pending submissions (refunds the vaults),
//  - tops the company up to exactly DEMO_COMPANY_USDC (default 1000),
//  - on devnet (or with --fresh-scouts): archives the scout keypairs and generates fresh ones, so the
//    demo starts with a scout whose on-chain reputation is 0/0; then rewrites VITE_DEMO_SCOUT_SECRET /
//    VITE_DEMO_SCOUT2_SECRET in app/.env. Pass --keep-scouts to skip. The company keypair is kept.
//  - makes sure both scouts have USDC token accounts (relayer-paid).
// Role ids are never reused; the backend just creates new roles.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Address, getBase58Decoder } from "@solana/kit";
import { getMintToInstruction } from "@solana-program/token";
import {
	getCloseRoleInstruction,
	getRoleVaultDecoder,
	ROLE_VAULT_DISCRIMINATOR,
	RoleStatus,
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
	PROGRAM_ID,
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
const deployer = await loadKeypair(KEYPAIRS.deployer);
const company = await loadKeypair(KEYPAIRS.company);
const wallets = await demoWallets();
const companyAta = await ata(company.address, deployment.usdcMint);

const roles = await rpc
	.getProgramAccounts(PROGRAM_ID, {
		encoding: "base64",
		filters: [
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
	const role = getRoleVaultDecoder().decode(Buffer.from(account.data[0], "base64"));
	if (role.status !== RoleStatus.Open) continue;
	if (role.pendingCount > 0) {
		console.log(`role ${pubkey} has ${role.pendingCount} pending submission(s); leaving it open`);
		continue;
	}
	const sig = await send(deployer, [
		getCloseRoleInstruction({
			payer: deployer,
			company,
			roleVault: pubkey as Address,
			vaultTokenAccount: role.vaultTokenAccount,
			companyTokenAccount: companyAta,
			mint: deployment.usdcMint,
		}),
	]);
	console.log(`closed role ${pubkey} (id ${role.roleId})  ${explorerTx(sig)}`);
}

const balance = await tokenBalance(companyAta);
if (balance < target) {
	await send(deployer, [
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
await fundWallet(wallets.scout2, 0n, "scout2");

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
