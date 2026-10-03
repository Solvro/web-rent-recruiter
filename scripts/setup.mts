// One-time setup per cluster: mock USDC mint, program Config, the demo operator and agent wallet. Idempotent.
// Usage: CLUSTER=localnet|devnet pnpm tsx scripts/setup.mts  (or pnpm setup:localnet / setup:devnet)
import { existsSync } from "node:fs";
import { type Address, generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import { getInitializeMint2Instruction, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
	fetchMaybeConfig,
	fetchMaybeOperator,
	findConfigPda,
	findOperatorPda,
	getInitializeConfigInstructionAsync,
	getRegisterOperatorInstructionAsync,
} from "../packages/shared/src/generated/index.ts";
import {
	accountExists,
	ata,
	CLUSTER,
	CONFIG_PARAMS,
	DEMO_OPERATOR,
	type Deployment,
	deploymentPath,
	expandHome,
	explorerTx,
	KEYPAIRS,
	loadKeypair,
	loadOrCreateKeypair,
	PROGRAM_ID,
	PUBLIC_RPC_URL,
	programUpgradeAuthority,
	RPC_LABEL,
	readDeployment,
	rpc,
	send,
	solBalance,
	tryAirdrop,
	USDC_DECIMALS,
	writeDeployment,
} from "./lib.mts";

const deployer = await loadKeypair(KEYPAIRS.deployer);
const relayer = await loadOrCreateKeypair(KEYPAIRS.relayer);
console.log(
	`cluster ${CLUSTER} (${RPC_LABEL}), relayer ${relayer.address}, mint authority ${deployer.address}`,
);

if (!(await accountExists(PROGRAM_ID))) {
	throw new Error(
		`program ${PROGRAM_ID} is not deployed on ${CLUSTER}. Run: anchor deploy --provider.cluster ${CLUSTER}`,
	);
}
for (const wallet of [relayer.address, deployer.address]) {
	if ((await solBalance(wallet)) < 100_000_000n) {
		if (CLUSTER === "localnet") await tryAirdrop(wallet, 10);
		else console.warn(`${wallet} has < 0.1 SOL; fund it (the relayer pays every user transaction)`);
	}
}

const [config] = await findConfigPda();
const existing = await fetchMaybeConfig(rpc, config);
let usdcMint: Address;
let treasury: Address;
let treasuryTokenAccount: Address;
let feeBps: number;

if (existing.exists) {
	console.log(`config already initialized at ${config}`);
	({ usdcMint, treasury, treasuryTokenAccount, feeBps } = existing.data);
} else {
	// Reuse the mock USDC mint of a previous setup on this cluster, so wallets keep their balances.
	const previousMint = existsSync(deploymentPath()) ? readDeployment().usdcMint : undefined;
	if (previousMint && (await accountExists(previousMint))) {
		usdcMint = previousMint;
		console.log(`reusing mock USDC mint ${usdcMint}`);
	} else {
		// Mock USDC: 6 decimals, the deployer is the mint authority so scripts can mint test funds.
		const mint = await generateKeyPairSigner();
		const rent = await rpc.getMinimumBalanceForRentExemption(BigInt(getMintSize())).send();
		const mintSig = await send(relayer, [
			getCreateAccountInstruction({
				payer: relayer,
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
		usdcMint = mint.address;
		console.log(`mock USDC mint ${usdcMint}\n  ${explorerTx(mintSig)}`);
	}

	// Config admin must be the program's upgrade authority (the cold key on devnet, the deployer on localnet).
	const authority = await programUpgradeAuthority();
	const candidates = [KEYPAIRS.upgradeAuthority, KEYPAIRS.deployer];
	let admin: KeyPairSigner | undefined;
	for (const path of candidates) {
		const kp = existsSync(expandHome(path)) ? await loadKeypair(path) : undefined;
		if (kp && kp.address === authority) admin = kp;
	}
	if (!admin) throw new Error(`no local keypair matches the program's upgrade authority ${authority}`);

	treasury = (await loadOrCreateKeypair(KEYPAIRS.treasury)).address;
	feeBps = CONFIG_PARAMS.feeBps;
	const configSig = await send(relayer, [
		await getInitializeConfigInstructionAsync({
			payer: relayer,
			admin,
			treasuryWallet: treasury,
			usdcMint,
			treasury,
			params: CONFIG_PARAMS,
		}),
	]);
	treasuryTokenAccount = await ata(treasury, usdcMint);
	console.log(`config ${config} (admin ${admin.address}, treasury ${treasury})\n  ${explorerTx(configSig)}`);
}

// Demo operator: a recruiting academy that vouches for Ola and takes 10% of her share.
const operatorAuthority = await loadOrCreateKeypair(KEYPAIRS.operator);
const [operator] = await findOperatorPda({ authority: operatorAuthority.address });
const existingOperator = await fetchMaybeOperator(rpc, operator);
if (existingOperator.exists) {
	console.log(`operator "${existingOperator.data.name}" already registered at ${operator}`);
} else {
	const sig = await send(relayer, [
		await getRegisterOperatorInstructionAsync({
			payer: relayer,
			authority: operatorAuthority,
			mint: usdcMint,
			feeBps: DEMO_OPERATOR.feeBps,
			name: DEMO_OPERATOR.name,
		}),
	]);
	console.log(`operator "${DEMO_OPERATOR.name}" ${operator}\n  ${explorerTx(sig)}`);
}
const operatorData = existingOperator.exists ? existingOperator.data : DEMO_OPERATOR;

// The demo AI agent: role.agent on demo roles. It never needs SOL; the relayer pays its fees.
const agent = await loadOrCreateKeypair(KEYPAIRS.agent);
console.log(`agent ${agent.address}`);

const deployment: Deployment = {
	cluster: CLUSTER,
	rpcUrl: PUBLIC_RPC_URL,
	programId: PROGRAM_ID,
	usdcMint,
	usdcDecimals: USDC_DECIMALS,
	config,
	treasury,
	treasuryTokenAccount,
	feeBps,
	tokenProgram: TOKEN_PROGRAM_ADDRESS,
	operator: {
		address: operator,
		authority: operatorAuthority.address,
		tokenAccount: await ata(operatorAuthority.address, usdcMint),
		name: operatorData.name,
		feeBps: operatorData.feeBps,
	},
	agent: agent.address,
	relayer: relayer.address,
	upgradeAuthority: (await programUpgradeAuthority()) ?? undefined,
	configParams: {
		feeBps: CONFIG_PARAMS.feeBps,
		minBounty: CONFIG_PARAMS.minBounty.toString(),
		minReputableBounty: CONFIG_PARAMS.minReputableBounty.toString(),
		minWindowSeconds: Number(CONFIG_PARAMS.minWindowSeconds),
		maxWindowSeconds: Number(CONFIG_PARAMS.maxWindowSeconds),
	},
};
writeDeployment(deployment);
console.log(`wrote ${deploymentPath()}`);
console.log(deployment);
