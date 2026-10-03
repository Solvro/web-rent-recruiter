/**
 * Minimal Anchor IDL (spec 0.1.0) reader + Borsh codec.
 *
 * The backend reads the IDL at runtime instead of relying on hand-written layouts, so it keeps working while the
 * program evolves: instruction data, account data and events are all encoded/decoded from the IDL.
 */
import { existsSync, readFileSync } from "node:fs";
import { getAddressDecoder, getAddressEncoder } from "@solana/kit";
import { env } from "../env.ts";

export type IdlType =
	| "bool"
	| "u8"
	| "i8"
	| "u16"
	| "i16"
	| "u32"
	| "i32"
	| "u64"
	| "i64"
	| "u128"
	| "i128"
	| "string"
	| "bytes"
	| "pubkey"
	| { option: IdlType }
	| { vec: IdlType }
	| { array: [IdlType, number] }
	| { defined: { name: string } };

type IdlField = { name: string; type: IdlType };
type IdlTypeDef = {
	name: string;
	type:
		| { kind: "struct"; fields?: IdlField[] }
		| { kind: "enum"; variants: { name: string; fields?: IdlField[] | IdlType[] }[] };
};
export type IdlSeed =
	| { kind: "const"; value: number[] }
	| { kind: "arg"; path: string }
	| { kind: "account"; path: string; account?: string };
export type IdlInstructionAccount = {
	name: string;
	writable?: boolean;
	signer?: boolean;
	optional?: boolean;
	address?: string;
	pda?: { seeds: IdlSeed[]; program?: IdlSeed };
};
export type IdlInstruction = {
	name: string;
	discriminator: number[];
	accounts: IdlInstructionAccount[];
	args: IdlField[];
};
export type Idl = {
	address: string;
	instructions: IdlInstruction[];
	accounts?: { name: string; discriminator: number[] }[];
	events?: { name: string; discriminator: number[] }[];
	types?: IdlTypeDef[];
	errors?: { code: number; name: string; msg?: string }[];
};

let cached: { idl: Idl; path: string } | null = null;

export function loadIdl(): Idl | null {
	if (cached) return cached.idl;
	for (const path of env.idlPaths) {
		if (existsSync(path)) {
			cached = { idl: JSON.parse(readFileSync(path, "utf8")) as Idl, path };
			return cached.idl;
		}
	}
	return null;
}

export function requireIdl(): Idl {
	const idl = loadIdl();
	if (!idl)
		throw new Error(`Scout IDL not found. Run \`pnpm build\` (looked in: ${env.idlPaths.join(", ")})`);
	return idl;
}

// ---- Borsh ----------------------------------------------------------------

const addressEncoder = getAddressEncoder();
const addressDecoder = getAddressDecoder();

export class BorshWriter {
	private chunks: Uint8Array[] = [];
	bytes(b: Uint8Array) {
		this.chunks.push(b);
	}
	int(value: bigint | number, size: number, signed: boolean) {
		const buf = new Uint8Array(size);
		const view = new DataView(buf.buffer);
		const v = BigInt(value);
		if (size === 1) signed ? view.setInt8(0, Number(v)) : view.setUint8(0, Number(v));
		else if (size === 2) signed ? view.setInt16(0, Number(v), true) : view.setUint16(0, Number(v), true);
		else if (size === 4) signed ? view.setInt32(0, Number(v), true) : view.setUint32(0, Number(v), true);
		else if (size === 8) signed ? view.setBigInt64(0, v, true) : view.setBigUint64(0, v, true);
		else {
			const mask = (1n << 64n) - 1n;
			const n = signed && v < 0n ? (1n << 128n) + v : v;
			view.setBigUint64(0, n & mask, true);
			view.setBigUint64(8, n >> 64n, true);
		}
		this.chunks.push(buf);
	}
	finish(): Uint8Array {
		const len = this.chunks.reduce((n, c) => n + c.length, 0);
		const out = new Uint8Array(len);
		let o = 0;
		for (const c of this.chunks) {
			out.set(c, o);
			o += c.length;
		}
		return out;
	}
}

