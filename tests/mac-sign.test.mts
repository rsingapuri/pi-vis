import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MACH_O_MAGICS,
  composeSignIgnore,
  ignoreNonMachORegularFile,
  isMachOFile,
  portableSignOptions,
  retrySign,
} from "../scripts/mac-sign.mjs";

const roots: string[] = [];

function fixture(name: string, bytes: Uint8Array): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pivis-mac-sign-"));
  roots.push(root);
  const file = path.join(root, name);
  fs.writeFileSync(file, bytes);
  return file;
}

function writeUInt32(buffer: Buffer, value: number, offset: number, littleEndian: boolean): void {
  if (littleEndian) buffer.writeUInt32LE(value, offset);
  else buffer.writeUInt32BE(value, offset);
}

function writeUInt64(buffer: Buffer, value: bigint, offset: number, littleEndian: boolean): void {
  if (littleEndian) buffer.writeBigUInt64LE(value, offset);
  else buffer.writeBigUInt64BE(value, offset);
}

function thinMachO(magic: number): Buffer {
  const littleEndian = magic === 0xcefaedfe || magic === 0xcffaedfe;
  const headerSize = magic === 0xfeedfacf || magic === 0xcffaedfe ? 32 : 28;
  const buffer = Buffer.alloc(headerSize + 8);
  buffer.writeUInt32BE(magic, 0);
  writeUInt32(buffer, headerSize === 32 ? 0x0100000c : 7, 4, littleEndian);
  writeUInt32(buffer, 3, 8, littleEndian);
  writeUInt32(buffer, 2, 12, littleEndian);
  writeUInt32(buffer, 1, 16, littleEndian);
  writeUInt32(buffer, 8, 20, littleEndian);
  return buffer;
}

function fatMachO(magic: number): Buffer {
  const littleEndian = magic === 0xbebafeca || magic === 0xbfbafeca;
  const width = magic === 0xcafebabf || magic === 0xbfbafeca ? 64 : 32;
  const archSize = width === 64 ? 32 : 20;
  const slice = thinMachO(0xcffaedfe);
  const offset = 8 + archSize;
  const buffer = Buffer.alloc(offset + slice.length);
  buffer.writeUInt32BE(magic, 0);
  writeUInt32(buffer, 1, 4, littleEndian);
  writeUInt32(buffer, 0x0100000c, 8, littleEndian);
  writeUInt32(buffer, 0, 12, littleEndian);
  if (width === 64) {
    writeUInt64(buffer, BigInt(offset), 16, littleEndian);
    writeUInt64(buffer, BigInt(slice.length), 24, littleEndian);
  } else {
    writeUInt32(buffer, offset, 16, littleEndian);
    writeUInt32(buffer, slice.length, 20, littleEndian);
  }
  slice.copy(buffer, offset);
  return buffer;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("portable macOS signing filter", () => {
  it("recognizes every native, byte-swapped, and universal Mach-O magic", () => {
    for (const magic of MACH_O_MAGICS) {
      const bytes =
        magic === 0xcafebabe || magic === 0xbebafeca || magic === 0xcafebabf || magic === 0xbfbafeca
          ? fatMachO(magic)
          : thinMachO(magic);
      const file = fixture(`${magic.toString(16)}.node`, bytes);
      expect(isMachOFile(file)).toBe(true);
      expect(ignoreNonMachORegularFile(file)).toBe(false);
    }
  });

  it("rejects Java CAFEBABE and truncated or out-of-bounds Mach-O lookalikes", () => {
    const javaClass = Buffer.alloc(64);
    javaClass.writeUInt32BE(0xcafebabe, 0);
    javaClass.writeUInt16BE(0, 4);
    javaClass.writeUInt16BE(61, 6);
    expect(isMachOFile(fixture("Example.class", javaClass))).toBe(false);

    const thinStub = Buffer.alloc(8);
    thinStub.writeUInt32BE(0xfeedfacf, 0);
    expect(isMachOFile(fixture("thin-stub.node", thinStub))).toBe(false);

    const badFat = fatMachO(0xcafebabe);
    badFat.writeUInt32BE(badFat.length + 1, 16);
    expect(isMachOFile(fixture("bad-fat.node", badFat))).toBe(false);
  });

  it("excludes binary-looking resources that must remain sealed bundle data", () => {
    for (const [name, bytes] of [
      ["worker.wasm", Uint8Array.from([0x00, 0x61, 0x73, 0x6d])],
      ["font.woff2", Uint8Array.from([0x77, 0x4f, 0x46, 0x32])],
      ["linux.node", Uint8Array.from([0x7f, 0x45, 0x4c, 0x46])],
      ["image.png", Uint8Array.from([0x89, 0x50, 0x4e, 0x47])],
    ] as const) {
      const file = fixture(name, bytes);
      expect(isMachOFile(file)).toBe(false);
      expect(ignoreNonMachORegularFile(file)).toBe(true);
    }
  });

  it("classifies file symlinks exactly as the osx-sign walker does", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pivis-mac-sign-symlink-"));
    roots.push(root);
    const resource = path.join(root, "font.woff2");
    fs.writeFileSync(resource, Uint8Array.from([0x77, 0x4f, 0x46, 0x32]));
    const resourceLink = path.join(root, "font-link");
    fs.symlinkSync(resource, resourceLink, "file");
    expect(ignoreNonMachORegularFile(resourceLink)).toBe(true);

    const native = path.join(root, "native.node");
    fs.writeFileSync(native, thinMachO(0xfeedfacf));
    const nativeLink = path.join(root, "native-link");
    fs.symlinkSync(native, nativeLink, "file");
    expect(ignoreNonMachORegularFile(nativeLink)).toBe(false);
  });

  it("does not suppress bundle directories or an inherited ignore rule", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pivis-mac-sign-directory-"));
    roots.push(root);
    const bundle = path.join(root, "Nested.app");
    fs.mkdirSync(bundle);

    expect(ignoreNonMachORegularFile(bundle)).toBe(false);
    const inherited = (filePath: string): boolean => filePath.endsWith("ignored.bin");
    const filter = composeSignIgnore(inherited);
    expect(typeof filter).toBe("function");
    expect(filter(bundle)).toBe(false);
    expect(filter(path.join(root, "ignored.bin"))).toBe(true);
    expect(composeSignIgnore([inherited])(path.join(root, "ignored.bin"))).toBe(true);
    expect(composeSignIgnore(undefined)(bundle)).toBe(false);

    const options = portableSignOptions({ app: bundle, ignore: inherited });
    expect(Array.isArray(options.ignore)).toBe(false);
    expect(options.ignore(path.join(root, "ignored.bin"))).toBe(true);
  });

  it("preserves electron-builder's three signing retries and backoff", async () => {
    const error = new Error("keychain was briefly busy");
    const signer = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockResolvedValue("signed");
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(retrySign(signer, { app: "Pi-Vis.app" }, { wait })).resolves.toBe("signed");
    expect(signer).toHaveBeenCalledTimes(4);
    expect(wait.mock.calls).toEqual([[5_000], [10_000], [15_000]]);

    const permanentFailure = vi.fn().mockRejectedValue(error);
    await expect(retrySign(permanentFailure, {}, { delays: [0, 0, 0], wait })).rejects.toBe(error);
    expect(permanentFailure).toHaveBeenCalledTimes(4);
  });
});
