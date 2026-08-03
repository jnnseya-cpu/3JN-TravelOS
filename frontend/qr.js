// Minimal, dependency-free QR code generator — byte mode, error-correction
// level M, versions 1–6 (enough for the short share URLs 3JN builds). Pure: no
// DOM, no network, no npm — so it runs identically in the browser (assigns
// window.qrSvg) and under Node for tests (ES exports). Implements the standard
// (ISO/IEC 18004) so a real scanner reads it; still, scan-test one on a phone
// before trusting it in print.
//
// The share URLs we encode are short (~40–60 chars), so a small, dense code
// that scans reliably is the whole point — that's why the version range is
// capped low rather than trying to be a general QR library.

// ---- GF(256) arithmetic (primitive polynomial 0x11d) ----------------------
const EXP = new Array(256);
const LOG = new Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  EXP[255] = EXP[0];
})();
function gmul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[(LOG[a] + LOG[b]) % 255]; }

// Reed–Solomon: build the monic generator polynomial, then the remainder.
function rsGenerator(ec) {
  let g = [1];
  for (let i = 0; i < ec; i++) {
    const ng = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) { ng[j] ^= g[j]; ng[j + 1] ^= gmul(g[j], EXP[i]); }
    g = ng;
  }
  return g; // length ec+1, g[0] === 1
}
function rsEncode(data, ec) {
  const gen = rsGenerator(ec);
  let res = new Array(ec).fill(0);
  for (const d of data) {
    const factor = d ^ res[0];
    res = res.slice(1); res.push(0);
    if (factor) for (let i = 0; i < ec; i++) res[i] ^= gmul(gen[i + 1], factor);
  }
  return res;
}

// ---- Version tables (ECC level M) -----------------------------------------
// ec = EC codewords per block; blocks = [[count, dataCodewordsPerBlock], …];
// alignCenter = the single alignment-pattern centre coordinate (none for v1).
const VERSIONS = {
  1: { ec: 10, blocks: [[1, 16]], alignCenter: null },
  2: { ec: 16, blocks: [[1, 28]], alignCenter: 18 },
  3: { ec: 26, blocks: [[1, 44]], alignCenter: 22 },
  4: { ec: 18, blocks: [[2, 32]], alignCenter: 26 },
  5: { ec: 24, blocks: [[2, 43]], alignCenter: 30 },
  6: { ec: 16, blocks: [[4, 27]], alignCenter: 34 },
};
function totalDataCodewords(v) { return VERSIONS[v].blocks.reduce((s, [c, d]) => s + c * d, 0); }
function sizeForVersion(v) { return 21 + 4 * (v - 1); }

// Smallest version whose byte-mode capacity holds `len` bytes (mode 4 bits +
// 8-bit char count + len*8 + 4-bit terminator).
function pickVersion(len) {
  for (let v = 1; v <= 6; v++) {
    const capacityBits = totalDataCodewords(v) * 8;
    if (4 + 8 + len * 8 + 4 <= capacityBits) return v;
  }
  return null; // too long for the supported range
}

// ---- Bit / codeword assembly ----------------------------------------------
function toCodewords(bytes, v) {
  const total = totalDataCodewords(v);
  const bits = [];
  const push = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(0b0100, 4);          // byte mode
  push(bytes.length, 8);    // char count (8 bits for v1–9)
  for (const b of bytes) push(b, 8);
  // Terminator (up to 4 bits), then pad to a byte boundary.
  const cap = total * 8;
  for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  const cws = [];
  for (let i = 0; i < bits.length; i += 8) { let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]; cws.push(b); }
  // Pad codewords 0xEC / 0x11 alternating.
  const pads = [0xec, 0x11];
  let pi = 0;
  while (cws.length < total) { cws.push(pads[pi % 2]); pi++; }
  return cws;
}

