// Minimal, DEPENDENCY-FREE PDF generator (text-only, standard Helvetica fonts).
//
// Why hand-rolled: on a serverless host a real PDF must be produced without a
// headless browser (puppeteer/chromium is ~50MB + cold-start heavy and blows the
// function budget) and without native deps. A booking confirmation is essentially
// styled text, so we emit a valid PDF 1.4 by hand using the two built-in base-14
// fonts (Helvetica / Helvetica-Bold) with WinAnsi encoding — no font embedding,
// tiny output, instant. It supports a title, headings, key/value rows (value
// right-aligned to the margin), paragraphs (word-wrapped) and rules, across as
// many A4 pages as the content needs.

const PAGE_W = 595.28; // A4 in points
const PAGE_H = 841.89;
const MARGIN = 48;
const TOP = PAGE_H - 56;
const BOTTOM = 60;

// Approximate Helvetica advance widths (per 1000 units) for the ASCII range —
// good enough to right-align a price to the margin. Unknown glyphs fall back to
// an average width. (We only need alignment, not exact justification.)
const W = { ' ': 278, '!': 278, '"': 355, '#': 556, '$': 556, '%': 889, '&': 667, "'": 191, '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278, '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556, '8': 556, '9': 556, ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556, '@': 1015, A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500, K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611, '[': 278, '\\': 278, ']': 278, '^': 469, _: 556, '`': 333, a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556, v: 500, w: 722, x: 500, y: 500, z: 500, '{': 334, '|': 260, '}': 334, '~': 584, '£': 556 };

function textWidth(str, size) {
  let w = 0;
  for (const ch of String(str)) w += (W[ch] != null ? W[ch] : 556);
  return (w / 1000) * size;
}

// Downgrade to WinAnsi-safe characters: normalise common unicode punctuation to
// ASCII, keep Latin-1 (so the £ sign survives), and drop anything else (emoji,
// CJK) so the byte stream can never produce a broken glyph.
function toWinAnsi(str) {
  return String(str == null ? '' : str)
    .replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/…/g, '...').replace(/•/g, '-').replace(/✓/g, 'v').replace(/[ ]/g, ' ')
    .split('').filter((ch) => ch.charCodeAt(0) <= 0xff).join('');
}
function escPdf(str) { return toWinAnsi(str).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)'); }

function wrap(str, size, maxWidth) {
  const words = toWinAnsi(str).split(/\s+/).filter(Boolean);
  const lines = []; let cur = '';
  for (const word of words) {
    const cand = cur ? `${cur} ${word}` : word;
    if (textWidth(cand, size) > maxWidth && cur) { lines.push(cur); cur = word; }
    else cur = cand;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

// blocks: array of
//   { type:'title', text }
//   { type:'subtitle', text }
//   { type:'heading', text }
//   { type:'row', label, value }         value right-aligned to the margin
//   { type:'para', text }
//   { type:'rule' }
//   { type:'space', h }
export function renderPdf(blocks) {
  const contentWidth = PAGE_W - MARGIN * 2;
  const pages = [];
  let ops = [];
  let y = TOP;
  const gray = '0.42 0.42 0.42 rg';
  const ink = '0.10 0.10 0.11 rg';
  const gold = '0.72 0.58 0.30 rg';

  const newPage = () => { pages.push(ops.join('\n')); ops = []; y = TOP; };
  const need = (h) => { if (y - h < BOTTOM) newPage(); };
  const put = (x, yy, size, font, color, text) => {
    ops.push(`BT\n${color}\n/${font} ${size} Tf\n1 0 0 1 ${x.toFixed(2)} ${yy.toFixed(2)} Tm\n(${escPdf(text)}) Tj\nET`);
  };

  for (const b of blocks) {
    if (b.type === 'title') { need(26); put(MARGIN, y, 20, 'F2', ink, b.text); y -= 26; }
    else if (b.type === 'subtitle') { need(15); put(MARGIN, y, 10.5, 'F1', gray, b.text); y -= 16; }
    else if (b.type === 'heading') { y -= 6; need(18); put(MARGIN, y, 12.5, 'F2', gold, b.text); y -= 17; }
    else if (b.type === 'rule') { need(10); ops.push(`0.85 0.85 0.85 RG\n0.7 w\n${MARGIN} ${y.toFixed(2)} m ${(PAGE_W - MARGIN).toFixed(2)} ${y.toFixed(2)} l S`); y -= 10; }
    else if (b.type === 'space') { y -= (b.h || 8); }
    else if (b.type === 'row') {
      const size = 10.5; need(15);
      put(MARGIN, y, size, 'F1', gray, b.label || '');
      const val = String(b.value == null ? '' : b.value);
      const vx = PAGE_W - MARGIN - textWidth(toWinAnsi(val), size);
      put(Math.max(MARGIN + textWidth(b.label || '', size) + 10, vx), y, size, b.strong ? 'F2' : 'F1', b.strong ? ink : ink, val);
      y -= 15;
    } else if (b.type === 'para') {
      const size = b.size || 10;
      for (const ln of wrap(b.text || '', size, contentWidth)) { need(size + 4); put(MARGIN, y, size, 'F1', b.muted ? gray : ink, ln); y -= size + 4; }
    }
  }
  newPage();

  // ---- assemble the PDF objects ----
  const objs = [];
  const add = (s) => { objs.push(s); return objs.length; }; // 1-indexed object number

  const catalogNo = add(''); // 1
  const pagesNo = add('');   // 2
  const fontF1No = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const fontF2No = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

  const pageNos = [];
  for (const content of pages) {
    const streamNo = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
    const pageNo = add(`<< /Type /Page /Parent ${pagesNo} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${fontF1No} 0 R /F2 ${fontF2No} 0 R >> >> /Contents ${streamNo} 0 R >>`);
    pageNos.push(pageNo);
  }
  objs[catalogNo - 1] = `<< /Type /Catalog /Pages ${pagesNo} 0 R >>`;
  objs[pagesNo - 1] = `<< /Type /Pages /Kids [${pageNos.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageNos.length} >>`;

  // ---- serialise with a cross-reference table ----
  let pdf = '%PDF-1.4\n%âãÏÓ\n';
  const offsets = [];
  for (let i = 0; i < objs.length; i++) {
    offsets[i] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 0; i < objs.length; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root ${catalogNo} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return Buffer.from(pdf, 'latin1');
}
