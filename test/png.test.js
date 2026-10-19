import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { parsePng, pixels, recompressPng } from "../server/png.js";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) {
        c ^= buf[i];
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return (c ^ -1) >>> 0;
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
 * A PNG written the way Ren'Py writes one: every scanline unfiltered, deflate level 0. `paint`
 * returns the four channel values of a pixel.
 */
function enginePng(width, height, paint, { colorType = 6, extra = [] } = {}) {
    const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
    const rowBytes = width * channels;
    const raw = Buffer.alloc((rowBytes + 1) * height);
    for (let y = 0; y < height; y++) {
        const base = y * (rowBytes + 1) + 1;
        for (let x = 0; x < width; x++) {
            const px = paint(x, y);
            for (let c = 0; c < channels; c++) raw[base + x * channels + c] = px[c];
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = colorType;
    return Buffer.concat([
        SIGNATURE,
        chunk("IHDR", ihdr),
        ...extra,
        chunk("IDAT", zlib.deflateSync(raw, { level: 0 })),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

/** A frame that looks like a game screen: flat panels over a gradient, which is what filters help. */
const gameScreen = (x, y) => (y > 150 && y < 200 && x > 40 && x < 260
    ? [24, 24, 27, 230]
    : [(x * 2) & 0xff, (y + 40) & 0xff, 120, 255]);

test("a screenshot comes back smaller with the same pixels", () => {
    const src = enginePng(320, 240, gameScreen);
    const out = recompressPng(src);
    assert.ok(out, "期望重压缩成功");
    assert.ok(out.length < src.length / 2, `期望体积减半：${src.length} → ${out.length}`);
    assert.equal(Buffer.compare(pixels(out), pixels(src)), 0);
    assert.deepEqual(parsePng(out).header, parsePng(src).header);
});

test("every scanline filter round-trips", () => {
    // Rows that each favour a different filter: flat, horizontal ramp, vertical ramp, average, edges.
    const src = enginePng(64, 40, (x, y) => {
        switch (y % 5) {
            case 0: return [10, 20, 30, 255];
            case 1: return [x * 4, x * 4, x * 4, 255];
            case 2: return [y * 6, y * 6, y * 6, 255];
            case 3: return [(x + y) & 0xff, (x * y) & 0xff, x ^ y, 255];
            default: return [x > 32 ? 255 : 0, y > 20 ? 255 : 0, (x * 7) & 0xff, x & 1 ? 255 : 0];
        }
    });
    const out = recompressPng(src);
    assert.ok(out);
    assert.equal(Buffer.compare(pixels(out), pixels(src)), 0);
});

test("chunks other than the image data are kept in order", () => {
    const phys = Buffer.alloc(9);
    phys.writeUInt32BE(2835, 0);
    phys.writeUInt32BE(2835, 4);
    phys[8] = 1;
    const src = enginePng(32, 32, gameScreen, { extra: [chunk("pHYs", phys)] });
    const out = recompressPng(src);
    assert.ok(out);
    assert.deepEqual(parsePng(out).chunks.map((c) => c.type), ["IHDR", "pHYs", "IDAT", "IEND"]);
    const kept = parsePng(out).chunks.find((c) => c.type === "pHYs");
    assert.equal(Buffer.compare(kept.data, phys), 0);
});

test("colour types without an alpha channel work too", () => {
    for (const colorType of [0, 2, 4]) {
        const src = enginePng(48, 48, gameScreen, { colorType });
        const out = recompressPng(src);
        assert.ok(out, `colorType ${colorType} 期望重压缩成功`);
        assert.equal(Buffer.compare(pixels(out), pixels(src)), 0);
    }
});

test("an image that is already small is left alone", () => {
    const src = enginePng(16, 16, () => [0, 0, 0, 255]);
    const packed = recompressPng(src);
    // Ren'Py's own level 0 on 16×16 of one colour is already near the deflate floor.
    assert.ok(packed === null || packed.length < src.length);
    assert.equal(recompressPng(recompressPng(enginePng(320, 240, gameScreen))), null);
});

test("anything that is not a plain PNG is refused rather than guessed at", () => {
    assert.equal(recompressPng(Buffer.from("not a png at all")), null);
    assert.equal(parsePng(Buffer.alloc(0)), null);
    // Truncated: the last chunk does not fit.
    const src = enginePng(32, 32, gameScreen);
    assert.equal(recompressPng(src.subarray(0, src.length - 4)), null);
    // Interlaced: the rows are not where this module expects them.
    const interlaced = Buffer.from(src);
    const ihdrAt = 8 + 8;
    interlaced[ihdrAt + 12] = 1;
    assert.equal(recompressPng(interlaced), null);
});
