// server/export/workbook.js
// 生成 XLSX Buffer（内存中完成，不落盘）。
// xlsx 0.18 CE 不支持冻结表头，因此生成后对 zip 内的 sheet XML 打补丁加入 pane。

import zlib from "node:zlib";

import XLSX from "xlsx";

export const SHEET_KEYS = ["summary", "sessions", "events", "walks", "violations"];
export const SHEET_TITLES = {
  summary: "导出说明",
  sessions: "会话数据",
  events: "事件明细",
  walks: "通行按键",
  violations: "闯红灯记录"
};

/**
 * 生成 XLSX Buffer。
 * data: transformExportRows 的输出（{ sessions, events, walks, violations }，各含 headers/rows）
 *       + summaryRows（导出说明 AOA）
 * options: { sheets: SHEET_KEYS 子集（非空）, timeRange: { from, to } }
 */
export function buildWorkbookBuffer(data, options) {
  const wb = XLSX.utils.book_new();

  for (const key of options.sheets) {
    let ws;
    if (key === "summary") {
      ws = XLSX.utils.aoa_to_sheet(data.summaryRows);
      ws["!cols"] = [{ wch: 16 }, { wch: 110 }];
    } else {
      const part = data[key];
      ws = makeDataSheet(part.headers, part.rows);
    }
    XLSX.utils.book_append_sheet(wb, ws, SHEET_TITLES[key]);
  }

  const buffer = XLSX.write(wb, {
    type: "buffer",
    bookType: "xlsx",
    compression: true
  });

  return applyFrozenHeaderPane(buffer, options.sheets.length);
}

function makeDataSheet(headers, rows) {
  let ws;
  if (rows.length === 0) {
    ws = XLSX.utils.aoa_to_sheet([headers]);
  } else {
    ws = XLSX.utils.json_to_sheet(rows, { header: headers });
  }

  const range = XLSX.utils.decode_range(ws["!ref"]);
  ws["!autofilter"] = { ref: XLSX.utils.encode_range(range) };
  ws["!cols"] = headers.map((header, colIdx) => ({
    wch: computeColumnWidth(header, rows, colIdx)
  }));
  return ws;
}

function computeColumnWidth(header, rows, colIdx) {
  let width = displayWidth(header);
  const limit = Math.min(rows.length, 200);
  for (let i = 0; i < limit; i += 1) {
    const value = rows[i][header];
    width = Math.max(width, displayWidth(value));
  }
  return Math.min(Math.max(width, 8), 60);
}

function displayWidth(value) {
  if (value === null || value === undefined) return 0;
  const text = String(value);
  let width = 0;
  for (const ch of text) {
    width += /[\u0000-\u00ff]/.test(ch) ? 1 : 2;
  }
  return width + 2;
}

// ---------------------------------------------------------------------------
// 冻结表头：向每个工作表 sheetView 注入 <pane>（zip 级补丁）
// ---------------------------------------------------------------------------

const PANE_XML = '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>';
const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

/**
 * 读取 zip 条目（供补丁与测试共用）。
 * 返回 Map<entryName, { method, flags, crc, compSize, uncompSize, data }>，
 * data 为解压后的原始内容。
 */
