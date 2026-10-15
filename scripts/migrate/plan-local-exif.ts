#!/usr/bin/env npx tsx

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { dateInputValue, profilePhoto, type PhotoProfile } from "../../src/photo-metadata.js";

interface ImportPhoto {
  id: string;
  sourceKind: "blog" | "desktop";
  sourceFiles: string[];
  sourceUrl: string | null;
  title: string | null;
  caption: string | null;
  location: string | null;
  date: string | null;
}

interface ImportManifest {
  photos: ImportPhoto[];
}

interface ExifUpdate {
  id: string;
  sourceFile: string;
  profile: PhotoProfile;
  updates: {
    title: string | null;
    caption: string | null;
    location: string | null;
    date: string | null;
  };
}

const getArgument = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
};

const importManifestPath = resolve(getArgument("import-manifest") || "data/imports/local-photos.manifest.json");
const desktopDir = resolve(getArgument("desktop-dir") || "../Desktop Pictures copy");
const outputPath = resolve(getArgument("output") || "data/imports/local-exif.manifest.json");

const manifest = JSON.parse(await readFile(importManifestPath, "utf8")) as ImportManifest;
const updates: ExifUpdate[] = [];

for (const photo of manifest.photos.filter(({ sourceKind }) => sourceKind === "desktop")) {
  const sourceFile = photo.sourceFiles[0];
  if (!sourceFile) continue;
  const bytes = await readFile(join(desktopDir, sourceFile));
  const input = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const profile = await profilePhoto(input);
  if (!profile) continue;
  updates.push({
    id: photo.id,
    sourceFile,
    profile,
    updates: {
      title: profile.imageDescription || photo.title,
      caption: profile.userComment || photo.caption,
      location: photo.location,
      date: dateInputValue(profile.dateTaken) || photo.date,
    },
  });
}

const output = {
  version: 1,
  generatedAt: new Date().toISOString(),
  summary: {
    desktopPhotos: manifest.photos.filter(({ sourceKind }) => sourceKind === "desktop").length,
    profiled: updates.length,
    withDate: updates.filter(({ profile }) => profile.dateTaken).length,
    withGps: updates.filter(({ profile }) => profile.latitude != null && profile.longitude != null).length,
    withDescription: updates.filter(({ profile }) => profile.imageDescription || profile.userComment).length,
    withCamera: updates.filter(({ profile }) => profile.make || profile.model).length,
    publicLocationChanges: 0,
    gpsKeptProtected: updates.filter(({ profile }) =>
      profile.latitude != null && profile.longitude != null
    ).length,
  },
  updates,
};
const serialized = `${JSON.stringify(output, null, 2)}\n`;
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, serialized);
console.log(JSON.stringify(output.summary, null, 2));
console.log(`Manifest: ${outputPath}`);
console.log(`Approval digest: ${createHash("sha256").update(serialized).digest("hex")}`);
