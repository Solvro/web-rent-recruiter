// Mints mock USDC to demo wallets (and tries a small SOL airdrop).
// Usage:
//   pnpm fund                          -> company 1000 USDC, scout2 (unvouched) 10 USDC for bonds
//   pnpm fund <address> [--usdc 500]   -> mint to any wallet
import { type Address, address, type Instruction } from "@solana/kit";
import {
	getCreateAssociatedTokenIdempotentInstructionAsync,
	getMintToInstruction,
} from "@solana-program/token";
import {
	ata,
	CLUSTER,
	formatUsdc,
	KEYPAIRS,
	loadKeypair,
	loadOrCreateKeypair,
	readDeployment,
	send,
	solBalance,
	tokenBalance,
	tryAirdrop,
	USDC,
} from "./lib.mts";

const args = process.argv.slice(2);
const usdcFlag = args.indexOf("--usdc");
const usdcOverride = usdcFlag >= 0 ? BigInt(args[usdcFlag + 1]) : undefined;
const explicit = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--usdc");

const deployment = readDeployment();
const deployer = await loadKeypair(KEYPAIRS.deployer); // mock-USDC mint authority
const relayer = await loadKeypair(KEYPAIRS.relayer); // pays fees and rent

export async function fundWallet(owner: Address, usdc: bigint, label: string = owner) {
	const tokenAccount = await ata(owner, deployment.usdcMint);
	const instructions: Instruction[] = [
		await getCreateAssociatedTokenIdempotentInstructionAsync({
			payer: relayer,
			owner,
			mint: deployment.usdcMint,
		}),
	];
	if (usdc > 0n) {
		instructions.push(
			getMintToInstruction({
				mint: deployment.usdcMint,
				token: tokenAccount,
				mintAuthority: deployer,
				amount: usdc * USDC,
			}),
		);
	}
	await send(relayer, instructions);
	// Users never need SOL (the relayer pays), but a little helps when testing with a browser wallet.
	if (CLUSTER === "localnet" && (await solBalance(owner)) === 0n) await tryAirdrop(owner, 1);
	console.log(`${label}: ${formatUsdc(await tokenBalance(tokenAccount))}  (${owner})`);
}

export async function demoWallets(): Promise<Record<"deployer" | "company" | "scout" | "scout2", Address>> {
	return {
		deployer: deployer.address,
		company: (await loadOrCreateKeypair(KEYPAIRS.company)).address,
		scout: (await loadOrCreateKeypair(KEYPAIRS.scout)).address,
		scout2: (await loadOrCreateKeypair(KEYPAIRS.scout2)).address,
	};
}

if (import.meta.main ?? process.argv[1]?.endsWith("fund.mts")) {
	if (explicit.length > 0) {
		for (const a of explicit) await fundWallet(address(a), usdcOverride ?? 1000n);
	} else {
		const wallets = await demoWallets();
		await fundWallet(wallets.company, usdcOverride ?? 1000n, "company");
		await fundWallet(wallets.scout, 0n, "scout");
		await fundWallet(wallets.scout2, 10n, "scout2"); // unvouched: needs USDC for deliverable bonds
	}
}
