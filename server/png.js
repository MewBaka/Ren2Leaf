// Lossless PNG recompression, used when the package is written.
//
// Ren'Py hands out screenshots with every scanline unfiltered and almost no deflate: a 1280×720
// frame costs 3.5 MB, which is the raw pixel buffer. Ten screens of a game therefore leave a 36 MB
// folder on somebody's hands. Re-filtering each scanline and deflating at level 9 gives back the
// same pixels — this is a byte-exact transform of the image, not a re-encode of the picture.
//
// Anything this module does not fully understand (an interlaced image, an unknown colour type, a
// truncated file) is left exactly as it was: every entry point returns null instead of guessing.

import zlib from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Channels per colour type: 0 grey, 2 truecolour, 3 palette, 4 grey+alpha, 6 truecolour+alpha.
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

// Node's zlib.crc32 only exists from 20.15; package.json asks for 20, so the table is our own.
const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();

function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

/**
 * Splits a PNG into its chunks. Returns null if the file is not a PNG this module can take apart.
 * @returns {{header: object, chunks: {type: string, data: Buffer}[]} | null}
 */
export function parsePng(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) return null;
    const chunks = [];
    let i = 8;
    while (i + 12 <= buf.length) {
        const length = buf.readUInt32BE(i);
        const end = i + 12 + length;
        if (length > 0x7fffffff || end > buf.length) return null;
        chunks.push({ type: buf.toString("latin1", i + 4, i + 8), data: buf.subarray(i + 8, i + 8 + length) });
        i = end;
    }
    if (i !== buf.length) return null;
    const ihdr = chunks[0];
    if (!ihdr || ihdr.type !== "IHDR" || ihdr.data.length !== 13) return null;
    const header = {
        width: ihdr.data.readUInt32BE(0),
        height: ihdr.data.readUInt32BE(4),
        depth: ihdr.data[8],
        colorType: ihdr.data[9],
        compression: ihdr.data[10],
        filter: ihdr.data[11],
        interlace: ihdr.data[12],
    };
    if (!header.width || !header.height) return null;
    return { header, chunks };
}

/** Bytes per pixel as filtering counts them: at least one, rounded up from the bit depth. */
function bytesPerPixel({ depth, colorType }) {
    const channels = CHANNELS[colorType];
    if (!channels) return 0;
    return Math.max(1, Math.ceil((depth * channels) / 8));
}

function bytesPerRow({ width, depth, colorType }) {
    return Math.ceil((width * depth * CHANNELS[colorType]) / 8);
}

function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    return pb <= pc ? b : c;
}

/** Reverses the per-scanline filters, leaving the raw pixel rows. */
function unfilter(data, { rowBytes, height, bpp }) {
    const out = Buffer.alloc(rowBytes * height);
    let src = 0;
    for (let y = 0; y < height; y++) {
        if (src >= data.length) return null;
        const type = data[src++];
        const row = out.subarray(y * rowBytes, (y + 1) * rowBytes);
        const prev = y ? out.subarray((y - 1) * rowBytes, y * rowBytes) : null;
        if (src + rowBytes > data.length) return null;
        data.copy(row, 0, src, src + rowBytes);
        src += rowBytes;
        for (let x = 0; x < rowBytes; x++) {
            const a = x >= bpp ? row[x - bpp] : 0;
            const b = prev ? prev[x] : 0;
            const c = prev && x >= bpp ? prev[x - bpp] : 0;
            switch (type) {
                case 0: break;
                case 1: row[x] = (row[x] + a) & 0xff; break;
                case 2: row[x] = (row[x] + b) & 0xff; break;
                case 3: row[x] = (row[x] + ((a + b) >> 1)) & 0xff; break;
                case 4: row[x] = (row[x] + paeth(a, b, c)) & 0xff; break;
                default: return null;
            }
        }
    }
    return src === data.length ? out : null;
}

