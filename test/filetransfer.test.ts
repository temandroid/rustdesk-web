import { describe, expect, it } from "vitest";
import { create } from "@bufbuild/protobuf";
import { FileTransfer, type Fields } from "../src/filetransfer";
import {
  FileActionSchema,
  FileDirectorySchema,
  FileEntrySchema,
  FileResponseSchema,
  FileTransferDigestSchema,
  FileTransferDoneSchema,
  FileTransferSendConfirmRequestSchema,
  FileType,
  type Message,
} from "../src/proto/message_pb";

function fakeHost(peerPlatform = "Windows", peerVersion = "1.4.9") {
  const sent: Message[] = [];
  const events: { name: string; fields: Fields }[] = [];
  const host = {
    emit: (name: string, fields: Fields) => void events.push({ name, fields }),
    send: (m: Message) => void sent.push(m),
    bufferedAmount: () => 0,
    peerPlatform: () => peerPlatform,
    peerVersion: () => peerVersion,
  };
  return { host, sent, events };
}

const action = (m: Message) => (m.union.case === "fileAction" ? m.union.value.union : null);
const response = (m: Message) => (m.union.case === "fileResponse" ? m.union.value.union : null);

describe("file transfer", () => {
  it("browses and emits file_dir with Windows names normalised", () => {
    const { host, sent, events } = fakeHost();
    const ft = new FileTransfer(host);
    ft.readRemoteDir("C:\\Users", true);
    expect(action(sent[0]!)?.case).toBe("readDir");
    const fd = create(FileDirectorySchema, {
      id: 0,
      path: "C:\\Users",
      entries: [
        create(FileEntrySchema, { entryType: FileType.Dir, name: "a\\b", size: 0n, modifiedTime: 5n }),
        create(FileEntrySchema, { entryType: FileType.File, name: "f.txt", size: 12n, modifiedTime: 7n }),
      ],
    });
    const r = create(FileResponseSchema, {});
    r.union = { case: "dir", value: fd };
    ft.handleResponse(r);
    expect(events[0]!.name).toBe("file_dir");
    expect(events[0]!.fields["is_local"]).toBe("false");
    const v = JSON.parse(events[0]!.fields["value"]!);
    expect(v).toEqual({
      id: 0,
      path: "C:\\Users",
      entries: [
        { entry_type: 0, name: "a/b", size: 0, modified_time: 5 },
        { entry_type: 4, name: "f.txt", size: 12, modified_time: 7 },
      ],
    });
  });

  it("answers download digests with offset 0 and passes done/error through", () => {
    const { host, sent, events } = fakeHost();
    const ft = new FileTransfer(host);
    // no picker in node: startDownload falls back to blob mode
    return ft.startDownload(7, "C:\\x\\file.bin", false, false).then(() => {
      expect(action(sent[0]!)?.case).toBe("send");
      const dg = create(FileResponseSchema, {});
      dg.union = { case: "digest", value: create(FileTransferDigestSchema, { id: 7, fileNum: 0, fileSize: 3n }) };
      ft.handleResponse(dg);
      const c = action(sent[1]!);
      expect(c?.case).toBe("sendConfirm");
      if (c?.case === "sendConfirm") expect(c.value.union).toEqual({ case: "offsetBlk", value: 0 });
      const err = create(FileResponseSchema, {});
      err.union = { case: "error", value: { $typeName: "hbb.FileTransferError", id: 7, error: "boom", fileNum: 0 } };
      ft.handleResponse(err);
      expect(events.at(-1)).toEqual({ name: "job_error", fields: { id: "7", err: "boom", file_num: "0" } });
    });
  });

  it("uploads a File as receive + digest, then blocks and done after confirm", async () => {
    const { host, sent, events } = fakeHost();
    const ft = new FileTransfer(host);
    const file = new File([new Uint8Array(300 * 1024)], "big.bin", { lastModified: 1_700_000_000_000 });
    ft.startUpload(3, file, "C:\\dest\\big.bin");
    const recv = action(sent[0]!);
    expect(recv?.case).toBe("receive");
    if (recv?.case === "receive") {
      expect(recv.value.path).toBe("C:\\dest\\big.bin");
      expect(recv.value.files[0]!.name).toBe("");
      expect(recv.value.totalSize).toBe(BigInt(300 * 1024));
    }
    const dg = response(sent[1]!);
    expect(dg?.case).toBe("digest");
    if (dg?.case === "digest") expect(dg.value.lastModified).toBe(1_700_000_000n);
    expect(events[0]!.name).toBe("update_folder_files");
    // peer: go ahead from byte 0
    const a = create(FileActionSchema, {});
    const confirm = create(FileTransferSendConfirmRequestSchema, { id: 3, fileNum: 0 });
    confirm.union = { case: "offsetBlk", value: 0 };
    a.union = { case: "sendConfirm", value: confirm };
    ft.handleAction(a);
    await new Promise((r) => setTimeout(r, 50));
    const blocks = sent.slice(2).map(response).filter((x) => x?.case === "block");
    // 300 KiB -> 2 full 128 KiB blocks + 44 KiB + empty EOF marker
    expect(blocks.length).toBe(4);
    expect(blocks[3]!.case === "block" && blocks[3]!.value.data.length).toBe(0);
    const last = response(sent.at(-1)!);
    expect(last?.case).toBe("done");
    // peer echoes done -> job_done
    const echo = create(FileResponseSchema, {});
    echo.union = { case: "done", value: create(FileTransferDoneSchema, { id: 3, fileNum: 1 }) };
    ft.handleResponse(echo);
    expect(events.at(-1)).toEqual({ name: "job_done", fields: { id: "3", file_num: "1" } });
    ft.close();
  });

  it("skips an upload when the user declines the overwrite", () => {
    const { host, sent, events } = fakeHost();
    const ft = new FileTransfer(host);
    ft.startUpload(9, new File(["x"], "a.txt"), "/tmp/a.txt");
    const dg = create(FileResponseSchema, {});
    dg.union = { case: "digest", value: create(FileTransferDigestSchema, { id: 9, fileNum: 0, isUpload: true, isIdentical: true }) };
    ft.handleResponse(dg);
    expect(events.at(-1)?.name).toBe("override_file_confirm");
    expect(events.at(-1)?.fields["is_upload"]).toBe("true");
    ft.confirmOverride(9, 0, false, true);
    expect(response(sent.at(-1)!)?.case).toBe("error");
    expect(events.at(-1)).toEqual({ name: "job_error", fields: { id: "9", err: "skipped", file_num: "0" } });
  });
});