// Split into blocks, RS-encode each, then interleave data then EC (spec §8.6).
function interleave(dataCws, v) {
  const { ec, blocks } = VERSIONS[v];
  const dataBlocks = [];
  const ecBlocks = [];
  let idx = 0;
  for (const [count, size] of blocks) {
    for (let b = 0; b < count; b++) {
      const chunk = dataCws.slice(idx, idx + size); idx += size;
      dataBlocks.push(chunk);
      ecBlocks.push(rsEncode(chunk, ec));
    }
  }
  const out = [];
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) for (const blk of dataBlocks) if (i < blk.length) out.push(blk[i]);
  for (let i = 0; i < ec; i++) for (const blk of ecBlocks) out.push(blk[i]);
  return out;
}

// ---- Matrix construction ---------------------------------------------------
function newMatrix(size) { return Array.from({ length: size }, () => new Array(size).fill(null)); }

function placeFinder(m, fn, r, c) {
  for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) {
    const rr = r + dr; const cc = c + dc;
    if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
    const inRing = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
    let dark = false;
    if (inRing) {
      const onEdge = dr === 0 || dr === 6 || dc === 0 || dc === 6;
      const inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
      dark = onEdge || inCore;
    }
    m[rr][cc] = dark ? 1 : 0; fn[rr][cc] = 1;
  }
}

function placeAlignment(m, fn, cx, cy) {
  for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
    const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
    m[cy + dr][cx + dc] = dark ? 1 : 0; fn[cy + dr][cx + dc] = 1;
  }
}

function reserveFormat(fn, size) {
  for (let i = 0; i < 9; i++) { if (i !== 6) { fn[8][i] = 1; fn[i][8] = 1; } }
  for (let i = 0; i < 8; i++) { fn[8][size - 1 - i] = 1; fn[size - 1 - i][8] = 1; }
  fn[8][8] = 1;
}

function buildBase(v) {
  const size = sizeForVersion(v);
  const m = newMatrix(size);
  const fn = newMatrix(size); // function-module mask (1 = reserved)
  placeFinder(m, fn, 0, 0);
  placeFinder(m, fn, 0, size - 7);
  placeFinder(m, fn, size - 7, 0);
  // Timing patterns.
  for (let i = 8; i < size - 8; i++) {
    if (fn[6][i] == null) { m[6][i] = i % 2 === 0 ? 1 : 0; fn[6][i] = 1; }
    if (fn[i][6] == null) { m[i][6] = i % 2 === 0 ? 1 : 0; fn[i][6] = 1; }
  }
  // Alignment pattern (single, centred) for v2–6.
  const ac = VERSIONS[v].alignCenter;
  if (ac != null) placeAlignment(m, fn, ac, ac);
  // Dark module.
  m[size - 8][8] = 1; fn[size - 8][8] = 1;
  reserveFormat(fn, size);
  return { m, fn, size };
}

// Zig-zag data placement (upward/downward columns, skipping the vertical timing
// column 6 and all function modules).
function placeData(m, fn, size, bits) {
  let bitIdx = 0;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // skip the timing column
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (let c = 0; c < 2; c++) {
        const cc = col - c;
        if (fn[row][cc] != null && fn[row][cc]) continue;
        if (m[row][cc] != null) continue;
        m[row][cc] = bitIdx < bits.length ? bits[bitIdx] : 0;
        bitIdx++;
      }
    }
    upward = !upward;
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMask(m, fn, size, maskFn) {
  const out = m.map((row) => row.slice());
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
    if (fn[r][c]) continue;
    if (maskFn(r, c)) out[r][c] ^= 1;
  }
  return out;
}

