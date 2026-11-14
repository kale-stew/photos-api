import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { captureDate, dateInputValue, profilePhoto, UPLOAD_TYPES, userComment } from "./photo-metadata.js";

type Exif = Record<string, Record<string, string>>;

async function jpegWithExif(exif: Exif, orientation?: number): Promise<ArrayBuffer> {
  let pipeline = sharp({ create: { width: 8, height: 8, channels: 3, background: "#888" } }).jpeg();
  if (orientation) pipeline = pipeline.withMetadata({ orientation });
  const image = await pipeline.withExif(exif).toBuffer();
  return image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength) as ArrayBuffer;
}

// Capture time used to depend on the runtime timezone, so profile each image
// under zones on both sides of UTC.
async function inEachTimezone(run: () => Promise<void>) {
  const original = process.env.TZ;
  try {
    for (const zone of ["UTC", "America/Los_Angeles", "Pacific/Auckland"]) {
      process.env.TZ = zone;
      await run();
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
}

test("accepts HEIC and HEIF uploads as canonical HEIC originals", () => {
  assert.equal(UPLOAD_TYPES["image/heic"], "heic");
  assert.equal(UPLOAD_TYPES["image/heif"], "heic");
});

test("returns null for invalid image metadata without blocking upload", async () => {
  assert.equal(await profilePhoto(new TextEncoder().encode("not an image").buffer as ArrayBuffer), null);
});

test("formats an EXIF capture timestamp for a date input", () => {
  assert.equal(dateInputValue("2026-10-14T17:30:00-07:00"), "2026-10-14");
  assert.equal(dateInputValue(null), null);
});

test("profiles camera, capture time, and GPS from one EXIF read", async () => {
  const input = await jpegWithExif({
    IFD0: { Make: "Canon", Model: "EOS R6", Software: "Lightroom", Artist: "Kylie", Copyright: "(c) Kylie", ImageDescription: "Sunset" },
    IFD2: {
      DateTimeOriginal: "2025:12:24 18:03:25", OffsetTimeOriginal: "-10:00",
      ISOSpeedRatings: "400", FNumber: "28/10", ExposureTime: "1/250", FocalLength: "50/1",
      ExposureBiasValue: "-1/3", LensModel: "RF 50mm", ColorSpace: "1", UserComment: "Summit at dusk",
    },
    IFD3: {
      GPSLatitudeRef: "N", GPSLatitude: "39/1 38/1 2400/100",
      GPSLongitudeRef: "W", GPSLongitude: "105/1 49/1 1200/100", GPSAltitude: "4000/1",
    },
  }, 6);

  await inEachTimezone(async () => {
    const profile = await profilePhoto(input);
    assert.ok(profile);
    assert.equal(profile.dateTaken, "2025-12-24T18:03:25-10:00");
    assert.equal(dateInputValue(profile.dateTaken), "2025-12-24");
    assert.deepEqual(
      [profile.make, profile.model, profile.lensModel, profile.software, profile.artist, profile.copyright, profile.imageDescription],
      ["Canon", "EOS R6", "RF 50mm", "Lightroom", "Kylie", "(c) Kylie", "Sunset"],
    );
    assert.deepEqual(
      [profile.focalLength, profile.aperture, profile.exposureTime, profile.iso, profile.colorSpace, profile.orientation],
      [50, 2.8, 0.004, 400, "sRGB", 6],
    );
    assert.equal(profile.userComment, "Summit at dusk");
    assert.ok(Math.abs(profile.exposureCompensation! + 1 / 3) < 1e-9);
    assert.deepEqual([profile.latitude, profile.longitude, profile.altitude], [39.64, -105.82, 4000]);
  });
});

test("profiles capture time without an offset as local wall-clock time", async () => {
  const input = await jpegWithExif({ IFD0: { Make: "Apple" }, IFD2: { DateTimeOriginal: "2019:03:30 23:27:53" } });
  await inEachTimezone(async () => {
    assert.equal((await profilePhoto(input))?.dateTaken, "2019-03-30T23:27:53");
  });
});

test("falls back to the digitized time and its offset", async () => {
  const digitizedOnly = await jpegWithExif({
    IFD0: { Make: "Apple" },
    IFD2: { DateTimeDigitized: "2026:04:12 21:27:03", OffsetTimeDigitized: "+02:00" },
  });
  const invalidOriginal = await jpegWithExif({
    IFD0: { Make: "Apple" },
    IFD2: { DateTimeOriginal: "0000:00:00 00:00:00", DateTimeDigitized: "2026:04:12 21:27:03", OffsetTimeDigitized: "+02:00" },
  });
  await inEachTimezone(async () => {
    assert.equal((await profilePhoto(digitizedOnly))?.dateTaken, "2026-04-12T21:27:03+02:00");
    assert.equal((await profilePhoto(invalidOriginal))?.dateTaken, "2026-04-12T21:27:03+02:00");
  });
});

test("profiles an image without capture time", async () => {
  const profile = await profilePhoto(await jpegWithExif({ IFD0: { Make: "Apple" } }));
  assert.equal(profile?.make, "Apple");
  assert.equal(profile?.dateTaken, null);
  assert.equal(profile?.latitude, null);
});

test("keeps EXIF wall-clock time and offset as written", () => {
  assert.equal(captureDate("2025:12:24 18:03:25", "-10:00"), "2025-12-24T18:03:25-10:00");
  assert.equal(captureDate("2026:04:12 21:27:03", "+02:00"), "2026-04-12T21:27:03+02:00");
  assert.equal(captureDate("2026:04:12 21:27:03", "+0545"), "2026-04-12T21:27:03+05:45");
  assert.equal(captureDate("2026-04-12T21:27:03.120", "+14:00"), "2026-04-12T21:27:03+14:00");
});

test("drops a missing or invalid offset and keeps local wall-clock time", () => {
  assert.equal(captureDate("2019:03:30 10:27:53"), "2019-03-30T10:27:53");
  for (const offset of ["garbage", "+15:00", "-03:60", "   "]) {
    assert.equal(captureDate("2019:03:30 10:27:53", offset), "2019-03-30T10:27:53", offset);
  }
});

test("rejects empty, zeroed, or out-of-range EXIF dates", () => {
  assert.equal(captureDate(undefined), null);
  assert.equal(captureDate("    "), null);
  assert.equal(captureDate("0000:00:00 00:00:00"), null);
  for (const value of [
    "2019:13:01 10:00:00", "2019:00:10 10:00:00", "2019:04:31 10:00:00", "2019:02:29 10:00:00",
    "2019:03:30 24:00:00", "2019:03:30 10:60:00", "2019:03:30 10:00:60",
  ]) {
    assert.equal(captureDate(value), null, value);
  }
  assert.equal(captureDate("2024:02:29 10:00:00"), "2024-02-29T10:00:00");
});

test("decodes EXIF user comments by character code", () => {
  const comment = (code: string, body: number[]) =>
    Uint8Array.from([...code.padEnd(8, "\0")].map((c) => c.charCodeAt(0)).concat(body));
  const ascii = [...new TextEncoder().encode("Longs Peak  ")];
  const utf16le = [..."Péak ⛰"].flatMap((c) => [c.charCodeAt(0) & 0xff, c.charCodeAt(0) >> 8]);
  const utf16be = [..."Péak ⛰"].flatMap((c) => [c.charCodeAt(0) >> 8, c.charCodeAt(0) & 0xff]);

  assert.equal(userComment(comment("ASCII", ascii)), "Longs Peak");
  assert.equal(userComment(comment("ASCII", [...ascii, 0, 0, 0])), "Longs Peak");
  assert.equal(userComment(comment("", ascii)), "Longs Peak");
  assert.equal(userComment(comment("UNICODE", utf16le)), "Péak ⛰");
  assert.equal(userComment(comment("UNICODE", utf16be)), "Péak ⛰");
  assert.equal(userComment(comment("JIS", [0x30, 0x42])), null);
  assert.equal(userComment(comment("ASCII", [0, 0, 0, 0])), null);
  assert.equal(userComment(comment("", [0x20, 0x20])), null);
  assert.equal(userComment(new Uint8Array(4)), null);
  assert.equal(userComment("  plain text \0"), "plain text");
  assert.equal(userComment(undefined), null);
});

test("leaves the user comment null when the tag is missing", async () => {
  const profile = await profilePhoto(await jpegWithExif({ IFD0: { Make: "Apple" } }));
  assert.equal(profile?.userComment, null);
});
