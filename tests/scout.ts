import * as anchor from "@anchor-lang/core";
import { BN, Program } from "@anchor-lang/core";
import {
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";
import { createHash } from "node:crypto";
import { Scout } from "../target/types/scout";

const { Keypair, LAMPORTS_PER_SOL, PublicKey, sendAndConfirmTransaction } = anchor.web3;
type Keypair = anchor.web3.Keypair;
type PublicKey = anchor.web3.PublicKey;
type Transaction = anchor.web3.Transaction;

const USDC = 1_000_000; // 6 decimals
const FEE_BPS = 1000;
const BOUNTY = 20 * USDC;
const PAYOUT = BOUNTY - (BOUNTY * FEE_BPS) / 10_000; // 18 USDC
const FEE = BOUNTY - PAYOUT; // 2 USDC

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const candidateHash = (salt: string, url: string) =>
  [...createHash("sha256").update(salt + url).digest()];

describe("scout", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const connection = provider.connection;
  const program = anchor.workspace.scout as Program<Scout>;
  const admin = provider.wallet.payer!;

  // The relayer pays every fee and all rent; company and scouts hold no SOL at all.
  const relayer = Keypair.generate();
  const company = Keypair.generate();
  const scoutA = Keypair.generate();
  const scoutB = Keypair.generate();
  const treasury = Keypair.generate();
  let mint: PublicKey;
  let companyAta: PublicKey;
  let treasuryAta: PublicKey;
  let nextRoleId = 1;

  const pda = (seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, program.programId)[0];
  const configPda = pda([Buffer.from("config")]);
  const profilePda = (scout: PublicKey) => pda([Buffer.from("scout"), scout.toBuffer()]);
  const rolePda = (roleId: number) =>
    pda([Buffer.from("role"), company.publicKey.toBuffer(), new BN(roleId).toArrayLike(Buffer, "le", 8)]);
  const submissionPda = (role: PublicKey, hash: number[]) =>
    pda([Buffer.from("submission"), role.toBuffer(), Buffer.from(hash)]);
  const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true);
  const balance = async (account: PublicKey) => Number((await getAccount(connection, account)).amount);

  /** Sends with the relayer as fee payer, like the backend does. */
  async function send(builder: { transaction(): Promise<Transaction> }, signers: Keypair[]) {
    const tx = await builder.transaction();
    tx.feePayer = relayer.publicKey;
    return sendAndConfirmTransaction(connection, tx, [relayer, ...signers]);
  }

  async function createRole(opts: { deposit: number; maxCandidates?: number; window?: number }) {
    const roleId = nextRoleId++;
    const roleVault = rolePda(roleId);
    await send(
      program.methods
        .createRole(
          new BN(roleId),
          new BN(BOUNTY),
          opts.maxCandidates ?? 10,
          new BN(opts.window ?? 3600),
          new BN(opts.deposit),
          null,
        )
        .accountsPartial({
          payer: relayer.publicKey,
          company: company.publicKey,
          config: configPda,
          roleVault,
          vaultTokenAccount: ata(roleVault),
          companyTokenAccount: companyAta,
          mint,
          tokenProgram: TOKEN_PROGRAM_ID,
        }),
      [company],
    );
    return roleVault;
  }

  async function submit(roleVault: PublicKey, scout: Keypair, hash: number[]) {
    const submission = submissionPda(roleVault, hash);
    await send(
      program.methods.submitCandidate(hash).accountsPartial({
        payer: relayer.publicKey,
        scout: scout.publicKey,
        roleVault,
        scoutProfile: profilePda(scout.publicKey),
        submission,
        vaultTokenAccount: ata(roleVault),
      }),
      [scout],
    );
    return submission;
  }

  const payoutAccounts = (roleVault: PublicKey, submission: PublicKey, scout: PublicKey) => ({
    payer: relayer.publicKey,
    config: configPda,
    roleVault,
    submission,
    scoutProfile: profilePda(scout),
    vaultTokenAccount: ata(roleVault),
    scoutTokenAccount: ata(scout),
    treasuryTokenAccount: treasuryAta,
    mint,
    tokenProgram: TOKEN_PROGRAM_ID,
  });

  const accept = (roleVault: PublicKey, submission: PublicKey, scout: PublicKey, signer = company) =>
    send(
      program.methods
        .acceptSubmission()
        .accountsPartial({ ...payoutAccounts(roleVault, submission, scout), authority: signer.publicKey }),
      [signer],
    );

  const clockNow = async () => {
    const info = await connection.getAccountInfo(anchor.web3.SYSVAR_CLOCK_PUBKEY);
    return Number(info!.data.readBigInt64LE(32));
  };

  /** Surfpool's clock doesn't follow wall time; jump it past a deadline with its cheatcode. */
  async function timeTravelPast(deadline: number) {
    for (const absoluteTimestamp of [deadline + 5, (deadline + 5) * 1000]) {
      await fetch(connection.rpcEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "surfnet_timeTravel", params: [{ absoluteTimestamp }] }),
      });
      await sleep(500);
      if ((await clockNow()) > deadline) return;
    }
    throw new Error(`clock did not move past ${deadline}, now ${await clockNow()}`);
  }

  async function expectError(promise: Promise<unknown>, pattern: RegExp) {
    try {
      await promise;
    } catch (e) {
      const text = `${e}\n${(e as { logs?: string[] }).logs?.join("\n") ?? ""}`;
      expect(text).to.match(pattern);
      return;
    }
    expect.fail(`expected failure matching ${pattern}`);
  }

  before(async () => {
    const sig = await connection.requestAirdrop(relayer.publicKey, 20 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");

    mint = await createMint(connection, admin, admin.publicKey, null, 6);
    companyAta = (await getOrCreateAssociatedTokenAccount(connection, admin, mint, company.publicKey)).address;
    await mintTo(connection, admin, mint, companyAta, admin, 1_000 * USDC);
    treasuryAta = ata(treasury.publicKey);

    await send(
      program.methods.initializeConfig(FEE_BPS, treasury.publicKey).accountsPartial({
        payer: relayer.publicKey,
        admin: admin.publicKey,
        config: configPda,
        treasuryWallet: treasury.publicKey,
        treasuryTokenAccount: treasuryAta,
        usdcMint: mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      }),
      [admin],
    );

    for (const scout of [scoutA, scoutB]) {
      await send(
        program.methods.registerScout().accountsPartial({
          payer: relayer.publicKey,
          scout: scout.publicKey,
          config: configPda,
          scoutProfile: profilePda(scout.publicKey),
          scoutTokenAccount: ata(scout.publicKey),
          mint,
          tokenProgram: TOKEN_PROGRAM_ID,
        }),
        [scout],
      );
    }
  });

  it("happy path: create, submit, accept pays scout and treasury", async () => {
    const roleVault = await createRole({ deposit: 200 * USDC });
    expect(await balance(ata(roleVault))).to.equal(200 * USDC);

    const submission = await submit(roleVault, scoutA, candidateHash("salt-1", "linkedin.com/in/ada"));
    const scoutBefore = await balance(ata(scoutA.publicKey));
    const treasuryBefore = await balance(treasuryAta);

    await accept(roleVault, submission, scoutA.publicKey);

    expect(await balance(ata(scoutA.publicKey))).to.equal(scoutBefore + PAYOUT);
    expect(await balance(treasuryAta)).to.equal(treasuryBefore + FEE);
    expect(await balance(ata(roleVault))).to.equal(200 * USDC - BOUNTY);

    const role = await program.account.roleVault.fetch(roleVault);
    expect(role.acceptedCount).to.equal(1);
    expect(role.pendingCount).to.equal(0);
    expect(role.totalPaid.toNumber()).to.equal(BOUNTY);
    const sub = await program.account.submission.fetch(submission);
    expect(sub.status).to.deep.equal({ accepted: {} });
    const profile = await program.account.scoutProfile.fetch(profilePda(scoutA.publicKey));
    expect(profile.accepted).to.equal(1);
    expect(profile.totalEarned.toNumber()).to.equal(PAYOUT);

    // Users never paid anything in SOL.
    expect(await connection.getBalance(company.publicKey)).to.equal(0);
    expect(await connection.getBalance(scoutA.publicKey)).to.equal(0);
  });

  it("only the company or its agent can accept", async () => {
    const roleVault = await createRole({ deposit: 40 * USDC });
    const submission = await submit(roleVault, scoutA, candidateHash("salt-2", "linkedin.com/in/grace"));
    await expectError(accept(roleVault, submission, scoutA.publicKey, scoutB), /Unauthorized/);
  });

  it("reject: no payout, reputation records it", async () => {
    const roleVault = await createRole({ deposit: 40 * USDC });
    const submission = await submit(roleVault, scoutB, candidateHash("salt-3", "linkedin.com/in/linus"));
    const before = await balance(ata(scoutB.publicKey));

    await send(
      program.methods.rejectSubmission(0).accountsPartial({
        payer: relayer.publicKey,
        company: company.publicKey,
        roleVault,
        submission,
        scoutProfile: profilePda(scoutB.publicKey),
      }),
      [company],
    );

    expect(await balance(ata(scoutB.publicKey))).to.equal(before);
    const sub = await program.account.submission.fetch(submission);
    expect(sub.status).to.deep.equal({ rejected: {} });
    expect(sub.rejectReason).to.equal(0);
    const profile = await program.account.scoutProfile.fetch(profilePda(scoutB.publicKey));
    expect(profile.rejected).to.equal(1);
    expect((await program.account.roleVault.fetch(roleVault)).pendingCount).to.equal(0);
  });

  it("settle_expired: silence counts as acceptance after the review window", async () => {
    const roleVault = await createRole({ deposit: 40 * USDC, window: 2 });
    const submission = await submit(roleVault, scoutB, candidateHash("salt-4", "linkedin.com/in/barbara"));
    const settle = () =>
      send(
        program.methods.settleExpired().accountsPartial(payoutAccounts(roleVault, submission, scoutB.publicKey)),
        [],
      );

    await expectError(settle(), /ReviewWindowOpen/);
    const { reviewDeadline } = await program.account.submission.fetch(submission);
    await timeTravelPast(reviewDeadline.toNumber());
    const before = await balance(ata(scoutB.publicKey));
    await settle(); // signed by the relayer only: permissionless
    expect(await balance(ata(scoutB.publicKey))).to.equal(before + PAYOUT);
    expect((await program.account.submission.fetch(submission)).status).to.deep.equal({ accepted: {} });
  });

  it("duplicate candidate fails and the first scout keeps the credit", async () => {
    const roleVault = await createRole({ deposit: 100 * USDC });
    const hash = candidateHash("salt-5", "linkedin.com/in/margaret");
    const submission = await submit(roleVault, scoutA, hash);
    await expectError(submit(roleVault, scoutB, hash), /already in use/);
    expect((await program.account.submission.fetch(submission)).scout.toBase58()).to.equal(
      scoutA.publicKey.toBase58(),
    );
  });

  it("every pending submission must be funded; top_up adds budget", async () => {
    const roleVault = await createRole({ deposit: BOUNTY });
    await submit(roleVault, scoutA, candidateHash("salt-6", "linkedin.com/in/one"));
    await expectError(
      submit(roleVault, scoutA, candidateHash("salt-6", "linkedin.com/in/two")),
      /InsufficientBudget/,
    );

    await send(
      program.methods.topUp(new BN(50 * USDC)).accountsPartial({
        payer: relayer.publicKey,
        company: company.publicKey,
        roleVault,
        vaultTokenAccount: ata(roleVault),
        companyTokenAccount: companyAta,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      }),
      [company],
    );
    expect(await balance(ata(roleVault))).to.equal(BOUNTY + 50 * USDC);
    expect((await program.account.roleVault.fetch(roleVault)).totalDeposited.toNumber()).to.equal(
      BOUNTY + 50 * USDC,
    );
    await submit(roleVault, scoutA, candidateHash("salt-6", "linkedin.com/in/two"));
  });

  it("max candidates caps submissions", async () => {
    const roleVault = await createRole({ deposit: 100 * USDC, maxCandidates: 1 });
    await submit(roleVault, scoutA, candidateHash("salt-7", "linkedin.com/in/a"));
    await expectError(submit(roleVault, scoutB, candidateHash("salt-7", "linkedin.com/in/b")), /RoleFull/);
  });

  it("close_role is blocked while pending, then refunds the unspent budget", async () => {
    const roleVault = await createRole({ deposit: 100 * USDC });
    const submission = await submit(roleVault, scoutA, candidateHash("salt-8", "linkedin.com/in/close"));
    const close = () =>
      send(
        program.methods.closeRole().accountsPartial({
          payer: relayer.publicKey,
          company: company.publicKey,
          roleVault,
          vaultTokenAccount: ata(roleVault),
          companyTokenAccount: companyAta,
          mint,
          tokenProgram: TOKEN_PROGRAM_ID,
        }),
        [company],
      );

    await expectError(close(), /PendingSubmissions/);
    await accept(roleVault, submission, scoutA.publicKey);

    const before = await balance(companyAta);
    await close();
    expect(await balance(companyAta)).to.equal(before + 100 * USDC - BOUNTY);
    expect(await balance(ata(roleVault))).to.equal(0);
    expect((await program.account.roleVault.fetch(roleVault)).status).to.deep.equal({ closed: {} });
    await expectError(submit(roleVault, scoutB, candidateHash("salt-8", "linkedin.com/in/late")), /RoleClosed/);
  });
});
