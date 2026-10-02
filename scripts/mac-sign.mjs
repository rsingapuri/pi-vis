import fs from "node:fs";
import { signAsync } from "@electron/osx-sign";

// Mach-O and universal/fat magic values, represented as big-endian reads so
// both native and byte-swapped encodings are explicit. Only these regular
// files need an embedded code signature. Signing arbitrary binary-looking
// resources makes codesign store detached signatures in com.apple.cs.* xattrs;
// those are not portable through ZIP extraction or an ordinary app copy.
export const MACH_O_MAGICS = new Set([
  0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca,
]);

const THIN_MACH_O = new Map([
  [0xfeedface, { headerSize: 28, littleEndian: false }],
  [0xcefaedfe, { headerSize: 28, littleEndian: true }],
  [0xfeedfacf, { headerSize: 32, littleEndian: false }],
  [0xcffaedfe, { headerSize: 32, littleEndian: true }],
]);
const FAT_MACH_O = new Map([
  [0xcafebabe, { archSize: 20, littleEndian: false, width: 32 }],
  [0xbebafeca, { archSize: 20, littleEndian: true, width: 32 }],
  [0xcafebabf, { archSize: 32, littleEndian: false, width: 64 }],
  [0xbfbafeca, { archSize: 32, littleEndian: true, width: 64 }],
]);

function readExact(descriptor, length, position) {
  const buffer = Buffer.allocUnsafe(length);
  return fs.readSync(descriptor, buffer, 0, length, position) === length ? buffer : null;
}

function uint32(buffer, offset, littleEndian) {
  return littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
}

function uint64(buffer, offset, littleEndian) {
  return littleEndian ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset);
}

function isThinMachO(descriptor, start, availableSize) {
  const magicHeader = readExact(descriptor, 4, start);
  if (!magicHeader) return false;
  const format = THIN_MACH_O.get(magicHeader.readUInt32BE(0));
  if (!format || availableSize < format.headerSize) return false;
  const header = readExact(descriptor, format.headerSize, start);
  if (!header) return false;
  const cpuType = uint32(header, 4, format.littleEndian);
  const fileType = uint32(header, 12, format.littleEndian);
  const commandCount = uint32(header, 16, format.littleEndian);
  const commandBytes = uint32(header, 20, format.littleEndian);
  return (
    cpuType !== 0 &&
    fileType !== 0 &&
    commandCount * 8 <= commandBytes &&
    format.headerSize + commandBytes <= availableSize
  );
}

function isFatMachO(descriptor, fileSize, magic) {
  const format = FAT_MACH_O.get(magic);
  if (!format) return false;
  const header = readExact(descriptor, 8, 0);
  if (!header) return false;
  const architectureCount = uint32(header, 4, format.littleEndian);
  const tableSize = 8 + architectureCount * format.archSize;
  if (architectureCount === 0 || architectureCount > 64 || tableSize > fileSize) return false;
  const table = readExact(descriptor, tableSize - 8, 8);
  if (!table) return false;

  for (let index = 0; index < architectureCount; index += 1) {
    const entry = index * format.archSize;
    if (uint32(table, entry, format.littleEndian) === 0) return false;
    const offsetValue =
      format.width === 64
        ? uint64(table, entry + 8, format.littleEndian)
        : BigInt(uint32(table, entry + 8, format.littleEndian));
    const sizeValue =
      format.width === 64
        ? uint64(table, entry + 16, format.littleEndian)
        : BigInt(uint32(table, entry + 12, format.littleEndian));
    if (
      offsetValue > BigInt(Number.MAX_SAFE_INTEGER) ||
      sizeValue > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      return false;
    }
    const offset = Number(offsetValue);
    const size = Number(sizeValue);
    if (offset < tableSize || size === 0 || offset + size > fileSize) return false;
    if (!isThinMachO(descriptor, offset, size)) return false;
  }
  return true;
}

export function isMachOFile(filePath) {
  let descriptor;
  try {
    // Match osx-sign's walker, which follows file symlinks with stat().
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 4) return false;
    descriptor = fs.openSync(filePath, "r");
    const header = readExact(descriptor, 4, 0);
    if (!header) return false;
    const magic = header.readUInt32BE(0);
    return THIN_MACH_O.has(magic)
      ? isThinMachO(descriptor, 0, stat.size)
      : isFatMachO(descriptor, stat.size, magic);
  } catch {
    // Let codesign surface a missing/unreadable candidate instead of silently
    // excluding it from the signed bundle.
    return true;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function ignoreNonMachORegularFile(filePath) {
  try {
    return fs.statSync(filePath).isFile() && !isMachOFile(filePath);
  } catch {
    return false;
  }
}

export function composeSignIgnore(existingIgnore) {
  const inherited = Array.isArray(existingIgnore)
    ? existingIgnore
    : existingIgnore == null
      ? []
      : [existingIgnore];
  // osx-sign 1.3.3 accidentally drops an array-valued ignore option in
  // validateOptsIgnore(). Return one predicate so its wrapper retains both the
  // electron-builder rule and this portable-signature rule.
  return (filePath) =>
    inherited.some((rule) =>
      typeof rule === "function" ? rule(filePath) : Boolean(filePath.match(rule)),
    ) || ignoreNonMachORegularFile(filePath);
}

export function portableSignOptions(options) {
  return {
    ...options,
    ignore: composeSignIgnore(options.ignore),
  };
}

export async function retrySign(
  signer,
  options,
  {
    delays = [5_000, 10_000, 15_000],
    wait = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
  } = {},
) {
  let attempt = 0;
  for (;;) {
    try {
      return await signer(options);
    } catch (error) {
      if (attempt >= delays.length) throw error;
      await wait(delays[attempt]);
      attempt += 1;
    }
  }
}

/** electron-builder custom mac.sign hook. */
export async function sign(options) {
  await retrySign(signAsync, portableSignOptions(options));
}

export default sign;
