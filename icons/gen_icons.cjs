// 生成 icons/icon{16,48,128}.png：蓝底圆角方块 + 白色 "U"，纯 Node 标准库，无依赖
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xFF];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// 8x8 "U" 字形
const FONT_U = [
  '11000011',
  '11000011',
  '11000011',
  '11000011',
  '11000011',
  '11000011',
  '01111110',
  '00111100',
];

function insideRoundedRect(x, y, s, r) {
  const cx = Math.min(Math.max(x, r), s - r);
  const cy = Math.min(Math.max(y, r), s - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function makeIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  const glyphSize = size * 0.58;
  const gx0 = (size - glyphSize) / 2;
  const gy0 = (size - glyphSize) / 2;
  const cell = glyphSize / 8;
  const BG = [0x2e, 0x86, 0xde];
  const FG = [0xff, 0xff, 0xff];

  const sample = (x, y) => {
    if (!insideRoundedRect(x, y, size, radius)) return null;
    const col = Math.floor((x - gx0) / cell);
    const row = Math.floor((y - gy0) / cell);
    if (col < 0 || col > 7 || row < 0 || row > 7) return BG;
    return FONT_U[row][col] === '1' ? FG : BG;
  };

  // 2x2 超采样抗锯齿
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const pts = [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
      let r = 0, g = 0, b = 0, n = 0;
      for (const [dx, dy] of pts) {
        const c = sample(x + dx, y + dy);
        if (c) { r += c[0]; g += c[1]; b += c[2]; n += 1; }
      }
      const i = (y * size + x) * 4;
      px[i] = n ? Math.round(r / n) : 0;
      px[i + 1] = n ? Math.round(g / n) : 0;
      px[i + 2] = n ? Math.round(b / n) : 0;
      px[i + 3] = Math.round(n * 255 / 4);
    }
  }

  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 48, 128]) {
  fs.writeFileSync(path.join(outDir, `icon${size}.png`), makeIcon(size));
  console.log(`icon${size}.png 已生成`);
}
