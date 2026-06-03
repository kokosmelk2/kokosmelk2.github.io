/**
 * VaseLife Report Generator - generate_report.js
 * Called by main.py: node generate_report.js <payload.json> <output.docx>
 */

const fs = require("fs");
const path = require("path");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  ImageRun, AlignmentType, LevelFormat, BorderStyle, WidthType,
  ShadingType, VerticalAlign, PageBreak, HeadingLevel, PageNumber,
  Header, Footer, TabStopType, TabStopPosition
} = require("docx");

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

const PAGE_WIDTH_DXA = 11906;  // A4
const PAGE_HEIGHT_DXA = 16838;
const MARGIN_DXA = 1134;       // ~2cm margins
const CONTENT_WIDTH = PAGE_WIDTH_DXA - MARGIN_DXA * 2; // 9638

const COLORS = {
  primary: "1A5276",
  headerBg: "1A5276",
  headerText: "FFFFFF",
  green: "C6EFCE",
  greenText: "276221",
  lightGray: "F2F2F2",
  borderGray: "CCCCCC",
  textDark: "222222",
  textMid: "555555",
};

const BORDER = { style: BorderStyle.SINGLE, size: 1, color: COLORS.borderGray };
const BORDERS = { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER };
const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const NO_BORDERS = { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER };

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function fmt(val, decimals = 2, suffix = "") {
  if (val === null || val === undefined || val === "n/a") return "n/a";
  const n = parseFloat(val);
  if (isNaN(n)) return "n/a";
  return n.toFixed(decimals) + suffix;
}

function fmtPct(val) {
  if (val === null || val === undefined) return "n/a";
  return parseFloat(val).toFixed(1) + "%";
}

function isGreen(avg_cts, pct_lt7) {
  const cts = parseFloat(avg_cts);
  const pct = parseFloat(pct_lt7);
  return !isNaN(cts) && !isNaN(pct) && cts > 3 && pct === 0;
}

function spacer(pt = 6) {
  return new Paragraph({ spacing: { before: 0, after: pt * 20 }, children: [] });
}

function cell(text, opts = {}) {
  const {
    bold = false, size = 18, color = COLORS.textDark, align = AlignmentType.LEFT,
    shade = null, shadeColor = null, width = null, borders = BORDERS,
    colSpan = 1, rowSpan = 1, verticalAlign = VerticalAlign.CENTER,
  } = opts;

  const cellOpts = {
    borders,
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    verticalAlign,
    children: [new Paragraph({
      alignment: align,
      children: [new TextRun({ text: String(text), bold, size, font: "Arial", color })],
    })],
  };

  if (shade && shadeColor) {
    cellOpts.shading = { fill: shadeColor, type: ShadingType.CLEAR };
  }
  if (width) {
    cellOpts.width = { size: width, type: WidthType.DXA };
  }
  if (colSpan > 1) cellOpts.columnSpan = colSpan;

  return new TableCell(cellOpts);
}

// ─── BULLET LOGIC ────────────────────────────────────────────────────────────

