import type { Photo, PhotoListResponse, PhotoWithDetails } from "./types.js";

const API_BASE = process.env.PHOTOS_API_URL?.replace(/\/$/, "") || "";
const ACCESS_TOKEN = process.env.CF_ACCESS_TOKEN || "";

function getHeaders(isAdmin = false): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (isAdmin && ACCESS_TOKEN) {
    headers["Cf-Access-Jwt-Assertion"] = ACCESS_TOKEN;
  }
  return headers;
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export async function listPhotos(params?: {
  site?: string;
  limit?: number;
  offset?: number;
}): Promise<PhotoListResponse> {
  const url = new URL(`${API_BASE}/api/photos`);
  if (params?.site) url.searchParams.set("site", params.site);
  if (params?.limit) url.searchParams.set("limit", String(params.limit));
  if (params?.offset !== undefined)
    url.searchParams.set("offset", String(params.offset));

  const res = await fetch(url.toString(), { headers: getHeaders() });
  return handleResponse<PhotoListResponse>(res);
}

export async function searchPhotos(params: {
  q: string;
  site?: string;
  limit?: number;
  offset?: number;
}): Promise<PhotoListResponse> {
  const url = new URL(`${API_BASE}/api/photos`);
  url.searchParams.set("q", params.q);
  if (params.site) url.searchParams.set("site", params.site);
  if (params.limit) url.searchParams.set("limit", String(params.limit));
  if (params.offset !== undefined)
    url.searchParams.set("offset", String(params.offset));

  const res = await fetch(url.toString(), { headers: getHeaders() });
  return handleResponse<PhotoListResponse>(res);
}

export async function getRandomPhoto(params?: {
  site?: string;
  tag?: string;
}): Promise<Photo> {
  const url = new URL(`${API_BASE}/api/photos/random`);
  if (params?.site) url.searchParams.set("site", params.site);
  if (params?.tag) url.searchParams.set("tag", params.tag);

  const res = await fetch(url.toString(), { headers: getHeaders() });
  return handleResponse<Photo>(res);
}

export async function getPhoto(
  id: string,
  include?: { exif?: boolean; ai?: boolean }
): Promise<PhotoWithDetails> {
  const url = new URL(`${API_BASE}/api/photos/${id}`);
  const parts: string[] = [];
  if (include?.exif) parts.push("exif");
  if (include?.ai) parts.push("ai");
  if (parts.length) url.searchParams.set("include", parts.join(","));

  const res = await fetch(url.toString(), { headers: getHeaders() });
  return handleResponse<PhotoWithDetails>(res);
}

export async function updatePhoto(
  id: string,
  fields: Partial<{
    title: string;
    caption: string;
    location: string;
    date: string;
    tags: string[];
    site: string;
    exclude: boolean;
  }>
): Promise<Photo> {
  const res = await fetch(`${API_BASE}/api/admin/photos/${id}`, {
    method: "PATCH",
    headers: getHeaders(true),
    body: JSON.stringify(fields),
  });
  return handleResponse<Photo>(res);
}

export async function deletePhoto(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/admin/photos/${id}`, {
    method: "DELETE",
    headers: getHeaders(true),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body || res.statusText}`);
  }
}
