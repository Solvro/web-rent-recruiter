import { createFileRoute } from "@tanstack/react-router";
import { BadgeCheck, Share2 } from "lucide-react";
import { toast } from "sonner";
import { PageSkeleton } from "@/components/account";
import { EmptyState, Stat, StatusBadge } from "@/components/bits";
import { ExplorerLink } from "@/components/explorer-link";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { errorMessage } from "@/lib/api";
import { formatUsdc, initials, timeAgo } from "@/lib/format";
import { useScout } from "@/lib/queries";

export const Route = createFileRoute("/scouts/$pubkey")({
	component: () => {
		const { pubkey } = Route.useParams();
		return <ScoutProfile pubkey={pubkey} />;
	},
});

function ScoutProfile({ pubkey }: { pubkey: string }) {
	const scout = useScout(pubkey);
	if (scout.isPending) return <PageSkeleton />;
	if (scout.isError) return <EmptyState title="Scout not found">{errorMessage(scout.error)}</EmptyState>;
	const p = scout.data;
	const { accepted, submitted, rejected, totalEarned } = p.reputation;
	const decided = accepted + rejected;
	const rate = decided ? Math.round((accepted / decided) * 100) : null;

	const share = async () => {
		try {
			await navigator.clipboard.writeText(location.href);
			toast.success("Profile link copied");
		} catch {
			toast(location.href);
		}
	};

	return (
		<div className="mx-auto max-w-3xl space-y-6">
			<Card>
				<CardContent className="flex flex-col gap-6 sm:flex-row sm:items-center">
					<Avatar className="size-16">
						<AvatarFallback className="bg-accent text-lg text-accent-foreground">
							{initials(p.displayName)}
						</AvatarFallback>
					</Avatar>
					<div className="flex-1 space-y-1">
						<h1 className="text-2xl font-semibold tracking-tight">{p.displayName}</h1>
						<p className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
							<BadgeCheck className="size-4 text-success" />
							Independent scout · track record recorded on-chain
						</p>
					</div>
					<Button variant="outline" onClick={share}>
						<Share2 /> Share
					</Button>
				</CardContent>
			</Card>
			<Card>
				<CardContent className="grid grid-cols-2 gap-6 md:grid-cols-4">
					<Stat
						label="Acceptance rate"
						value={rate === null ? "—" : `${rate}%`}
						hint={`${accepted} of ${decided} decided`}
					/>
					<Stat label="Accepted" value={accepted} />
					<Stat label="Submitted" value={submitted} />
					<Stat label="Total earned" value={formatUsdc(totalEarned)} />
				</CardContent>
			</Card>
			<Card>
				<CardHeader>
					<CardTitle className="text-base">Recent activity</CardTitle>
				</CardHeader>
				<CardContent>
					{p.recent.length ? (
						<ul className="divide-y">
							{p.recent.map((r) => (
								<li key={r.id} className="flex items-center justify-between gap-3 py-3 text-sm">
									<span className="min-w-0 truncate">{r.roleTitle}</span>
									<span className="flex shrink-0 items-center gap-3">
										<span className="text-muted-foreground">{timeAgo(r.submittedAt)}</span>
										<StatusBadge status={r.status} />
									</span>
								</li>
							))}
						</ul>
					) : (
						<p className="text-sm text-muted-foreground">No submissions yet.</p>
					)}
				</CardContent>
			</Card>
			<p className="text-center text-xs text-muted-foreground">
				These numbers are read from a public record that neither {p.displayName} nor we can edit.{" "}
				<ExplorerLink address={p.profileAddress}>Verify</ExplorerLink>
			</p>
		</div>
	);
}
