import { createClient } from "@supabase/supabase-js";

const required = {
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
};

export const settings = {
  workflowUrl:
    import.meta.env.VITE_WORKFLOW_URL ||
    "/workflow",
  clipApiUrl: import.meta.env.VITE_CLIP_API_URL || "http://127.0.0.1:8000/clip",
  uploadBucket: import.meta.env.VITE_UPLOAD_BUCKET || "videos",
  clipsBucket: import.meta.env.VITE_CLIPS_BUCKET || "clips",
  transcriptSchema: import.meta.env.VITE_TRANSCRIPT_SCHEMA || "transcript",
  videosTable: import.meta.env.VITE_VIDEOS_TABLE || "videos",
  transcriptTable: import.meta.env.VITE_TRANSCRIPT_TABLE || "segments",
  videosUrlColumn: import.meta.env.VITE_VIDEOS_URL_COLUMN || "url",
  videosSourceColumn: import.meta.env.VITE_VIDEOS_SOURCE_COLUMN || "source",
  transcriptVideoIdColumn: import.meta.env.VITE_TRANSCRIPT_VIDEO_ID_COLUMN || "video_id",
  transcriptOrderColumn: import.meta.env.VITE_TRANSCRIPT_ORDER_COLUMN || "segment_number",
  workflowTimeoutMs: Number(import.meta.env.VITE_WORKFLOW_TIMEOUT_MS || 300000),
};

export function getMissingConfig() {
  const missing = [];
  if (!required.supabaseUrl) missing.push("VITE_SUPABASE_URL");
  if (!required.supabaseAnonKey) missing.push("VITE_SUPABASE_ANON_KEY");
  return missing;
}

export const supabase =
  required.supabaseUrl && required.supabaseAnonKey
    ? createClient(required.supabaseUrl, required.supabaseAnonKey)
    : null;

export function isValidHttpUrl(input) {
  try {
    const parsed = new URL(input);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function looksLikeHttpUrl(value) {
  if (value == null) return false;
  return isValidHttpUrl(String(value).trim());
}

export function toTimestamp(value) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return secondsToTimestamp(value);
  }

  const text = String(value).trim();
  if (!text) return null;

  if (/^\d+(\.\d+)?$/.test(text)) {
    return secondsToTimestamp(Number(text));
  }

  const hhmmss = text.match(/^(\d{1,2}):(\d{2}):(\d{2})(\.\d{1,3})?$/);
  if (!hhmmss) return null;

  const h = hhmmss[1].padStart(2, "0");
  const m = hhmmss[2];
  const s = hhmmss[3];
  const ms = hhmmss[4] || "";
  return `${h}:${m}:${s}${ms}`;
}

export function secondsToTimestamp(seconds) {
  const safe = Math.max(0, Number(seconds));
  const whole = Math.floor(safe);
  const ms = Math.round((safe - whole) * 1000);
  const h = String(Math.floor(whole / 3600)).padStart(2, "0");
  const m = String(Math.floor((whole % 3600) / 60)).padStart(2, "0");
  const s = String(whole % 60).padStart(2, "0");
  const suffix = ms > 0 ? `.${String(ms).padStart(3, "0")}` : "";
  return `${h}:${m}:${s}${suffix}`;
}

