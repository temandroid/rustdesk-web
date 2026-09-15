// libsodium primitives matching sodiumoxide usage in src/common.rs and
// hbb_common tcp.rs:
//   sign::verify            -> crypto_sign_open
//   box_::gen_keypair/seal  -> crypto_box_keypair / crypto_box_easy (zero nonce)
//   secretbox::gen_key      -> crypto_secretbox_keygen
//   secretbox::seal/open    -> crypto_secretbox_easy / _open_easy with a
//                              24-byte nonce whose first 8 bytes are a LE u64
//                              sequence counter (separate per direction).
import _sodium from "libsodium-wrappers-sumo";

type Sodium = typeof _sodium;
let sodium: Sodium | null = null;

export async function initCrypto(): Promise<void> {
  if (sodium) return;
  await _sodium.ready;
  sodium = _sodium;
}

function s(): Sodium {
  if (!sodium) throw new Error("crypto not initialised; call initCrypto() first");
  return sodium;
}

export function decodeBase64(v: string): Uint8Array {
  return s().from_base64(v, s().base64_variants.ORIGINAL);
}

export function encodeBase64(v: Uint8Array): string {
  return s().to_base64(v, s().base64_variants.ORIGINAL);
}

export function toHex(v: Uint8Array): string {
  return s().to_hex(v);
}

// Returns the message if `signed` verifies under ed25519 `pk`, else null.
export function signOpen(signed: Uint8Array, pk: Uint8Array): Uint8Array | null {
  try {
    if (pk.length !== s().crypto_sign_PUBLICKEYBYTES) return null;
    return s().crypto_sign_open(signed, pk);
  } catch {
    return null;
  }
}

export function sha256(...parts: (Uint8Array | string)[]): Uint8Array {
  const st = s().crypto_hash_sha256_init();
  for (const p of parts) {
    s().crypto_hash_sha256_update(st, typeof p === "string" ? new TextEncoder().encode(p) : p);
  }
  return s().crypto_hash_sha256_final(st);
}

export interface SymmetricKeyMsg {
  asymmetricValue: Uint8Array; // our X25519 box public key
  symmetricValue: Uint8Array; // secretbox key sealed to the peer
  key: Uint8Array; // the secretbox key we keep
}

// Port of src/common.rs create_symmetric_key_msg. The all-zero box nonce is
// what the peer expects (each session uses a fresh box keypair anyway).
export function createSymmetricKeyMsg(theirPk: Uint8Array): SymmetricKeyMsg {
  const so = s();
  if (theirPk.length !== so.crypto_box_PUBLICKEYBYTES) {
    throw new Error("peer box public key must be 32 bytes");
  }
  const pair = so.crypto_box_keypair();
  const key = so.crypto_secretbox_keygen();
  const nonce = new Uint8Array(so.crypto_box_NONCEBYTES);
  const sealed = so.crypto_box_easy(key, nonce, theirPk, pair.privateKey);
  return { asymmetricValue: pair.publicKey, symmetricValue: sealed, key };
}

export function nonceForSeq(seq: bigint, size = 24): Uint8Array {
  const n = new Uint8Array(size);
  let v = seq;
  for (let i = 0; i < 8; i++) {
    n[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return n;
}

// Port of hbb_common tcp.rs `Encrypt(Key, send_seq, recv_seq)`.
export class Encrypt {
  private sendSeq = 0n;
  private recvSeq = 0n;
  constructor(private readonly key: Uint8Array) {
    if (key.length !== s().crypto_secretbox_KEYBYTES) {
      throw new Error("secretbox key must be 32 bytes");
    }
  }

  enc(plain: Uint8Array): Uint8Array {
    this.sendSeq += 1n;
    return s().crypto_secretbox_easy(plain, nonceForSeq(this.sendSeq), this.key);
  }

  // Rust skips decryption for payloads of length <= 1 (the empty "no
  // security" probe message) and does not advance the counter for them.
  dec(cipher: Uint8Array): Uint8Array {
    if (cipher.length <= 1) return cipher;
    this.recvSeq += 1n;
    return s().crypto_secretbox_open_easy(cipher, nonceForSeq(this.recvSeq), this.key);
  }
}

// Port of src/common.rs pk_to_fingerprint: lowercase hex of the raw key with a
// space every 4 characters.
export function pkToFingerprint(pk: Uint8Array): string {
  const hex = toHex(pk);
  let out = "";
  for (let i = 0; i < hex.length; i++) {
    if (i > 0 && i % 4 === 0) out += " ";
    out += hex[i];
  }
  return out;
}
