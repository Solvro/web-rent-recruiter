import type { Me } from "@scout/shared";
import { PROJECT_NAME } from "@scout/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Building2, ChevronDown, LogIn, LogOut, RotateCcw, UserRound, UsersRound } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage } from "@/lib/api";
import { API_MOCK, PRIVY_AVAILABLE, switchAuthMode } from "@/lib/env";
import { formatUsdc, initials } from "@/lib/format";
import { resetMockData } from "@/lib/mock/store";
import { PERSONAS, type Persona, type PersonaId } from "@/lib/personas";
import { useMe } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { useWallet } from "@/lib/wallet";

function PersonaIcon({ persona }: { persona: Persona }) {
	return persona.kind === "company" ? <Building2 className="size-4" /> : <UserRound className="size-4" />;
}

export function AccountMenu() {
	const wallet = useWallet();
	const me = useMe();

	if (wallet.mode === "privy" && !wallet.address)
		return (
			<div className="flex items-center gap-1">
				<Button variant="ghost" onClick={() => switchAuthMode("demo")} className="hidden sm:inline-flex">
					<UsersRound /> Demo accounts
				</Button>
				<Button onClick={wallet.login} disabled={!wallet.ready}>
					Log in with Google
				</Button>
			</div>
		);

	const name = me.data?.displayName ?? wallet.persona?.displayName ?? wallet.label ?? "Choose account";
	return (
		<div className="flex items-center gap-2">
			{me.data && (
				<span className="hidden rounded-full bg-secondary px-3 py-1 text-sm font-medium tabular sm:inline">
					{formatUsdc(me.data.usdcBalance)}
				</span>
			)}
			<DropdownMenu>
				<DropdownMenuTrigger
					render={<Button variant="outline" className="h-9 gap-2 pl-1.5" />}
					aria-label="Account menu"
				>
					<Avatar className="size-6">
						<AvatarFallback className="bg-accent text-[10px] text-accent-foreground">
							{me.data || wallet.persona ? initials(name) : <UserRound className="size-3.5" />}
						</AvatarFallback>
					</Avatar>
					<span className="max-w-32 truncate">{name}</span>
					<ChevronDown className="size-3.5 opacity-60" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-72">
					{wallet.mode === "demo" ? (
						<DropdownMenuGroup>
							<DropdownMenuLabel>Demo accounts{API_MOCK ? " · simulated" : " · devnet"}</DropdownMenuLabel>
							{wallet.personas.map((p) => (
								<DropdownMenuItem
									key={p.id}
									onClick={() => wallet.selectPersona(p.id)}
									className={cn("items-start gap-2.5 py-2", wallet.persona?.id === p.id && "bg-accent")}
								>
									<span className="mt-0.5 text-muted-foreground">
										<PersonaIcon persona={p} />
									</span>
									<span className="flex flex-col">
										<span className="font-medium">{p.displayName}</span>
										<span className="text-xs text-muted-foreground">{p.role}</span>
									</span>
								</DropdownMenuItem>
							))}
						</DropdownMenuGroup>
					) : (
						<DropdownMenuLabel className="font-normal text-muted-foreground">
							{wallet.label}
						</DropdownMenuLabel>
					)}
					{me.data?.kind === "scout" && wallet.address && (
						<>
							<DropdownMenuSeparator />
							<DropdownMenuItem render={<Link to="/scouts/$pubkey" params={{ pubkey: wallet.address }} />}>
								Public profile
							</DropdownMenuItem>
						</>
					)}
					{wallet.mode === "demo" && (API_MOCK || PRIVY_AVAILABLE) && (
						<>
							<DropdownMenuSeparator />
							{PRIVY_AVAILABLE && (
								<DropdownMenuItem onClick={() => switchAuthMode("privy")}>
									<LogIn className="size-4" /> Use Google login instead
								</DropdownMenuItem>
							)}
							{API_MOCK && (
								<DropdownMenuItem
									onClick={() => {
										resetMockData();
										location.reload();
									}}
								>
									<RotateCcw className="size-4" /> Reset demo data
								</DropdownMenuItem>
							)}
						</>
					)}
					<DropdownMenuSeparator />
					<DropdownMenuItem onClick={wallet.logout}>
						<LogOut className="size-4" /> Log out
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}

/** Demo personas get their profile created automatically; Privy users pick company or scout once. */
export function Onboarding() {
	const wallet = useWallet();
	const me = useMe();
	const qc = useQueryClient();
	const needsProfile = !!wallet.address && me.isSuccess && me.data === null;

	const upsert = useMutation({
		mutationFn: api.upsertMe,
		onSuccess: (data) => qc.setQueryData(["me", wallet.address], data),
	});

	const { persona } = wallet;
	const { mutate, isPending, isError } = upsert;
	useEffect(() => {
		if (needsProfile && persona && !isPending && !isError)
			mutate({ kind: persona.kind, displayName: persona.displayName, companyName: persona.companyName });
	}, [needsProfile, persona, isPending, isError, mutate]);

	const [kind, setKind] = useState<Me["kind"]>("company");
	const [displayName, setDisplayName] = useState("");
	const [companyName, setCompanyName] = useState("");

	if (!needsProfile || wallet.mode !== "privy") return null;
	return (
		<Dialog open>
			<DialogContent showCloseButton={false}>
				<DialogHeader>
					<DialogTitle>Welcome to {PROJECT_NAME}</DialogTitle>
					<DialogDescription>
						Tell us how you'll use it. You can't change this later in the demo.
					</DialogDescription>
				</DialogHeader>
				<form
					className="space-y-4"
					onSubmit={(e) => {
						e.preventDefault();
						upsert.mutate({ kind, displayName, companyName: kind === "company" ? companyName : undefined });
					}}
				>
					<div className="grid grid-cols-2 gap-2">
						{(
							[
								["company", "I'm hiring", "Post roles and pay per qualified candidate"],
								["scout", "I'm a recruiter", "Source candidates and get paid instantly"],
							] as const
						).map(([k, title, text]) => (
							<button
								key={k}
								type="button"
								onClick={() => setKind(k)}
								className={cn(
									"rounded-2xl border p-3 text-left transition-colors",
									kind === k ? "border-primary bg-accent" : "hover:bg-muted",
								)}
							>
								<p className="font-medium">{title}</p>
								<p className="text-xs text-muted-foreground">{text}</p>
							</button>
						))}
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="displayName">Your name</Label>
						<Input
							id="displayName"
							required
							value={displayName}
							onChange={(e) => setDisplayName(e.target.value)}
						/>
					</div>
					{kind === "company" && (
						<div className="space-y-1.5">
							<Label htmlFor="companyName">Company</Label>
							<Input
								id="companyName"
								required
								value={companyName}
								onChange={(e) => setCompanyName(e.target.value)}
							/>
						</div>
					)}
					{upsert.isError && <p className="text-sm text-destructive">{errorMessage(upsert.error)}</p>}
					<Button type="submit" className="w-full" disabled={upsert.isPending}>
						Continue
					</Button>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** Gate for company-only or scout-only pages. */
export function RequireAccount({ kind, children }: { kind: Me["kind"]; children: (me: Me) => ReactNode }) {
	const wallet = useWallet();
	const me = useMe();
	const wanted: PersonaId = kind === "company" ? "company" : "scout";

	if (!wallet.ready) return <PageSkeleton />;

	if (wallet.missingKeyFor)
		return (
			<GateCard title="Demo keypair missing">
				Add{" "}
				<code className="rounded bg-muted px-1">VITE_DEMO_{wallet.missingKeyFor.toUpperCase()}_SECRET</code>{" "}
				to <code className="rounded bg-muted px-1">app/.env</code> to use this account against the devnet API.
			</GateCard>
		);

	if (!wallet.address)
		return (
			<GateCard
				title={kind === "company" ? "Log in to hire" : "Log in to start scouting"}
				action={
					wallet.mode === "demo" ? (
						<Button onClick={() => wallet.selectPersona(wanted)}>
							Continue as {PERSONAS[wanted].displayName}
						</Button>
					) : (
						<Button onClick={wallet.login}>Log in with Google</Button>
					)
				}
			>
				{kind === "company"
					? "Create a role, fund a budget and let scouts bring you qualified candidates."
					: "Pick a task, submit candidates you know, and get paid the moment they're accepted."}
			</GateCard>
		);

	if (me.isPending || me.data === null) return <PageSkeleton />;
	if (me.isError) return <GateCard title="Couldn't load your account">{errorMessage(me.error)}</GateCard>;

	if (me.data.kind !== kind)
		return (
			<GateCard
				title={kind === "company" ? "This area is for hiring companies" : "This area is for scouts"}
				action={
					wallet.mode === "demo" ? (
						<Button onClick={() => wallet.selectPersona(wanted)}>
							Switch to {PERSONAS[wanted].displayName}
						</Button>
					) : (
						<Link to={kind === "company" ? "/scout" : "/company"} className={buttonVariants()}>
							Go to your dashboard
						</Link>
					)
				}
			>
				You're signed in as {me.data.displayName}.
			</GateCard>
		);

	return <>{children(me.data)}</>;
}

function GateCard({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
	return (
		<Card className="mx-auto mt-10 max-w-md text-center">
			<CardHeader>
				<CardTitle>{title}</CardTitle>
				<CardDescription>{children}</CardDescription>
			</CardHeader>
			{action && <CardContent className="flex justify-center">{action}</CardContent>}
		</Card>
	);
}

export function PageSkeleton() {
	return (
		<div className="space-y-6">
			<Skeleton className="h-9 w-72" />
			<Skeleton className="h-28 w-full rounded-2xl" />
			<Skeleton className="h-48 w-full rounded-2xl" />
		</div>
	);
}