function generateId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  if (globalThis.crypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
      .slice(6, 8)
      .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function fileSha256Hex(file) {
  const buffer = await file.arrayBuffer();
  if (globalThis.crypto?.subtle?.digest) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
    const bytes = Array.from(new Uint8Array(digest));
    return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // Fallback for environments where Web Crypto Subtle API is unavailable.
  const bytes = new Uint8Array(buffer);
  let hash = 2166136261; // FNV-1a 32-bit
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}-${file.size}`;
}

export async function uploadVideoFile(file) {
  if (!supabase) throw new Error("Supabase client is not configured.");
  const ext = file.name.includes(".") ? file.name.split(".").pop().toLowerCase() : "mp4";
  const hash = await fileSha256Hex(file);
  const path = `source/${hash}.${ext}`;
  const { error } = await supabase.storage.from(settings.uploadBucket).upload(path, file, {
    cacheControl: "3600",
    upsert: false,
  });
  if (error) {
    if (!/already exists/i.test(error.message || "")) {
      throw new Error(`Upload failed: ${error.message}`);
    }
  }

  const { data } = supabase.storage.from(settings.uploadBucket).getPublicUrl(path);
  if (!data?.publicUrl) {
    throw new Error("Upload succeeded but no public URL was returned.");
  }

  return { path, publicUrl: data.publicUrl, deduplicated: !!error };
}

export async function triggerWorkflow(youtubeUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), settings.workflowTimeoutMs);

  try {
    const response = await fetch(settings.workflowUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        youtube_url: youtubeUrl,
        video_url: youtubeUrl,
        url: youtubeUrl,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Workflow trigger failed (${response.status}): ${body || "no body"}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      return response.json();
    }
    return response.text();
  } finally {
    clearTimeout(timeout);
  }
}

export async function triggerWorkflowAndWaitForSegments(youtubeUrl) {
  const response = await fetch("/workflow/segments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ youtube_url: youtubeUrl }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Workflow/segments failed (${response.status}): ${body || "no body"}`);
  }

  const data = await response.json();
  if (!data?.video_id || !Array.isArray(data?.segments)) {
    throw new Error("Workflow returned invalid payload.");
  }
  return {
    videoId: data.video_id,
    segments: data.segments,
    video: {
      id: data?.video?.id ?? data.video_id,
      url: data?.video?.url ?? null,
      source: data?.video?.source ?? null,
      fullTranscript: String(data?.video?.full_transcript ?? "").trim(),
    },
    workflowResponse: data?.workflow_response ?? null,
  };
}

