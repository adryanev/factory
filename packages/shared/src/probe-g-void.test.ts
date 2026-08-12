import { expect, it } from "vitest";

// VARIAN G — bentuk `void` + async dari #50 di bawah anotasi.
// Yang diukur: (1) apakah `satisfies` + `?: never` tetap menyempit di union
// yang arm suksesnya TIDAK punya kolom hasil, dan (2) apakah anotasi membeli
// kembali proteksi "baris lupa `throws`" yang #50 rela lepas.

async function verifyIsolationStub(readable: boolean): Promise<void> {
  if (readable) {
    throw new Error("host path is readable from inside the sandbox");
  }
}

type IsolationCase =
  | { case: string; readable: boolean; throws?: never }
  | { case: string; readable: boolean; throws: RegExp };

it.each([
  { case: "path tertutup lolos", readable: false },
  { case: "path terbaca ditolak", readable: true, throws: /host path is readable/ },
  // baris ini SEHARUSNYA melempar tapi lupa `throws` — apakah tsc melihatnya?
  { case: "lupa throws", readable: true },
] satisfies IsolationCase[])("G $case", async (row) => {
  if ("throws" in row) {
    await expect(verifyIsolationStub(row.readable)).rejects.toThrow(row.throws);
    return;
  }
  await expect(verifyIsolationStub(row.readable)).resolves.toBeUndefined();
});
