export interface Photo {
  id: string;
  notion_id: string | null;
  r2_key: string;
  title: string | null;
  caption: string | null;
  location: string | null;
  date: string | null;
  width: number | null;
  height: number | null;
  blurhash: string | null;
  format: string | null;
  size_bytes: number | null;
  site: string | null;
  source: string | null;
  tags: string | null; // JSON array string
  exclude: number | null;
  flickr_id: string | null;
  accent_color: string | null;
  source_url: string | null;
  camera: string | null;
  ai_caption: string | null;
  ai_keywords: string | null; // JSON array string
  ai_quality_score: number | null;
  ai_processed_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface PhotoExif {
  photo_id: string;
  make: string | null;
  model: string | null;
  lens_model: string | null;
  focal_length: number | null;
  aperture: number | null;
  shutter_speed: number | null;
  iso: number | null;
  exposure_compensation: string | null;
  date_taken: string | null;
  gps_latitude: number | null;
  gps_longitude: number | null;
  gps_altitude: number | null;
  software: string | null;
  orientation: number | null;
  color_space: string | null;
  extracted_at: string | null;
}

export interface PhotoWithDetails extends Photo {
  exif?: PhotoExif | null;
}

export interface PhotoListResponse {
  photos: Photo[];
  total: number;
  limit: number;
  offset: number;
}

export interface ApiError {
  error: string;
}
