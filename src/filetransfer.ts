// File transfer, controller side. Port of the FILE_TRANSFER parts of
// src/client/io_loop.rs + libs/base/src/fs.rs for a browser host:
//   download: FileAction.send -> FileResponse.dir/digest/block/done, bytes go to
//             the File System Access API (streamed) or a Blob download
//   upload  : FileAction.receive + FileResponse.digest/block/done from a File
//   browse  : FileAction.read_dir -> FileResponse.dir -> `file_dir` event
// Requests are FileAction; bulk data is FileResponse in BOTH directions.
import { create } from "@bufbuild/protobuf";
import { decompress as zstdDecompress } from "fzstd";
import {
  type FileAction,
  FileActionSchema,
  type FileDirectory,
  FileDirCreateSchema,
  type FileEntry,
  FileEntrySchema,
  FileRemoveDirSchema,
  FileRemoveFileSchema,
  FileRenameSchema,
  type FileResponse,
  FileResponseSchema,
  FileTransferBlockSchema,
  FileTransferCancelSchema,
  type FileTransferDigest,
  FileTransferDigestSchema,
  FileTransferDoneSchema,
  FileTransferErrorSchema,
  FileTransferReceiveRequestSchema,
  FileTransferSendConfirmRequestSchema,
  FileTransferSendRequestSchema,
  FileType,
  type Message,
  MessageSchema,
  ReadAllFilesSchema,
  ReadDirSchema,
} from "./proto/message_pb";
import { getVersionNumber } from "./version";
import { log } from "./log";

// libs/base/src/fs.rs BUF_SIZE
const BLOCK_SIZE = 128 * 1024;
// keep the WebSocket send buffer bounded while streaming uploads
const MAX_BUFFERED = 4 * 1024 * 1024;
// io_loop.rs update_jobs_status: at most one job_progress per second
const PROGRESS_MS = 1000;

export type Fields = Record<string, string>;

export interface FileTransferHost {
  emit(name: string, fields: Fields): void;
  send(msg: Message): void;
  bufferedAmount(): number;
  peerPlatform(): string;
  peerVersion(): string;
}

// ---- helpers ---------------------------------------------------------------

function jsonStr(v: unknown): string {
  return JSON.stringify(v);
}

// src/common.rs make_fd_to_json
function fdToJson(fd: FileDirectory, peerIsWindows: boolean): string {
  return jsonStr({
    id: fd.id,
    path: fd.path,
    entries: fd.entries.map((e) => ({
      entry_type: e.entryType,
      // fs::transform_windows_path when the peer is Windows and we are not
      name: peerIsWindows ? e.name.replace(/\\/g, "/") : e.name,
      size: Number(e.size),
      modified_time: Number(e.modifiedTime),
    })),
  });
}

function baseName(p: string): string {
  const s = p.replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i >= 0 ? s.slice(i + 1) : s;
}

function safeName(rel: string): string {
  return rel.replace(/[\\/]+/g, "_").replace(/^_+/, "") || "download";
}

function fileMsg(union: FileResponse["union"] | null, action: FileAction["union"] | null): Message {
  const m = create(MessageSchema, {});
  if (union) {
    const r = create(FileResponseSchema, {});
    r.union = union;
    m.union = { case: "fileResponse", value: r };
  } else if (action) {
    const a = create(FileActionSchema, {});
    a.union = action;
    m.union = { case: "fileAction", value: a };
  }
  return m;
}

// fs.rs can_enable_overwrite_detection
function overwriteDetection(peerVersion: string): boolean {
  return getVersionNumber(peerVersion) >= getVersionNumber("1.1.10");
}

// ---- download sinks --------------------------------------------------------

interface FileSink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

class BlobSink implements FileSink {
  private parts: Uint8Array[] = [];
  constructor(private readonly name: string) {}
  async write(chunk: Uint8Array): Promise<void> {
    this.parts.push(chunk);
  }
  async close(): Promise<void> {
    const blob = new Blob(this.parts as BlobPart[]);
    this.parts = [];
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = this.name;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 60_000);
  }
  async abort(): Promise<void> {
    this.parts = [];
  }
}

