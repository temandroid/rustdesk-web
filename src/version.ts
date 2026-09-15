import versionJson from "./proto/version.json";

// Peers gate features on LoginRequest.version, so this must track the Rust
// crate version of the tree the protos were generated from (Cargo.toml).
export const VERSION: string = versionJson.version;

// Port of hbb_common::get_version_number.
// 1.1.10 -> 1001100, 1.2.3 -> 1002030 (last component x10 leaves room for a
// "-N" patch suffix, which is added on top).
export function getVersionNumber(v: string): number {
  const parts = v.split("-");
  let n = 0;
  const head = parts[0];
  if (head !== undefined) {
    let last = 0;
    for (const x of head.split(".")) {
      const p = parseInt(x, 10);
      last = Number.isFinite(p) ? p : 0;
      n = n * 1000 + last;
    }
    n -= last;
    n += last * 10;
  }
  const patch = parts[1];
  if (patch !== undefined) {
    const p = parseInt(patch, 10);
    n += Number.isFinite(p) ? p : 0;
  }
  return n;
}

export function isSupportMultiUiSession(peerVersion: string): boolean {
  return getVersionNumber(peerVersion) > getVersionNumber("1.2.4");
}
