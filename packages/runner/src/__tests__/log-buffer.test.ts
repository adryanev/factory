/**
 * The Runner's log accumulation (issue #7): the flush cadence, the two
 * size mechanisms that must never be conflated (ring buffer vs cap), and
 * the literal-redaction-before-upload step.
 */
import { describe, expect, it } from "vitest";
import { CAP_MARKER, createLogSink, LogBuffer, RING_MARKER, type LogChunk } from "../log-buffer.js";
import type { LogChunkUploader } from "../log-buffer.js";

/** Collects uploaded chunks in order; can be told to fail the next `failTimes` uploads. */
function recordingUploader(failTimes = 0): LogChunkUploader & { chunks: LogChunk[] } {
  const chunks: LogChunk[] = [];
  let remainingFailures = failTimes;
  return {
    chunks,
    async upload(chunk) {
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error(`upload refused for seq ${chunk.seq}`);
      }
      chunks.push(chunk);
    },
  };
}

function bufferWith(options: Partial<ConstructorParameters<typeof LogBuffer>[0]> = {}): LogBuffer {
  return new LogBuffer({
    sizeFlushBytes: 256,
    ringBufferBytes: 64,
    capBytes: 256,
    ...options,
  });
}

describe("LogBuffer", () => {
  it("flushes the staged output as one chunk with contiguous seq and byte offsets", async () => {
    const buffer = bufferWith({ sizeFlushBytes: 5 });
    const uploader = recordingUploader();
    buffer.write("hello");
    buffer.write(" world");
    expect(buffer.needsSizeFlush).toBe(true);

    await buffer.flush(uploader.upload);
    expect(uploader.chunks).toHaveLength(1);
    expect(uploader.chunks[0]).toMatchObject({ seq: 0, byteOffset: 0, size: 11, text: "hello world" });

    buffer.write("again");
    await buffer.flush(uploader.upload);
    expect(uploader.chunks[1]).toMatchObject({ seq: 1, byteOffset: 11, size: 5, text: "again" });
  });

  it("flushes the tail on a timer every flushIntervalMs (spec: 'Runner flush tiap 1 detik')", async () => {
    const buffer = bufferWith();
    const uploader = recordingUploader();
    const sink = createLogSink(uploader, buffer, 20);

    sink.write("line-one\n");
    sink.write("line-two\n");
    sink.start();
    await new Promise((resolve) => setTimeout(resolve, 70));
    sink.stop();

    expect(uploader.chunks.length).toBeGreaterThanOrEqual(1);
    expect(uploader.chunks[0]!.text).toBe("line-one\nline-two\n");
  });

  it("a failed flush keeps the batch pending for the next retry — nothing is lost", async () => {
    const buffer = bufferWith();
    const uploader = recordingUploader(1); // the first upload fails.
    buffer.write("important bytes");

    await expect(buffer.flush(uploader.upload)).rejects.toThrow(/refused/);
    expect(uploader.chunks).toHaveLength(0); // nothing committed.

    // The retry uploads the same batch under the same seq — safe because a
    // re-upload overwrites the same object and the control plane dedups.
    await buffer.flush(uploader.upload);
    expect(uploader.chunks).toHaveLength(1);
    expect(uploader.chunks[0]).toMatchObject({ seq: 0, text: "important bytes" });
  });

  it("writes that land while an upload is in flight start a fresh batch and are not lost", async () => {
    const buffer = bufferWith();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const uploader: LogChunkUploader = {
      async upload(chunk) {
        await gate;
        uploaded.push(chunk);
      },
    };
    const uploaded: LogChunk[] = [];

    buffer.write("first");
    const flushing = buffer.flush(uploader.upload); // hangs until released.
    buffer.write("second");
    release();
    await flushing;

    await buffer.flush(uploader.upload);
    expect(uploaded.map((chunk) => chunk.text)).toEqual(["first", "second"]);
    expect(uploaded[0]!.seq).toBe(0);
    expect(uploaded[1]!.seq).toBe(1);
  });

  it("ring buffer drops the OLDEST pending bytes and produces exactly one ring-marker chunk", async () => {
    const buffer = bufferWith({ ringBufferBytes: 10, capBytes: 10_000, sizeFlushBytes: 10_000 });
    const uploader = recordingUploader();

    buffer.write("AAAAA"); // 5
    buffer.write("BBBBB"); // 5  → pending 10
    buffer.write("CCCCCCC"); // 7  → overflow 7: drops "AAAAA"(5) + "B"(2) of "BBBBB"
    expect(buffer.pendingByteCount).toBe(10);

    await buffer.flush(uploader.upload);
    // Exactly the ring marker chunk plus the surviving text — the dropped
    // bytes are gone, the failure is at the oldest end.
    const markers = uploader.chunks.filter((chunk) => chunk.marker !== undefined);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ marker: "ring" });
    expect(markers[0]!.text).toBe(RING_MARKER(7));
    const text = uploader.chunks.filter((chunk) => chunk.marker === undefined);
    expect(text.map((chunk) => chunk.text)).toEqual(["BBBCCCCCCC"]);
  });

  it("the cap truncates WITHOUT failing and produces exactly one cap-marker chunk, distinct from the ring marker", async () => {
    const buffer = bufferWith({ capBytes: 10, ringBufferBytes: 10_000, sizeFlushBytes: 10_000 });
    const uploader = recordingUploader();

    buffer.write("ABCDEFGHIJ"); // exactly the cap.
    buffer.write("K"); // past the cap → truncated, marker pending.
    buffer.write("L"); // dropped, post-truncation.

    await buffer.flush(uploader.upload);
    const markers = uploader.chunks.filter((chunk) => chunk.marker !== undefined);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ marker: "cap" });
    expect(markers[0]!.text).toBe(CAP_MARKER(10));
    // The pre-cap bytes still made it out; nothing after the cap did.
    expect(uploader.chunks.map((chunk) => chunk.text)).toContain("ABCDEFGHIJ");

    // Post-cap writes are dropped; nothing more is flushed.
    buffer.write("M");
    await buffer.flush(uploader.upload);
    expect(uploader.chunks.filter((chunk) => chunk.marker !== undefined)).toHaveLength(1);
  });

  it("the two markers are provably distinct — never conflated on the wire", () => {
    expect(RING_MARKER(7)).not.toBe(CAP_MARKER(10));
    expect(RING_MARKER(7)).toMatch(/ring buffer/);
    expect(CAP_MARKER(10)).toMatch(/capped/);
  });

  it("redacts literally, before the bytes are staged (best-effort, never a regex)", async () => {
    const buffer = bufferWith({ redact: (text) => text.split("ghs_TOP_SECRET").join("[redacted]") });
    const uploader = recordingUploader();
    buffer.write("token is ghs_TOP_SECRET and also ghs_TOP_SECRET again");
    await buffer.flush(uploader.upload);
    expect(uploader.chunks[0]!.text).toBe("token is [redacted] and also [redacted] again");
  });
});
