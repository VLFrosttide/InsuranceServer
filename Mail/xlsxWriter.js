"use strict";
// Minimal, dependency-free Excel (.xlsx) writer for the server.
//
// Port of the client's renderer/WorkPage/xlsxWriter.js: it builds a single-sheet
// OOXML workbook (a ZIP archive of XML documents) entirely in memory. Entries
// are "stored" (not compressed), which every spreadsheet program accepts.
//
//   buildXlsxFile({ sheetName, columns, rows }) -> Buffer (the .xlsx bytes)
//     columns: [{ label: string, width?: number }]   (header row, bold + frozen)
//     rows:    [[cell, ...], ...] where a cell is
//                null/undefined/""                 -> empty cell
//                number                            -> numeric cell
//                string                            -> text cell
//                { value: number, style: "money" } -> number shown as 0.00
//                { value: number, style: "date" }  -> Excel date serial shown
//                                                     as dd-mm-yyyy hh:mm
//
// The bills are the only user of this: a broker gets a real .xlsx file that
// Excel, LibreOffice and Google Sheets open without a format warning.

const XLSX_STYLE = { header: 1, money: 2, date: 3 };

// --- ZIP (stored entries) ----------------------------------------------------

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStored(files) {
  const now = new Date();
  const dosTime =
    (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate =
    ((Math.max(now.getFullYear(), 1980) - 1980) << 9) |
    ((now.getMonth() + 1) << 5) |
    now.getDate();

  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const data = Buffer.from(file.content, "utf8");
    const crc = crc32(data);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8); // flags: UTF-8 names
    central.writeUInt16LE(0, 10); // method: stored
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    // extra/comment length, disk start and attributes stay 0.
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);

    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }

  const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, ...centrals, eocd]);
}

// --- XML / cell helpers ------------------------------------------------------

function xmlEscape(value) {
  return (
    String(value)
      // Control characters are not allowed in XML 1.0.
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
  );
}

// Zero-based column index -> "A", "B", ..., "Z", "AA", ...
function columnName(index) {
  let n = index + 1;
  let name = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

// Excel sheet names: at most 31 characters, none of []:*?/\ and not blank.
function sheetName(name) {
  const clean = String(name || "")
    .replace(/[\[\]:*?/\\]/g, " ")
    .trim()
    .slice(0, 31);
  return clean || "Sheet1";
}

// Excel serial (days since 1899-12-30) of a Date's LOCAL wall-clock time.
function dateSerial(date) {
  if (
    Object.prototype.toString.call(date) !== "[object Date]" ||
    !Number.isFinite(date.getTime())
  ) {
    return null;
  }
  const utc = Date.UTC(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds()
  );
  return (utc - Date.UTC(1899, 11, 30)) / 86400000;
}

function cellXml(ref, cell, defaultStyle) {
  if (cell === undefined || cell === null || cell === "") return "";
  let value = cell;
  let style = defaultStyle || 0;
  if (typeof cell === "object") {
    value = cell.value;
    style = XLSX_STYLE[cell.style] || style;
    if (value === undefined || value === null || value === "") return "";
  }
  const s = style ? ` s="${style}"` : "";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    return `<c r="${ref}"${s}><v>${value}</v></c>`;
  }
  return (
    `<c r="${ref}"${s} t="inlineStr"><is>` +
    `<t xml:space="preserve">${xmlEscape(value)}</t></is></c>`
  );
}


// --- workbook ----------------------------------------------------------------

