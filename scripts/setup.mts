// One-time setup per cluster: mock USDC mint + program Config. Idempotent.
// Usage: CLUSTER=localnet|devnet pnpm tsx scripts/setup.mts  (or pnpm setup:localnet / setup:devnet)
import { existsSync } from "node:fs";
import { generateKeyPairSigner } from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import { getInitializeMint2Instruction, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
	fetchMaybeConfig,
	findConfigPda,
	getInitializeConfigInstructionAsync,
} from "../packages/shared/src/generated/index.ts";
import {
	accountExists,
	ata,
	CLUSTER,
	type Deployment,
	deploymentPath,
	explorerTx,
	FEE_BPS,
	KEYPAIRS,
	loadKeypair,
	PROGRAM_ID,
	RPC_URL,
	readDeployment,
	rpc,
	send,
	solBalance,
	tryAirdrop,
	USDC_DECIMALS,
	writeDeployment,
} from "./lib.mts";

const deployer = await loadKeypair(KEYPAIRS.deployer);
console.log(`cluster ${CLUSTER} (${RPC_URL}), deployer ${deployer.address}`);

if (!(await accountExists(PROGRAM_ID))) {
	throw new Error(
		`program ${PROGRAM_ID} is not deployed on ${CLUSTER}. Run: anchor deploy --provider.cluster ${CLUSTER}`,
	);
}
if ((await solBalance(deployer.address)) < 100_000_000n)
	await tryAirdrop(deployer.address, CLUSTER === "devnet" ? 1 : 10);

const [config] = await findConfigPda();
const existing = await fetchMaybeConfig(rpc, config);

if (existing.exists) {
	console.log(`config already initialized at ${config}`);
	if (!existsSync(deploymentPath())) {
		const { usdcMint, treasury, treasuryTokenAccount, feeBps } = existing.data;
		writeDeployment({
			cluster: CLUSTER,
			rpcUrl: RPC_URL,
			programId: PROGRAM_ID,
			usdcMint,
			usdcDecimals: USDC_DECIMALS,
			config,
			treasury,
			treasuryTokenAccount,
			feeBps,
			tokenProgram: TOKEN_PROGRAM_ADDRESS,
		});
	}
	console.log(readDeployment());
	process.exit(0);
}

// Mock USDC: 6 decimals, deployer is the mint authority so scripts can mint test funds.
const mint = await generateKeyPairSigner();
const rent = await rpc.getMinimumBalanceForRentExemption(BigInt(getMintSize())).send();
const mintSig = await send(deployer, [
	getCreateAccountInstruction({
		payer: deployer,
		newAccount: mint,
		lamports: rent,
		space: getMintSize(),
		programAddress: TOKEN_PROGRAM_ADDRESS,
	}),
	getInitializeMint2Instruction({
		mint: mint.address,
		decimals: USDC_DECIMALS,
		mintAuthority: deployer.address,
		freezeAuthority: null,
	}),
]);
console.log(`mock USDC mint ${mint.address}\n  ${explorerTx(mintSig)}`);

const treasury = deployer.address;
const configSig = await send(deployer, [
	await getInitializeConfigInstructionAsync({
		payer: deployer,
		admin: deployer,
		treasuryWallet: treasury,
		usdcMint: mint.address,
		feeBps: FEE_BPS,
		treasury,
	}),
]);
console.log(`config ${config}\n  ${explorerTx(configSig)}`);

const deployment: Deployment = {
	cluster: CLUSTER,
	rpcUrl: RPC_URL,
	programId: PROGRAM_ID,
	usdcMint: mint.address,
	usdcDecimals: USDC_DECIMALS,
	config,
	treasury,
	treasuryTokenAccount: await ata(treasury, mint.address),
	feeBps: FEE_BPS,
	tokenProgram: TOKEN_PROGRAM_ADDRESS,
};
writeDeployment(deployment);
console.log(`wrote ${deploymentPath()}`);
console.log(deployment);
