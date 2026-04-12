import { createWriteStream } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const iconsDir = join(__dirname, 'icons');

async function createMinimalPNG(width, height) {
  // PNG signature
  const signature = Buffer.from([
    137, 80, 78, 71, 13, 10, 26, 10
  ]);

  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type (RGB)
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace

  const ihdrChunk = createChunk('IHDR', ihdrData);

  // IDAT chunk (image data) - solid color placeholder
  const rawImage = Buffer.alloc(width * height * 3);
  for (let i = 0; i < rawImage.length; i++) {
    rawImage[i] = 15; // dark blue (#0f3460 background simplified)
  }
  const deflated = await import('zlib').then(m => m.deflateSync(rawImage));
  const idatChunk = createChunk('IDAT', deflated);

  // IEND chunk
  const iendChunk = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function createChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = computeCrc(Buffer.concat([typeBuf, data]));
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function computeCrc(data) {
  const crcTable = createCRCTable();
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ data[i]) & 0xff];
  }
  return Buffer.alloc(4).fill(0).map((_, i) => ((crc >>> (i * 8)) & 0xff)).reverse();
}

function createCRCTable() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  return table;
}

async function generateIcons() {
  console.log('Generating icon PNG files...');

  const sizes = [16, 32, 128, 256];
  for (const size of sizes) {
    const pngData = await createMinimalPNG(size, size);
    const filename = size === 256 ? '128x128@2x.png' : `${size}x${size}.png`;
    const filepath = join(iconsDir, filename);

    try {
      const stream = createWriteStream(filepath);
      await new Promise((resolve, reject) => {
        stream.on('finish', resolve);
        stream.on('error', reject);
        stream.end(pngData);
      });
      console.log(`Created ${filename}`);
    } catch (err) {
      console.error(`Error creating ${filename}:`, err.message);
    }
  }

  console.log('Icon generation complete.');
  console.log('Note: These are minimal placeholder icons. For production, replace with high-quality SVG/PNG icons.');
}

generateIcons().catch(console.error);