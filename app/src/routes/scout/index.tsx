import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Check, Lock, Search, UserRound } from "lucide-react";
import { useMemo } from "react";
import { PageSkeleton, rememberIntent } from "@/components/account";
import { EmptyState, ErrorState } from "@/components/bits";
import { Avatar } from "@/components/person";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatMoney } from "@/lib/format";
import { eligibilityLine, requirementChips } from "@/lib/gig-access";
import type { GigKind } from "@/lib/gig-types";
import { CLAIM_HOURS, GIG_TYPE_ORDER, GIG_TYPES, kindOf } from "@/lib/gig-types";
import { earnFor, useGigs } from "@/lib/gigs/api";
import type { GigView } from "@/lib/gigs/schemas";
import { useMe } from "@/lib/queries";
import { standing, TYPE_WORD } from "@/lib/reputation";
import { cn } from "@/lib/utils";
import { useWallet } from "@/lib/wallet";

type Sort = "pay" | "new" | "full";
type BoardSearch = { q?: string; type?: GigKind; where?: string; pay?: number; sort?: Sort };

/** Board state lives in the URL so a filtered view can be shared or reloaded. */
export const Route = createFileRoute("/scout/")({
	validateSearch: (s: Record<string, unknown>): BoardSearch => ({
		q: typeof s.q === "string" && s.q ? s.q : undefined,
		type: GIG_TYPE_ORDER.includes(s.type as GigKind) ? (s.type as GigKind) : undefined,
		where: typeof s.where === "string" && s.where ? s.where : undefined,
		pay: Number(s.pay) > 0 ? Number(s.pay) : undefined,
		sort: s.sort === "new" || s.sort === "full" ? s.sort : undefined,
	}),
	component: GigBoard,
});

const SORTS = [
	{ value: "pay", label: "Highest pay" },
	{ value: "new", label: "Newest" },
	{ value: "full", label: "Almost full" },
];
const PAYS = [
	{ value: "0", label: "Any pay" },
	{ value: "5", label: "$5 or more" },
	{ value: "25", label: "$25 or more" },
];
/** "Remote" or the gig's city. */
const placeOf = (g: GigView) => (g.remote ? "Remote" : g.city);

