/**
 * Minimal zero-dependency ZIP writer (store method, no compression).
 * Used by the wiki export (Q8) to ship an Obsidian-compatible vault snapshot
 * without introducing npm runtime dependencies.
 *
 * @param {Array<{path: string, content: string|Buffer}>} files
 * @returns {Buffer}
 */
export function createZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(String(file.path), "utf8");
    const data = Buffer.isBuffer(file.content) ? file.content : Buffer.from(String(file.content ?? ""), "utf8");
    const crc = crc32(data);
    const dosTime = 0x21; // 1980-01-01 00:00:00, deterministic
    const dosDate = 0x21;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // UTF-8 names
    local.writeUInt16LE(0, 8);           // store
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);          // extra length
    parts.push(local, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);  // version made by
    centralHeader.writeUInt16LE(20, 6);  // version needed
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);  // store
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, name);
    offset += 30 + name.length + data.length;
  }

  const centralStart = offset;
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  for (const part of central) parts.push(part);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  parts.push(end);

  return Buffer.concat(parts);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Minimal ZIP reader for tests: returns { path -> Buffer } for stored entries.
 * @param {Buffer} buffer
 */
export function readZip(buffer) {
  const files = {};
  let cursor = 0;
  while (cursor + 30 <= buffer.length) {
    const signature = buffer.readUInt32LE(cursor);
    if (signature !== 0x04034b50) break;
    const nameLength = buffer.readUInt16LE(cursor + 26);
    const extraLength = buffer.readUInt16LE(cursor + 28);
    const size = buffer.readUInt32LE(cursor + 18);
    const name = buffer.toString("utf8", cursor + 30, cursor + 30 + nameLength);
    const data = buffer.subarray(cursor + 30 + nameLength + extraLength, cursor + 30 + nameLength + extraLength + size);
    files[name] = Buffer.from(data);
    cursor += 30 + nameLength + extraLength + size;
  }
  return files;
}