export async function requestSelectionClip({
  videoId,
  segmentNumber,
  selectedText,
  youtubeUrl,
  selectionScope = "segment",
}) {
  const payload = {
    video_id: String(videoId),
    selected_text: selectedText,
    youtube_url: youtubeUrl,
    selection_scope: selectionScope,
  };
  if (segmentNumber != null) {
    payload.segment_number = Number(segmentNumber);
  }

  const response = await fetch("/clip/by-selection", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Selection clip failed (${response.status}): ${body || "no body"}`);
  }

  return response.blob();
}

function mapSegment(row, index) {
  const range = parseTimeRange(row.time_range);
  const start = toTimestamp(
    row.start_time ?? row.start ?? row.segment_start ?? row.from ?? range?.start
  );
  const end = toTimestamp(row.end_time ?? row.end ?? row.segment_end ?? row.to ?? range?.end);
  if (!start || !end) return null;

  const segmentNumber = Number(
    row.segment_number ?? row.segment_no ?? row.segment ?? row.order_index ?? index + 1
  );

  return {
    id: String(row.id ?? `${segmentNumber}-${start}-${end}`),
    segmentNumber: Number.isFinite(segmentNumber) ? segmentNumber : index + 1,
    start,
    end,
    transcript: String(
      row.transcript ?? row.original_text ?? row.text ?? row.content ?? row.arabic_translation ?? ""
    ).trim(),
  };
}

function mapVideoRow(row, index) {
  const primaryUrl = row?.[settings.videosUrlColumn] ?? row?.url ?? row?.youtube_url ?? row?.video_url ?? "";
  const sourceValue = row?.[settings.videosSourceColumn] ?? row?.source ?? "";
  const playableUrl = looksLikeHttpUrl(primaryUrl)
    ? String(primaryUrl).trim()
    : looksLikeHttpUrl(sourceValue)
      ? String(sourceValue).trim()
      : "";
  const sourceLabel = !looksLikeHttpUrl(sourceValue) ? String(sourceValue || "").trim() : "";
  const titleCandidate =
    row?.title ?? row?.video_title ?? row?.name ?? row?.headline ?? row?.slug ?? "";
  const title = String(titleCandidate || `Video ${index + 1}`).trim();

  return {
    id: String(row?.id ?? ""),
    title,
    playableUrl,
    rawUrl: String(primaryUrl || "").trim(),
    sourceLabel,
    fullTranscript: String(row?.full_transcript ?? row?.fullTranscript ?? "").trim(),
    createdAt: row?.created_at ?? row?.createdAt ?? row?.inserted_at ?? null,
    raw: row,
  };
}

function parseTimeRange(value) {
  if (!value) return null;
  const match = String(value)
    .trim()
    .match(
      /^\s*(\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)\s*-\s*(\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)\s*$/
    );
  if (!match) return null;
  return { start: match[1], end: match[2] };
}

function formatSupabaseErrorMessage(err, actionName = "Supabase query") {
  const msg = err?.message || String(err || "");
  if (
    msg.includes("Failed to fetch") ||
    msg.includes("TypeError") ||
    msg.includes("NetworkError") ||
    err?.name === "TypeError"
  ) {
    const url = required.supabaseUrl || "configured Supabase URL";
    return (
      `${actionName} failed due to network connection error (Failed to fetch). ` +
      `The host '${url}' could not be reached. ` +
      `Please check your internet connection or verify VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in client/.env.`
    );
  }
  return `${actionName} failed: ${msg}`;
}

async function resolveVideoId(videoUrl) {
  try {
    const base = supabase
      .schema(settings.transcriptSchema)
      .from(settings.videosTable)
      .select("id")
      .limit(1);

    const byUrl = await base.eq(settings.videosUrlColumn, videoUrl).maybeSingle();
    if (byUrl.error) throw new Error(formatSupabaseErrorMessage(byUrl.error, "Supabase video lookup"));
    if (byUrl.data?.id) return byUrl.data.id;

    const bySource = await base.eq(settings.videosSourceColumn, videoUrl).maybeSingle();
    if (bySource.error) throw new Error(formatSupabaseErrorMessage(bySource.error, "Supabase video lookup"));
    return bySource.data?.id || null;
  } catch (err) {
    throw new Error(formatSupabaseErrorMessage(err, "Supabase video lookup"));
  }
}

export async function fetchSegmentsForVideo(videoUrl, { allowEmpty = false } = {}) {
  if (!supabase) throw new Error("Supabase client is not configured.");
  const videoId = await resolveVideoId(videoUrl);
  if (!videoId) {
    if (allowEmpty) return [];
    throw new Error("No matching video record found in transcript.videos for this URL.");
  }

  try {
    const query = supabase
      .schema(settings.transcriptSchema)
      .from(settings.transcriptTable)
      .select("*")
      .eq(settings.transcriptVideoIdColumn, videoId)
      .order(settings.transcriptOrderColumn, { ascending: true });

    const { data, error } = await query;
    if (error) {
      throw new Error(formatSupabaseErrorMessage(error, "Supabase query"));
    }

    const mapped = (data || []).map(mapSegment).filter(Boolean);
    if (!mapped.length) {
      if (allowEmpty) return [];
      throw new Error("No transcript segments were found for this video URL.");
    }

    return mapped.sort((a, b) => a.segmentNumber - b.segmentNumber);
  } catch (err) {
    throw new Error(formatSupabaseErrorMessage(err, "Supabase query"));
  }
}

export async function fetchSegmentsForVideoId(videoId, { allowEmpty = false } = {}) {
  if (!supabase) throw new Error("Supabase client is not configured.");
  if (!videoId) throw new Error("video_id is required.");

  try {
    const query = supabase
      .schema(settings.transcriptSchema)
      .from(settings.transcriptTable)
      .select("*")
      .eq(settings.transcriptVideoIdColumn, videoId)
      .order(settings.transcriptOrderColumn, { ascending: true });

    const { data, error } = await query;
    if (error) {
      throw new Error(formatSupabaseErrorMessage(error, "Supabase query"));
    }

    const mapped = (data || []).map(mapSegment).filter(Boolean);
    if (!mapped.length && !allowEmpty) {
      throw new Error("No transcript segments were found for this video.");
    }
    return mapped.sort((a, b) => a.segmentNumber - b.segmentNumber);
  } catch (err) {
    throw new Error(formatSupabaseErrorMessage(err, "Supabase query"));
  }
}

export async function fetchClipsForVideoId(videoId) {
  if (!supabase) throw new Error("Supabase client is not configured.");
  if (!videoId) throw new Error("video_id is required.");

  try {
    const { data: clipRows, error: clipError } = await supabase
      .schema(settings.transcriptSchema)
      .from("clip")
      .select("*")
      .eq("video_id", videoId)
      .order("created_at", { ascending: false });

    if (clipError) throw new Error(formatSupabaseErrorMessage(clipError, "Fetch clips"));
    if (!clipRows || !clipRows.length) return [];

    const clipIds = clipRows.map((c) => c.id).filter(Boolean);
    const { data: transcriptRows, error: transError } = await supabase
      .schema(settings.transcriptSchema)
      .from("clip_transcript")
      .select("*")
      .in("clip_id", clipIds)
      .order("order", { ascending: true });

    const transcriptsByClipId = {};
    if (!transError && transcriptRows) {
      for (const row of transcriptRows) {
        if (!transcriptsByClipId[row.clip_id]) {
          transcriptsByClipId[row.clip_id] = [];
        }
        transcriptsByClipId[row.clip_id].push(row);
      }
    }

    return clipRows.map((clip) => ({
      id: clip.id,
      videoId: clip.video_id,
      clipPath: clip.clip_path || clip.url || "",
      createdAt: clip.created_at,
      transcripts: transcriptsByClipId[clip.id] || [],
    }));
  } catch (err) {
    throw new Error(formatSupabaseErrorMessage(err, "Fetch clips"));
  }
}

export async function fetchVideosFeed({ limit = 60 } = {}) {
  if (!supabase) throw new Error("Supabase client is not configured.");

  try {
    let query = supabase.schema(settings.transcriptSchema).from(settings.videosTable).select("*").limit(limit);
    let { data, error } = await query.order("created_at", { ascending: false });

    if (error && /column .*created_at/i.test(error.message || "")) {
      const fallback = await supabase
        .schema(settings.transcriptSchema)
        .from(settings.videosTable)
        .select("*")
        .limit(limit);
      data = fallback.data;
      error = fallback.error;
    }

    if (error) {
      throw new Error(formatSupabaseErrorMessage(error, "Supabase videos query"));
    }

    return (data || [])
      .map(mapVideoRow)
      .filter((video) => video.id);
  } catch (err) {
    throw new Error(formatSupabaseErrorMessage(err, "Supabase videos query"));
  }
}

export async function waitForSegments(videoUrl) {
  const timeoutMs = settings.workflowTimeoutMs;
  const pollEveryMs = 5000;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const segments = await fetchSegmentsForVideo(videoUrl, { allowEmpty: true });
    if (segments.length) return segments;
    await new Promise((resolve) => setTimeout(resolve, pollEveryMs));
  }

  throw new Error("Workflow timeout: transcript segments were not ready in time.");
}

export async function createClipBlob(videoUrl, start, end) {
  const response = await fetch(settings.clipApiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      video_url: videoUrl,
      time_range: `${start} - ${end}`,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Clip API failed (${response.status}): ${body || "no body"}`);
  }

  return response.blob();
}

export async function uploadClipBlob(blob, segmentNumber) {
  if (!supabase) throw new Error("Supabase client is not configured.");

  const path = `clips/${Date.now()}-segment-${segmentNumber}-${generateId()}.mp4`;
  const { error } = await supabase.storage.from(settings.clipsBucket).upload(path, blob, {
    contentType: "video/mp4",
    cacheControl: "3600",
    upsert: false,
  });

  if (error) {
    throw new Error(`Clip upload failed: ${error.message}`);
  }

  const { data } = supabase.storage.from(settings.clipsBucket).getPublicUrl(path);
  if (!data?.publicUrl) {
    throw new Error("Clip upload succeeded but no public URL was returned.");
  }

  return { path, publicUrl: data.publicUrl };
}

export async function deleteOriginal(path) {
  if (!supabase || !path) return;
  const { error } = await supabase.storage.from(settings.uploadBucket).remove([path]);
  if (error) {
    throw new Error(`Failed to delete original upload: ${error.message}`);
  }
}
