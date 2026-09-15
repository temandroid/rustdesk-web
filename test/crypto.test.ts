import { beforeAll, describe, expect, it } from "vitest";
import _sodium from "libsodium-wrappers-sumo";
import { Encrypt, createSymmetricKeyMsg, initCrypto, nonceForSeq, pkToFingerprint, sha256, signOpen } from "../src/crypto";

beforeAll(async () => {
  await initCrypto();
});

describe("nonce layout (hbb_common tcp.rs get_nonce)", () => {
  it("puts the LE u64 counter in the first 8 bytes", () => {
    const n = nonceForSeq(1n);
    expect(n.length).toBe(24);
    expect(Array.from(n.subarray(0, 8))).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(Array.from(n.subarray(8))).toEqual(new Array(16).fill(0));
    const big = nonceForSeq(0x0102030405060708n);
    expect(Array.from(big.subarray(0, 8))).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
  });
});

describe("Encrypt", () => {
  it("round-trips with independent send/recv counters starting at 1", () => {
    const key = _sodium.crypto_secretbox_keygen();
    const a = new Encrypt(key);
    const b = new Encrypt(key);
    const m1 = new TextEncoder().encode("hello");
    const m2 = new TextEncoder().encode("world");
    const c1 = a.enc(m1);
    const c2 = a.enc(m2);
    // manual check of the nonce used for the first message
    expect(Array.from(_sodium.crypto_secretbox_open_easy(c1, nonceForSeq(1n), key))).toEqual(Array.from(m1));
    expect(Array.from(b.dec(c1))).toEqual(Array.from(m1));
    expect(Array.from(b.dec(c2))).toEqual(Array.from(m2));
    // reply direction starts at 1 again
    const r = b.enc(m2);
    expect(Array.from(a.dec(r))).toEqual(Array.from(m2));
  });

  it("passes through 0/1-byte payloads without touching the counter", () => {
    const key = _sodium.crypto_secretbox_keygen();
    const a = new Encrypt(key);
    const b = new Encrypt(key);
    expect(b.dec(new Uint8Array()).length).toBe(0);
    const c = a.enc(new Uint8Array([9]));
    expect(Array.from(b.dec(c))).toEqual([9]);
  });
});

describe("createSymmetricKeyMsg (src/common.rs)", () => {
  it("seals the secretbox key with a zero box nonce the peer can open", () => {
    const peer = _sodium.crypto_box_keypair();
    const { asymmetricValue, symmetricValue, key } = createSymmetricKeyMsg(peer.publicKey);
    const nonce = new Uint8Array(_sodium.crypto_box_NONCEBYTES);
    const opened = _sodium.crypto_box_open_easy(symmetricValue, nonce, asymmetricValue, peer.privateKey);
    expect(Array.from(opened)).toEqual(Array.from(key));
    expect(key.length).toBe(32);
  });
});

describe("signOpen", () => {
  it("verifies ed25519 signed blobs and rejects wrong keys", () => {
    const kp = _sodium.crypto_sign_keypair();
    const other = _sodium.crypto_sign_keypair();
    const msg = new TextEncoder().encode("id-pk");
    const signed = _sodium.crypto_sign(msg, kp.privateKey);
    expect(Array.from(signOpen(signed, kp.publicKey)!)).toEqual(Array.from(msg));
    expect(signOpen(signed, other.publicKey)).toBeNull();
    expect(signOpen(signed, new Uint8Array(5))).toBeNull();
  });
});

describe("sha256 password hashing", () => {
  it("matches SHA256(SHA256(pw||salt)||challenge)", () => {
    const p1 = sha256("pw", "salt");
    const p2 = sha256(p1, "challenge");
    const ref1 = _sodium.crypto_hash_sha256(new TextEncoder().encode("pwsalt"));
    const cat = new Uint8Array(ref1.length + 9);
    cat.set(ref1);
    cat.set(new TextEncoder().encode("challenge"), ref1.length);
    expect(Array.from(p1)).toEqual(Array.from(ref1));
    expect(Array.from(p2)).toEqual(Array.from(_sodium.crypto_hash_sha256(cat)));
  });
});

describe("pkToFingerprint", () => {
  it("groups lowercase hex in blocks of four", () => {
    expect(pkToFingerprint(new Uint8Array([0xab, 0xcd, 0xef, 0x01, 0x23]))).toBe("abcd ef01 23");
  });
});
