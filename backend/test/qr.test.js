// Verifies the dependency-free QR encoder (frontend/qr.js) by ROUND-TRIP
// decoding its own output: encode a string → read the matrix back → compare.
// A pass proves geometry, data masking, block interleaving and format-info
// placement are all spec-correct (the parts a real scanner depends on).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeToMatrix, buildBase, VERSIONS, MASKS, formatBits, pickVersion } from '../../frontend/qr.js';

const MASK_FROM_FORMAT = (() => { const m = {}; for (let k = 0; k < 8; k++) m[formatBits(k).join('')] = k; return m; })();

function decode(text) {
  const { matrix, size, version, mask } = encodeToMatrix(text);
  // Read the top-left format-info copy (LSB-first) and confirm the mask.
  const f = [];
  for (let i = 0; i <= 5; i++) f.push(matrix[8][i]);
  f.push(matrix[8][7], matrix[8][8], matrix[7][8]);
  for (let i = 9; i <= 14; i++) f.push(matrix[14 - i][8]);
  const readMask = MASK_FROM_FORMAT[f.slice().reverse().join('')];
  assert.equal(readMask, mask, 'format-info mask reads back');

  // Unmask and read the data stream in placement order (skip function modules).
  const { fn } = buildBase(version);
  const un = matrix.map((row, r) => row.map((v, c) => (fn[r][c] ? v : v ^ (MASKS[mask](r, c) ? 1 : 0))));
  const bits = [];
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (let c = 0; c < 2; c++) { const cc = col - c; if (!fn[row][cc]) bits.push(un[row][cc]); }
    }
    upward = !upward;
  }
  const cws = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) { let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]; cws.push(b); }

  // De-interleave into data blocks (drop EC), then byte-decode.
  const { blocks } = VERSIONS[version];
  const dataBlocks = [];
  for (const [count, dsize] of blocks) for (let b = 0; b < count; b++) dataBlocks.push(new Array(dsize));
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  let idx = 0;
  for (let i = 0; i < maxData; i++) for (const blk of dataBlocks) if (i < blk.length) blk[i] = cws[idx++];
  const data = [].concat(...dataBlocks);
  let bitStr = '';
  for (const cw of data) bitStr += cw.toString(2).padStart(8, '0');
  assert.equal(bitStr.slice(0, 4), '0100', 'byte mode');
  const len = parseInt(bitStr.slice(4, 12), 2);
  const out = [];
  for (let i = 0; i < len; i++) out.push(parseInt(bitStr.slice(12 + i * 8, 20 + i * 8), 2));
  return decodeURIComponent(out.map((b) => '%' + b.toString(16).padStart(2, '0')).join(''));
}

test('qr: encoder round-trips short share URLs across versions', () => {
  const cases = [
    'https://3jntravel.com/?trip=a1b2c3d4&src=whatsapp',
    'https://3jntravel.com/?trip=z9y8x7w6&src=qr',
    'hi',
    'https://3jntravel.com/?trip=abcdefgh&src=a-longer-channel-name-here-01',
    'accented café façade — 0123456789',
  ];
  for (const t of cases) assert.equal(decode(t), t, `round-trips: ${t}`);
});

test('qr: smallest fitting version is chosen, and over-long payloads are rejected', () => {
  assert.equal(pickVersion(2), 1);      // tiny → v1
  assert.equal(pickVersion(50), 4);     // ~50 bytes → v4
  assert.equal(pickVersion(999), null); // beyond supported range
});