function GigBoard() {
	const gigs = useGigs();
	const me = useMe();
	const search = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const set = (patch: Partial<BoardSearch>) =>
		navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true });
	const operatorFeeBps = me.data?.operator?.feeBps ?? 0;

	const all = useMemo(() => gigs.data ?? [], [gigs.data]);
	const places = useMemo(() => [...new Set(all.map(placeOf).filter((p): p is string => !!p))].sort(), [all]);
	const matches = (g: GigView, ignoreType = false) => {
		const q = search.q?.toLowerCase().trim();
		if (q && !`${g.title} ${g.brief} ${g.roleTitle} ${g.companyName}`.toLowerCase().includes(q)) return false;
		if (!ignoreType && search.type && kindOf(g) !== search.type) return false;
		if (search.where && placeOf(g) !== search.where) return false;
		if (search.pay && earnFor(g, operatorFeeBps) < BigInt(search.pay * 1_000_000)) return false;
		return true;
	};
	const shown = all
		.filter((g) => matches(g))
		.sort((a, b) =>
			search.sort === "new"
				? b.createdAt.localeCompare(a.createdAt)
				: search.sort === "full"
					? a.slotsLeft / a.maxDeliverables - b.slotsLeft / b.maxDeliverables
					: Number(earnFor(b, operatorFeeBps) - earnFor(a, operatorFeeBps)),
		);
	const count = (kind?: GigKind) =>
		all.filter((g) => matches(g, true) && (!kind || kindOf(g) === kind)).length;
	const active = search.type ? GIG_TYPES[search.type] : null;

	if (gigs.isError) return <ErrorState />;
	if (gigs.isPending) return <PageSkeleton />;

	return (
		<div className="mx-auto max-w-3xl space-y-8">
			<div className="flex flex-wrap items-center justify-between gap-4">
				<h1 className="type-display">Gigs</h1>
				<div className="relative w-full sm:w-72">
					<Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
					<Input
						value={search.q ?? ""}
						onChange={(e) => set({ q: e.target.value || undefined })}
						placeholder="Role, skill, city, company"
						aria-label="Search gigs"
						className="pl-10"
					/>
				</div>
			</div>

			<div className="space-y-3">
				<div className="flex flex-wrap gap-2" role="tablist" aria-label="Gig type">
					<TypeTab
						selected={!search.type}
						onClick={() => set({ type: undefined })}
						label="All"
						count={count()}
					/>
					{GIG_TYPE_ORDER.map((t) => (
						<TypeTab
							key={t}
							selected={search.type === t}
							onClick={() => set({ type: t })}
							label={GIG_TYPES[t].name}
							icon={GIG_TYPES[t].icon}
							count={count(t)}
						/>
					))}
				</div>
				{active && (
					<p className="type-label text-muted-foreground">
						{active.does} · you send: {active.deliver.toLowerCase()} · {active.time.toLowerCase()}
					</p>
				)}
			</div>

			<div className="flex flex-wrap items-center gap-2">
				<FilterSelect
					value={search.where ?? "any"}
					onChange={(v) => set({ where: v === "any" ? undefined : v })}
					items={[{ value: "any", label: "Anywhere" }, ...places.map((p) => ({ value: p, label: p }))]}
					label="Location"
				/>
				<FilterSelect
					value={String(search.pay ?? 0)}
					onChange={(v) => set({ pay: Number(v) || undefined })}
					items={PAYS}
					label="Pay"
				/>
				<span className="ml-auto type-label text-muted-foreground tabular">
					{shown.length} gig{shown.length === 1 ? "" : "s"}
				</span>
				<FilterSelect
					value={search.sort ?? "pay"}
					onChange={(v) => set({ sort: v === "pay" ? undefined : (v as Sort) })}
					items={SORTS}
					label="Sort"
				/>
			</div>

			{shown.length ? (
				<ul className="space-y-4">
					{shown.map((gig) => (
						<GigCard key={gig.id} gig={gig} earn={earnFor(gig, operatorFeeBps)} place={placeOf(gig)} />
					))}
				</ul>
			) : (
				<EmptyState
					title={all.length ? "No gigs match these filters." : "No open gigs right now."}
					action={
						all.length ? (
							<Button variant="outline" onClick={() => navigate({ search: {}, replace: true })}>
								Clear filters
							</Button>
						) : undefined
					}
				/>
			)}
		</div>
	);
}

function TypeTab({
	selected,
	onClick,
	label,
	count,
	icon: Icon,
}: {
	selected: boolean;
	onClick: () => void;
	label: string;
	count: number;
	icon?: (typeof GIG_TYPES)[GigKind]["icon"];
}) {
	return (
		<button
			type="button"
			role="tab"
			aria-selected={selected}
			onClick={onClick}
			className={cn(
				"inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 type-label ring-1 ring-inset transition-colors",
				selected
					? "bg-foreground text-background ring-foreground"
					: "text-muted-foreground ring-border hover:bg-muted",
			)}
		>
			{Icon && <Icon className="size-3.5" />}
			{label}
			<span className={cn("tabular", selected ? "text-background/70" : "text-muted-foreground/70")}>
				{count}
			</span>
		</button>
	);
}