export class BorshReader {
	offset = 0;
	private view: DataView;
	constructor(private buf: Uint8Array) {
		this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	}
	bytes(n: number) {
		const out = this.buf.subarray(this.offset, this.offset + n);
		this.offset += n;
		return out;
	}
	int(size: number, signed: boolean): bigint | number {
		const o = this.offset;
		this.offset += size;
		if (size === 1) return signed ? this.view.getInt8(o) : this.view.getUint8(o);
		if (size === 2) return signed ? this.view.getInt16(o, true) : this.view.getUint16(o, true);
		if (size === 4) return signed ? this.view.getInt32(o, true) : this.view.getUint32(o, true);
		if (size === 8) return signed ? this.view.getBigInt64(o, true) : this.view.getBigUint64(o, true);
		const lo = this.view.getBigUint64(o, true);
		const hi = this.view.getBigUint64(o + 8, true);
		const n = (hi << 64n) | lo;
		return signed && hi >> 63n ? n - (1n << 128n) : n;
	}
}

const INT_SIZES: Record<string, [number, boolean]> = {
	u8: [1, false],
	i8: [1, true],
	u16: [2, false],
	i16: [2, true],
	u32: [4, false],
	i32: [4, true],
	u64: [8, false],
	i64: [8, true],
	u128: [16, false],
	i128: [16, true],
};

const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

function typeDef(idl: Idl, name: string): IdlTypeDef {
	const def = idl.types?.find((t) => t.name === name);
	if (!def) throw new Error(`IDL type ${name} not found`);
	return def;
}

/** Values use camelCase keys; enums are `{ __kind: "Variant" }` or just the variant name for unit variants. */
export function encodeType(idl: Idl, w: BorshWriter, type: IdlType, value: unknown): void {
	if (typeof type === "string") {
		if (type in INT_SIZES) {
			const [size, signed] = INT_SIZES[type];
			w.int(value as bigint | number, size, signed);
			return;
		}
		if (type === "bool") {
			w.int(value ? 1 : 0, 1, false);
			return;
		}
		if (type === "pubkey") {
			w.bytes(new Uint8Array(addressEncoder.encode(value as never)));
			return;
		}
		if (type === "string" || type === "bytes") {
			const b = type === "string" ? new TextEncoder().encode(value as string) : (value as Uint8Array);
			w.int(b.length, 4, false);
			w.bytes(b);
			return;
		}
		throw new Error(`unsupported IDL type ${type}`);
	}
	if ("option" in type) {
		if (value === null || value === undefined) {
			w.int(0, 1, false);
			return;
		}
		w.int(1, 1, false);
		encodeType(idl, w, type.option, value);
		return;
	}
	if ("vec" in type) {
		const arr = value as unknown[];
		w.int(arr.length, 4, false);
		for (const v of arr) encodeType(idl, w, type.vec, v);
		return;
	}
	if ("array" in type) {
		const [inner, len] = type.array;
		const arr = value as ArrayLike<unknown>;
		if (arr.length !== len) throw new Error(`expected array of ${len}, got ${arr.length}`);
		if (inner === "u8") {
			w.bytes(Uint8Array.from(arr as ArrayLike<number>));
			return;
		}
		for (let i = 0; i < len; i++) encodeType(idl, w, inner, arr[i]);
		return;
	}
	const def = typeDef(idl, type.defined.name);
	if (def.type.kind === "struct") {
		const obj = value as Record<string, unknown>;
		for (const f of def.type.fields ?? []) encodeType(idl, w, f.type, obj[camel(f.name)] ?? obj[f.name]);
		return;
	}
	const kind = typeof value === "string" ? value : (value as { __kind: string }).__kind;
	const idx = def.type.variants.findIndex((v) => v.name === kind);
	if (idx < 0) throw new Error(`unknown variant ${kind} for ${def.name}`);
	w.int(idx, 1, false);
	const variant = def.type.variants[idx];
	const obj = value as Record<string, unknown>;
	for (const [i, f] of (variant.fields ?? []).entries()) {
		if (typeof f === "object" && f !== null && "name" in f) encodeType(idl, w, f.type, obj[camel(f.name)]);
		else encodeType(idl, w, f as IdlType, (obj.fields as unknown[])[i]);
	}
}