const XML_HEAD = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`;
const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";

/**
 * Build a one-sheet .xlsx workbook.
 *
 * @param {{sheetName?: string, columns?: Array<{label: string, width?: number}>,
 *          rows?: Array<Array<any>>}} [spec]
 * @returns {Buffer} the file bytes
 */
function buildXlsxFile({ sheetName: name, columns, rows, widths } = {}) {
  const cols = Array.isArray(columns) ? columns : [];
  const body = Array.isArray(rows) ? rows : [];
  const sheet = sheetName(name);
  const lastCol = columnName(Math.max(cols.length, 1) - 1);
  const lastRow = body.length + (cols.length ? 1 : 0);

  const sheetRows = [];
  if (cols.length) {
    sheetRows.push(
      `<row r="1">` +
        cols
          .map((c, i) =>
            cellXml(`${columnName(i)}1`, c.label ?? "", XLSX_STYLE.header)
          )
          .join("") +
        `</row>`
    );
  }
  const bodyStart = cols.length ? 2 : 1;
  body.forEach((cells, r) => {
    const rowNo = r + bodyStart;
    sheetRows.push(
      `<row r="${rowNo}">` +
        (cells || [])
          .map((cell, i) => cellXml(`${columnName(i)}${rowNo}`, cell))
          .join("") +
        `</row>`
    );
  });

  // Column widths: `widths` (a plain list) works for a sheet without a header
  // row, `columns[].width` for the ordinary tabular one.
  const widthList = Array.isArray(widths)
    ? widths
    : cols.map((c) => (c && c.width) || 0);
  const colsXml = widthList.length
    ? `<cols>` +
      widthList
        .map((w, i) => {
          const width = Number(w) > 0 ? Number(w) : 14;
          return `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`;
        })
        .join("") +
      `</cols>`
    : "";

  // Header row frozen + an auto-filter over the whole table.
  const sheetXml =
    XML_HEAD +
    `<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
    `<sheetViews><sheetView workbookViewId="0">` +
    (cols.length
      ? `<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>`
      : "") +
    `</sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>` +
    colsXml +
    `<sheetData>${sheetRows.join("")}</sheetData>` +
    (cols.length ? `<autoFilter ref="A1:${lastCol}${lastRow}"/>` : "") +
    `</worksheet>`;

  const quotedName = `'${sheet.replace(/'/g, "''")}'`;
  const workbookXml =
    XML_HEAD +
    `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
    `<sheets><sheet name="${xmlEscape(sheet)}" sheetId="1" r:id="rId1"/></sheets>` +
    (cols.length
      ? `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">` +
        `${xmlEscape(quotedName)}!$A$1:$${lastCol}$${lastRow}` +
        `</definedName></definedNames>`
      : "") +
    `</workbook>`;


  // cellXfs indexes must match XLSX_STYLE: 1 = bold header, 2 = "0.00",
  // 3 = "dd-mm-yyyy hh:mm".
  const stylesXml =
    XML_HEAD +
    `<styleSheet xmlns="${NS_MAIN}">` +
    `<numFmts count="1"><numFmt numFmtId="164" formatCode="dd-mm-yyyy hh:mm"/></numFmts>` +
    `<fonts count="2">` +
    `<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>` +
    `<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>` +
    `</fonts>` +
    `<fills count="2"><fill><patternFill patternType="none"/></fill>` +
    `<fill><patternFill patternType="gray125"/></fill></fills>` +
    `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="4">` +
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
    `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
    `<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
    `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
    `</cellXfs>` +
    `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
    `</styleSheet>`;

  const ct = "application/vnd.openxmlformats-officedocument.spreadsheetml";
  const contentTypesXml =
    XML_HEAD +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="${ct}.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="${ct}.worksheet+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="${ct}.styles+xml"/>` +
    `</Types>`;

  const rootRelsXml =
    XML_HEAD +
    `<Relationships xmlns="${NS_PKG_REL}">` +
    `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;

  const workbookRelsXml =
    XML_HEAD +
    `<Relationships xmlns="${NS_PKG_REL}">` +
    `<Relationship Id="rId1" Type="${NS_REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="${NS_REL}/styles" Target="styles.xml"/>` +
    `</Relationships>`;

  return zipStored([
    { name: "[Content_Types].xml", content: contentTypesXml },
    { name: "_rels/.rels", content: rootRelsXml },
    { name: "xl/workbook.xml", content: workbookXml },
    { name: "xl/_rels/workbook.xml.rels", content: workbookRelsXml },
    { name: "xl/styles.xml", content: stylesXml },
    { name: "xl/worksheets/sheet1.xml", content: sheetXml },
  ]);
}

module.exports = { buildXlsxFile, dateSerial, XLSX_STYLE };

