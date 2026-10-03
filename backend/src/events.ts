import { EventEmitter } from "node:events";

export type LiveEvent = {
	type:
		| "role.updated"
		| "submission.created"
		| "submission.reviewed"
		| "submission.accepted"
		| "submission.rejected"
		| "role.closed";
	roleId?: string;
	submissionId?: string;
	signature?: string;
	/** Scout wallet, so the scout app can toast "payout arrived" only for its own submissions. */
	scout?: string;
	payout?: string;
};

const bus = new EventEmitter();
bus.setMaxListeners(0);

export const publish = (e: LiveEvent) => bus.emit("event", e);
export function subscribe(fn: (e: LiveEvent) => void) {
	bus.on("event", fn);
	return () => bus.off("event", fn);
}
