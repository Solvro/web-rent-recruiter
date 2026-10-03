/**
 * The job post a role turns into: what the company reviews before starting its agent, and what recruiters read on
 * the gig board. Pass `reveal` to show it assembling field by field (placeholders until a field resolves); leave it
 * out to render the finished post. Pass `edit` to make it editable in place.
 *
 * The DOM is the same in every mode: editing only adds affordances (text becomes editable on click, remove on hover)
 * into space that is always reserved, so a post that finishes streaming and becomes editable never moves.
 */
import type { Criteria, Criterion } from "@scout/shared";
import { X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { cn } from "@/lib/utils";
import "./role-draft.css";

export type JobPostData = {
	title?: string;
	company?: string;
	seniority?: Criteria["seniority"];
	location?: Partial<Criteria["location"]>;
	/** null = the job description doesn't state a salary. */
	salary?: Partial<NonNullable<Criteria["salaryRange"]>> | null;
	summary?: string;
	mustHave?: Criterion[];
	niceToHave?: Criterion[];
	dealBreakers?: Criterion[];
	languages?: string[];
};

export type JobPostReveal = {
	isShown: (key: string) => boolean;
	/** The field is expected but not resolved yet: show a placeholder. */
	isPending: (key: string) => boolean;
};

export type JobPostEdit = {
	onTitle: (title: string) => void;
	onCompany?: (company: string) => void;
	onCriteria: (patch: Partial<Pick<Criteria, "mustHave" | "niceToHave" | "dealBreakers">>) => void;
};

export const SENIORITY: Record<Criteria["seniority"], string> = {
	JUNIOR: "Junior",
	MID: "Mid-level",
	SENIOR: "Senior",
	STAFF: "Staff",
	PRINCIPAL: "Principal",
	EXECUTIVE: "Executive",
};
const MODE = { ONSITE: "On-site", HYBRID: "Hybrid", REMOTE: "Remote" } as const;

export function locationText(l?: Partial<Criteria["location"]>) {
	if (!l?.mode) return null;
	const places = (l.places ?? []).filter(Boolean);
	return places.length ? `${MODE[l.mode]} · ${places.join(", ")}` : MODE[l.mode];
}

const compact = (n: number) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n));
export function salaryText(s?: JobPostData["salary"]) {
	if (s === null) return "Salary not stated";
	if (!s || s.min == null || s.max == null) return null;
	const period = s.period === "YEAR" ? "year" : "month";
	return `${compact(s.min)}–${compact(s.max)} ${s.currency ?? ""} / ${period}`.replace(/\s+\//, " /");
}

/** Plain text that becomes editable on click when `onCommit` is set. Enter saves, Escape cancels. */
function EditableText({
	value,
	onCommit,
	label,
}: {
	value: string;
	onCommit?: (v: string) => void;
	label: string;
}) {
	if (!onCommit) return <>{value}</>;
	return (
		// biome-ignore lint/a11y/useSemanticElements: inline editing keeps the exact text layout of the read-only post
		<span
			role="textbox"
			tabIndex={0}
			aria-label={label}
			contentEditable="plaintext-only"
			suppressContentEditableWarning
			spellCheck={false}
			onKeyDown={(e) => {
				if (e.key === "Enter") {
					e.preventDefault();
					e.currentTarget.blur();
				} else if (e.key === "Escape") {
					e.currentTarget.textContent = value;
					e.currentTarget.blur();
				}
			}}
			onBlur={(e) => {
				const text = (e.currentTarget.textContent ?? "").replace(/\s+/g, " ").trim();
				if (!text) e.currentTarget.textContent = value;
				else if (text !== value) onCommit(text);
			}}
			className="-mx-1 cursor-text rounded-md px-1 outline-none transition-colors duration-150 ease-out hover:bg-foreground/[0.04] focus:bg-foreground/[0.06]"
		>
			{value}
		</span>
	);
}

/** Resolves from a placeholder into its value; renders nothing if the field is neither known nor expected. */
function Field({
	k,
	reveal,
	placeholder,
	children,
}: {
	k: string;
	reveal?: JobPostReveal;
	placeholder: string;
	children: ReactNode;
}) {
	if (!reveal || reveal.isShown(k)) {
		return (
			<span key={`${k}:shown`} data-field={k} className={cn(reveal && "rd-in")}>
				{children}
			</span>
		);
	}
	if (reveal.isPending(k)) return <span className={cn("rd-skel h-[0.9em]", placeholder)} aria-hidden />;
	return null;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="space-y-3">
			<h3 className="type-label text-muted-foreground">{title}</h3>
			{children}
		</section>
	);
}

const slug = (text: string, n: number) =>
	`${text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.slice(0, 40)}-${n}`;

