import {
	type Address,
	createKeyPairFromBytes,
	getAddressFromPublicKey,
	getBase58Encoder,
	getBase64EncodedWireTransaction,
	getBase64Encoder,
	getTransactionDecoder,
	partiallySignTransaction,
	type SignatureBytes,
	type Transaction,
} from "@solana/kit";

export function decodeWireTransaction(base64Tx: string): Transaction {
	return getTransactionDecoder().decode(getBase64Encoder().encode(base64Tx));
}

export function wireBytes(base64Tx: string) {
	return new Uint8Array(getBase64Encoder().encode(base64Tx));
}

/** Accepts a base58 secret key or a JSON byte array (solana-keygen format). */
export async function keyPairFromSecret(secret: string) {
	const trimmed = secret.trim();
	const bytes = trimmed.startsWith("[")
		? new Uint8Array(JSON.parse(trimmed) as number[])
		: new Uint8Array(getBase58Encoder().encode(trimmed));
	const keyPair = await createKeyPairFromBytes(bytes);
	const address = await getAddressFromPublicKey(keyPair.publicKey);
	return { keyPair, address };
}

export async function signWithKeyPair(base64Tx: string, keyPair: CryptoKeyPair) {
	const signed = await partiallySignTransaction([keyPair], decodeWireTransaction(base64Tx));
	return getBase64EncodedWireTransaction(signed);
}

/**
 * Wallets either return the whole signed transaction or just the 64-byte signature
 * (sign-only embedded wallets). Normalise both into a base64 wire transaction.
 */
export function mergeWalletSignature(base64Tx: string, result: Uint8Array, signer: Address) {
	if (result.length === 64) {
		const tx = decodeWireTransaction(base64Tx);
		return getBase64EncodedWireTransaction({
			...tx,
			signatures: { ...tx.signatures, [signer]: result as SignatureBytes },
		});
	}
	return getBase64EncodedWireTransaction(getTransactionDecoder().decode(result));
}
