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
const FEE = (BOUNTY * FEE_BPS) / 10_000; // 2 USDC
const PAYOUT = BOUNTY - FEE; // 18 USDC
const HOLDBACK_BPS = 3000;
// Test config: bounties from 1 base unit; reputation from 1 USDC; windows from 1 s (devnet: 60 s .. 90 days).
const CONFIG_PARAMS = {
  feeBps: FEE_BPS,
  minBounty: new BN(1),
  minReputableBounty: new BN(USDC),
  minWindowSeconds: new BN(1),
  maxWindowSeconds: new BN(365 * 24 * 3600),
};
const HELD = (PAYOUT * HOLDBACK_BPS) / 10_000; // 5.4 USDC
const PAID_NOW = PAYOUT - HELD; // 12.6 USDC
const ZERO_HASH = new Array(32).fill(0);

type TaskTypeArg = { sourcing: {} } | { screeningCall: {} } | { referenceCheck: {} };
type OperatorAccounts = { operator: PublicKey | null; operatorTokenAccount: PublicKey | null };
const NO_OPERATOR: OperatorAccounts = { operator: null, operatorTokenAccount: null };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (...parts: string[]) => [...createHash("sha256").update(parts.join("")).digest()];

describe("scout", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const connection = provider.connection;
  const program = anchor.workspace.scout as Program<Scout>;
  const admin = provider.wallet.payer!;

  // The relayer pays every fee and all rent; company, agent and scouts hold no SOL at all.
  const relayer = Keypair.generate();
  const company = Keypair.generate();
  const agent = Keypair.generate();
  const scoutA = Keypair.generate();
  const scoutB = Keypair.generate();
  const treasury = Keypair.generate();
  let mint: PublicKey;
  let companyAta: PublicKey;
  let treasuryAta: PublicKey;
  let nextRoleId = 1;

  const pda = (seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, program.programId)[0];
  const configPda = pda([Buffer.from("config_v2")]);
  const BPF_LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
  const programData = PublicKey.findProgramAddressSync([program.programId.toBuffer()], BPF_LOADER_UPGRADEABLE)[0];
  const profilePda = (scout: PublicKey) => pda([Buffer.from("scout"), scout.toBuffer()]);
  const rolePda = (roleId: number) =>
    pda([Buffer.from("role"), company.publicKey.toBuffer(), new BN(roleId).toArrayLike(Buffer, "le", 8)]);
  const taskPda = (role: PublicKey, taskId: number) =>
    pda([Buffer.from("task"), role.toBuffer(), new BN(taskId).toArrayLike(Buffer, "le", 4)]);
  const submissionPda = (task: PublicKey, hash: number[]) =>
    pda([Buffer.from("submission"), task.toBuffer(), Buffer.from(hash)]);
  const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true);
  const balance = async (account: PublicKey) => Number((await getAccount(connection, account)).amount);
  const profile = (scout: PublicKey) => program.account.scoutProfile.fetch(profilePda(scout));

  /** Sends with the relayer as fee payer, like the backend does. */
  async function send(builder: { transaction(): Promise<Transaction> }, signers: Keypair[]) {
    const tx = await builder.transaction();
    tx.feePayer = relayer.publicKey;
    // Fresh blockhash every time: web3.js caches one for ~30 s, which goes stale after a time jump.
    try {
      for (let attempt = 0; ; attempt++) {
        tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
        try {
          return await sendAndConfirmTransaction(connection, tx, [relayer, ...signers]);
        } catch (e) {
          // Surfpool (transaction mode) occasionally reports a just-fetched blockhash as unknown.
          if (!/Blockhash not found/.test(String(e)) || attempt >= 3) throw e;
          await sleep(300);
        }
      }
    } catch (e) {
      // Name the failing instruction in the error (mocha loses the async stack).
      const disc = Buffer.from(tx.instructions.at(-1)!.data.subarray(0, 8));
      const ix = program.idl.instructions.find((i) => Buffer.from(i.discriminator).equals(disc))?.name ?? "?";
      (e as Error).message = `[${ix}] ${(e as Error).message}`;
      throw e;
    }
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

  const clockNow = async () => {
    const info = await connection.getAccountInfo(anchor.web3.SYSVAR_CLOCK_PUBKEY);
    return Number(info!.data.readBigInt64LE(32));
  };

  /** Surfpool's clock doesn't follow wall time; jump it past a deadline with its cheatcode. */
  async function timeTravelPast(deadline: number) {
    for (const absoluteTimestamp of [(deadline + 5) * 1000, deadline + 5]) {
      await fetch(connection.rpcEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "surfnet_timeTravel", params: [{ absoluteTimestamp }] }),
      });
      await sleep(500);
      if ((await clockNow()) > deadline) {
        // After a jump Surfpool catches up on slots for a moment; a blockhash fetched during that
        // burst expires before confirmation. Wait until block production is back to normal.
        for (let i = 0; i < 40; i++) {
          const h1 = await connection.getBlockHeight();
          await sleep(400);
          if ((await connection.getBlockHeight()) - h1 < 5) return;
        }
        return;
      }
    }
    throw new Error(`clock did not move past ${deadline}, now ${await clockNow()}`);
  }

  // ---- Role and task helpers --------------------------------------------------

  /** The company funds the role once and delegates it to the agent; it never has to sign again. */
  async function createRole(opts: {
    deposit: number;
    window?: number;
    claimTimeout?: number;
    holdbackWindow?: number;
    agent?: PublicKey | null;
    agentMaxBounty?: number;
    agentMaxCommitment?: number;
  }) {
    const roleId = nextRoleId++;
    const roleVault = rolePda(roleId);
    await send(
      program.methods
        .createRole(
          new BN(roleId),
          opts.agent === undefined ? agent.publicKey : opts.agent,
          new BN(opts.window ?? 3600),
          new BN(opts.claimTimeout ?? 3600),
          new BN(opts.holdbackWindow ?? 120),
          new BN(opts.deposit),
          new BN(opts.agentMaxBounty ?? 1_000 * USDC),
          new BN(opts.agentMaxCommitment ?? 100_000 * USDC),
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

  async function createTask(
    roleVault: PublicKey,
    opts: {
      taskType?: TaskTypeArg;
      bounty?: number;
      max?: number;
      exclusive?: boolean;
      holdbackBps?: number;
      subjectScout?: PublicKey | null;
      minAccepted?: number;
      minAcceptRateBps?: number;
      bondBps?: number;
      confirmationAttestor?: PublicKey | null;
      signer?: Keypair;
    } = {},
  ) {
    const { taskCount } = await program.account.roleVault.fetch(roleVault);
    const task = taskPda(roleVault, taskCount);
    await send(
      program.methods
        .createTask(
          taskCount,
          opts.taskType ?? { sourcing: {} },
          new BN(opts.bounty ?? BOUNTY),
          opts.max ?? 3,
          opts.exclusive ?? false,
          sha("brief", String(taskCount)),
          opts.holdbackBps ?? 0,
          opts.subjectScout ?? null,
          opts.minAccepted ?? 0,
          opts.minAcceptRateBps ?? 0,
          opts.bondBps ?? 0,
          opts.confirmationAttestor ?? null,
        )
        .accountsPartial({
          payer: relayer.publicKey,
          authority: (opts.signer ?? agent).publicKey,
          roleVault,
          task,
          vaultTokenAccount: ata(roleVault),
        }),
      [opts.signer ?? agent],
    );
    return task;
  }

  async function submit(
    roleVault: PublicKey,
    task: PublicKey,
    scout: Keypair,
    hash: number[],
    evidence = ZERO_HASH,
    scoutTokenAccount: PublicKey | null = null,
    gatekeeper: Keypair = agent,
  ) {
    const submission = submissionPda(task, hash);
    await send(
      program.methods.submitDeliverable(hash, evidence).accountsPartial({
        payer: relayer.publicKey,
        scout: scout.publicKey,
        gatekeeper: gatekeeper.publicKey,
        roleVault,
        task,
        scoutProfile: profilePda(scout.publicKey),
        submission,
        vaultTokenAccount: ata(roleVault),
        scoutTokenAccount: scoutTokenAccount ?? ata(scout.publicKey),
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      }),
      gatekeeper.publicKey.equals(scout.publicKey) ? [scout] : [scout, gatekeeper],
    );
    return submission;
  }

  const payoutAccounts = (roleVault: PublicKey, task: PublicKey, submission: PublicKey, scout: PublicKey) => ({
    payer: relayer.publicKey,
    config: configPda,
    roleVault,
    task,
    submission,
    scoutProfile: profilePda(scout),
    vaultTokenAccount: ata(roleVault),
    scoutTokenAccount: ata(scout),
    treasuryTokenAccount: treasuryAta,
    mint,
    tokenProgram: TOKEN_PROGRAM_ID,
  });

  const accept = (
    roleVault: PublicKey,
    task: PublicKey,
    submission: PublicKey,
    scout: PublicKey,
    signer = agent,
    operator = NO_OPERATOR,
  ) =>
    send(
      program.methods
        .acceptSubmission(ZERO_HASH)
        .accountsPartial({ ...payoutAccounts(roleVault, task, submission, scout), ...operator, authority: signer.publicKey }),
      [signer],
    );

  const reject = (roleVault: PublicKey, task: PublicKey, submission: PublicKey, scout: PublicKey, signer = agent) =>
    send(
      program.methods.rejectSubmission(0, sha("reason", submission.toBase58())).accountsPartial({
        payer: relayer.publicKey,
        authority: signer.publicKey,
        roleVault,
        task,
        submission,
        rentPayer: relayer.publicKey,
        scoutProfile: profilePda(scout),
      }),
      [signer],
    );

  /** Sourcing tasks need the confirmation attestor (default: the agent) or the company to co-sign. */
  const settle = (
    roleVault: PublicKey,
    task: PublicKey,
    submission: PublicKey,
    scout: PublicKey,
    attestor: Keypair | null = agent,
  ) =>
    send(
      program.methods
        .settleExpired()
        .accountsPartial({
          ...payoutAccounts(roleVault, task, submission, scout),
          ...NO_OPERATOR,
          attestor: attestor?.publicKey ?? null,
        }),
      attestor ? [attestor] : [],
    );

  const attest = (
    roleVault: PublicKey,
    task: PublicKey,
    submission: PublicKey,
    scout: PublicKey,
    outcome: { advanced: {} } | { fabricated: {} },
    signer = company,
    operator: PublicKey | null = null,
  ) =>
    send(
      program.methods.attestOutcome(outcome, 0).accountsPartial({
        payer: relayer.publicKey,
        authority: signer.publicKey,
        roleVault,
        task,
        submission,
        scoutProfile: profilePda(scout),
        vaultTokenAccount: ata(roleVault),
        scoutTokenAccount: ata(scout),
        companyTokenAccount: companyAta,
        operator,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      }),
      [signer],
    );

  const release = (roleVault: PublicKey, task: PublicKey, submission: PublicKey, scout: PublicKey) =>
    send(
      program.methods.releaseHoldback().accountsPartial({
        payer: relayer.publicKey,
        roleVault,
        task,
        submission,
        scoutProfile: profilePda(scout),
        vaultTokenAccount: ata(roleVault),
        scoutTokenAccount: ata(scout),
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      }),
      [],
    );

  const closeTask = (roleVault: PublicKey, task: PublicKey, signer = agent) =>
    send(
      program.methods.closeTask().accountsPartial({ payer: relayer.publicKey, authority: signer.publicKey, roleVault, task }),
      [signer],
    );

  const closeRole = (roleVault: PublicKey) =>
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

  const topUp = (roleVault: PublicKey, amount: number) =>
    send(
      program.methods.topUp(new BN(amount)).accountsPartial({
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

  const claim = (roleVault: PublicKey, task: PublicKey, scout: Keypair, gatekeeper: Keypair = agent) =>
    send(
      program.methods.claimTask().accountsPartial({
        payer: relayer.publicKey,
        scout: scout.publicKey,
        gatekeeper: gatekeeper.publicKey,
        scoutProfile: profilePda(scout.publicKey),
        roleVault,
        task,
      }),
      gatekeeper.publicKey.equals(scout.publicKey) ? [scout] : [scout, gatekeeper],
    );

  const releaseClaim = (roleVault: PublicKey, task: PublicKey, signer: Keypair) =>
    send(
      program.methods.releaseClaim().accountsPartial({ payer: relayer.publicKey, authority: signer.publicKey, roleVault, task }),
      [signer],
    );

  const registerScout = (scout: Keypair, operator: PublicKey | null = null, opSigner: Keypair | null = null) =>
    send(
      program.methods.registerScout().accountsPartial({
        payer: relayer.publicKey,
        scout: scout.publicKey,
        config: configPda,
        scoutProfile: profilePda(scout.publicKey),
        scoutTokenAccount: ata(scout.publicKey),
        operator,
        operatorAuthority: opSigner?.publicKey ?? null,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      }),
      opSigner ? [scout, opSigner] : [scout],
    );

  before(async () => {
    const sig = await connection.requestAirdrop(relayer.publicKey, 50 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");

    mint = await createMint(connection, admin, admin.publicKey, null, 6);
    companyAta = (await getOrCreateAssociatedTokenAccount(connection, admin, mint, company.publicKey)).address;
    await mintTo(connection, admin, mint, companyAta, admin, 10_000 * USDC);
    treasuryAta = ata(treasury.publicKey);

    const initConfig = (signer: Keypair) =>
      send(
        program.methods.initializeConfig(treasury.publicKey, CONFIG_PARAMS).accountsPartial({
          payer: relayer.publicKey,
          admin: signer.publicKey,
          programData,
          config: configPda,
          treasuryWallet: treasury.publicKey,
          treasuryTokenAccount: treasuryAta,
          usdcMint: mint,
          tokenProgram: TOKEN_PROGRAM_ID,
        }),
        [signer],
      );
    // Only the upgrade authority can claim the singleton Config (no front-running after deploy).
    await expectError(initConfig(scoutA), /NotUpgradeAuthority/);
    await initConfig(admin);
    for (const scout of [scoutA, scoutB]) await registerScout(scout);
  });

  // ---- Core gig flow ----------------------------------------------------------

  it("happy path: company funds once, the agent posts a gig and accepts, the scout is paid", async () => {
    const roleVault = await createRole({ deposit: 200 * USDC });
    const task = await createTask(roleVault); // signed by the agent only
    const submission = await submit(roleVault, task, scoutA, sha("salt-1", "linkedin.com/in/ada"));
    const treasuryBefore = await balance(treasuryAta);

    await accept(roleVault, task, submission, scoutA.publicKey); // agent signs

    expect(await balance(ata(scoutA.publicKey))).to.equal(PAYOUT);
    expect(await balance(treasuryAta)).to.equal(treasuryBefore + FEE);
    expect(await balance(ata(roleVault))).to.equal(200 * USDC - BOUNTY);

    const role = await program.account.roleVault.fetch(roleVault);
    expect(role.acceptedCount).to.equal(1);
    expect(role.pendingCount).to.equal(0);
    expect(role.pendingValue.toNumber()).to.equal(0);
    expect(role.openCapacity.toNumber()).to.equal(2 * BOUNTY);
    expect(role.totalPaid.toNumber()).to.equal(BOUNTY);
    const t = await program.account.task.fetch(task);
    expect(t.acceptedCount).to.equal(1);
    expect((await program.account.submission.fetch(submission)).status).to.deep.equal({ accepted: {} });
    const p = await profile(scoutA.publicKey);
    expect(p.accepted).to.equal(1);
    expect(p.sourcingAccepted).to.equal(1);
    expect(p.totalEarned.toNumber()).to.equal(PAYOUT);

    for (const who of [company, agent, scoutA]) expect(await connection.getBalance(who.publicKey)).to.equal(0);
  });

  it("only the company or its agent can create tasks and accept", async () => {
    const roleVault = await createRole({ deposit: 100 * USDC });
    await expectError(createTask(roleVault, { signer: scoutB }), /Unauthorized/);
    const task = await createTask(roleVault, { signer: company });
    const s1 = await submit(roleVault, task, scoutA, sha("salt-2", "linkedin.com/in/grace"));
    await expectError(accept(roleVault, task, s1, scoutA.publicKey, scoutB), /Unauthorized/);
    await accept(roleVault, task, s1, scoutA.publicKey, company);
  });

  it("reject by the agent: no payout, reputation records it", async () => {
    const roleVault = await createRole({ deposit: 40 * USDC });
    const task = await createTask(roleVault, { max: 2 });
    const submission = await submit(roleVault, task, scoutB, sha("salt-3", "linkedin.com/in/linus"));
    const before = await balance(ata(scoutB.publicKey));
    const rejectedBefore = (await profile(scoutB.publicKey)).rejected;

    await expectError(reject(roleVault, task, submission, scoutB.publicKey, scoutA), /Unauthorized/);
    await reject(roleVault, task, submission, scoutB.publicKey);

    expect(await balance(ata(scoutB.publicKey))).to.equal(before);
    // Rejected submissions are closed and their rent goes back to the payer (the relayer).
    expect(await connection.getAccountInfo(submission)).to.equal(null);
    expect((await profile(scoutB.publicKey)).rejected).to.equal(rejectedBefore + 1);
    const role = await program.account.roleVault.fetch(roleVault);
    expect(role.pendingCount).to.equal(0);
    expect(role.pendingValue.toNumber()).to.equal(0);
    expect((await program.account.task.fetch(task)).pendingCount).to.equal(0);
  });

  it("settle_expired: silence counts as acceptance after the review window", async () => {
    const roleVault = await createRole({ deposit: 40 * USDC, window: 2 });
    const task = await createTask(roleVault, { max: 2 });
    const submission = await submit(roleVault, task, scoutB, sha("salt-4", "linkedin.com/in/barbara"));

    await expectError(settle(roleVault, task, submission, scoutB.publicKey), /ReviewWindowOpen/);
    const { reviewDeadline } = await program.account.submission.fetch(submission);
    await timeTravelPast(reviewDeadline.toNumber());
    await expectError(reject(roleVault, task, submission, scoutB.publicKey), /ReviewWindowExpired/);
    const before = await balance(ata(scoutB.publicKey));
    await settle(roleVault, task, submission, scoutB.publicKey); // relayer only: permissionless
    expect(await balance(ata(scoutB.publicKey))).to.equal(before + PAYOUT);
    expect((await program.account.submission.fetch(submission)).status).to.deep.equal({ accepted: {} });
  });

  it("duplicate deliverable on a task fails and the first scout keeps the credit", async () => {
    const roleVault = await createRole({ deposit: 100 * USDC });
    const task = await createTask(roleVault, { max: 5 });
    const hash = sha("salt-5", "linkedin.com/in/margaret");
    const submission = await submit(roleVault, task, scoutA, hash);
    await expectError(submit(roleVault, task, scoutB, hash), /already in use/);
    expect((await program.account.submission.fetch(submission)).scout.toBase58()).to.equal(scoutA.publicKey.toBase58());
  });

  it("funded invariant across tasks: open tasks can't promise more than the vault; top_up raises it", async () => {
    const roleVault = await createRole({ deposit: 50 * USDC });
    const t1 = await createTask(roleVault, { max: 1 }); // promises 20
    const t2 = await createTask(roleVault, { max: 1 }); // promises 40 in total
    await expectError(createTask(roleVault, { max: 1 }), /OverCommitted/); // 60 > 50

    await topUp(roleVault, 10 * USDC);
    const role = await program.account.roleVault.fetch(roleVault);
    expect(role.totalDeposited.toNumber()).to.equal(60 * USDC);
    const t3 = await createTask(roleVault, { max: 1 });
    expect((await program.account.roleVault.fetch(roleVault)).openCapacity.toNumber()).to.equal(3 * BOUNTY);

    // Deliverables across all three tasks are pending at once and fully funded.
    await submit(roleVault, t1, scoutA, sha("inv", "a"));
    await submit(roleVault, t2, scoutA, sha("inv", "b"));
    await submit(roleVault, t3, scoutB, sha("inv", "c"));
    const after = await program.account.roleVault.fetch(roleVault);
    expect(after.pendingCount).to.equal(3);
    expect(after.pendingValue.toNumber()).to.equal(3 * BOUNTY);
  });

  it("max_deliverables caps a task", async () => {
    const roleVault = await createRole({ deposit: 100 * USDC });
    const task = await createTask(roleVault, { max: 1 });
    await submit(roleVault, task, scoutA, sha("salt-7", "a"));
    await expectError(submit(roleVault, task, scoutB, sha("salt-7", "b")), /TaskFull/);
  });

  it("close_task and close_role: blocked while pending or open, then the unspent budget is refunded", async () => {
    const roleVault = await createRole({ deposit: 100 * USDC });
    const task = await createTask(roleVault, { max: 3 });
    const submission = await submit(roleVault, task, scoutA, sha("salt-8", "close"));

    await expectError(closeTask(roleVault, task), /PendingSubmissions/);
    await expectError(closeRole(roleVault), /OpenTasks/);
    await accept(roleVault, task, submission, scoutA.publicKey);
    await expectError(closeTask(roleVault, task, scoutB), /Unauthorized/);
    await closeTask(roleVault, task);
    expect((await program.account.roleVault.fetch(roleVault)).openCapacity.toNumber()).to.equal(0);
    await expectError(submit(roleVault, task, scoutB, sha("salt-8", "late")), /TaskClosed/);

    const before = await balance(companyAta);
    await closeRole(roleVault);
    expect(await balance(companyAta)).to.equal(before + 100 * USDC - BOUNTY);
    expect(await connection.getAccountInfo(ata(roleVault))).to.equal(null); // swept and closed: no dust, no rent
    expect((await program.account.roleVault.fetch(roleVault)).status).to.deep.equal({ closed: {} });
    // The vault token account is gone, so the transaction fails at account loading (or RoleClosed).
    await expectError(createTask(roleVault), /RoleClosed|AccountNotInitialized|3012/);
  });

  // ---- Exclusive gigs ---------------------------------------------------------

  it("screening call: exclusive claim, evidence required, only the claimant delivers", async () => {
    const roleVault = await createRole({ deposit: 100 * USDC });
    const sourcing = await createTask(roleVault);
    await expectError(claim(roleVault, sourcing, scoutA), /NotExclusive/);

    const task = await createTask(roleVault, { taskType: { screeningCall: {} }, bounty: 35 * USDC, max: 1, exclusive: true });
    const deliverable = sha("call", "karolina");
    const notes = sha("notes", "answers v1");
    await expectError(submit(roleVault, task, scoutA, deliverable, notes), /NotClaimant/);

    await claim(roleVault, task, scoutA);
    await expectError(claim(roleVault, task, scoutB), /AlreadyClaimed/);
    await expectError(submit(roleVault, task, scoutB, deliverable, notes), /NotClaimant/);
    await expectError(submit(roleVault, task, scoutA, deliverable), /MissingEvidence/);

    const submission = await submit(roleVault, task, scoutA, deliverable, notes);
    expect((await program.account.submission.fetch(submission)).evidenceHash).to.deep.equal(notes);
    const before = (await profile(scoutA.publicKey)).screeningAccepted;
    await accept(roleVault, task, submission, scoutA.publicKey);
    expect((await profile(scoutA.publicKey)).screeningAccepted).to.equal(before + 1);
    const t = await program.account.task.fetch(task);
    expect(t.claimant?.toBase58()).to.equal(scoutA.publicKey.toBase58());
    expect(t.taskType).to.deep.equal({ screeningCall: {} });
  });

  it("release_claim: the claimant any time; the agent only after the timeout", async () => {
    const roleVault = await createRole({ deposit: 100 * USDC, claimTimeout: 30 });
    const task = await createTask(roleVault, { taskType: { referenceCheck: {} }, bounty: 25 * USDC, max: 1, exclusive: true });

    await claim(roleVault, task, scoutA);
    await expectError(releaseClaim(roleVault, task, scoutB), /Unauthorized/);
    await releaseClaim(roleVault, task, scoutA);
    expect((await program.account.task.fetch(task)).claimant).to.equal(null);

    await claim(roleVault, task, scoutB);
    await expectError(releaseClaim(roleVault, task, agent), /ClaimTimeoutOpen/);
    const { claimedAt } = await program.account.task.fetch(task);
    await timeTravelPast(claimedAt.toNumber() + 30);
    await releaseClaim(roleVault, task, agent);

    await claim(roleVault, task, scoutA);
    const submission = await submit(roleVault, task, scoutA, sha("ref", "karolina"), sha("ref-notes"));
    const before = (await profile(scoutA.publicKey)).referenceAccepted;
    await accept(roleVault, task, submission, scoutA.publicKey);
    expect((await profile(scoutA.publicKey)).referenceAccepted).to.equal(before + 1);
  });

  // ---- Holdback -------------------------------------------------------------

  async function acceptedWithHoldback(label: string, scout: Keypair, deposit = 100 * USDC) {
    const roleVault = await createRole({ deposit });
    const task = await createTask(roleVault, { max: 1, holdbackBps: HOLDBACK_BPS });
    const submission = await submit(roleVault, task, scout, sha(label, `linkedin.com/in/${label}`));
    const before = await balance(ata(scout.publicKey));
    await accept(roleVault, task, submission, scout.publicKey);
    expect(await balance(ata(scout.publicKey))).to.equal(before + PAID_NOW);
    return { roleVault, task, submission, before };
  }

  it("holdback: accept pays the share minus holdback; Hanna's Advanced releases the rest", async () => {
    const { roleVault, task, submission, before } = await acceptedWithHoldback("hb-advanced", scoutA);
    expect((await program.account.roleVault.fetch(roleVault)).heldBackTotal.toNumber()).to.equal(HELD);
    expect(await balance(ata(roleVault))).to.equal(100 * USDC - PAID_NOW - FEE);
    const sub = await program.account.submission.fetch(submission);
    expect(sub.holdbackAmount.toNumber()).to.equal(HELD);
    expect(sub.holdbackDeadline.toNumber()).to.be.greaterThan(0);

    const p0 = await profile(scoutA.publicKey);
    await attest(roleVault, task, submission, scoutA.publicKey, { advanced: {} }); // company ("Invite to interview")
    expect(await balance(ata(scoutA.publicKey))).to.equal(before + PAYOUT);
    expect((await program.account.roleVault.fetch(roleVault)).heldBackTotal.toNumber()).to.equal(0);
    const after = await program.account.submission.fetch(submission);
    expect(after.outcome).to.deep.equal({ advanced: {} });
    expect(after.holdbackAmount.toNumber()).to.equal(0);
    const p1 = await profile(scoutA.publicKey);
    expect(p1.advanced).to.equal(p0.advanced + 1);
    expect(p1.totalEarned.toNumber()).to.equal(p0.totalEarned.toNumber() + HELD);

    await expectError(attest(roleVault, task, submission, scoutA.publicKey, { fabricated: {} }), /OutcomeAlreadySet/);
    await expectError(release(roleVault, task, submission, scoutA.publicKey), /OutcomeAlreadySet/);
  });

  it("holdback: Fabricated refunds the holdback to the company and flags the scout", async () => {
    const { roleVault, task, submission, before } = await acceptedWithHoldback("hb-fabricated", scoutB);
    await expectError(attest(roleVault, task, submission, scoutB.publicKey, { fabricated: {} }, scoutA), /Unauthorized/);

    const companyBefore = await balance(companyAta);
    const flaggedBefore = (await profile(scoutB.publicKey)).flagged;
    await attest(roleVault, task, submission, scoutB.publicKey, { fabricated: {} }, agent);
    expect(await balance(companyAta)).to.equal(companyBefore + HELD);
    expect(await balance(ata(scoutB.publicKey))).to.equal(before + PAID_NOW); // the paid part is never clawed back
    expect((await profile(scoutB.publicKey)).flagged).to.equal(flaggedBefore + 1);
    expect((await program.account.submission.fetch(submission)).outcome).to.deep.equal({ fabricated: {} });
  });

  it("holdback: anyone releases it after the window; Fabricated is then too late", async () => {
    const { roleVault, task, submission, before } = await acceptedWithHoldback("hb-release", scoutA);
    await expectError(release(roleVault, task, submission, scoutA.publicKey), /HoldbackWindowOpen/);

    const { holdbackDeadline } = await program.account.submission.fetch(submission);
    await timeTravelPast(holdbackDeadline.toNumber());
    await expectError(attest(roleVault, task, submission, scoutA.publicKey, { fabricated: {} }), /HoldbackWindowExpired/);
    await release(roleVault, task, submission, scoutA.publicKey); // relayer only: permissionless
    expect(await balance(ata(scoutA.publicKey))).to.equal(before + PAYOUT);
    expect((await program.account.roleVault.fetch(roleVault)).heldBackTotal.toNumber()).to.equal(0);
    await expectError(release(roleVault, task, submission, scoutA.publicKey), /NothingHeldBack/);
  });

  it("held-back funds are reserved: no new task can promise them, and close_role waits for them", async () => {
    // Deposit 21: after one accept the vault keeps 5.4 held back + 1 free.
    const { roleVault, task } = await acceptedWithHoldback("hb-reserved", scoutA, BOUNTY + 1 * USDC);
    await expectError(createTask(roleVault, { max: 1, bounty: 2 * USDC }), /OverCommitted/);
    await closeTask(roleVault, task);
    await expectError(closeRole(roleVault), /HoldbackOutstanding/);
  });

  // ---- Operators ------------------------------------------------------------

  const operatorAuthority = Keypair.generate();
  const vouched = Keypair.generate();
  const OPERATOR_FEE_BPS = 1000;
  const OPERATOR_FEE = ((BOUNTY - FEE) * OPERATOR_FEE_BPS) / 10_000; // 1.8 USDC
  const VOUCHED_SHARE = BOUNTY - FEE - OPERATOR_FEE; // 16.2 USDC
  const operatorPda = () => pda([Buffer.from("operator"), operatorAuthority.publicKey.toBuffer()]);
  const opAccounts = (): OperatorAccounts => ({
    operator: operatorPda(),
    operatorTokenAccount: ata(operatorAuthority.publicKey),
  });
  const registerOperator = (feeBps: number, name: string) =>
    send(
      program.methods.registerOperator(feeBps, name).accountsPartial({
        payer: relayer.publicKey,
        authority: operatorAuthority.publicKey,
        config: configPda,
        operator: operatorPda(),
        operatorTokenAccount: ata(operatorAuthority.publicKey),
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      }),
      [operatorAuthority],
    );

  it("register_operator and a vouched register_scout (operator must co-sign)", async () => {
    await expectError(registerOperator(2001, "Too Greedy"), /InvalidOperatorFee/);
    await registerOperator(OPERATOR_FEE_BPS, "Kraków Recruiting Academy");
    const op = await program.account.operator.fetch(operatorPda());
    expect(op.name).to.equal("Kraków Recruiting Academy");
    expect(op.feeBps).to.equal(OPERATOR_FEE_BPS);

    await expectError(registerScout(vouched, operatorPda(), null), /OperatorSignatureRequired/);
    await expectError(registerScout(vouched, operatorPda(), scoutA), /OperatorSignatureRequired/);
    await registerScout(vouched, operatorPda(), operatorAuthority);
    expect((await profile(vouched.publicKey)).operator?.toBase58()).to.equal(operatorPda().toBase58());
    expect((await program.account.operator.fetch(operatorPda())).recruiters).to.equal(1);
  });

  it("three-way split: the operator fee comes out of the scout's share, the company pays only the bounty", async () => {
    const roleVault = await createRole({ deposit: 100 * USDC });
    const task = await createTask(roleVault);
    const submission = await submit(roleVault, task, vouched, sha("op-split", "linkedin.com/in/split"));

    await expectError(accept(roleVault, task, submission, vouched.publicKey), /OperatorMismatch/);
    const treasuryBefore = await balance(treasuryAta);
    await accept(roleVault, task, submission, vouched.publicKey, agent, opAccounts());
    expect(await balance(ata(vouched.publicKey))).to.equal(VOUCHED_SHARE);
    expect(await balance(ata(operatorAuthority.publicKey))).to.equal(OPERATOR_FEE);
    expect(await balance(treasuryAta)).to.equal(treasuryBefore + FEE);
    expect(await balance(ata(roleVault))).to.equal(100 * USDC - BOUNTY);
    expect((await program.account.operator.fetch(operatorPda())).accepted).to.equal(1);
  });

  it("operator counters follow outcomes; holdback applies to the scout's share only", async () => {
    const roleVault = await createRole({ deposit: 100 * USDC });
    const task = await createTask(roleVault, { holdbackBps: HOLDBACK_BPS });
    const submission = await submit(roleVault, task, vouched, sha("op-hb", "linkedin.com/in/op-hb"));
    const scoutBefore = await balance(ata(vouched.publicKey));
    const opBefore = await balance(ata(operatorAuthority.publicKey));

    await accept(roleVault, task, submission, vouched.publicKey, agent, opAccounts());
    const held = (VOUCHED_SHARE * HOLDBACK_BPS) / 10_000;
    expect(await balance(ata(vouched.publicKey))).to.equal(scoutBefore + VOUCHED_SHARE - held);
    expect(await balance(ata(operatorAuthority.publicKey))).to.equal(opBefore + OPERATOR_FEE);

    await expectError(attest(roleVault, task, submission, vouched.publicKey, { advanced: {} }), /OperatorMismatch/);
    await attest(roleVault, task, submission, vouched.publicKey, { advanced: {} }, company, operatorPda());
    expect(await balance(ata(vouched.publicKey))).to.equal(scoutBefore + VOUCHED_SHARE);
    expect((await program.account.operator.fetch(operatorPda())).advanced).to.equal(1);
    expect((await profile(vouched.publicKey)).advanced).to.equal(1);
  });

  // ---- Security: access control and exactly-once ----------------------------

  /** Reads the role's accounting and checks invariants I1–I3 from the client side too. */
  async function assertInvariants(roleVault: PublicKey) {
    const r = await program.account.roleVault.fetch(roleVault);
    const v = await balance(ata(roleVault));
    const held = r.heldBackTotal.toNumber();
    expect(v, "I1 vault >= pending + held").to.be.gte(r.pendingValue.toNumber() + held);
    expect(r.openCapacity.toNumber(), "I2 commitments <= free").to.be.lte(v - held);
    expect(r.pendingValue.toNumber(), "I3 pending within commitments").to.be.lte(r.openCapacity.toNumber());
  }

  it("self-dealing: neither the agent nor the company can deliver to their own role", async () => {
    const roleVault = await createRole({ deposit: 100 * USDC });
    const task = await createTask(roleVault);
    for (const insider of [agent, company]) {
      await registerScout(insider);
      await expectError(submit(roleVault, task, insider, sha("self", insider.publicKey.toBase58())), /SelfDealing/);
    }
  });

  it("an agent has no authority over a role it isn't the agent of", async () => {
    const roleId = nextRoleId++;
    const roleVault = rolePda(roleId);
    await send(
      program.methods
        .createRole(
          new BN(roleId),
          null,
          new BN(3600),
          new BN(3600),
          new BN(120),
          new BN(100 * USDC),
          new BN(0),
          new BN(0),
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
    await expectError(createTask(roleVault), /Unauthorized/);
    const task = await createTask(roleVault, { signer: company });
    // Without an agent the company is the gatekeeper.
    const submission = await submit(roleVault, task, scoutA, sha("no-agent", "x"), ZERO_HASH, null, company);
    await expectError(accept(roleVault, task, submission, scoutA.publicKey, agent), /Unauthorized/);
    await expectError(reject(roleVault, task, submission, scoutA.publicKey, agent), /Unauthorized/);
    await expectError(closeTask(roleVault, task, agent), /Unauthorized/);
  });

  it("payouts only reach the submitter's account, with the config mint and the configured treasury", async () => {
    const roleVault = await createRole({ deposit: 100 * USDC });
    const task = await createTask(roleVault);
    const submission = await submit(roleVault, task, scoutA, sha("routing", "x"));
    const base = payoutAccounts(roleVault, task, submission, scoutA.publicKey);
    const tryAccept = (overrides: Record<string, PublicKey>) =>
      send(
        program.methods
          .acceptSubmission(ZERO_HASH)
          .accountsPartial({ ...base, ...NO_OPERATOR, ...overrides, authority: agent.publicKey }),
        [agent],
      );

    // Another scout's account (owner != submission.scout).
    await expectError(tryAccept({ scoutTokenAccount: ata(scoutB.publicKey) }), /InvalidTokenAccount/);
    // The scout's own account, but for a different mint.
    const otherMint = await createMint(connection, admin, admin.publicKey, null, 6);
    const wrongMintAta = (await getOrCreateAssociatedTokenAccount(connection, admin, otherMint, scoutA.publicKey)).address;
    await expectError(tryAccept({ scoutTokenAccount: wrongMintAta }), /InvalidTokenAccount/);
    // A different mint for the whole transfer.
    await expectError(tryAccept({ mint: otherMint }), /has.?one|ConstraintHasOne|2001/i);
    // Fee to anything but config.treasury_token_account.
    await expectError(tryAccept({ treasuryTokenAccount: ata(scoutB.publicKey) }), /has.?one|ConstraintHasOne|2001/i);
    // A submission of another task can't be paid through this task.
    const otherTask = await createTask(roleVault, { max: 1 });
    await expectError(tryAccept({ task: otherTask }), /has.?one|ConstraintSeeds|ConstraintHasOne|2001|2006/i);

    await tryAccept({});
    await assertInvariants(roleVault);
  });

  it("exactly once: a decided submission can't be accepted, rejected or settled again", async () => {
    const roleVault = await createRole({ deposit: 100 * USDC, window: 2 });
    const task = await createTask(roleVault);
    const submission = await submit(roleVault, task, scoutB, sha("once", "x"));
    await accept(roleVault, task, submission, scoutB.publicKey);
    const balanceAfter = await balance(ata(scoutB.publicKey));

    await expectError(accept(roleVault, task, submission, scoutB.publicKey), /NotPending/);
    await expectError(reject(roleVault, task, submission, scoutB.publicKey), /NotPending/);
    const { reviewDeadline } = await program.account.submission.fetch(submission);
    await timeTravelPast(reviewDeadline.toNumber());
    await expectError(settle(roleVault, task, submission, scoutB.publicKey), /NotPending/);
    expect(await balance(ata(scoutB.publicKey))).to.equal(balanceAfter);
    await assertInvariants(roleVault);
  });

  it("operator fee only to operator.token_account", async () => {
    const roleVault = await createRole({ deposit: 100 * USDC });
    const task = await createTask(roleVault);
    const submission = await submit(roleVault, task, vouched, sha("op-route", "x"));
    await expectError(
      accept(roleVault, task, submission, vouched.publicKey, agent, {
        operator: operatorPda(),
        operatorTokenAccount: ata(scoutB.publicKey),
      }),
      /OperatorMismatch/,
    );
  });

  it("random bounties: the split sums exactly to the bounty and the invariants hold after every step", async () => {
    // Deterministic pseudo-random bounties, including 1 base unit and odd amounts that force rounding.
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
    const bounties = [1, 7, 333_333, 19_999_999, ...Array.from({ length: 6 }, () => 1 + (rand() % 50_000_000))];
    const roleVault = await createRole({ deposit: 1_000 * USDC });
    await assertInvariants(roleVault);

    for (const [i, bounty] of bounties.entries()) {
      const holdbackBps = [0, 1, 3000, 5000][i % 4];
      const task = await createTask(roleVault, { bounty, max: 1, holdbackBps });
      await assertInvariants(roleVault);
      const submission = await submit(roleVault, task, vouched, sha("rand", String(i)));
      await assertInvariants(roleVault);

      const before = await Promise.all(
        [ata(vouched.publicKey), ata(operatorAuthority.publicKey), treasuryAta, ata(roleVault)].map(balance),
      );
      const heldBefore = (await program.account.roleVault.fetch(roleVault)).heldBackTotal.toNumber();
      await accept(roleVault, task, submission, vouched.publicKey, agent, opAccounts());
      const after = await Promise.all(
        [ata(vouched.publicKey), ata(operatorAuthority.publicKey), treasuryAta, ata(roleVault)].map(balance),
      );
      const held = (await program.account.roleVault.fetch(roleVault)).heldBackTotal.toNumber() - heldBefore;
      const [scoutNow, operatorFee, fee] = [after[0] - before[0], after[1] - before[1], after[2] - before[2]];

      expect(scoutNow + operatorFee + fee + held, `bounty ${bounty}`).to.equal(bounty);
      expect(before[3] - after[3], "vault outflow").to.equal(bounty - held);
      expect(fee).to.equal(Math.floor((bounty * FEE_BPS) / 10_000));
      expect(operatorFee).to.equal(Math.floor(((bounty - fee) * OPERATOR_FEE_BPS) / 10_000));
      expect(held).to.equal(Math.floor(((bounty - fee - operatorFee) * holdbackBps) / 10_000));
      await assertInvariants(roleVault);

      if (held > 0) {
        await attest(roleVault, task, submission, vouched.publicKey, { advanced: {} }, company, operatorPda());
        await assertInvariants(roleVault);
      }
      await closeTask(roleVault, task);
    }
    // Everything decided: closing the role sweeps the vault to zero and closes it.
    await closeRole(roleVault);
    expect(await connection.getAccountInfo(ata(roleVault))).to.equal(null);
  });

  // ---- v3.1: bonds, separation of duties, reputation gate --------------------

  async function newScout(usdc = 0, operator: PublicKey | null = null, opSigner: Keypair | null = null) {
    const scout = Keypair.generate();
    await registerScout(scout, operator, opSigner);
    if (usdc > 0) await mintTo(connection, admin, mint, ata(scout.publicKey), admin, usdc);
    return scout;
  }
  const BOND_BPS = 1000;
  const BOND = (BOUNTY * BOND_BPS) / 10_000; // 2 USDC

  it("bond: an unvouched scout posts it, gets it back on accept, loses it to the company budget on reject", async () => {
    const bonded = await newScout(10 * USDC);
    const roleVault = await createRole({ deposit: 100 * USDC });
    const task = await createTask(roleVault, { bondBps: BOND_BPS });

    const s1 = await submit(roleVault, task, bonded, sha("bond", "1"));
    expect(await balance(ata(bonded.publicKey))).to.equal(10 * USDC - BOND);
    expect((await program.account.submission.fetch(s1)).bondAmount.toNumber()).to.equal(BOND);
    expect((await program.account.roleVault.fetch(roleVault)).bondsHeld.toNumber()).to.equal(BOND);
    await assertInvariants(roleVault);

    await accept(roleVault, task, s1, bonded.publicKey);
    expect(await balance(ata(bonded.publicKey))).to.equal(10 * USDC + PAYOUT); // bond back whole + payout
    expect((await program.account.roleVault.fetch(roleVault)).bondsHeld.toNumber()).to.equal(0);
    await assertInvariants(roleVault);

    const s2 = await submit(roleVault, task, bonded, sha("bond", "2"));
    const vaultBefore = await balance(ata(roleVault));
    const depositedBefore = (await program.account.roleVault.fetch(roleVault)).totalDeposited.toNumber();
    await reject(roleVault, task, s2, bonded.publicKey);
    expect(await balance(ata(bonded.publicKey))).to.equal(10 * USDC + PAYOUT - BOND);
    expect(await balance(ata(roleVault))).to.equal(vaultBefore); // stays in the vault...
    const role = await program.account.roleVault.fetch(roleVault);
    expect(role.bondsHeld.toNumber()).to.equal(0);
    expect(role.totalDeposited.toNumber()).to.equal(depositedBefore + BOND); // ...as company budget
    await assertInvariants(roleVault);
  });

  it("bond: refunded on settle_expired, waived for vouched scouts, and needs the scout's own funds", async () => {
    const roleVault = await createRole({ deposit: 100 * USDC, window: 2 });
    const task = await createTask(roleVault, { bondBps: BOND_BPS });

    const bonded = await newScout(5 * USDC);
    const s1 = await submit(roleVault, task, bonded, sha("bond-settle", "1"));
    const { reviewDeadline } = await program.account.submission.fetch(s1);
    await timeTravelPast(reviewDeadline.toNumber());
    await settle(roleVault, task, s1, bonded.publicKey);
    expect(await balance(ata(bonded.publicKey))).to.equal(5 * USDC + PAYOUT);

    const before = await balance(ata(vouched.publicKey));
    const s2 = await submit(roleVault, task, vouched, sha("bond-vouched", "1"));
    expect(await balance(ata(vouched.publicKey))).to.equal(before);
    expect((await program.account.submission.fetch(s2)).bondAmount.toNumber()).to.equal(0);

    const broke = await newScout(0);
    await expectError(submit(roleVault, task, broke, sha("bond-broke", "1")), /insufficient funds|0x1\b/i);
    // Someone else's token account can't fund the bond.
    await expectError(
      submit(roleVault, task, broke, sha("bond-broke", "2"), ZERO_HASH, ata(bonded.publicKey)),
      /InvalidTokenAccount/,
    );
    await assertInvariants(roleVault);
  });

  it("bond in the random loop: bond in and out nets to zero; the split stays exact", async () => {
    const roleVault = await createRole({ deposit: 500 * USDC });
    const bonded = await newScout(500 * USDC);
    for (const [i, bounty] of [1, 9, 12_345_679, 33_333_333].entries()) {
      const bondBps = [2000, 1, 1000, 1999][i];
      const task = await createTask(roleVault, { bounty, max: 1, bondBps, holdbackBps: 3000 });
      const scoutBefore = await balance(ata(bonded.publicKey));
      const vaultBefore = await balance(ata(roleVault));
      const submission = await submit(roleVault, task, bonded, sha("bond-rand", String(i)));
      const bond = Math.floor((bounty * bondBps) / 10_000);
      expect(scoutBefore - (await balance(ata(bonded.publicKey)))).to.equal(bond);
      await assertInvariants(roleVault);

      const heldBefore = (await program.account.roleVault.fetch(roleVault)).heldBackTotal.toNumber();
      await accept(roleVault, task, submission, bonded.publicKey);
      const held = (await program.account.roleVault.fetch(roleVault)).heldBackTotal.toNumber() - heldBefore;
      const fee = Math.floor((bounty * FEE_BPS) / 10_000);
      expect((await balance(ata(bonded.publicKey))) - scoutBefore, `bounty ${bounty}`).to.equal(bounty - fee - held);
      expect(vaultBefore - (await balance(ata(roleVault)))).to.equal(bounty - held);
      await assertInvariants(roleVault);
    }
  });

  it("separation of duties + reputation gate; an independent screening flags the sourcer (clawback)", async () => {
    const roleVault = await createRole({ deposit: 200 * USDC });
    // scoutA sources Karolina; 30% of the payout is held back.
    const sourcing = await createTask(roleVault, { holdbackBps: HOLDBACK_BPS });
    const sourced = await submit(roleVault, sourcing, scoutA, sha("sod", "karolina"));
    await accept(roleVault, sourcing, sourced, scoutA.publicKey);

    // The agent posts the screening call for Karolina: not scoutA, and only for proven scouts.
    const screening = await createTask(roleVault, {
      taskType: { screeningCall: {} },
      bounty: 35 * USDC,
      max: 1,
      exclusive: true,
      subjectScout: scoutA.publicKey,
      minAccepted: 1,
    });
    await expectError(claim(roleVault, screening, scoutA), /SelfReview/);
    const newcomer = await newScout();
    await expectError(claim(roleVault, screening, newcomer), /ReputationTooLow/);
    expect((await profile(scoutB.publicKey)).sourcingAccepted).to.be.gte(1);
    await claim(roleVault, screening, scoutB);
    const call = await submit(roleVault, screening, scoutB, sha("sod-call", "karolina"), sha("no-show notes"));
    await accept(roleVault, screening, call, scoutB.publicKey);

    // Non-exclusive tasks enforce the same gates at submit.
    const reference = await createTask(roleVault, {
      taskType: { referenceCheck: {} },
      max: 2,
      subjectScout: scoutA.publicKey,
      minAccepted: 1,
    });
    await expectError(submit(roleVault, reference, scoutA, sha("sod-ref", "a"), sha("n")), /SelfReview/);
    await expectError(submit(roleVault, reference, newcomer, sha("sod-ref", "b"), sha("n")), /ReputationTooLow/);

    // The screener reports the candidate was fake / a no-show: the agent claws back the sourcer's holdback.
    const companyBefore = await balance(companyAta);
    const flaggedBefore = (await profile(scoutA.publicKey)).flagged;
    await attest(roleVault, sourcing, sourced, scoutA.publicKey, { fabricated: {} }, agent);
    expect(await balance(companyAta)).to.equal(companyBefore + HELD);
    expect((await profile(scoutA.publicKey)).flagged).to.equal(flaggedBefore + 1);
    await assertInvariants(roleVault);
  });

  it("create_task validates bond_bps", async () => {
    const roleVault = await createRole({ deposit: 100 * USDC });
    await expectError(createTask(roleVault, { bondBps: 2001 }), /InvalidBond/);
  });

  // ---- v3.2: jury fixes --------------------------------------------------------

  it("ghost deliverables: submit and claim need the gatekeeper's co-signature", async () => {
    const roleVault = await createRole({ deposit: 100 * USDC, window: 2 });
    const task = await createTask(roleVault);
    // A scout talking to the chain directly, without the agent, can't create a pending deliverable…
    await expectError(submit(roleVault, task, scoutA, sha("ghost", "1"), ZERO_HASH, null, scoutA), /NotGatekeeper/);
    // …nor with any key other than the role's agent or company.
    await expectError(submit(roleVault, task, scoutA, sha("ghost", "2"), ZERO_HASH, null, scoutB), /NotGatekeeper/);
    const screening = await createTask(roleVault, { taskType: { screeningCall: {} }, max: 1, exclusive: true });
    await expectError(claim(roleVault, screening, scoutA, scoutA), /NotGatekeeper/);
    await assertInvariants(roleVault);
  });

  const setAgent = (roleVault: PublicKey, newAgent: PublicKey | null, maxBounty: number, maxCommitment: number, signer = company) =>
    send(
      program.methods
        .setAgent(newAgent, new BN(maxBounty), new BN(maxCommitment))
        .accountsPartial({ payer: relayer.publicKey, company: signer.publicKey, roleVault }),
      [signer],
    );

  it("agent caps: per-task bounty and total commitment; closing returns unused allowance", async () => {
    const roleVault = await createRole({ deposit: 500 * USDC, agentMaxBounty: 20 * USDC, agentMaxCommitment: 60 * USDC });
    await expectError(createTask(roleVault, { bounty: 25 * USDC, max: 1 }), /AgentCapExceeded/);
    const t1 = await createTask(roleVault, { max: 2 }); // 40 of 60
    await expectError(createTask(roleVault, { max: 2 }), /AgentCapExceeded/); // 80 > 60
    await createTask(roleVault, { bounty: 25 * USDC, max: 4, signer: company }); // the company isn't capped

    const s1 = await submit(roleVault, t1, scoutA, sha("cap", "1"));
    await accept(roleVault, t1, s1, scoutA.publicKey);
    await closeTask(roleVault, t1); // 1 slot unused: 20 back
    expect((await program.account.roleVault.fetch(roleVault)).agentCommitted.toNumber()).to.equal(20 * USDC);
    await createTask(roleVault, { max: 2 }); // 20 + 40 = 60: fits again
    await assertInvariants(roleVault);
  });

  it("set_agent: only the company rotates or revokes the agent", async () => {
    const roleVault = await createRole({ deposit: 200 * USDC });
    const agent2 = Keypair.generate();
    await expectError(setAgent(roleVault, agent2.publicKey, 1, 1, agent), /has.?one|ConstraintHasOne|2001/i);
    await setAgent(roleVault, agent2.publicKey, 50 * USDC, 100 * USDC);
    await expectError(createTask(roleVault), /Unauthorized/); // the old agent is out
    const task = await createTask(roleVault, { signer: agent2 });
    const s1 = await submit(roleVault, task, scoutA, sha("rotate", "1"), ZERO_HASH, null, agent2);
    await accept(roleVault, task, s1, scoutA.publicKey, agent2);

    await setAgent(roleVault, null, 0, 0); // revoked: the company runs the role (and gatekeeps) itself
    await expectError(createTask(roleVault, { signer: agent2 }), /Unauthorized/);
    await expectError(submit(roleVault, task, scoutB, sha("rotate", "2"), ZERO_HASH, null, agent2), /NotGatekeeper/);
    await submit(roleVault, task, scoutB, sha("rotate", "3"), ZERO_HASH, null, company);
  });

  it("bounds: windows within the config range, bounty >= min_bounty, bond and holdback limits", async () => {
    await expectError(createRole({ deposit: 10 * USDC, window: 0 }), /WindowOutOfRange/);
    await expectError(createRole({ deposit: 10 * USDC, holdbackWindow: 366 * 24 * 3600 }), /WindowOutOfRange/);
    const roleVault = await createRole({ deposit: 100 * USDC });
    await expectError(createTask(roleVault, { bounty: 0 }), /BountyTooSmall/);
    await expectError(createTask(roleVault, { holdbackBps: 5001 }), /InvalidHoldback/);
  });

  it("reject releases an exclusive claim, so a squatter can't block the gig", async () => {
    const roleVault = await createRole({ deposit: 100 * USDC });
    const task = await createTask(roleVault, { taskType: { screeningCall: {} }, bounty: 35 * USDC, max: 1, exclusive: true });
    await claim(roleVault, task, scoutA);
    const junk = await submit(roleVault, task, scoutA, sha("squat", "junk"), sha("junk notes"));
    const relayerBefore = await connection.getBalance(relayer.publicKey);
    await reject(roleVault, task, junk, scoutA.publicKey);
    expect((await program.account.task.fetch(task)).claimant).to.equal(null);
    expect(await connection.getBalance(relayer.publicKey)).to.be.greaterThan(relayerBefore - 10_000); // rent back
    await claim(roleVault, task, scoutB);
    const good = await submit(roleVault, task, scoutB, sha("squat", "good"), sha("real notes"));
    await accept(roleVault, task, good, scoutB.publicKey);
  });

  it("reputation only from tasks worth at least min_reputable_bounty", async () => {
    const roleVault = await createRole({ deposit: 100 * USDC });
    const dust = await createTask(roleVault, { bounty: USDC / 2, max: 5 });
    expect((await program.account.task.fetch(dust)).reputable).to.equal(false);
    const before = await profile(scoutA.publicKey);
    const s1 = await submit(roleVault, dust, scoutA, sha("dust", "1"));
    await accept(roleVault, dust, s1, scoutA.publicKey);
    const after = await profile(scoutA.publicKey);
    expect(after.accepted).to.equal(before.accepted);
    expect(after.sourcingAccepted).to.equal(before.sourcingAccepted);
    expect(after.totalEarned.toNumber()).to.be.greaterThan(before.totalEarned.toNumber()); // still paid

    const real = await createTask(roleVault, { bounty: USDC, max: 1 });
    const s2 = await submit(roleVault, real, scoutA, sha("dust", "2"));
    await accept(roleVault, real, s2, scoutA.publicKey);
    expect((await profile(scoutA.publicKey)).accepted).to.equal(before.accepted + 1);
  });

  it("update_config: admin-only, bounded fee, treasury rotation applies to new roles only", async () => {
    const newTreasury = Keypair.generate();
    const update = (signer: Keypair, wallet: PublicKey, params = CONFIG_PARAMS) =>
      send(
        program.methods.updateConfig(params).accountsPartial({
          payer: relayer.publicKey,
          admin: signer.publicKey,
          config: configPda,
          treasuryWallet: wallet,
          treasuryTokenAccount: ata(wallet),
          usdcMint: mint,
          tokenProgram: TOKEN_PROGRAM_ID,
        }),
        [signer],
      );
    const oldRole = await createRole({ deposit: 100 * USDC });
    await expectError(update(scoutA, newTreasury.publicKey), /has.?one|ConstraintHasOne|2001/i);
    await expectError(update(admin, newTreasury.publicKey, { ...CONFIG_PARAMS, feeBps: 2001 }), /InvalidConfig/);
    await update(admin, newTreasury.publicKey, { ...CONFIG_PARAMS, feeBps: 500 });
    const cfg = await program.account.config.fetch(configPda);
    expect(cfg.treasury.toBase58()).to.equal(newTreasury.publicKey.toBase58());
    expect(cfg.feeBps).to.equal(500);
    // An open role keeps the fee it snapshotted.
    expect((await program.account.roleVault.fetch(oldRole)).feeBps).to.equal(FEE_BPS);
    const newRole = await createRole({ deposit: 100 * USDC });
    expect((await program.account.roleVault.fetch(newRole)).feeBps).to.equal(500);
    // Fees now go to the new treasury (the old ATA is refused).
    const task = await createTask(newRole, { max: 1 });
    const sub = await submit(newRole, task, scoutA, sha("treasury", "1"));
    await expectError(accept(newRole, task, sub, scoutA.publicKey), /has.?one|ConstraintHasOne|2001/i);
    await send(
      program.methods.acceptSubmission(ZERO_HASH).accountsPartial({
        ...payoutAccounts(newRole, task, sub, scoutA.publicKey),
        ...NO_OPERATOR,
        treasuryTokenAccount: ata(newTreasury.publicKey),
        authority: agent.publicKey,
      }),
      [agent],
    );
    expect(await balance(ata(newTreasury.publicKey))).to.equal((BOUNTY * 500) / 10_000);
    await update(admin, treasury.publicKey); // restore
  });

  it("acceptance-rate gate: min_accept_rate_bps over reputable submitted/accepted (newcomers fail it)", async () => {
    const roleVault = await createRole({ deposit: 300 * USDC });
    const gated = await createTask(roleVault, {
      taskType: { screeningCall: {} },
      bounty: 35 * USDC,
      max: 1,
      exclusive: true,
      minAccepted: 1,
      minAcceptRateBps: 5000,
    });
    const fresh = await newScout();
    await expectError(claim(roleVault, gated, fresh), /ReputationTooLow/); // 0 submitted

    // fresh: 1 accepted of 3 submitted (33%) -> below 50%.
    const sourcing = await createTask(roleVault, { max: 3 });
    const subs = [];
    for (const i of [1, 2, 3]) subs.push(await submit(roleVault, sourcing, fresh, sha("rate", String(i))));
    await accept(roleVault, sourcing, subs[0], fresh.publicKey);
    await reject(roleVault, sourcing, subs[1], fresh.publicKey);
    await reject(roleVault, sourcing, subs[2], fresh.publicKey);
    const p = await profile(fresh.publicKey);
    expect([p.accepted, p.submitted, p.rejected]).to.deep.equal([1, 3, 2]);
    await expectError(claim(roleVault, gated, fresh), /ReputationTooLow/);

    // One more accepted: 2 of 4 = 50% -> passes.
    const more = await createTask(roleVault, { max: 1 });
    await accept(roleVault, more, await submit(roleVault, more, fresh, sha("rate", "4")), fresh.publicKey);
    await claim(roleVault, gated, fresh);
  });

  // ---- v3.3: protocol, not platform --------------------------------------------

  /** Decodes the program's events from a confirmed transaction's logs. */
  async function eventsOf(signature: string) {
    const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const parser = new anchor.EventParser(program.programId, new anchor.BorshCoder(program.idl));
    return [...parser.parseLogs(tx?.meta?.logMessages ?? [])];
  }

  it("the company can always act as gatekeeper and reviewer, even with an agent set; hashes are recorded", async () => {
    const roleVault = await createRole({ deposit: 100 * USDC });
    const task = await createTask(roleVault, { taskType: { screeningCall: {} }, bounty: 30 * USDC, max: 2, exclusive: true });
    await claim(roleVault, task, scoutA, company); // company co-signs the claim, agent untouched
    const good = await submit(roleVault, task, scoutA, sha("c-gk", "1"), sha("notes 1"), null, company);
    const review = sha("review: all 6 questions answered, concrete evidence");
    await send(
      program.methods.acceptSubmission(review).accountsPartial({
        ...payoutAccounts(roleVault, task, good, scoutA.publicKey),
        ...NO_OPERATOR,
        authority: company.publicKey,
      }),
      [company],
    );
    expect((await program.account.submission.fetch(good)).reviewHash).to.deep.equal(review);

    const bad = await submit(roleVault, task, scoutA, sha("c-gk", "2"), sha("notes 2"), null, company);
    const reason = sha("Reason: question 4 (notice period) not answered");
    const sig = await send(
      program.methods.rejectSubmission(1, reason).accountsPartial({
        payer: relayer.publicKey,
        authority: company.publicKey,
        roleVault,
        task,
        submission: bad,
        rentPayer: relayer.publicKey,
        scoutProfile: profilePda(scoutA.publicKey),
      }),
      [company],
    );
    const rejected = (await eventsOf(sig)).find((e) => e.name === "submissionRejected");
    expect(rejected?.data.reasonHash).to.deep.equal(reason);
    expect(rejected?.data.reasonCode).to.equal(1);
    expect((rejected?.data.rejectedBy as PublicKey).toBase58()).to.equal(company.publicKey.toBase58());
  });

  it("agent revoked mid-flight: pending work still settles, new work needs the company or a new agent", async () => {
    const roleVault = await createRole({ deposit: 200 * USDC, window: 2 });
    const reference = await createTask(roleVault, { taskType: { referenceCheck: {} }, max: 2 });
    const sourcing = await createTask(roleVault, { max: 2 });
    const pendingRef = await submit(roleVault, reference, scoutA, sha("revoke", "ref"), sha("ref notes"));
    const pendingSrc = await submit(roleVault, sourcing, scoutB, sha("revoke", "src"));

    await setAgent(roleVault, null, 0, 0); // the company stops trusting the agent
    await expectError(accept(roleVault, reference, pendingRef, scoutA.publicKey, agent), /Unauthorized/);
    await expectError(submit(roleVault, sourcing, scoutA, sha("revoke", "new"), ZERO_HASH, null, agent), /NotGatekeeper/);
    await submit(roleVault, sourcing, scoutA, sha("revoke", "new"), ZERO_HASH, null, company);

    const { reviewDeadline } = await program.account.submission.fetch(pendingSrc);
    await timeTravelPast(reviewDeadline.toNumber());
    // Non-sourcing work settles permissionlessly: nobody's signature needed.
    const refBefore = await balance(ata(scoutA.publicKey));
    await settle(roleVault, reference, pendingRef, scoutA.publicKey, null);
    expect(await balance(ata(scoutA.publicKey))).to.equal(refBefore + PAYOUT);
    // Sourcing waits for a confirmation attestation: the revoked agent no longer counts, the company does.
    await expectError(settle(roleVault, sourcing, pendingSrc, scoutB.publicKey, null), /NotAttestor/);
    await expectError(settle(roleVault, sourcing, pendingSrc, scoutB.publicKey, agent), /NotAttestor/);
    await settle(roleVault, sourcing, pendingSrc, scoutB.publicKey, company);
    await assertInvariants(roleVault);
  });

  it("any implementation can be the confirmation attestor for sourcing", async () => {
    const thirdParty = Keypair.generate(); // e.g. a self-hosted agent or an independent confirmation service
    const roleVault = await createRole({ deposit: 100 * USDC, window: 2 });
    const task = await createTask(roleVault, { max: 1, confirmationAttestor: thirdParty.publicKey });
    expect((await program.account.task.fetch(task)).confirmationAttestor?.toBase58()).to.equal(
      thirdParty.publicKey.toBase58(),
    );
    const submission = await submit(roleVault, task, scoutA, sha("attestor", "1"));
    const { reviewDeadline } = await program.account.submission.fetch(submission);
    await timeTravelPast(reviewDeadline.toNumber());
    await expectError(settle(roleVault, task, submission, scoutA.publicKey, agent), /NotAttestor/); // not designated
    await settle(roleVault, task, submission, scoutA.publicKey, thirdParty);
  });
});