/** One criterion per line. Editing: click a line to reword it, hover to remove, type into the last line to add. */
function Lines({
	items,
	prefix,
	label,
	weight,
	reveal,
	onChange,
}: {
	items: Criterion[];
	prefix: string;
	label: string;
	weight: number;
	reveal?: JobPostReveal;
	onChange?: (items: Criterion[]) => void;
}) {
	const [adding, setAdding] = useState("");
	const add = () => {
		const text = adding.trim();
		if (!text || !onChange) return;
		onChange([...items, { id: slug(text, items.length), label: text, weight }]);
		setAdding("");
	};
	return (
		<ul className="space-y-2">
			{items.map((c, i) => {
				const k = `${prefix}:${i}`;
				if (reveal && !reveal.isShown(k)) {
					if (!reveal.isPending(k)) return null;
					return (
						<li key={c.id || k} aria-hidden>
							<span className="rd-skel h-[0.9em] w-[min(26rem,80%)]" />
						</li>
					);
				}
				return (
					<li
						key={c.id || k}
						data-field={k}
						className={cn("group relative flex gap-3 pr-8", reveal && "rd-in")}
					>
						<span className="mt-[0.65em] size-1 shrink-0 rounded-full bg-foreground/40" aria-hidden />
						<span className="min-w-0">
							<EditableText
								value={c.label}
								label={`Edit ${label}`}
								onCommit={
									onChange &&
									((text) => onChange(items.map((x) => (x.id === c.id ? { ...x, label: text } : x))))
								}
							/>
						</span>
						{onChange && (
							<button
								type="button"
								aria-label={`Remove ${c.label}`}
								onClick={() => onChange(items.filter((x) => x.id !== c.id))}
								className="absolute top-0.5 right-0 grid size-6 place-items-center rounded-full text-muted-foreground opacity-0 transition-opacity duration-150 ease-out hover:bg-foreground/[0.06] hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
							>
								<X className="size-3.5" />
							</button>
						)}
					</li>
				);
			})}
			{/* Always laid out, only usable once editable: the post doesn't grow when streaming ends. */}
			<li className={cn("flex gap-3 pr-8", !onChange && "invisible")} aria-hidden={!onChange}>
				<span className="mt-[0.65em] size-1 shrink-0 rounded-full border border-foreground/30" aria-hidden />
				<input
					value={adding}
					onChange={(e) => setAdding(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && add()}
					onBlur={add}
					disabled={!onChange}
					tabIndex={onChange ? 0 : -1}
					placeholder="Add…"
					aria-label={`Add ${label}`}
					className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground/60"
				/>
			</li>
		</ul>
	);
}

export function JobPost({
	data,
	reveal,
	edit,
	className,
}: {
	data: JobPostData;
	reveal?: JobPostReveal;
	edit?: JobPostEdit;
	className?: string;
}) {
	const meta = [
		{ k: "seniority", text: data.seniority ? SENIORITY[data.seniority] : null, w: "w-14" },
		{ k: "location", text: locationText(data.location), w: "w-28" },
		{ k: "salary", text: salaryText(data.salary), w: "w-32" },
	].filter((m) => (reveal ? reveal.isShown(m.k) || reveal.isPending(m.k) : m.text));
	const must = data.mustHave ?? [];
	const nice = data.niceToHave ?? [];
	const deal = data.dealBreakers ?? [];
	const languages = data.languages ?? [];
	const showLanguages = !reveal || reveal.isShown("languages");
	/** Is anything of this field (or list) on screen yet, resolved or as a placeholder? */
	const visible = (k: string) => !reveal || reveal.isShown(k) || reveal.isPending(k);
	const anyOf = (items: Criterion[], prefix: string) => items.some((_, i) => visible(`${prefix}:${i}`));

	return (
		<article className={cn("space-y-8", className)}>
			<header className="space-y-3">
				{(data.company || edit?.onCompany) && (
					<p className="text-muted-foreground">
						{edit?.onCompany ? (
							<EditableText value={data.company ?? ""} label="Company" onCommit={edit.onCompany} />
						) : (
							data.company
						)}
					</p>
				)}
				{visible("title") && (
					<h2 className="type-display">
						<Field k="title" reveal={reveal} placeholder="w-[min(22rem,90%)] h-[1em]">
							<EditableText value={data.title ?? ""} label="Role title" onCommit={edit?.onTitle} />
						</Field>
					</h2>
				)}
				{/* While assembling, the row is reserved: seniority/location/salary resolve late and must not push the post down. */}
				{(meta.length > 0 || reveal) && (
					<p
						className={cn(
							"flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground",
							reveal && "min-h-[1.5em]",
						)}
					>
						{meta.map((m, i) => (
							<span key={m.k} className="inline-flex items-center gap-3">
								{i > 0 && (!reveal || reveal.isShown(m.k)) && <span aria-hidden>·</span>}
								<Field k={m.k} reveal={reveal} placeholder={m.w}>
									{m.text}
								</Field>
							</span>
						))}
					</p>
				)}
			</header>

			{visible("summary") && (data.summary !== undefined || reveal?.isPending("summary")) && (
				<p className="max-w-prose">
					<Field k="summary" reveal={reveal} placeholder="h-[0.9em] w-full">
						{data.summary}
					</Field>
				</p>
			)}

			{anyOf(must, "must") && (
				<Section title="What you'll need">
					<Lines
						items={must}
						prefix="must"
						label="must-have"
						weight={4}
						reveal={reveal}
						onChange={edit && ((mustHave) => edit.onCriteria({ mustHave }))}
					/>
				</Section>
			)}

			{anyOf(nice, "nice") && (
				<Section title="Nice to have">
					<Lines
						items={nice}
						prefix="nice"
						label="nice-to-have"
						weight={2}
						reveal={reveal}
						onChange={edit && ((niceToHave) => edit.onCriteria({ niceToHave }))}
					/>
				</Section>
			)}

			{anyOf(deal, "deal") && (
				<Section title="Not a fit if">
					<Lines
						items={deal}
						prefix="deal"
						label="deal-breaker"
						weight={5}
						reveal={reveal}
						onChange={edit && ((dealBreakers) => edit.onCriteria({ dealBreakers }))}
					/>
				</Section>
			)}

			{languages.length > 0 && showLanguages && (
				<div data-field="languages" className={cn(reveal && "rd-in")}>
					<Section title="Languages">
						<p>{languages.join(", ")}</p>
					</Section>
				</div>
			)}
		</article>
	);
}