export function decodeType(idl: Idl, r: BorshReader, type: IdlType): unknown {
	if (typeof type === "string") {
		if (type in INT_SIZES) {
			const [size, signed] = INT_SIZES[type];
			return r.int(size, signed);
		}
		if (type === "bool") return r.int(1, false) === 1;
		if (type === "pubkey") return addressDecoder.decode(r.bytes(32));
		if (type === "string") return new TextDecoder().decode(r.bytes(Number(r.int(4, false))));
		if (type === "bytes") return r.bytes(Number(r.int(4, false)));
		throw new Error(`unsupported IDL type ${type}`);
	}
	if ("option" in type) return r.int(1, false) === 1 ? decodeType(idl, r, type.option) : null;
	if ("vec" in type) {
		const n = Number(r.int(4, false));
		return Array.from({ length: n }, () => decodeType(idl, r, type.vec));
	}
	if ("array" in type) {
		const [inner, len] = type.array;
		if (inner === "u8") return Uint8Array.from(r.bytes(len));
		return Array.from({ length: len }, () => decodeType(idl, r, inner));
	}
	const def = typeDef(idl, type.defined.name);
	if (def.type.kind === "struct") {
		const out: Record<string, unknown> = {};
		for (const f of def.type.fields ?? []) out[camel(f.name)] = decodeType(idl, r, f.type);
		return out;
	}
	const variant = def.type.variants[Number(r.int(1, false))];
	if (!variant) throw new Error(`bad enum discriminant for ${def.name}`);
	if (!variant.fields?.length) return variant.name;
	const out: Record<string, unknown> = { __kind: variant.name };
	for (const f of variant.fields) {
		if (typeof f === "object" && f !== null && "name" in f) out[camel(f.name)] = decodeType(idl, r, f.type);
	}
	return out;
}

const eq8 = (a: Uint8Array, b: number[]) => b.every((x, i) => a[i] === x);

/** Decode program-owned account data by its 8-byte discriminator. */
export function decodeAccount<T = Record<string, unknown>>(
	idl: Idl,
	name: string,
	data: Uint8Array,
): T | null {
	const acc = idl.accounts?.find((a) => a.name === name);
	if (!acc || !eq8(data, acc.discriminator)) return null;
	return decodeType(idl, new BorshReader(data.subarray(8)), { defined: { name } }) as T;
}

/** Decode an Anchor event emitted via `emit!` (log line `Program data: <base64>`). */
export function decodeEvent(
	idl: Idl,
	data: Uint8Array,
): { name: string; data: Record<string, unknown> } | null {
	for (const ev of idl.events ?? []) {
		if (eq8(data, ev.discriminator)) {
			const decoded = decodeType(idl, new BorshReader(data.subarray(8)), { defined: { name: ev.name } });
			return { name: ev.name, data: decoded as Record<string, unknown> };
		}
	}
	return null;
}

export function encodeInstructionData(
	idl: Idl,
	ix: IdlInstruction,
	args: Record<string, unknown>,
): Uint8Array {
	const w = new BorshWriter();
	w.bytes(Uint8Array.from(ix.discriminator));
	for (const a of ix.args) {
		const v = args[camel(a.name)] ?? args[a.name];
		if (v === undefined && !(typeof a.type === "object" && "option" in a.type)) {
			throw new Error(`missing arg ${a.name} for ${ix.name}`);
		}
		encodeType(idl, w, a.type, v ?? null);
	}
	return w.finish();
}

export function findInstruction(idl: Idl, name: string): IdlInstruction {
	const ix = idl.instructions.find((i) => i.name === name || i.name === snake(name));
	if (!ix) throw new Error(`instruction ${name} not in IDL`);
	return ix;
}

export function programErrorMessage(idl: Idl | null, code: number): string | null {
	const e = idl?.errors?.find((x) => x.code === code);
	return e ? (e.msg ?? e.name) : null;
}

export { camel, snake };
