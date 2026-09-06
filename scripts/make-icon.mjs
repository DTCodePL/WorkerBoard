#!/usr/bin/env node
// Generuje media/icon.png - ikone rozszerzenia dla Visual Studio Marketplace.
//
// Zero zaleznosci: kodowanie PNG (chunk IHDR/IDAT/IEND + CRC32) recznie,
// kompresja przez wbudowany node:zlib. Rysowanie odbywa sie w 4x
// nadprobkowaniu (1024x1024), a nastepnie jest usredniane blokami 4x4 do
// docelowych 256x256 - to daje wygladzone krawedzie zaokraglen bez
// zadnej biblioteki graficznej.
//
// Uruchomienie: node scripts/make-icon.mjs

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SIZE = 256;
const SCALE = 4;
const BIG = SIZE * SCALE; // 1024 - platno robocze przed usrednieniem

const NAVY = hexToRgb('#061126');
const BAR_1 = hexToRgb('#EAF3FF');
const BAR_2 = hexToRgb('#006AE9');
const BAR_3 = hexToRgb('#0289F8');

/**
 * @param {string} hex
 * @returns {[number, number, number]}
 */
function hexToRgb(hex) {
  const value = hex.replace('#', '');
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

/**
 * Test przynaleznosci punktu do zaokraglonego prostokata (standardowa
 * metoda: obcinanie wspolrzednych do "wewnetrznego" prostokata i pomiar
 * odleglosci od najblizszego naroznika).
 */
function inRoundedRect(px, py, x, y, w, h, r) {
  if (px < x || px > x + w || py < y || py > y + h) {
    return false;
  }
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

// Ksztalty zdefiniowane we wspolrzednych docelowych 256px, przeskalowane do
// przestrzeni nadprobkowanej. Pierwszy ksztalt to tlo (zaokraglony kwadrat
// na cala powierzchnie) - reszta to trzy poziome belki.
const shapesAt256 = [
  { x: 0, y: 0, w: SIZE, h: SIZE, r: 56, color: NAVY },
  { x: 56, y: 68, w: 144, h: 28, r: 14, color: BAR_1 },
  { x: 56, y: 114, w: 112, h: 28, r: 14, color: BAR_2 },
  { x: 56, y: 160, w: 80, h: 28, r: 14, color: BAR_3 },
];

const shapes = shapesAt256.map((s) => ({
  x: s.x * SCALE,
  y: s.y * SCALE,
  w: s.w * SCALE,
  h: s.h * SCALE,
  r: s.r * SCALE,
  color: s.color,
}));

// Platno robocze RGB (bez kanalu alfa - caly obraz jest w pelni
// nieprzezroczysty). Wypelnienie startowe to NAVY - gwarantuje to, ze cztery
// naroza platna poza promieniem zaokraglenia tla tez sa opaque i tego
// samego koloru, wiec finalny obraz nie ma przezroczystych marginesow.
const big = new Uint8Array(BIG * BIG * 3);
for (let i = 0; i < BIG * BIG; i++) {
  big[i * 3] = NAVY[0];
  big[i * 3 + 1] = NAVY[1];
  big[i * 3 + 2] = NAVY[2];
}

for (const shape of shapes) {
  const yStart = Math.max(0, Math.floor(shape.y) - 1);
  const yEnd = Math.min(BIG - 1, Math.ceil(shape.y + shape.h) + 1);
  for (let py = yStart; py <= yEnd; py++) {
    for (let px = 0; px < BIG; px++) {
      if (inRoundedRect(px + 0.5, py + 0.5, shape.x, shape.y, shape.w, shape.h, shape.r)) {
        const idx = (py * BIG + px) * 3;
        big[idx] = shape.color[0];
        big[idx + 1] = shape.color[1];
        big[idx + 2] = shape.color[2];
      }
    }
  }
}

// Usrednianie blokow 4x4 -> antyaliasing krawedzi zaokraglen.
const out = new Uint8Array(SIZE * SIZE * 4);
for (let oy = 0; oy < SIZE; oy++) {
  for (let ox = 0; ox < SIZE; ox++) {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let j = 0; j < SCALE; j++) {
      for (let i = 0; i < SCALE; i++) {
        const px = ox * SCALE + i;
        const py = oy * SCALE + j;
        const idx = (py * BIG + px) * 3;
        r += big[idx];
        g += big[idx + 1];
        b += big[idx + 2];
      }
    }
    const n = SCALE * SCALE;
    const oidx = (oy * SIZE + ox) * 4;
    out[oidx] = Math.round(r / n);
    out[oidx + 1] = Math.round(g / n);
    out[oidx + 2] = Math.round(b / n);
    out[oidx + 3] = 255; // alfa zawsze pelna - brak przezroczystosci w tle
  }
}

// --- Kodowanie PNG (RGBA, 8 bitow/kanal, filtr None na kazdym wierszu) ---

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

const stride = SIZE * 4;
const raw = Buffer.alloc((stride + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (stride + 1);
  raw[rowStart] = 0; // typ filtra: None
  raw.set(out.subarray(y * stride, y * stride + stride), rowStart + 1);
}

const idatData = deflateSync(raw, { level: 9 });

const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); // szerokosc
ihdr.writeUInt32BE(SIZE, 4); // wysokosc
ihdr[8] = 8; // glebia bitowa
ihdr[9] = 6; // typ koloru: RGBA
ihdr[10] = 0; // kompresja
ihdr[11] = 0; // filtrowanie
ihdr[12] = 0; // interlace

const png = Buffer.concat([
  signature,
  pngChunk('IHDR', ihdr),
  pngChunk('IDAT', idatData),
  pngChunk('IEND', Buffer.alloc(0)),
]);

const outPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'media', 'icon.png');
writeFileSync(outPath, png);
console.log(`Zapisano ${outPath} (${png.length} B)`);
