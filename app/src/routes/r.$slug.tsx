import { explorerAddressUrl, type ScoutPublicProfile } from "@scout/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Check, Link2, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { PageSkeleton } from "@/components/account";
import { Chip, EmptyState } from "@/components/bits";
import { Avatar } from "@/components/person";
import { Button, buttonVariants } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { formatMoney } from "@/lib/format";
import { useMe, useScout } from "@/lib/queries";
import { SKILL_CHOICES, skillName, skillSource, standing, TYPE_WORD, uniqueSkills } from "@/lib/reputation";
import { useTRPC } from "@/lib/trpc";
import { useTitle } from "@/lib/use-title";
import { cn } from "@/lib/utils";

/** Public recruiter profile at /r/<slug>, resolved by the API on any device. */
export const Route = createFileRoute("/r/$slug")({
	component: () => {
		const { slug } = Route.useParams();
		return <PublicProfile slug={slug} />;
	},
});

const dateLabel = (iso: string) =>
	new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const STATUS = {
	ACCEPTED: { label: "Accepted", tone: "good" },
	REJECTED: { label: "Not accepted", tone: "neutral" },
	PENDING: { label: "In review", tone: "accent" },
} as const;

function PublicProfile({ slug }: { slug: string }) {
	const scout = useScout({ slug });
	const me = useMe();
	useTitle(scout.data?.displayName ?? "Recruiter");
	if (scout.isPending) return <PageSkeleton />;
	if (scout.isError)
		return (
			<EmptyState
				title="We couldn't find this recruiter."
				action={
					<Link to="/" className={buttonVariants({ variant: "outline" })}>
						Go home
					</Link>
				}
			/>
		);
	const p = scout.data;
	const { accepted, rejected, totalEarned } = p.reputation;
	const owner = !!me.data && (me.data.slug === p.slug || me.data.wallet === p.wallet);
	const skills = uniqueSkills(p.skills ?? []);

	const share = async () => {
		try {
			await navigator.clipboard.writeText(`${location.origin}/r/${p.slug}`);
			toast.success("Link copied");
		} catch {
			toast(`${location.origin}/r/${p.slug}`);
		}
	};

	return (
		<div className="mx-auto flex max-w-xl flex-col items-center gap-6 pt-10 text-center">
			<Avatar name={p.displayName} src={p.avatarUrl} size="lg" />
			<div className="space-y-1">
				<p>{p.displayName}</p>
				{p.operator && <p className="type-label text-muted-foreground">Vouched by {p.operator.name}</p>}
			</div>
			<h1 className="type-display tabular">{formatMoney(totalEarned)} earned</h1>
			<p className="text-muted-foreground">
				{accepted} of {accepted + rejected} gigs accepted
			</p>
			{p.score && (
				<dl className="grid w-full grid-cols-3 gap-2">
					{(Object.keys(TYPE_WORD) as (keyof typeof TYPE_WORD)[]).map((t) => {
						const v = p.score?.byType[t] ?? 0;
						return (
							<div key={t} className="space-y-1 rounded-3xl bg-card p-4 ring-1 ring-foreground/5">
								<dt className="type-label text-muted-foreground">{TYPE_WORD[t]}</dt>
								<dd className="tabular">{v || "–"}</dd>
								<dd className="type-label text-muted-foreground">{v ? standing(v) : "no work yet"}</dd>
							</div>
						);
					})}
				</dl>
			)}

			{(skills.length > 0 || owner) && (
				<div className="w-full space-y-2">
					<p className="type-label text-muted-foreground">Skills</p>
					<ul className="flex flex-wrap justify-center gap-1.5">
						{skills.map((sk) => {
							const source = skillSource(sk);
							return (
								<li
									key={sk.skill}
									className="rounded-full bg-accent/60 px-3 py-1 type-label text-accent-foreground"
								>
									{skillName(sk.skill)}
									{source && <span className="text-muted-foreground"> · {source}</span>}
								</li>
							);
						})}
					</ul>
					{owner && <SkillsEditor profile={p} />}
				</div>
			)}

			{p.recent.length > 0 && (
				<div className="w-full space-y-2 text-left">
					<p className="text-center type-label text-muted-foreground">Recent gigs</p>
					<ul className="divide-y rounded-3xl bg-card px-5 ring-1 ring-foreground/5">
						{p.recent.slice(0, 5).map((r) => (
							<li key={r.id} className="flex items-center gap-3 py-3">
								<span className="min-w-0 flex-1">
									<span className="block truncate">{r.roleTitle}</span>
									<span className="type-label text-muted-foreground">{dateLabel(r.submittedAt)}</span>
								</span>
								<Chip tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Chip>
							</li>
						))}
					</ul>
				</div>
			)}

			{p.score?.seededHistory && (
				<p className="type-label text-muted-foreground">Part of this history is demo data.</p>
			)}
			<div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
				<Button variant="ghost" onClick={share}>
					<Link2 /> Copy link
				</Button>
				{p.profileAddress && (
					<a
						href={explorerAddressUrl(p.profileAddress)}
						target="_blank"
						rel="noreferrer"
						className="type-label text-muted-foreground/80 underline-offset-2 hover:text-foreground hover:underline"
					>
						Proof of track record
					</a>
				)}
			</div>
		</div>
	);
}

/** The owner picks the skills they claim; operator-verified and earned skills stay as they are. */
function SkillsEditor({ profile }: { profile: ScoutPublicProfile }) {
	const trpc = useTRPC();
	const qc = useQueryClient();
	const own = (profile.skills ?? [])
		.filter((s) => s.source === "self" || s.source === "seeded")
		.map((s) => s.skill.toLowerCase());
	const [open, setOpen] = useState(false);
	const [picked, setPicked] = useState<string[]>(own);
	const save = useMutation(
		trpc.me.setSkills.mutationOptions({
			onSuccess: () => {
				setOpen(false);
				toast.success("Skills saved");
				void qc.invalidateQueries();
			},
		}),
	);
	const choices = [...new Set([...SKILL_CHOICES, ...own])];
	if (!open)
		return (
			<button
				type="button"
				onClick={() => {
					setPicked(own);
					setOpen(true);
				}}
				className="type-label text-primary underline-offset-4 hover:underline"
			>
				Edit your skills
			</button>
		);
	return (
		<div className="space-y-4 rounded-3xl bg-card p-5 text-left ring-1 ring-foreground/5">
			<p className="type-label text-muted-foreground">
				Pick what you can do. Gigs that need a skill show up for you when you have it.
			</p>
			<div className="flex flex-wrap gap-2">
				{choices.map((tag) => {
					const on = picked.includes(tag);
					return (
						<button
							key={tag}
							type="button"
							aria-pressed={on}
							onClick={() => setPicked((list) => (on ? list.filter((x) => x !== tag) : [...list, tag]))}
							className={cn(
								"inline-flex items-center gap-1 rounded-full px-3 py-1.5 type-label ring-1 ring-inset transition-colors",
								on
									? "bg-accent text-accent-foreground ring-primary/30"
									: "text-muted-foreground ring-border hover:bg-muted",
							)}
						>
							{on && <Check className="size-3.5" />}
							{skillName(tag)}
						</button>
					);
				})}
			</div>
			{save.isError && <p className="type-label text-destructive">{errorMessage(save.error)}</p>}
			<div className="flex gap-2">
				<Button size="sm" onClick={() => save.mutate({ skills: picked })} disabled={save.isPending}>
					{save.isPending && <Loader2 className="animate-spin" />}
					Save
				</Button>
				<Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
					Cancel
				</Button>
			</div>
		</div>
	);
}