function generateBullets(subgroupName, varieties) {
  const validCts = varieties.filter(v => v.avg_cts !== null && !isNaN(parseFloat(v.avg_cts)));
  const validVl = varieties.filter(v => v.avg_vaselife !== null && !isNaN(parseFloat(v.avg_vaselife)));
  const validPct = varieties.filter(v => v.pct_lt7 !== null && !isNaN(parseFloat(v.pct_lt7)));

  // Subgroup totals
  const totalTests = varieties.reduce((s, v) => s + (v.num_tests || 0), 0);
  const avgCts = validCts.length > 0
    ? validCts.reduce((s, v) => s + parseFloat(v.avg_cts), 0) / validCts.length : null;
  const avgVl = validVl.length > 0
    ? validVl.reduce((s, v) => s + parseFloat(v.avg_vaselife), 0) / validVl.length : null;
  const avgPct = validPct.length > 0
    ? validPct.reduce((s, v) => s + parseFloat(v.pct_lt7), 0) / validPct.length : null;
  const avgBot = varieties.reduce((s, v) => s + (parseFloat(v.avg_botrytis) || 0), 0) / (varieties.length || 1);

  const missingCts = totalTests - validCts.reduce((s, v) => s + v.num_tests, 0);

  // CTS bullet
  let ctsBullet;
  if (avgCts !== null && avgCts > 3) {
    ctsBullet = `CTS Performance: Average CTS is ${avgCts.toFixed(2)}, which meets the target threshold of >3.` +
      (missingCts > 0 ? ` CTS is missing for ${missingCts} vase(s) in this subgroup.` : "");
  } else if (avgCts !== null) {
    ctsBullet = `CTS Performance: Average CTS is ${avgCts.toFixed(2)}, which is below the target threshold of >3.` +
      (missingCts > 0 ? ` CTS is missing for ${missingCts} vase(s) in this subgroup.` : "");
  } else {
    ctsBullet = `CTS Performance: CTS data is not available for this subgroup.`;
  }

  // Botrytis bullet
  let botBullet;
  if (avgPct !== null) {
    const concerning = avgPct > 0;
    botBullet = `Botrytis/Stem Failure: Average %<7 is ${avgPct.toFixed(1)}%, ` +
      (concerning ? `which is concerning because the target is 0%; ` : `which meets the 0% target; `) +
      `average botrytis is ${avgBot.toFixed(1)}%.`;
  } else {
    botBullet = `Botrytis/Stem Failure: Botrytis data is not available for this subgroup.`;
  }

  // Best/worst bullet
  let perfBullet;
  if (validCts.length > 0 || validPct.length > 0) {
    const sortedByCts = [...validCts].sort((a, b) => parseFloat(b.avg_cts) - parseFloat(a.avg_cts));
    const bestCts = sortedByCts[0];
    const sortedByPct = [...validPct].sort((a, b) => parseFloat(b.pct_lt7) - parseFloat(a.pct_lt7));
    const worstPct = sortedByPct[0];

    const parts = [];
    if (bestCts) {
      parts.push(`Highest Average CTS is ${parseFloat(bestCts.avg_cts).toFixed(2)} for ${bestCts.variety} (${bestCts.colour})`);
    }
    if (worstPct) {
      parts.push(`highest Average %<7 is ${parseFloat(worstPct.pct_lt7).toFixed(1)}% for ${worstPct.variety} (${worstPct.colour})`);
    }
    perfBullet = "Best and Worst Performers: " + parts.join("; ") + ".";
  } else {
    perfBullet = "Best and Worst Performers: Insufficient data to determine performance ranking.";
  }

  // Additional insight bullet
  let insightBullet;
  const vlTarget = 7;
  if (avgVl !== null) {
    const below = avgVl < vlTarget;
    insightBullet = `Additional Critical Insight: Average vaselife is ${avgVl.toFixed(2)} days, ` +
      (below ? `below the >${vlTarget} days target. ` : `meeting the >${vlTarget} days target. `);
    if (validPct.length > 0) {
      const minPct = Math.min(...validPct.map(v => parseFloat(v.pct_lt7)));
      const maxPct = Math.max(...validPct.map(v => parseFloat(v.pct_lt7)));
      insightBullet += `Variety-level Average %<7 ranges from ${minPct.toFixed(1)}% to ${maxPct.toFixed(1)}% in this subgroup.`;
    }
  } else {
    insightBullet = "Additional Critical Insight: Vaselife data is not available for this subgroup.";
  }

  return [ctsBullet, botBullet, perfBullet, insightBullet];
}

// ─── COVER PAGE ───────────────────────────────────────────────────────────────

