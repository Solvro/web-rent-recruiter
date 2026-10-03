import { createFileRoute } from "@tanstack/react-router";
import { Link2 } from "lucide-react";
import { toast } from "sonner";
import { PageSkeleton } from "@/components/account";
import { EmptyState } from "@/components/bits";
import { Avatar } from "@/components/person";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/format";
import { useScout } from "@/lib/queries";
import { skillName, skillSource, standing, TYPE_WORD } from "@/lib/reputation";

/** Public recruiter profile at /r/<slug>, resolved by the API on any device. */
export const Route = createFileRoute("/r/$slug")({
	component: () => {
		const { slug } = Route.useParams();
		return <PublicProfile slug={slug} />;
	},
});

function PublicProfile({ slug }: { slug: string }) {
	const scout = useScout({ slug });
	if (scout.isPending) return <PageSkeleton />;
	if (scout.isError) return <EmptyState title="We couldn't find this recruiter." />;
	const p = scout.data;
	const { accepted, rejected, totalEarned } = p.reputation;

	const share = async () => {
		try {
			await navigator.clipboard.writeText(`${location.origin}/r/${slug}`);
			toast.success("Link copied");
		} catch {
			toast(`${location.origin}/r/${slug}`);
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
			{p.skills && p.skills.length > 0 && (
				<div className="w-full space-y-2">
					<p className="type-label text-muted-foreground">Skills</p>
					<ul className="flex flex-wrap justify-center gap-1.5">
						{p.skills.map((sk) => {
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
				</div>
			)}
			{p.score?.seededHistory && (
				<p className="type-label text-muted-foreground">Part of this history is demo data.</p>
			)}
			<Button variant="ghost" onClick={share}>
				<Link2 /> Copy link
			</Button>
		</div>
	);
}
