# Vendored protos

- `rendezvous.proto`: copied from https://github.com/rustdesk/hbb_common (branch master, fetched 2026-09-10).
  The `libs/hbb_common` submodule in the sibling `rustdesk-master` checkout is empty, so it is vendored here.
- `message.proto`: NOT vendored. `npm run gen-proto` copies it from
  `../rustdesk-master/libs/base/protos/message.proto` at build time so it always matches the client tree.

Both are proto3, package `hbb`, no imports.
