/**
 * What a recruiter needs before committing to a gig: the role (must-haves, deal-breakers, salary, place) and
 * where the money goes (what the company pays, the service fee, the operator's cut, and the part held back).
 */
import { Disclosure } from "@/components/bits";
import { JobPost, locationText, salaryText } from "@/components/role-draft/job-post";
import { firstName, formatMoney } from "@/lib/format";
import type { GigView } from "@/lib/gigs/schemas";

type Post = NonNullable<GigView["post"]>;

const SENIORITY: Record<Post["seniority"], string> = {
	JUNIOR: "Junior",
	MID: "Mid-level",
	SENIOR: "Senior",
	STAFF: "Staff",
	PRINCIPAL: "Principal",
	EXECUTIVE: "Executive",
};

const locationOf = (post: Post) => ({
	mode: post.workMode,
	places: post.location ? post.location.split(/,\s*/) : [],
});

/**
 * The role, always visible: one meta line, the must-haves and the deal-breakers. Calls get the compact version
 * (must-haves in one sentence) since the script already covers them; the full post sits behind a link.
 */
export function RoleBrief({ post, compact = false }: { post: Post; compact?: boolean }) {
	const meta = [
		SENIORITY[post.seniority],
		locationText(locationOf(post)),
		salaryText(post.salaryRange),
		post.languages.length ? post.languages.join(", ") : null,
	]
		.filter(Boolean)
		.join(" · ");
	const crit = (labels: string[], prefix: string) =>
		labels.map((label, i) => ({ id: `${prefix}-${i}`, label, weight: 3 }));

	return (
		<section className="space-y-4 rounded-4xl bg-card p-6 ring-1 ring-foreground/5 sm:p-8">
			<div className="space-y-1">
				<p>
					{post.title}
					<span className="text-muted-foreground"> · {post.companyDescriptor}</span>
				</p>
				{meta && <p className="type-label text-muted-foreground">{meta}</p>}
			</div>
			{compact ? (
				<p className="text-muted-foreground">
					<span className="text-foreground">Must-haves:</span> {post.mustHave.join(", ")}.
					{post.dealBreakers.length > 0 && (
						<>
							{" "}
							<span className="text-foreground">Not a fit if:</span> {post.dealBreakers.join(", ")}.
						</>
					)}
				</p>
			) : (
				<div className="grid gap-5 sm:grid-cols-2">
					<List title="Must-haves" items={post.mustHave} />
					{post.dealBreakers.length > 0 && <List title="Not a fit if" items={post.dealBreakers} />}
				</div>
			)}
			<Disclosure label="Full job post">
				<JobPost
					data={{
						title: post.title,
						company: post.companyDescriptor,
						seniority: post.seniority,
						location: locationOf(post),
						salary: post.salaryRange,
						summary: post.summary,
						mustHave: crit(post.mustHave, "must"),
						niceToHave: crit(post.niceToHave, "nice"),
						dealBreakers: crit(post.dealBreakers, "deal"),
						languages: post.languages,
					}}
				/>
			</Disclosure>
		</section>
	);
}

function List({ title, items }: { title: string; items: string[] }) {
	return (
		<div className="space-y-2">
			<p className="type-label text-muted-foreground">{title}</p>
			<ul className="space-y-1.5">
				{items.map((x) => (
					<li key={x} className="flex gap-2">
						<span className="mt-2.5 size-1 shrink-0 rounded-full bg-muted-foreground/60" aria-hidden />
						{x}
					</li>
				))}
			</ul>
		</div>
	);
}

/** "within 14 days" / "within 20 minutes" for the held-back part. */
function within(seconds: number | undefined) {
	if (!seconds) return null;
	if (seconds >= 2 * 86_400) return `within ${Math.round(seconds / 86_400)} days`;
	if (seconds >= 7_200) return `within ${Math.round(seconds / 3_600)} hours`;
	return `within ${Math.max(1, Math.round(seconds / 60))} minutes`;
}

/**
 * Where the money goes, under "Earn $X": when each part is paid, and what the company pays before the service fee
 * and the operator's cut. The held-back part is paid after a waiting period, sooner if the candidate is interviewed;
 * it only goes back to the company if the work turns out to be made up.
 */
export function PayBreakdown({
	gig,
	now,
	later,
	operator,
}: {
	gig: GigView;
	now: bigint;
	later: bigint;
	operator: { name: string; feeBps: number } | null;
}) {
	const bounty = BigInt(gig.bounty);
	const net = BigInt(gig.payout.now) + BigInt(gig.payout.later);
	const serviceFee = bounty - net;
	const operatorFee = operator ? (net * BigInt(operator.feeBps)) / 10_000n : 0n;
	const who = gig.candidate?.name ? firstName(gig.candidate.name) : "the candidate";
	const first =
		gig.type === "SOURCING"
			? "when the candidate confirms they're interested"
			: "when the agent accepts your notes";
	const wait = within(gig.holdbackWindowSeconds);
	return (
		<div className="space-y-2">
			{later > 0n ? (
				<p className="text-muted-foreground">
					<span className="tabular text-success">{formatMoney(now)}</span> {first}. The other{" "}
					<span className="tabular">{formatMoney(later)}</span> is paid {wait ?? "after a short wait"}, sooner
					if the company interviews {who}. It only goes back to the company if the work turns out to be made
					up.
				</p>
			) : (
				<p className="text-muted-foreground">Paid in full {first}.</p>
			)}
			<p className="type-label text-muted-foreground">
				The company pays <span className="tabular">{formatMoney(bounty)}</span>
				{serviceFee > 0n && (
					<>
						{" "}
						· service fee <span className="tabular">{formatMoney(serviceFee)}</span>
					</>
				)}
				{operatorFee > 0n && operator && (
					<>
						{" "}
						· <span className="tabular">{formatMoney(operatorFee)}</span> to {operator.name}, who vouched for
						you
					</>
				)}
			</p>
		</div>
	);
}

/** Deposit rules in one sentence, for the place it is taken. */
export function depositLine(amount: bigint) {
	return `${formatMoney(amount)} deposit per profile. You get it back when the agent accepts. If it isn't accepted or you take it back, the deposit stays with the company.`;
}
