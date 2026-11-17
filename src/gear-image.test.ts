import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import {
  centerOnFrame,
  containSize,
  contentBox,
  cropRgba,
  contentCoverage,
  gearAssetVersion,
  hasTransparency,
  isAllowedSourceUrl,
  isGearVersion,
  isNotionPageId,
  judgeSegmentation,
  sourceKey,
  toRgba8,
} from "./gear-image.js";

function image(width: number, height: number, alphaAt: (x: number, y: number) => number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = 10;
      data[i + 1] = 20;
      data[i + 2] = 30;
      data[i + 3] = alphaAt(x, y);
    }
  }
  return data;
}

test("accepts only Notion-hosted https uploads", () => {
  assert.ok(isAllowedSourceUrl("https://prod-files-secure.s3.us-west-2.amazonaws.com/ws/file/pack.png?X-Amz=1"));
  assert.ok(isAllowedSourceUrl("https://file.notion.so/f/f/ws/file/pack.png"));
  assert.ok(isAllowedSourceUrl("https://img.notionusercontent.com/s3/pack.png"));
  assert.equal(isAllowedSourceUrl("http://prod-files-secure.s3.us-west-2.amazonaws.com/a.png"), false);
  assert.equal(isAllowedSourceUrl("https://evil.com/prod-files-secure.s3.us-west-2.amazonaws.com"), false);
  assert.equal(isAllowedSourceUrl("https://prod-files-secure.s3.us-west-2.amazonaws.com.evil.com/a.png"), false);
  assert.equal(isAllowedSourceUrl("https://other-bucket.s3.us-west-2.amazonaws.com/a.png"), false);
  assert.equal(isAllowedSourceUrl("https://file.notion.so:8443/a.png"), false);
  assert.equal(isAllowedSourceUrl("https://www.rei.com/pack.png"), false);
  assert.equal(isAllowedSourceUrl("not a url"), false);
});

test("keys a source by host and path, ignoring the signature", () => {
  const a = "https://prod-files-secure.s3.us-west-2.amazonaws.com/ws/file/pack.png?X-Amz-Signature=a";
  const b = "https://prod-files-secure.s3.us-west-2.amazonaws.com/ws/file/pack.png?X-Amz-Signature=b";
  assert.equal(sourceKey(a), sourceKey(b));
  assert.equal(sourceKey(a), "prod-files-secure.s3.us-west-2.amazonaws.com/ws/file/pack.png");
});

test("validates page ids and versions used in R2 keys", () => {
  assert.ok(isNotionPageId("41801b50-4364-8164-a9b6-fae06d0f2a8d"));
  assert.equal(isNotionPageId("41801b5043648164a9b6fae06d0f2a8d"), false);
  assert.equal(isNotionPageId("../../photos/x"), false);
  assert.ok(isGearVersion("0123456789ab"));
  assert.equal(isGearVersion("0123456789AB"), false);
});

test("versions change with the source and the pipeline", async () => {
  const v1 = await gearAssetVersion("abc", 1);
  assert.match(v1, /^[0-9a-f]{12}$/);
  assert.equal(v1, await gearAssetVersion("abc", 1));
  assert.notEqual(v1, await gearAssetVersion("abc", 2));
  assert.notEqual(v1, await gearAssetVersion("abd", 1));
});

test("detects transparency by share of pixels, not just the border", () => {
  const opaque = image(10, 10, () => 255);
  assert.equal(hasTransparency(opaque), false);
  // A cut-out cropped tight to the edges still has transparent corners.
  const tightCutout = image(10, 10, (x, y) => (x === 0 && y === 0 ? 0 : 255));
  assert.equal(hasTransparency(tightCutout), true);
});

test("finds the content box and ignores faint halos", () => {
  const rgba = image(20, 10, (x, y) => {
    if (x >= 5 && x <= 14 && y >= 2 && y <= 7) return 255;
    if (x === 0 && y === 0) return 8; // halo below the threshold
    return 0;
  });
  assert.deepEqual(contentBox(rgba, 20, 10), { left: 5, top: 2, width: 10, height: 6 });
  const cropped = cropRgba(rgba, 20, 10, { left: 5, top: 2, width: 10, height: 6 });
  assert.equal(cropped.length, 10 * 6 * 4);
  assert.equal(contentCoverage(cropped), 1);
  assert.throws(() => cropRgba(rgba, 20, 10, { left: 15, top: 0, width: 10, height: 1 }));
});

test("returns no box for a fully transparent image", () => {
  assert.equal(contentBox(image(4, 4, () => 0), 4, 4), null);
});

test("fits the longest side to the content box", () => {
  assert.deepEqual(containSize(300, 150, 704), { width: 704, height: 352 });
  assert.deepEqual(containSize(150, 600, 704), { width: 176, height: 704 });
});

test("centres content on a transparent square frame", () => {
  const content = image(4, 2, () => 255);
  const frame = centerOnFrame(content, 4, 2, 8);
  const alpha = (x: number, y: number) => frame[(y * 8 + x) * 4 + 3];
  assert.equal(alpha(2, 3), 255);
  assert.equal(alpha(5, 4), 255);
  assert.equal(alpha(1, 3), 0);
  assert.equal(alpha(6, 3), 0);
  assert.equal(alpha(2, 2), 0);
  assert.equal(alpha(2, 5), 0);
  assert.equal(contentCoverage(frame), 8 / 64);
  assert.throws(() => centerOnFrame(image(9, 1, () => 255), 9, 1, 8));
});

test("expands gray, RGB, and 16-bit pixels to 8-bit RGBA", () => {
  assert.deepEqual([...toRgba8({ width: 1, height: 1, data: [7], depth: 8, channels: 1 })], [7, 7, 7, 255]);
  assert.deepEqual([...toRgba8({ width: 1, height: 1, data: [7, 9], depth: 8, channels: 2 })], [7, 7, 7, 9]);
  assert.deepEqual([...toRgba8({ width: 1, height: 1, data: [1, 2, 3], depth: 8, channels: 3 })], [1, 2, 3, 255]);
  assert.deepEqual([...toRgba8({ width: 1, height: 1, data: [65535, 0, 256, 32768], depth: 16, channels: 4 })], [255, 0, 1, 128]);
  assert.deepEqual(
    [...toRgba8({ width: 2, height: 1, data: [1, 2, 3, 4, 5, 6], depth: 8, channels: 3, transparency: [1, 2, 3] })],
    [1, 2, 3, 0, 4, 5, 6, 255],
  );
  assert.throws(() => toRgba8({ width: 2, height: 2, data: [1], depth: 8, channels: 4 }));
});

test("rejects segmentation that removed everything or nothing", () => {
  assert.equal(judgeSegmentation(0.01), "empty");
  assert.equal(judgeSegmentation(0.5), "ok");
  assert.equal(judgeSegmentation(0.99), "everything");
});

test("the gear route pattern matches versioned files only", async () => {
  const app = new Hono();
  app.get("/gear/:id{[0-9a-f-]{36}}/:file{[0-9a-f]{12}\\.(?:webp|png)}", (c) => c.text(c.req.param("file")));
  const id = "41801b50-4364-8164-a9b6-fae06d0f2a8d";
  assert.equal(await (await app.request(`/gear/${id}/0123456789ab.webp?w=400`)).text(), "0123456789ab.webp");
  assert.equal(await (await app.request(`/gear/${id}/0123456789ab.png`)).text(), "0123456789ab.png");
  assert.equal((await app.request(`/gear/${id}/0123456789ab.jpg`)).status, 404);
  assert.equal((await app.request(`/gear/${id}/xyz.webp`)).status, 404);
});