function FilterSelect({
	value,
	onChange,
	items,
	label,
}: {
	value: string;
	onChange: (v: string) => void;
	items: { value: string; label: string }[];
	label: string;
}) {
	return (
		<Select value={value} onValueChange={(v) => v && onChange(v)} items={items}>
			<SelectTrigger aria-label={label} className="h-9 w-auto gap-2 rounded-full">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{items.map((i) => (
					<SelectItem key={i.value} value={i.value}>
						{i.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

/** Before taking a gig the API sends only an anonymous summary: no name, photo or link. */
function CandidateLine({ gig }: { gig: GigView }) {
	const c = gig.candidate;
	if (!c) return null;
	if (c.redacted || !c.name)
		return (
			<p className="flex items-center gap-2 text-muted-foreground">
				<span className="grid size-6 place-items-center rounded-full bg-muted" aria-hidden>
					<UserRound className="size-3.5" />
				</span>
				{[c.summary.headline, c.summary.city].filter(Boolean).join(" · ")}
			</p>
		);
	return (
		<p className="flex items-center gap-2 text-muted-foreground">
			<Avatar name={c.name} src={c.card?.avatarUrl} size="xs" />
			{c.name}
		</p>
	);
}

function GigCard({ gig, earn, place }: { gig: GigView; earn: bigint; place: string | null }) {
	const wallet = useWallet();
	const info = GIG_TYPES[kindOf(gig)];
	const loggedIn = !!wallet.address;
	const meta = gig.exclusive
		? gig.claimedByMe
			? "Yours"
			: `One recruiter · yours for ${CLAIM_HOURS}h once you take it`
		: `${gig.slotsLeft} of ${gig.maxDeliverables} left`;
	const me = useMe();
	const myScore = me.data?.reputation?.byType[gig.type] ?? null;
	const locked = loggedIn && gig.eligibility && !gig.eligibility.allowed && !gig.claimedByMe;
	const chips = requirementChips(gig.requirements);
	const raisedFrom = gig.priceHistory[0]
		? (earn * BigInt(gig.priceHistory[0].bounty)) / BigInt(gig.bounty)
		: null;
	const action = !loggedIn
		? wallet.mode === "demo"
			? "Pick an account to start"
			: wallet.settingUp
				? "Setting up your account…"
				: "Log in to start"
		: gig.claimedByMe
			? "Continue"
			: info.action;

	return (
		<li className="space-y-5 rounded-4xl bg-card p-6 shadow-sm ring-1 ring-foreground/5 sm:p-8">
			<div className="flex items-start gap-4">
				<span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-accent text-accent-foreground">
					<info.icon className="size-5" />
				</span>
				<div className="min-w-0 flex-1 space-y-1.5">
					<p className="type-label text-muted-foreground">{info.name}</p>
					<p>{gig.exclusive ? gig.roleTitle : gig.title}</p>
					<CandidateLine gig={gig} />
					<p className="type-label text-muted-foreground">
						{[gig.companyName, place && !gig.companyName.includes(place) ? place : null, meta]
							.filter(Boolean)
							.join(" · ")}
					</p>
				</div>
				<p className="shrink-0 text-right">
					<span className="block tabular text-success">{formatMoney(earn)}</span>
					<span className="type-label text-muted-foreground">{info.unit}</span>
					{raisedFrom !== null && (
						<span className="mt-1 block type-label text-muted-foreground">
							Price went up · was <span className="line-through">{formatMoney(raisedFrom)}</span>
						</span>
					)}
				</p>
			</div>
			{chips.length > 0 && (
				<div className="flex flex-wrap gap-1.5 pl-14">
					{chips.map((c) => (
						<span key={c} className="rounded-full bg-muted px-2.5 py-0.5 type-label text-muted-foreground">
							{c}
						</span>
					))}
				</div>
			)}
			<div className="flex flex-wrap items-center justify-between gap-4 pl-14">
				{myScore !== null && myScore > 0 && (
					<span className="type-label text-muted-foreground">
						You: {TYPE_WORD[gig.type]} · {standing(myScore)}
					</span>
				)}
				{loggedIn && gig.eligibility ? (
					<span
						className={cn(
							"inline-flex items-center gap-1.5 type-label",
							locked ? "text-muted-foreground" : "text-success",
						)}
					>
						{locked ? <Lock className="size-3.5" /> : <Check className="size-3.5" />}
						{eligibilityLine(gig.eligibility)}
					</span>
				) : (
					<span className="inline-flex items-center gap-1.5 type-label text-success">
						<Check className="size-3.5" /> Money set aside
					</span>
				)}
				{locked ? (
					<Link
						to="/scout/gigs/$gigId"
						params={{ gigId: gig.id }}
						className={buttonVariants({ variant: "outline" })}
					>
						See what it takes
					</Link>
				) : loggedIn ? (
					<Link to="/scout/gigs/$gigId" params={{ gigId: gig.id }} className={buttonVariants()}>
						{action}
					</Link>
				) : (
					<Button
						disabled={wallet.settingUp}
						onClick={() => {
							rememberIntent("scout");
							if (wallet.mode === "demo") wallet.selectPersona("scout");
							else wallet.login();
						}}
					>
						{action}
					</Button>
				)}
			</div>
		</li>
	);
}
