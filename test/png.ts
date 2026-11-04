// テスト用の簡単な棒グラフの PNG を作る。
// 外部ライブラリを使わない最小の PNG エンコーダ（8bit RGB、フィルタなし）。
import { deflateSync } from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

type Rgb = [number, number, number];

function encodePng(width: number, height: number, pixel: (x: number, y: number) => Rgb): Uint8Array {
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), y * row + 1 + x * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // ビット深度
  ihdr[9] = 2; // RGB
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// 赤・緑・青の 3 本の棒。緑が最も高い
export function barChartPng(): Uint8Array {
  const width = 240;
  const height = 160;
  const base = height - 10;
  const bars: { x: number; h: number; color: Rgb }[] = [
    { x: 30, h: 50, color: [220, 50, 50] },
    { x: 100, h: 130, color: [40, 170, 60] },
    { x: 170, h: 85, color: [50, 90, 220] },
  ];
  return encodePng(width, height, (x, y) => {
    if (y === base || x === 15) return [0, 0, 0];
    const bar = bars.find((b) => x >= b.x && x < b.x + 45 && y >= base - b.h && y < base);
    return bar ? bar.color : [255, 255, 255];
  });
}