export function readZipEntries(buffer) {
  const entries = new Map();
  const eocd = findEocd(buffer);
  if (!eocd) throw new Error("zip: EOCD not found");

  let offset = eocd.cdOffset;
  for (let i = 0; i < eocd.entryCount; i += 1) {
    if (buffer.readUInt32LE(offset) !== SIG_CENTRAL) {
      throw new Error("zip: bad central directory signature");
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compSize = buffer.readUInt32LE(offset + 20);
    const uncompSize = buffer.readUInt32LE(offset + 24);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLen);

    const local = parseLocalHeader(buffer, localOffset);
    const raw = buffer.subarray(local.dataOffset, local.dataOffset + compSize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : method === 0 ? Buffer.from(raw) : null;
    if (data === null) throw new Error(`zip: unsupported compression method ${method} for ${name}`);

    entries.set(name, { name, method, flags, crc, compSize, uncompSize, data });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 把解压后的条目数据写回 zip（只重写给定条目，其余原样复制）。 */
export function writeZipEntries(buffer, patches) {
  const entries = readZipEntries(buffer);
  for (const [name, data] of Object.entries(patches)) {
    if (!entries.has(name)) throw new Error(`zip: entry not found: ${name}`);
    const entry = entries.get(name);
    entry.data = Buffer.from(data);
    entry.uncompSize = entry.data.length;
    entry.method = 8;
    entry.crc = crc32(entry.data);
    entry.compSize = zlib.deflateRawSync(entry.data).length;
  }

  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries.values()) {
    const compressed =
      entry.method === 8 ? zlib.deflateRawSync(entry.data) : Buffer.from(entry.data);
    entry.compSize = compressed.length;
    entry.crc = crc32(entry.data);

    const nameBuf = Buffer.from(entry.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(entry.flags & ~0x0008, 6); // 清除 data descriptor 位
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt32LE(entry.crc, 14);
    local.writeUInt32LE(entry.compSize, 18);
    local.writeUInt32LE(entry.uncompSize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra

    chunks.push(local, nameBuf, compressed);

    const centralEntry = Buffer.alloc(46);
    centralEntry.writeUInt32LE(SIG_CENTRAL, 0);
    centralEntry.writeUInt16LE(20, 4); // version made by
    centralEntry.writeUInt16LE(20, 6); // version needed
    centralEntry.writeUInt16LE(entry.flags & ~0x0008, 8);
    centralEntry.writeUInt16LE(entry.method, 10);
    centralEntry.writeUInt32LE(entry.crc, 16);
    centralEntry.writeUInt32LE(entry.compSize, 20);
    centralEntry.writeUInt32LE(entry.uncompSize, 24);
    centralEntry.writeUInt16LE(nameBuf.length, 28);
    centralEntry.writeUInt16LE(0, 30); // extra
    centralEntry.writeUInt16LE(0, 32); // comment
    centralEntry.writeUInt32LE(offset, 42); // local header offset
    central.push(centralEntry, nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralSize = central.reduce((sum, buf) => sum + buf.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(entries.size, 8);
  eocd.writeUInt16LE(entries.size, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...chunks, ...central, eocd]);
}

function applyFrozenHeaderPane(buffer, sheetCount) {
  const entries = readZipEntries(buffer);
  const patches = {};
  for (let i = 1; i <= sheetCount; i += 1) {
    const xml = entries.get(`xl/worksheets/sheet${i}.xml`)?.data;
    patches[`xl/worksheets/sheet${i}.xml`] = injectFrozenPane(xml ? xml.toString("utf8") : "");
  }
  return writeZipEntries(buffer, patches);
}

function injectFrozenPane(xml) {
  const openTagStart = xml.indexOf("<sheetView");
  if (openTagStart === -1) return xml;
  const openTagEnd = xml.indexOf(">", openTagStart);
  if (openTagEnd === -1) return xml;

  if (xml.charCodeAt(openTagEnd - 1) === 47 /* '/' 自闭合 */) {
    return (
      xml.slice(0, openTagEnd - 1) + `>${PANE_XML}</sheetView>` + xml.slice(openTagEnd + 1)
    );
  }
  return xml.slice(0, openTagEnd + 1) + PANE_XML + xml.slice(openTagEnd + 1);
}

function findEocd(buffer) {
  const minPos = Math.max(0, buffer.length - 22 - 65535);
  for (let i = buffer.length - 22; i >= minPos; i -= 1) {
    if (buffer.readUInt32LE(i) === SIG_EOCD) {
      return {
        entryCount: buffer.readUInt16LE(i + 10),
        cdOffset: buffer.readUInt32LE(i + 16)
      };
    }
  }
  return null;
}

function parseLocalHeader(buffer, localOffset) {
  if (buffer.readUInt32LE(localOffset) !== SIG_LOCAL) {
    throw new Error("zip: bad local header signature");
  }
  const nameLen = buffer.readUInt16LE(localOffset + 26);
  const extraLen = buffer.readUInt16LE(localOffset + 28);
  return { dataOffset: localOffset + 30 + nameLen + extraLen };
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

export function crc32(data) {
  let crc = -1;
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}