// Penalty scoring (spec §8.8.2) to pick the least-conspicuous mask.
function penalty(m, size) {
  let score = 0;
  // Rule 1: runs of 5+ same-colour in rows and columns.
  for (let r = 0; r < size; r++) {
    for (let dir = 0; dir < 2; dir++) {
      let run = 1;
      for (let c = 1; c < size; c++) {
        const a = dir === 0 ? m[r][c] : m[c][r];
        const b = dir === 0 ? m[r][c - 1] : m[c - 1][r];
        if (a === b) { run++; if (run === 5) score += 3; else if (run > 5) score += 1; }
        else run = 1;
      }
    }
  }
  // Rule 2: 2×2 blocks of the same colour.
  for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
    const v = m[r][c];
    if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
  }
  // Rule 3: finder-like 1:1:3:1:1 patterns in rows and columns.
  const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const matchAt = (get, i, pat) => { for (let k = 0; k < 11; k++) if (get(i + k) !== pat[k]) return false; return true; };
  for (let r = 0; r < size; r++) for (let c = 0; c <= size - 11; c++) {
    if (matchAt((x) => m[r][x], c, pat1) || matchAt((x) => m[r][x], c, pat2)) score += 40;
    if (matchAt((x) => m[x][r], c, pat1) || matchAt((x) => m[x][r], c, pat2)) score += 40;
  }
  // Rule 4: dark-module proportion deviation from 50%.
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (m[r][c]) dark++;
  const pct = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

// Format information: 5 data bits (EC level + mask) → BCH(15,5), XOR mask.
function formatBits(mask) {
  const ecLevelBits = 0b00; // level M
  let data = (ecLevelBits << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ (((rem >> 9) & 1) ? 0b10100110111 : 0);
  const bits = ((data << 10) | (rem & 0x3ff)) ^ 0b101010000010010;
  const arr = [];
  for (let i = 14; i >= 0; i--) arr.push((bits >> i) & 1);
  return arr; // index 0 = MSB (bit 14)
}

function placeFormat(m, size, mask) {
  const f = formatBits(mask); // f[0]=bit14 … f[14]=bit0
  // Around the top-left finder.
  for (let i = 0; i <= 5; i++) m[8][i] = f[14 - i];
  m[8][7] = f[14 - 6];
  m[8][8] = f[14 - 7];
  m[7][8] = f[14 - 8];
  for (let i = 9; i <= 14; i++) m[14 - i][8] = f[14 - i];
  // The split copy along the right and bottom finders (same bits, f[14-i]).
  for (let i = 0; i <= 7; i++) m[size - 1 - i][8] = f[14 - i];
  for (let i = 8; i <= 14; i++) m[8][size - 15 + i] = f[14 - i];
  m[size - 8][8] = 1; // dark module stays set
}

function encodeToMatrix(text) {
  const bytes = [];
  for (const ch of unescape(encodeURIComponent(text))) bytes.push(ch.charCodeAt(0) & 0xff);
  const v = pickVersion(bytes.length);
  if (!v) throw new Error('qr: payload too long for supported versions');
  const dataCws = toCodewords(bytes, v);
  const finalCws = interleave(dataCws, v);
  const bits = [];
  for (const cw of finalCws) for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1);
  const { m, fn, size } = buildBase(v);
  placeData(m, fn, size, bits);
  // Choose the lowest-penalty mask.
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const masked = applyMask(m, fn, size, MASKS[mask]);
    placeFormat(masked, size, mask);
    const p = penalty(masked, size);
    if (!best || p < best.p) best = { p, mask, masked };
  }
  return { matrix: best.masked, size, version: v, mask: best.mask };
}

// ---- Public API ------------------------------------------------------------
// Returns a self-contained SVG string (black modules on a light background,
// 4-module quiet zone). `dark`/`light` let the caller theme it.
function qrSvg(text, { scale = 4, dark = '#0b0f1a', light = '#ffffff', quiet = 4 } = {}) {
  const { matrix, size } = encodeToMatrix(text);
  const dim = (size + quiet * 2) * scale;
  let rects = '';
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
    if (matrix[r][c]) rects += `<rect x="${(c + quiet) * scale}" y="${(r + quiet) * scale}" width="${scale}" height="${scale}"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="${dim}" height="${dim}" fill="${light}"/><g fill="${dark}">${rects}</g></svg>`;
}

// Expose to the classic (non-module) app.js in the browser.
if (typeof window !== 'undefined') { window.qrSvg = qrSvg; }

export { qrSvg, encodeToMatrix, rsEncode, gmul, pickVersion, sizeForVersion, formatBits, MASKS, buildBase, VERSIONS };