function buildCoverPage(grower, period, logoPath) {
  const children = [];

  // Logo
  if (logoPath && fs.existsSync(logoPath)) {
    try {
      const logoData = fs.readFileSync(logoPath);
      const ext = path.extname(logoPath).toLowerCase().replace(".", "");
      const typeMap = { png: "png", jpg: "jpg", jpeg: "jpg", gif: "gif" };
      children.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 2000, after: 600 },
        children: [new ImageRun({
          data: logoData,
          transformation: { width: 160, height: 80 },
          type: typeMap[ext] || "png",
        })],
      }));
    } catch (e) {
      // Logo failed, skip silently
    }
  } else {
    children.push(spacer(80));
  }

  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 600, after: 200 },
    children: [new TextRun({
      text: "Vase Life Quality Report",
      bold: true, size: 56, font: "Arial", color: COLORS.primary,
    })],
  }));

  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 200, after: 200 },
    children: [new TextRun({
      text: grower, bold: false, size: 36, font: "Arial", color: COLORS.textMid,
    })],
  }));

  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 200, after: 200 },
    children: [new TextRun({
      text: period, size: 28, font: "Arial", color: COLORS.textMid,
    })],
  }));

  children.push(new Paragraph({
    children: [new PageBreak()],
  }));

  return children;
}

// ─── SUMMARY TABLE ───────────────────────────────────────────────────────────

function buildSummarySection(overall) {
  const children = [];

  children.push(new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 0, after: 200 },
    children: [new TextRun({ text: "Overall Summary", bold: true, size: 32, font: "Arial", color: COLORS.primary })],
  }));

  // Col widths summing to CONTENT_WIDTH
  const colW = [1600, 2000, 2000, 1900, 2138];

  const headerRow = new TableRow({
    tableHeader: true,
    children: [
      cell("Total number of vases", { bold: true, size: 17, color: COLORS.headerText, shade: true, shadeColor: COLORS.headerBg, width: colW[0], align: AlignmentType.CENTER }),
      cell("Average CTS", { bold: true, size: 17, color: COLORS.headerText, shade: true, shadeColor: COLORS.headerBg, width: colW[1], align: AlignmentType.CENTER }),
      cell("Average vaselife", { bold: true, size: 17, color: COLORS.headerText, shade: true, shadeColor: COLORS.headerBg, width: colW[2], align: AlignmentType.CENTER }),
      cell("Average %<7", { bold: true, size: 17, color: COLORS.headerText, shade: true, shadeColor: COLORS.headerBg, width: colW[3], align: AlignmentType.CENTER }),
      cell("Average % botrytis", { bold: true, size: 17, color: COLORS.headerText, shade: true, shadeColor: COLORS.headerBg, width: colW[4], align: AlignmentType.CENTER }),
    ],
  });

  const dataRow = new TableRow({
    children: [
      cell(String(overall.total_vases), { width: colW[0], align: AlignmentType.CENTER }),
      cell(fmt(overall.avg_cts), { width: colW[1], align: AlignmentType.CENTER }),
      cell(fmt(overall.avg_vaselife), { width: colW[2], align: AlignmentType.CENTER }),
      cell(fmtPct(overall.pct_lt7), { width: colW[3], align: AlignmentType.CENTER }),
      cell(fmtPct(overall.avg_botrytis), { width: colW[4], align: AlignmentType.CENTER }),
    ],
  });

  children.push(new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: colW,
    rows: [headerRow, dataRow],
  }));

  children.push(new Paragraph({ children: [new PageBreak()] }));

  return children;
}

// ─── SUBGROUP PAGE ────────────────────────────────────────────────────────────

