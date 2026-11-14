import exifr from "exifr";

export interface PhotoProfile {
  make: string | null;
  model: string | null;
  lensModel: string | null;
  focalLength: number | null;
  aperture: number | null;
  exposureTime: number | null;
  iso: number | null;
  exposureCompensation: number | null;
  dateTaken: string | null;
  latitude: number | null;
  longitude: number | null;
  altitude: number | null;
  software: string | null;
  orientation: number | null;
  colorSpace: string | null;
  imageDescription: string | null;
  userComment: string | null;
  artist: string | null;
  copyright: string | null;
}

export const UPLOAD_TYPES: Record<string, "jpeg" | "png" | "webp" | "heic"> = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heic",
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// UserComment is bytes behind an 8-byte character code: ASCII, UNICODE
// (UCS-2 in the file's byte order), JIS, or undefined (all zeros).
export function userComment(value: unknown): string | null {
  if (typeof value === "string") return text(value.replace(/\0+$/, ""));
  if (!(value instanceof Uint8Array) || value.length <= 8) return null;
  const code = String.fromCharCode(...value.subarray(0, 8)).replace(/\0+$/, "");
  const body = value.subarray(8);
  let decoded: string;
  if (code === "UNICODE") {
    const bigEndian = body.length > 1 && body[0] === 0 && body[1] !== 0;
    decoded = new TextDecoder(bigEndian ? "utf-16be" : "utf-16le").decode(body);
  } else if (code === "ASCII" || code === "") {
    decoded = new TextDecoder("utf-8").decode(body);
  } else {
    return null;
  }
  return text(decoded.replace(/\0[\s\S]*$/, ""));
}

const EXIF_DATE = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/;
const EXIF_OFFSET = /^([+-])(\d{2}):?(\d{2})$/;

function validDate(year: number, month: number, day: number, hour: number, minute: number, second: number): boolean {
  if (year < 1 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// EXIF stores capture time as local wall-clock text plus an optional offset.
// Keep both as written so the result never depends on the runtime's timezone.
export function captureDate(value: unknown, offset?: unknown): string | null {
  const match = text(value)?.match(EXIF_DATE);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  if (!validDate(+year, +month, +day, +hour, +minute, +second)) return null;
  const zone = text(offset)?.match(EXIF_OFFSET);
  const validZone = zone && +zone[2] <= 14 && +zone[3] <= 59;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${validZone ? `${zone[1]}${zone[2]}:${zone[3]}` : ""}`;
}

// Bump whenever profilePhoto output changes so stale EXIF manifests are refused.
// 2: capture time keeps its offset; orientation and user comments are read.
export const PROFILE_VERSION = 2;

export async function profilePhoto(input: ArrayBuffer): Promise<PhotoProfile | null> {
  try {
    // reviveValues: false keeps EXIF dates as raw text; exifr would otherwise
    // build Dates in the runtime's timezone. No other picked tag is revived.
    // translateValues: false keeps Orientation numeric; of the picked tags,
    // only Orientation has a translation table.
    const metadata = await exifr.parse(input, {
      pick: [
        "Make", "Model", "LensModel", "FocalLength", "FNumber", "ExposureTime",
        "ISO", "ExposureCompensation",
        "DateTimeOriginal", "OffsetTimeOriginal", "CreateDate", "OffsetTimeDigitized", "OffsetTime",
        "GPSLatitude", "GPSLatitudeRef", "GPSLongitude", "GPSLongitudeRef", "GPSAltitude",
        "Software", "Orientation", "ColorSpace",
        "ImageDescription", "UserComment", "Artist", "Copyright",
      ],
      reviveValues: false,
      translateValues: false,
    });
    if (!metadata || typeof metadata !== "object") return null;

    return {
      make: text(metadata.Make),
      model: text(metadata.Model),
      lensModel: text(metadata.LensModel),
      focalLength: number(metadata.FocalLength),
      aperture: number(metadata.FNumber),
      exposureTime: number(metadata.ExposureTime),
      iso: number(metadata.ISO),
      exposureCompensation: number(metadata.ExposureCompensation),
      dateTaken: captureDate(metadata.DateTimeOriginal, metadata.OffsetTimeOriginal ?? metadata.OffsetTime)
        ?? captureDate(metadata.CreateDate, metadata.OffsetTimeDigitized ?? metadata.OffsetTime),
      latitude: number(metadata.latitude),
      longitude: number(metadata.longitude),
      altitude: number(metadata.GPSAltitude),
      software: text(metadata.Software),
      orientation: number(metadata.Orientation),
      colorSpace: text(metadata.ColorSpace) ?? (number(metadata.ColorSpace) === 1 ? "sRGB" : null),
      imageDescription: text(metadata.ImageDescription),
      userComment: userComment(metadata.userComment ?? metadata.UserComment),
      artist: text(metadata.Artist),
      copyright: text(metadata.Copyright),
    };
  } catch {
    return null;
  }
}

export function dateInputValue(dateTaken: string | null): string | null {
  return dateTaken?.slice(0, 10) || null;
}
