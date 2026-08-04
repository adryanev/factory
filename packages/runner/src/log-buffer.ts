/**
 * The Runner's in-memory log accumulator, flushed as chunks (spec: "Log").
 *
 * The shape is forced by the object store: it cannot be read while written,
 * so a live log is many small objects, not one growing one (spec:
 * "Objek storage tidak bisa dibaca sambil ditulis ... log yang belum selesai
 * adalah banyak objek"). Chunks flush every `flushIntervalMs` or once
 * `sizeFlushBytes` of pending output has accumulated, whichever comes first.
 *
 * Two mechanisms that must never be conflated (spec):
 *
 *  - a **ring buffer** of `ringBufferBytes` bounds the *pending* memory while
 *    the object store is slow or down: past it, the **oldest** pending bytes
 *    are dropped — the failure is at the newest end — and one chunk carrying
 *    the ring marker is produced;
 *  - a **cap** of `capBytes` bounds the whole log: past it, output is
 *    truncated **without failing the StepRun**, and one chunk carrying the
 *    cap marker is produced.
 *
 * On the wire the two are indistinguishable — each is just one chunk whose
 * text is its marker. `flush` commits (advances seq/offset, clears pending)
 * only after every chunk in the batch uploaded, so a failed upload keeps the
 * batch pending for the next retry; because a re-upload overwrites the same
 * object key and the control plane dedups at the primary key, retrying is
 * safe (spec: "Dedup di primary key ... bukan di kode").
 */
/**
 * Uploads one flushed chunk: the object-store half of the log path. The
 * control plane mints the presigned PUT; this uploads the bytes peer-to-peer
 * and records the metadata after (spec: "control plane hanya mencatat
 * metadata chunk, tidak pernah menerima byte"). One per StepRun+attempt.
 */
export interface LogChunkUploader {
  upload(chunk: LogChunk): Promise<void>;
}

export type ChunkMarker = "ring" | "cap";

/** One chunk ready for upload: the text plus the metadata the control plane records (spec: "control plane hanya mencatat metadata chunk"). */
export interface LogChunk {
  seq: number;
  byteOffset: number;
  size: number;
  text: string;
  marker?: ChunkMarker;
}

export interface LogBufferOptions {
  /** Flush as soon as this much output is pending (spec: "atau 256 KiB"). */
  sizeFlushBytes: number;
  /** Pending-memory bound; past it the oldest bytes are dropped and a ring-marker chunk is produced (spec: "ring buffer 64 MiB membuang yang tertua"). */
  ringBufferBytes: number;
  /** Whole-log bound; past it output is truncated without failing the StepRun and a cap-marker chunk is produced (spec: "batas 256 MiB memotong tanpa menggagalkan StepRun"). */
  capBytes: number;
  /** Literal, best-effort redaction applied before the bytes are staged (spec: "Redaksi literal best-effort sebelum upload"). */
  redact?: (text: string) => string;
}

export const RING_MARKER = (droppedBytes: number): string =>
  `[factory: ring buffer overflow — ${droppedBytes} bytes of oldest output dropped]`;
export const CAP_MARKER = (capBytes: number): string =>
  `[factory: log capped at ${capBytes} bytes — further output dropped]`;

export class LogBuffer {
  private readonly sizeFlushBytes: number;
  private readonly ringBufferBytes: number;
  private readonly capBytes: number;
  private readonly redact: (text: string) => string;

  private pendingText: string[] = [];
  private pendingBytes = 0;
  private ringDroppedBytes = 0;
  private capPending = false;
  private truncated = false;
  private visibleBytes = 0;
  private nextSeq = 0;
  private nextByteOffset = 0;
  private flushing: Promise<void> | null = null;

  constructor(options: LogBufferOptions) {
    this.sizeFlushBytes = options.sizeFlushBytes;
    this.ringBufferBytes = options.ringBufferBytes;
    this.capBytes = options.capBytes;
    this.redact = options.redact ?? ((text: string) => text);
  }

  /** Bytes pending in memory right now — the ring buffer's occupancy. */
  get pendingByteCount(): number {
    return this.pendingBytes;
  }

  /** True once the size flush threshold is crossed — the write path asks after every `write`. */
  get needsSizeFlush(): boolean {
    return this.pendingBytes >= this.sizeFlushBytes;
  }

  get idle(): boolean {
    return this.pendingBytes === 0 && this.ringDroppedBytes === 0 && !this.capPending;
  }

  /** Total bytes accepted into the logical log so far — the cap tracks this. */
  get totalAcceptedBytes(): number {
    return this.visibleBytes;
  }