function buildSubgroupSection(subgroupName, varieties, multiVarieties) {
  const children = [];

  children.push(new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 0, after: 240 },
    children: [new TextRun({
      text: `Varieties Tested - ${subgroupName}`,
      bold: true, size: 32, font: "Arial", color: COLORS.primary,
    })],
  }));

  // Column widths
  const colW = [2000, 1400, 1200, 1300, 1400, 1200, 1138]; // sum = 9638

  // Header row
  const hRow = new TableRow({
    tableHeader: true,
    children: [
      cell("Variety", { bold: true, size: 17, color: COLORS.headerText, shade: true, shadeColor: COLORS.headerBg, width: colW[0] }),
      cell("Colour", { bold: true, size: 17, color: COLORS.headerText, shade: true, shadeColor: COLORS.headerBg, width: colW[1] }),
      cell("Number of tests", { bold: true, size: 17, color: COLORS.headerText, shade: true, shadeColor: COLORS.headerBg, width: colW[2], align: AlignmentType.CENTER }),
      cell("Average CTS", { bold: true, size: 17, color: COLORS.headerText, shade: true, shadeColor: COLORS.headerBg, width: colW[3], align: AlignmentType.CENTER }),
      cell("Average vaselife", { bold: true, size: 17, color: COLORS.headerText, shade: true, shadeColor: COLORS.headerBg, width: colW[4], align: AlignmentType.CENTER }),
      cell("Average %<7", { bold: true, size: 17, color: COLORS.headerText, shade: true, shadeColor: COLORS.headerBg, width: colW[5], align: AlignmentType.CENTER }),
      cell("Average % botrytis", { bold: true, size: 17, color: COLORS.headerText, shade: true, shadeColor: COLORS.headerBg, width: colW[6], align: AlignmentType.CENTER }),
    ],
  });

  // Data rows
  const dataRows = varieties.map(v => {
    const green = isGreen(v.avg_cts, v.pct_lt7);
    const shade = green ? true : false;
    const shadeColor = green ? COLORS.green : null;
    const textColor = green ? COLORS.greenText : COLORS.textDark;

    return new TableRow({
      children: [
        cell(v.variety, { width: colW[0], shade, shadeColor, color: textColor }),
        cell(v.colour, { width: colW[1], shade, shadeColor, color: textColor }),
        cell(String(v.num_tests), { width: colW[2], align: AlignmentType.CENTER, shade, shadeColor, color: textColor }),
        cell(fmt(v.avg_cts), { width: colW[3], align: AlignmentType.CENTER, shade, shadeColor, color: textColor }),
        cell(fmt(v.avg_vaselife), { width: colW[4], align: AlignmentType.CENTER, shade, shadeColor, color: textColor }),
        cell(fmtPct(v.pct_lt7), { width: colW[5], align: AlignmentType.CENTER, shade, shadeColor, color: textColor }),
        cell(fmtPct(v.avg_botrytis), { width: colW[6], align: AlignmentType.CENTER, shade, shadeColor, color: textColor }),
      ],
    });
  });

  // Total row
  const validCts = varieties.filter(v => v.avg_cts !== null && !isNaN(parseFloat(v.avg_cts)));
  const validVl = varieties.filter(v => v.avg_vaselife !== null && !isNaN(parseFloat(v.avg_vaselife)));
  const validPct = varieties.filter(v => v.pct_lt7 !== null && !isNaN(parseFloat(v.pct_lt7)));
  const totalTests = varieties.reduce((s, v) => s + (v.num_tests || 0), 0);
  const totalAvgCts = validCts.length > 0 ? validCts.reduce((s, v) => s + parseFloat(v.avg_cts), 0) / validCts.length : null;
  const totalAvgVl = validVl.length > 0 ? validVl.reduce((s, v) => s + parseFloat(v.avg_vaselife), 0) / validVl.length : null;
  const totalPct = validPct.length > 0 ? validPct.reduce((s, v) => s + parseFloat(v.pct_lt7), 0) / validPct.length : null;
  const totalBot = varieties.reduce((s, v) => s + (parseFloat(v.avg_botrytis) || 0), 0) / (varieties.length || 1);

  const totalRow = new TableRow({
    children: [
      cell("TOTAL", { bold: true, width: colW[0], shade: true, shadeColor: COLORS.lightGray }),
      cell("", { width: colW[1], shade: true, shadeColor: COLORS.lightGray }),
      cell(String(totalTests), { bold: true, width: colW[2], align: AlignmentType.CENTER, shade: true, shadeColor: COLORS.lightGray }),
      cell(fmt(totalAvgCts), { bold: true, width: colW[3], align: AlignmentType.CENTER, shade: true, shadeColor: COLORS.lightGray }),
      cell(fmt(totalAvgVl), { bold: true, width: colW[4], align: AlignmentType.CENTER, shade: true, shadeColor: COLORS.lightGray }),
      cell(fmtPct(totalPct), { bold: true, width: colW[5], align: AlignmentType.CENTER, shade: true, shadeColor: COLORS.lightGray }),
      cell(fmtPct(totalBot), { bold: true, width: colW[6], align: AlignmentType.CENTER, shade: true, shadeColor: COLORS.lightGray }),
    ],
  });

  children.push(new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: colW,
    rows: [hRow, ...dataRows, totalRow],
  }));

  children.push(spacer(8));

  // Footnotes for multi-subgroup varieties
  const footnotes = varieties
    .filter(v => multiVarieties[v.variety] && multiVarieties[v.variety].length > 1)
    .map(v => {
      const others = [...new Set(multiVarieties[v.variety])].filter(s => s !== subgroupName);
      return `* ${v.variety} also appears in ${others.join(", ")}`;
    });

  const seenFootnotes = new Set();
  footnotes.forEach(fn => {
    if (!seenFootnotes.has(fn)) {
      seenFootnotes.add(fn);
      children.push(new Paragraph({
        spacing: { before: 60, after: 60 },
        children: [new TextRun({ text: fn, italics: true, size: 16, font: "Arial", color: COLORS.textMid })],
      }));
    }
  });

  if (seenFootnotes.size > 0) children.push(spacer(4));

  // 4 Bullet points
  const bullets = generateBullets(subgroupName, varieties);
  bullets.forEach(b => {
    children.push(new Paragraph({
      bullet: { level: 0 },
      spacing: { before: 80, after: 80 },
      children: [new TextRun({ text: b, size: 18, font: "Arial", color: COLORS.textDark })],
    }));
  });

  children.push(new Paragraph({ children: [new PageBreak()] }));

  return children;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const [,, payloadPath, outputPath] = process.argv;

  if (!payloadPath || !outputPath) {
    console.error("Usage: node generate_report.js <payload.json> <output.docx>");
    process.exit(1);
  }

  const payload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
  const { grower, period, overall, subgroups, multi_subgroup_varieties, logo_path } = payload;

  const allChildren = [];

  // Cover page
  allChildren.push(...buildCoverPage(grower, period, logo_path));

  // Summary page
  allChildren.push(...buildSummarySection(overall));

  // One page per subgroup
  for (const [sgName, varieties] of Object.entries(subgroups)) {
    allChildren.push(...buildSubgroupSection(sgName, varieties, multi_subgroup_varieties || {}));
  }

  const doc = new Document({
    styles: {
      default: {
        document: { run: { font: "Arial", size: 20 } },
      },
      paragraphStyles: [
        {
          id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
          run: { size: 32, bold: true, font: "Arial", color: COLORS.primary },
          paragraph: { spacing: { before: 240, after: 200 }, outlineLevel: 0 },
        },
      ],
    },
    numbering: {
      config: [{
        reference: "bullets",
        levels: [{
          level: 0, format: LevelFormat.BULLET, text: "\u2022",
          alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 480, hanging: 240 } } },
        }],
      }],
    },
    sections: [{
      properties: {
        page: {
          size: { width: PAGE_WIDTH_DXA, height: PAGE_HEIGHT_DXA },
          margin: { top: MARGIN_DXA, right: MARGIN_DXA, bottom: MARGIN_DXA, left: MARGIN_DXA },
        },
      },
      children: allChildren,
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);
  console.log("OK: " + outputPath);
}

main().catch(e => { console.error(e.message); process.exit(1); });