class WritableSink implements FileSink {
  constructor(private readonly w: FileSystemWritableFileStream) {}
  write(chunk: Uint8Array): Promise<void> {
    return this.w.write(chunk as unknown as BufferSource);
  }
  close(): Promise<void> {
    return this.w.close();
  }
  abort(): Promise<void> {
    return this.w.abort();
  }
}

type FsaWindow = Window & {
  showSaveFilePicker?: (o?: { suggestedName?: string }) => Promise<FileSystemFileHandle>;
  showDirectoryPicker?: (o?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
};

interface DownloadTarget {
  // single-file job: a file handle; directory job: a directory handle; null: Blob fallback
  file?: FileSystemFileHandle;
  dir?: FileSystemDirectoryHandle;
}

async function openSink(target: DownloadTarget, relName: string): Promise<FileSink> {
  if (target.file) return new WritableSink(await target.file.createWritable());
  if (target.dir) {
    const parts = relName.split(/[\\/]+/).filter((p) => p.length > 0 && p !== "." && p !== "..");
    const name = parts.pop() ?? "download";
    let dir = target.dir;
    for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: true });
    const fh = await dir.getFileHandle(name, { create: true });
    return new WritableSink(await fh.createWritable());
  }
  return new BlobSink(safeName(relName));
}

// ---- jobs ------------------------------------------------------------------

interface JobBase {
  id: number;
  finished: number; // decompressed bytes (job_progress.finished_size)
  transferred: number; // on-wire bytes (speed)
  lastTransferred: number;
  lastTick: number;
  fileNum: number;
}

interface DownloadJob extends JobBase {
  kind: "download";
  remotePath: string;
  files: FileEntry[];
  target: DownloadTarget;
  sink: FileSink | null;
  sinkFileNum: number;
  queue: Promise<void>;
}

interface UploadJob extends JobBase {
  kind: "upload";
  file: File;
  remotePath: string;
  od: boolean;
  confirmed: boolean;
  offset: number;
  streaming: boolean;
  cancelled: boolean;
}

type Job = DownloadJob | UploadJob;

export class FileTransfer {
  private jobs = new Map<number, Job>();
  private progressTimer: number | null = null;
  private closed = false;

  constructor(private readonly host: FileTransferHost) {}

  private peerIsWindows(): boolean {
    return this.host.peerPlatform() === "Windows";
  }

  close(): void {
    this.closed = true;
    this.stopProgress();
    for (const j of this.jobs.values()) {
      if (j.kind === "download") void j.sink?.abort();
      else j.cancelled = true;
    }
    this.jobs.clear();
  }

  // ---- browse --------------------------------------------------------------

  readRemoteDir(path: string, includeHidden: boolean): void {
    this.host.send(fileMsg(null, { case: "readDir", value: create(ReadDirSchema, { path, includeHidden }) }));
  }

  // FileAction.all_files: recursive listing used by the delete flow
  readDirToRemoveRecursive(id: number, path: string, includeHidden: boolean): void {
    this.host.send(fileMsg(null, { case: "allFiles", value: create(ReadAllFilesSchema, { id, path, includeHidden }) }));
  }

  removeFile(id: number, path: string, fileNum: number): void {
    this.host.send(fileMsg(null, { case: "removeFile", value: create(FileRemoveFileSchema, { id, path, fileNum }) }));
  }

  removeAllEmptyDirs(id: number, path: string): void {
    this.host.send(fileMsg(null, { case: "removeDir", value: create(FileRemoveDirSchema, { id, path, recursive: true }) }));
  }

  createDir(id: number, path: string): void {
    this.host.send(fileMsg(null, { case: "create", value: create(FileDirCreateSchema, { id, path }) }));
  }

  renameFile(id: number, path: string, newName: string): void {
    this.host.send(fileMsg(null, { case: "rename", value: create(FileRenameSchema, { id, path, newName }) }));
  }

  cancelJob(id: number): void {
    const j = this.jobs.get(id);
    if (j) {
      if (j.kind === "download") void j.sink?.abort();
      else j.cancelled = true;
      this.jobs.delete(id);
    }
    this.host.send(fileMsg(null, { case: "cancel", value: create(FileTransferCancelSchema, { id }) }));
    this.maybeStopProgress();
  }

  // ---- download ------------------------------------------------------------

