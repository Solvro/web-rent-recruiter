import type { Me } from "@scout/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Building2, ChevronDown, Loader2, Search } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { ErrorState } from "@/components/bits";
import { Avatar } from "@/components/person";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { API_MOCK, PRIVY_AVAILABLE, switchAuthMode } from "@/lib/env";
import { errorMessage } from "@/lib/errors";
import { resetMockData } from "@/lib/mock/store";
import { PERSONAS, type PersonaId } from "@/lib/personas";
import { useMe } from "@/lib/queries";
import { useTRPC } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { useWallet } from "@/lib/wallet";

const INTENT_KEY = "scout.intent";
export function rememberIntent(kind: Me["kind"]) {
	try {
		sessionStorage.setItem(INTENT_KEY, kind);
	} catch {
		// private mode
	}
}
function readIntent(): Me["kind"] | null {
	try {
		const v = sessionStorage.getItem(INTENT_KEY);
		return v === "company" || v === "scout" ? v : null;
	} catch {
		return null;
	}
}

export function AccountMenu() {
	const wallet = useWallet();
	const me = useMe();
	const navigate = useNavigate();

	if (wallet.mode === "privy" && !wallet.authenticated)
		return (
			<div className="flex items-center gap-1">
				<Button variant="ghost" className="text-muted-foreground" onClick={() => switchAuthMode("demo")}>
					Demo accounts
				</Button>
				<Button variant="outline" onClick={wallet.login} disabled={!wallet.ready}>
					Log in
				</Button>
			</div>
		);

	const name =
		me.data?.displayName ??
		wallet.persona?.displayName ??
		(wallet.mode === "demo"
			? "Pick a demo account"
			: wallet.settingUp
				? "Setting up…"
				: (wallet.label ?? "Signed in"));
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={<Button variant="ghost" className="h-10 gap-2 pl-1" />}
				aria-label="Account"
			>
				{(me.data || wallet.persona) && <Avatar name={name} size="xs" />}
				<span className="hidden max-w-36 truncate sm:inline">{name}</span>
				<ChevronDown className="size-3.5 text-muted-foreground" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-64">
				{wallet.mode === "privy" && (
					<DropdownMenuGroup>
						<DropdownMenuLabel>Signed in{wallet.label ? ` as ${wallet.label}` : ""}</DropdownMenuLabel>
					</DropdownMenuGroup>
				)}
				{wallet.mode === "demo" && (
					<DropdownMenuGroup>
						<DropdownMenuLabel>Demo accounts</DropdownMenuLabel>
						{wallet.personas.map((p) => (
							<DropdownMenuItem
								key={p.id}
								onClick={() => {
									wallet.selectPersona(p.id);
									navigate({ to: p.kind === "company" ? "/company" : "/scout" });
								}}
								className={cn("justify-between", wallet.persona?.id === p.id && "bg-accent")}
							>
								{p.displayName}
								<span className="type-label text-muted-foreground">{p.role}</span>
							</DropdownMenuItem>
						))}
					</DropdownMenuGroup>
				)}
				{wallet.mode === "demo" && (PRIVY_AVAILABLE || API_MOCK) && <DropdownMenuSeparator />}
				{wallet.mode === "demo" && PRIVY_AVAILABLE && (
					<DropdownMenuItem onClick={() => switchAuthMode("privy")}>
						Use Google login instead
					</DropdownMenuItem>
				)}
				{wallet.mode === "privy" && (
					<DropdownMenuItem onClick={() => switchAuthMode("demo")}>
						Use demo accounts instead
					</DropdownMenuItem>
				)}
				{wallet.mode === "demo" && API_MOCK && (
					<DropdownMenuItem
						onClick={() => {
							resetMockData();
							location.reload();
						}}
					>
						Reset demo
					</DropdownMenuItem>
				)}
				{wallet.authenticated && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuItem onClick={wallet.logout}>Log out</DropdownMenuItem>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

const TILES = [
	{ kind: "company" as const, icon: Building2, title: "I'm hiring" },
	{ kind: "scout" as const, icon: Search, title: "I'm a recruiter" },
];

/** Logged in for the first time: one question, two big tiles, then a name. Calls me.upsert. */
function RolePicker({ preferred }: { preferred: Me["kind"] }) {
	const trpc = useTRPC();
	const qc = useQueryClient();
	const [kind, setKind] = useState<Me["kind"]>(readIntent() ?? preferred);
	const [displayName, setDisplayName] = useState("");
	const [companyName, setCompanyName] = useState("");
	const upsert = useMutation(
		trpc.me.upsert.mutationOptions({ onSuccess: (data) => qc.setQueryData(trpc.me.get.queryKey(), data) }),
	);
	return (
		<div className="mx-auto max-w-lg space-y-8 py-16">
			<h1 className="type-display">What brings you here?</h1>
			<div className="grid grid-cols-2 gap-3">
				{TILES.map((t) => (
					<button
						key={t.kind}
						type="button"
						onClick={() => setKind(t.kind)}
						className={cn(
							"flex flex-col items-center gap-3 rounded-3xl border-2 px-4 py-8 transition-colors",
							kind === t.kind ? "border-primary bg-accent" : "border-border hover:bg-muted",
						)}
					>
						<t.icon className="size-6 text-primary" />
						{t.title}
					</button>
				))}
			</div>
			<form
				className="space-y-3"
				onSubmit={(e) => {
					e.preventDefault();
					upsert.mutate({ kind, displayName, companyName: kind === "company" ? companyName : undefined });
				}}
			>
				<Input
					required
					placeholder="Your name"
					aria-label="Your name"
					value={displayName}
					onChange={(e) => setDisplayName(e.target.value)}
				/>
				{kind === "company" && (
					<Input
						required
						placeholder="Company"
						aria-label="Company"
						value={companyName}
						onChange={(e) => setCompanyName(e.target.value)}
					/>
				)}
				{upsert.isError && <p className="type-label text-destructive">{errorMessage(upsert.error)}</p>}
				<Button type="submit" size="lg" className="w-full" disabled={upsert.isPending}>
					{upsert.isPending && <Loader2 className="animate-spin" />}
					Continue
				</Button>
			</form>
		</div>
	);
}

/** Demo personas get their profile created on first use, without asking. */
function useAutoProfileForDemo(needsProfile: boolean) {
	const wallet = useWallet();
	const trpc = useTRPC();
	const qc = useQueryClient();
	const upsert = useMutation(
		trpc.me.upsert.mutationOptions({ onSuccess: (data) => qc.setQueryData(trpc.me.get.queryKey(), data) }),
	);
	const { persona } = wallet;
	const { mutate, isPending, isError } = upsert;
	useEffect(() => {
		if (needsProfile && persona && wallet.mode === "demo" && !isPending && !isError)
			mutate({ kind: persona.kind, displayName: persona.displayName, companyName: persona.companyName });
	}, [needsProfile, persona, wallet.mode, isPending, isError, mutate]);
	return upsert;
}

/** Logged out: one Google button (or the demo persona), and a way into the demo accounts. */
export function LoginGate({ kind, title }: { kind: Me["kind"]; title?: string }) {
	const wallet = useWallet();
	const wanted: PersonaId = kind === "company" ? "company" : "scout";
	return (
		<Gate
			title={title ?? "Log in to continue"}
			action={
				wallet.mode === "demo" ? (
					<Button size="lg" onClick={() => wallet.selectPersona(wanted)}>
						Continue as {PERSONAS[wanted].displayName}
					</Button>
				) : (
					<div className="flex flex-col items-center gap-4">
						<Button
							size="lg"
							onClick={() => {
								rememberIntent(kind);
								wallet.login();
							}}
						>
							Continue with Google
						</Button>
						<button
							type="button"
							onClick={() => switchAuthMode("demo")}
							className="type-label text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
						>
							Try the demo accounts
						</button>
					</div>
				)
			}
		/>
	);
}

/**
 * Gate for company-only or recruiter-only pages. Every state renders something final: a skeleton only while a
 * request is actually in flight, never for a query that is disabled.
 */
export function RequireAccount({ kind, children }: { kind: Me["kind"]; children: (me: Me) => ReactNode }) {
	const wallet = useWallet();
	const me = useMe();
	const wanted: PersonaId = kind === "company" ? "company" : "scout";
	const needsProfile = !!wallet.address && me.isSuccess && me.data === null;
	const autoProfile = useAutoProfileForDemo(needsProfile);

	if (!wallet.ready) return <PageSkeleton />;
	if (wallet.missingKeyFor) return <Gate title="This demo account isn't set up on this machine." />;
	if (wallet.settingUp)
		return (
			<Gate
				title="Setting up your account…"
				action={<Loader2 className="size-5 animate-spin text-muted-foreground" />}
			/>
		);
	if (!wallet.address) return <LoginGate kind={kind} />;
	if (me.isError || autoProfile.isError) return <ErrorState />;
	if (me.isPending) return me.fetchStatus === "idle" ? <LoginGate kind={kind} /> : <PageSkeleton />;
	if (me.data === null) return wallet.mode === "demo" ? <PageSkeleton /> : <RolePicker preferred={kind} />;

	if (me.data.kind !== kind)
		return (
			<Gate
				title={kind === "company" ? "This page is for companies." : "This page is for recruiters."}
				action={
					wallet.mode === "demo" ? (
						<Button size="lg" onClick={() => wallet.selectPersona(wanted)}>
							Switch to {PERSONAS[wanted].displayName}
						</Button>
					) : undefined
				}
			/>
		);

	return <>{children(me.data)}</>;
}

function Gate({ title, action }: { title: string; action?: ReactNode }) {
	return (
		<div className="flex flex-col items-center gap-8 py-28 text-center">
			<p className="max-w-md type-display">{title}</p>
			{action}
		</div>
	);
}

export function PageSkeleton() {
	return (
		<div className="space-y-6">
			<Skeleton className="h-10 w-72" />
			<Skeleton className="h-40 w-full rounded-3xl" />
		</div>
	);
}