/**
 * Filters the rows again, picking per scanline whichever of the five filters leaves the smallest
 * sum of absolute differences — the heuristic the PNG specification itself suggests.
 */
function refilter(raw, { rowBytes, height, bpp }) {
    const out = Buffer.alloc((rowBytes + 1) * height);
    const candidate = Buffer.alloc(rowBytes);
    let dst = 0;
    for (let y = 0; y < height; y++) {
        const row = raw.subarray(y * rowBytes, (y + 1) * rowBytes);
        const prev = y ? raw.subarray((y - 1) * rowBytes, y * rowBytes) : null;
        let bestType = 0;
        let bestScore = Infinity;
        let best = null;
        for (let type = 0; type <= 4; type++) {
            if (type === 2 && !prev) continue;
            let score = 0;
            for (let x = 0; x < rowBytes; x++) {
                const a = x >= bpp ? row[x - bpp] : 0;
                const b = prev ? prev[x] : 0;
                const c = prev && x >= bpp ? prev[x - bpp] : 0;
                let v;
                switch (type) {
                    case 0: v = row[x]; break;
                    case 1: v = row[x] - a; break;
                    case 2: v = row[x] - b; break;
                    case 3: v = row[x] - ((a + b) >> 1); break;
                    default: v = row[x] - paeth(a, b, c); break;
                }
                v &= 0xff;
                candidate[x] = v;
                score += v < 128 ? v : 256 - v;
                if (score >= bestScore) break;
            }
            if (score < bestScore) {
                bestScore = score;
                bestType = type;
                best = Buffer.from(candidate);
            }
        }
        out[dst++] = bestType;
        best.copy(out, dst);
        dst += rowBytes;
    }
    return out;
}

function chunk(type, data) {
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "latin1");
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
}

/**
 * Rewrites a PNG with the same pixels in fewer bytes. Every chunk other than the image data is kept
 * as it was, in its original order.
 * @returns {Buffer | null} null when the file cannot be read, or when it is already smaller.
 */
export function recompressPng(buf, { level = 9 } = {}) {
    const parsed = parsePng(buf);
    if (!parsed) return null;
    const { header, chunks } = parsed;
    if (header.interlace !== 0 || header.compression !== 0 || header.filter !== 0) return null;
    if (!CHANNELS[header.colorType]) return null;
    if (![1, 2, 4, 8, 16].includes(header.depth)) return null;

    const idat = chunks.filter((c) => c.type === "IDAT");
    if (!idat.length) return null;
    let inflated;
    try {
        inflated = zlib.inflateSync(Buffer.concat(idat.map((c) => c.data)));
    } catch {
        return null;
    }
    const shape = { rowBytes: bytesPerRow(header), height: header.height, bpp: bytesPerPixel(header) };
    if (inflated.length !== (shape.rowBytes + 1) * shape.height) return null;
    const raw = unfilter(inflated, shape);
    if (!raw) return null;
    const deflated = zlib.deflateSync(refilter(raw, shape), { level });

    const parts = [SIGNATURE];
    let written = false;
    for (const c of chunks) {
        if (c.type === "IDAT") {
            if (written) continue;
            parts.push(chunk("IDAT", deflated));
            written = true;
        } else {
            parts.push(chunk(c.type, c.data));
        }
    }
    const out = Buffer.concat(parts);
    return out.length < buf.length ? out : null;
}

/** The pixel rows behind a PNG, for tests and for comparing two encodings of one image. */
export function pixels(buf) {
    const parsed = parsePng(buf);
    if (!parsed) return null;
    const { header, chunks } = parsed;
    if (header.interlace !== 0 || !CHANNELS[header.colorType]) return null;
    let inflated;
    try {
        inflated = zlib.inflateSync(Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data)));
    } catch {
        return null;
    }
    return unfilter(inflated, {
        rowBytes: bytesPerRow(header),
        height: header.height,
        bpp: bytesPerPixel(header),
    });
}
