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

function captureDate(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  return text(value)?.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3") ?? null;
}

export async function profilePhoto(input: ArrayBuffer): Promise<PhotoProfile | null> {
  try {
    const [metadata, gps] = await Promise.all([
      exifr.parse(input, [
        "Make", "Model", "LensModel", "FocalLength", "FNumber", "ExposureTime",
        "ISO", "ExposureCompensation", "DateTimeOriginal", "CreateDate",
        "GPSAltitude", "Software", "Orientation", "ColorSpace",
        "ImageDescription", "UserComment", "Artist", "Copyright",
      ]),
      exifr.gps(input).catch(() => null),
    ]);
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
      dateTaken: captureDate(metadata.DateTimeOriginal ?? metadata.CreateDate),
      latitude: number(gps?.latitude),
      longitude: number(gps?.longitude),
      altitude: number(metadata.GPSAltitude),
      software: text(metadata.Software),
      orientation: number(metadata.Orientation),
      colorSpace: text(metadata.ColorSpace) ?? (number(metadata.ColorSpace) === 1 ? "sRGB" : null),
      imageDescription: text(metadata.ImageDescription),
      userComment: text(metadata.UserComment),
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