  // Dart `send_files` with is_remote = true. Must run inside the click's user
  // activation so the save/directory picker is allowed.
  async startDownload(id: number, remotePath: string, includeHidden: boolean, isDir: boolean): Promise<void> {
    if (this.jobs.has(id)) return;
    const target: DownloadTarget = {};
    const w = globalThis.window as FsaWindow | undefined;
    try {
      if (isDir && w?.showDirectoryPicker) {
        target.dir = await w.showDirectoryPicker({ mode: "readwrite" });
      } else if (!isDir && w?.showSaveFilePicker) {
        target.file = await w.showSaveFilePicker({ suggestedName: baseName(remotePath) });
      }
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") {
        this.host.emit("job_error", { id: String(id), err: "cancel", file_num: "-1" });
        return;
      }
      log.warn("file picker unavailable, falling back to browser downloads", e);
    }
    if (this.closed) return;
    const job: DownloadJob = {
      kind: "download",
      id,
      remotePath,
      files: [],
      target,
      sink: null,
      sinkFileNum: -1,
      queue: Promise.resolve(),
      finished: 0,
      transferred: 0,
      lastTransferred: 0,
      lastTick: Date.now(),
      fileNum: 0,
    };
    this.jobs.set(id, job);
    this.host.send(
      fileMsg(null, {
        case: "send",
        value: create(FileTransferSendRequestSchema, { id, path: remotePath, includeHidden, fileNum: 0 }),
      })
    );
    this.startProgress();
  }

  private relNameFor(job: DownloadJob, fileNum: number): string {
    const e = job.files[fileNum];
    const name = e?.name ?? "";
    return name === "" ? baseName(job.remotePath) : name;
  }

  private async ensureSink(job: DownloadJob, fileNum: number): Promise<FileSink> {
    if (job.sink && job.sinkFileNum === fileNum) return job.sink;
    if (job.sink) {
      await job.sink.close();
      job.sink = null;
    }
    job.sink = await openSink(job.target, this.relNameFor(job, fileNum));
    job.sinkFileNum = fileNum;
    return job.sink;
  }

  private onBlock(job: DownloadJob, fileNum: number, data: Uint8Array, compressed: boolean): void {
    job.fileNum = fileNum;
    job.transferred += data.length;
    job.queue = job.queue
      .then(async () => {
        if (data.length === 0) {
          // fs.rs: an empty block marks end of file
          if (job.sink && job.sinkFileNum === fileNum) {
            await job.sink.close();
            job.sink = null;
          }
          return;
        }
        let bytes = data;
        if (compressed) bytes = zstdDecompress(data);
        job.finished += bytes.length;
        const sink = await this.ensureSink(job, fileNum);
        await sink.write(bytes);
      })
      .catch((e) => {
        log.error(`download job ${job.id} write failed`, e);
        this.failJob(job.id, String((e as Error)?.message ?? e), fileNum, true);
      });
  }

  // ---- upload --------------------------------------------------------------

  // Dart `send_local_files`: one browser File per job; `to` is the remote path.
  startUpload(id: number, file: File, remotePath: string): void {
    if (this.jobs.has(id)) return;
    const od = overwriteDetection(this.host.peerVersion());
    const job: UploadJob = {
      kind: "upload",
      id,
      file,
      remotePath,
      od,
      confirmed: !od,
      offset: 0,
      streaming: false,
      cancelled: false,
      finished: 0,
      transferred: 0,
      lastTransferred: 0,
      lastTick: Date.now(),
      fileNum: 0,
    };
    this.jobs.set(id, job);
    const modified = BigInt(Math.max(0, Math.floor(file.lastModified / 1000)));
    const entry = create(FileEntrySchema, {
      entryType: FileType.File,
      name: "",
      size: BigInt(file.size),
      modifiedTime: modified,
    });
    this.host.send(
      fileMsg(null, {
        case: "receive",
        value: create(FileTransferReceiveRequestSchema, {
          id,
          path: remotePath,
          files: [entry],
          fileNum: 0,
          totalSize: BigInt(file.size),
        }),
      })
    );
    this.host.emit("update_folder_files", { info: jsonStr({ id, num_entries: 1, total_size: file.size + 0.0 }) });
    this.startProgress();
    if (od) {
      // fs.rs: with overwrite detection the reader first sends a digest and
      // waits for send_confirm (or a digest asking the user).
      this.host.send(
        fileMsg(
          {
            case: "digest",
            value: create(FileTransferDigestSchema, {
              id,
              fileNum: 0,
              lastModified: modified,
              fileSize: BigInt(file.size),
              isUpload: false,
            }),
          },
          null
        )
      );
    } else {
      void this.streamUpload(job);
    }
  }

  private async streamUpload(job: UploadJob): Promise<void> {
    if (job.streaming) return;
    job.streaming = true;
    try {
      let offset = job.offset;
      const size = job.file.size;
      while (offset < size) {
        if (job.cancelled || this.closed) return;
        while (this.host.bufferedAmount() > MAX_BUFFERED) {
          await new Promise((r) => setTimeout(r, 5));
          if (job.cancelled || this.closed) return;
        }
        const end = Math.min(size, offset + BLOCK_SIZE);
        const chunk = new Uint8Array(await job.file.slice(offset, end).arrayBuffer());
        this.host.send(
          fileMsg(
            { case: "block", value: create(FileTransferBlockSchema, { id: job.id, fileNum: 0, data: chunk, compressed: false }) },
            null
          )
        );
        offset = end;
        job.offset = offset;
        job.transferred += chunk.length;
        job.finished += chunk.length;
      }
      if (job.cancelled || this.closed) return;
      // end-of-file marker block, then Done; the peer echoes Done -> job_done
      this.host.send(
        fileMsg({ case: "block", value: create(FileTransferBlockSchema, { id: job.id, fileNum: 0, data: new Uint8Array(), compressed: false }) }, null)
      );
      job.fileNum = 1;
      this.host.send(fileMsg({ case: "done", value: create(FileTransferDoneSchema, { id: job.id, fileNum: 1 }) }, null));
    } catch (e) {
      log.error(`upload job ${job.id} failed`, e);
      const err = String((e as Error)?.message ?? e);
      this.host.send(fileMsg({ case: "error", value: create(FileTransferErrorSchema, { id: job.id, error: err, fileNum: 0 }) }, null));
      this.failJob(job.id, err, 0, false);
    }
  }

  // Dart `confirm_override_file`
  confirmOverride(id: number, fileNum: number, needOverride: boolean, isUpload: boolean): void {
    const job = this.jobs.get(id);
    if (isUpload) {
      if (!job || job.kind !== "upload") return;
      if (needOverride) {
        job.confirmed = true;
        job.offset = 0;
        void this.streamUpload(job);
      } else {
        // fs.rs: a fully skipped job ends as error "skipped" on both sides
        this.host.send(fileMsg({ case: "error", value: create(FileTransferErrorSchema, { id, error: "skipped", fileNum }) }, null));
        this.jobs.delete(id);
        this.host.emit("job_error", { id: String(id), err: "skipped", file_num: String(fileNum) });
        this.maybeStopProgress();
      }
      return;
    }
    const confirm = create(FileTransferSendConfirmRequestSchema, { id, fileNum });
    confirm.union = needOverride ? { case: "offsetBlk", value: 0 } : { case: "skip", value: true };
    this.host.send(fileMsg(null, { case: "sendConfirm", value: confirm }));
  }

  // ---- inbound -------------------------------------------------------------

  handleAction(action: FileAction): void {
    const u = action.union;
    if (u.case === "sendConfirm") {
      // peer answering our upload digest
      const job = this.jobs.get(u.value.id);
      if (!job || job.kind !== "upload") return;
      if (u.value.union.case === "skip") {
        this.jobs.delete(job.id);
        this.host.emit("job_error", { id: String(job.id), err: "skipped", file_num: String(u.value.fileNum) });
        this.maybeStopProgress();
        return;
      }
      job.confirmed = true;
      // "offset_blk" is a byte offset (fs.rs set_stream_offset)
      job.offset = u.value.union.case === "offsetBlk" ? u.value.union.value : 0;
      job.finished = job.offset;
      void this.streamUpload(job);
    }
  }

  handleResponse(resp: FileResponse): void {
    const u = resp.union;
    switch (u.case) {
      case "dir":
        this.onDir(u.value);
        return;
      case "digest":
        this.onDigest(u.value);
        return;
      case "block": {
        const b = u.value;
        const job = this.jobs.get(b.id);
        if (!job || job.kind !== "download") return;
        this.onBlock(job, b.fileNum, b.data, b.compressed);
        return;
      }
      case "done": {
        const d = u.value;
        const job = this.jobs.get(d.id);
        if (job?.kind === "download") {
          void job.queue.then(async () => {
            if (job.sink) {
              await job.sink.close();
              job.sink = null;
            }
            this.jobs.delete(d.id);
            this.host.emit("job_done", { id: String(d.id), file_num: String(d.fileNum) });
            this.maybeStopProgress();
          });
          return;
        }
        if (job) this.jobs.delete(d.id);
        this.host.emit("job_done", { id: String(d.id), file_num: String(d.fileNum) });
        this.maybeStopProgress();
        return;
      }
      case "error":
        this.failJob(u.value.id, u.value.error, u.value.fileNum, false);
        return;
      case "emptyDirs": {
        const v = u.value;
        this.host.emit("empty_dirs", {
          is_local: "false",
          value: jsonStr({ path: v.path, empty_dirs: v.emptyDirs.map((fd) => JSON.parse(fdToJson(fd, this.peerIsWindows()))) }),
        });
        return;
      }
      default:
        return;
    }
  }

  private onDir(fd: FileDirectory): void {
    const job = this.jobs.get(fd.id);
    if (job?.kind === "download") {
      job.files = fd.entries;
      const total = fd.entries.reduce((n, e) => n + Number(e.size), 0);
      this.host.emit("update_folder_files", { info: jsonStr({ id: fd.id, num_entries: fd.entries.length, total_size: total + 0.0 }) });
      return;
    }
    // id 0: plain listing (or the auto listing after login); id > 0: recursive
    // listing for the delete flow. Same event either way.
    this.host.emit("file_dir", { is_local: "false", value: fdToJson(fd, this.peerIsWindows()) });
  }

  private onDigest(d: FileTransferDigest): void {
    const job = this.jobs.get(d.id);
    if (!job) return;
    if (job.kind === "download") {
      // No local copy to compare against in a browser: always start from 0.
      const confirm = create(FileTransferSendConfirmRequestSchema, { id: d.id, fileNum: d.fileNum });
      confirm.union = { case: "offsetBlk", value: 0 };
      this.host.send(fileMsg(null, { case: "sendConfirm", value: confirm }));
      return;
    }
    // upload: the peer already has a file with that name -> ask the user
    this.host.emit("override_file_confirm", {
      id: String(d.id),
      file_num: String(d.fileNum),
      read_path: job.file.name,
      is_upload: "true",
      is_identical: d.isIdentical ? "true" : "false",
    });
  }

  private failJob(id: number, err: string, fileNum: number, sendCancel: boolean): void {
    const job = this.jobs.get(id);
    if (job) {
      if (job.kind === "download") void job.sink?.abort();
      else job.cancelled = true;
      this.jobs.delete(id);
    }
    if (sendCancel) this.host.send(fileMsg(null, { case: "cancel", value: create(FileTransferCancelSchema, { id }) }));
    this.host.emit("job_error", { id: String(id), err, file_num: String(fileNum) });
    this.maybeStopProgress();
  }

  // ---- progress ------------------------------------------------------------

  private startProgress(): void {
    if (this.progressTimer !== null) return;
    this.progressTimer = setInterval(() => this.tickProgress(), PROGRESS_MS) as unknown as number;
  }

  private stopProgress(): void {
    if (this.progressTimer !== null) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  }

  private maybeStopProgress(): void {
    if (this.jobs.size === 0) this.stopProgress();
  }

  private tickProgress(): void {
    const now = Date.now();
    for (const job of this.jobs.values()) {
      const elapsed = Math.max(1, now - job.lastTick) / 1000;
      const speed = (job.transferred - job.lastTransferred) / elapsed;
      job.lastTransferred = job.transferred;
      job.lastTick = now;
      this.host.emit("job_progress", {
        id: String(job.id),
        file_num: String(job.fileNum - 1),
        speed: speed.toFixed(1),
        finished_size: String(Math.floor(job.finished)),
      });
    }
  }
}