  /**
   * Stages one piece of output. Redaction happens here, before anything is
   * staged (spec: "Redaksi literal best-effort sebelum upload"). Never throws
   * for size — a past-cap write is dropped silently, exactly the "memotong
   * tanpa menggagalkan StepRun" contract.
   */
  write(text: string): void {
    if (this.truncated) {
      return;
    }
    const redacted = this.redact(text);
    if (redacted.length === 0) {
      return;
    }
    if (this.visibleBytes >= this.capBytes) {
      this.truncated = true;
      this.capPending = true;
      return;
    }

    let incoming = redacted;
    let overflow = this.pendingBytes + incoming.length - this.ringBufferBytes;
    if (overflow > 0) {
      let dropped = 0;
      while (overflow > 0) {
        if (this.pendingText.length > 0) {
          const first = this.pendingText[0]!;
          if (first.length <= overflow) {
            this.pendingText.shift();
            this.pendingBytes -= first.length;
            dropped += first.length;
            overflow -= first.length;
          } else {
            this.pendingText[0] = first.slice(overflow);
            this.pendingBytes -= overflow;
            dropped += overflow;
            overflow = 0;
          }
        } else {
          incoming = incoming.slice(overflow);
          dropped += overflow;
          overflow = 0;
        }
      }
      this.ringDroppedBytes += dropped;
      this.visibleBytes -= dropped;
    }

    this.pendingText.push(incoming);
    this.pendingBytes += incoming.length;
    this.visibleBytes += incoming.length;
  }

  /**
   * Uploads everything pending as one batch, committing (clearing pending,
   * advancing seq/offset) only after every chunk in the batch uploaded. A
   * failure leaves the batch pending for the next retry. Concurrent calls are
   * serialized — the timer and a size-flush can never overlap.
   */
  flush(upload: LogChunkUploader["upload"]): Promise<void> {
    if (!this.flushing) {
      this.flushing = this.doFlush(upload).finally(() => {
        this.flushing = null;
      });
    }
    return this.flushing;
  }

  private async doFlush(upload: LogChunkUploader["upload"]): Promise<void> {
    if (this.idle) {
      return;
    }

    // Snapshot ALL pending state, then clear it immediately so writes that
    // land while the upload is in flight start a fresh batch instead of being
    // wiped by this flush's commit.
    const snapshot = {
      pendingText: this.pendingText,
      pendingBytes: this.pendingBytes,
      ringDroppedBytes: this.ringDroppedBytes,
      capPending: this.capPending,
    };

    const emissions: { text: string; marker?: ChunkMarker }[] = [];
    if (snapshot.ringDroppedBytes > 0) {
      emissions.push({ text: RING_MARKER(snapshot.ringDroppedBytes), marker: "ring" });
    }
    if (snapshot.capPending) {
      emissions.push({ text: CAP_MARKER(this.capBytes), marker: "cap" });
    }
    if (snapshot.pendingBytes > 0) {
      emissions.push({ text: snapshot.pendingText.join("") });
    }

    this.pendingText = [];
    this.pendingBytes = 0;
    this.ringDroppedBytes = 0;
    this.capPending = false;

    let offset = this.nextByteOffset;
    const chunks = emissions.map((emission, index) => {
      const chunk: LogChunk = {
        seq: this.nextSeq + index,
        byteOffset: offset,
        size: emission.text.length,
        text: emission.text,
        ...(emission.marker ? { marker: emission.marker } : {}),
      };
      offset += chunk.size;
      return chunk;
    });

    try {
      for (const chunk of chunks) {
        await upload(chunk);
      }
    } catch (error) {
      // Nothing committed — restore the snapshot to the front of the pending
      // state so the retry re-uploads the whole batch. Safe because a
      // re-upload overwrites the same object key and the control plane dedups
      // at the primary key. seq/offset did not advance.
      this.pendingText = [...snapshot.pendingText, ...this.pendingText];
      this.pendingBytes = snapshot.pendingBytes + this.pendingBytes;
      this.ringDroppedBytes += snapshot.ringDroppedBytes;
      this.capPending = this.capPending || snapshot.capPending;
      throw error;
    }

    this.nextSeq += chunks.length;
    this.nextByteOffset = offset;
    this.visibleBytes = offset + this.pendingBytes;
  }
}

/**
 * Wires a `LogBuffer` to a `LogChunkUploader` and the 1-second flush timer —
 * the live plumbing the executor drives through `onLine`. `start()` begins
 * the flush timer; `stop()` stops it and flushes the tail so nothing is left
 * in memory at teardown.
 */
export interface LogSink {
  write(text: string): void;
  start(): void;
  stop(): Promise<void>;
}

export function createLogSink(uploader: LogChunkUploader, buffer: LogBuffer, flushIntervalMs: number): LogSink {
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const flush = (): Promise<void> => buffer.flush(uploader.upload);

  return {
    write(text) {
      buffer.write(text);
      if (buffer.needsSizeFlush) {
        void flush().catch(() => {
          // A failed flush keeps its batch pending; the timer retries.
        });
      }
    },
    start() {
      if (timer || stopped) {
        return;
      }
      timer = setInterval(() => {
        void flush().catch(() => {});
      }, flushIntervalMs);
    },
    async stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      await flush();
    },
  };
}
