import { useEffect, useMemo, useState } from "react";
import {
  fetchSegmentsForVideoId,
  fetchVideosFeed,
  getMissingConfig,
  uploadVideoFile,
} from "./lib/pipeline";

const TRIM_WEBHOOK_URL =
  import.meta.env.VITE_TRIM_WEBHOOK_URL ||
  "https://n8n-m4wwkkco4sogkkg0gk0k8og8.20.55.33.27.sslip.io/webhook/video-trim";

function getYoutubeVideoId(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    if (host === "youtube.com" || host === "m.youtube.com") {
      return parsed.searchParams.get("v") || "";
    }
    if (host === "youtu.be") {
      return parsed.pathname.replace("/", "");
    }
    if (host === "youtube-nocookie.com") {
      const parts = parsed.pathname.split("/").filter(Boolean);
      return parts[parts.length - 1] || "";
    }
    return "";
  } catch {
    return "";
  }
}

function getYoutubeEmbedUrl(url) {
  const id = getYoutubeVideoId(url);
  return id ? `https://www.youtube.com/embed/${id}` : "";
}

function timestampToSeconds(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{1,2}):(\d{2}):(\d{2})(\.\d{1,3})?$/);
  if (!match) return 0;
  const h = Number(match[1]);
  const m = Number(match[2]);
  const s = Number(match[3]);
  const ms = match[4] ? Number(`0${match[4]}`) : 0;
  return h * 3600 + m * 60 + s + ms;
}

function formatDuration(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = Math.floor(safe % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function countWords(text) {
  return String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function buildAnalytics(video, segments) {
  const durations = segments.map((segment) =>
    Math.max(0, timestampToSeconds(segment.end) - timestampToSeconds(segment.start))
  );
  const totalDuration = durations.reduce((sum, value) => sum + value, 0);
  const avgDuration = segments.length ? totalDuration / segments.length : 0;
  const transcriptText =
    video?.fullTranscript || segments.map((segment) => segment.transcript || "").join(" ");
  const totalWords = countWords(transcriptText);
  const firstStart = segments.length ? segments[0].start : null;
  const lastEnd = segments.length ? segments[segments.length - 1].end : null;

  return {
    segmentsCount: segments.length,
    totalDuration,
    avgDuration,
    totalWords,
    firstStart,
    lastEnd,
  };
}

function findClippedMp4Url(payload) {
  if (payload == null) return "";
  if (typeof payload === "string") {
    return /clipped\.mp4(\?|$)/i.test(payload) ? payload : "";
  }
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = findClippedMp4Url(item);
      if (found) return found;
    }
    return "";
  }
  if (typeof payload === "object") {
    const preferredKeys = ["clipped_mp4", "clippedUrl", "clipped_url", "clip_url", "clipUrl"];
    for (const key of preferredKeys) {
      if (key in payload) {
        const found = findClippedMp4Url(payload[key]);
        if (found) return found;
      }
    }
    for (const value of Object.values(payload)) {
      const found = findClippedMp4Url(value);
      if (found) return found;
    }
  }
  return "";
}

function toVideoDataUrl(base64Value, mediaType = "video/mp4") {
  const cleaned = String(base64Value || "").trim();
  if (!cleaned) return "";
  return `data:${mediaType};base64,${cleaned}`;
}

function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function mergeTranscriptSegments(segments) {
  if (!Array.isArray(segments) || !segments.length) return [];

  const merged = [];
  for (const segment of segments) {
    const text = String(segment?.text || "").trim();
    if (!text) continue;

    const current = {
      id: segment?.id ?? merged.length,
      start: toFiniteNumber(segment?.start),
      end: toFiniteNumber(segment?.end),
      text,
      words: Array.isArray(segment?.words) ? segment.words : [],
    };

    const previous = merged[merged.length - 1];
    if (!previous) {
      merged.push(current);
      continue;
    }

    const gap = Math.max(0, current.start - previous.end);
    const previousWordCount = countWords(previous.text);
    const currentWordCount = countWords(current.text);
    const previousEndsSentence = /[.!?]["']?$/.test(previous.text);
    const shouldMerge =
      gap <= 1.25 && (!previousEndsSentence || previousWordCount <= 6 || currentWordCount <= 3);

    if (!shouldMerge) {
      merged.push(current);
      continue;
    }

    previous.end = Math.max(previous.end, current.end);
    previous.text = `${previous.text} ${current.text}`.replace(/\s+/g, " ").trim();
    previous.words = [...previous.words, ...current.words];
  }

  return merged;
}

function parseTranscriptResponse(value) {
  if (!value) return { text: "", segments: [] };
  if (Array.isArray(value)) {
    const segments = value;
    const text = segments
      .map((segment) => String(segment?.text || "").trim())
      .filter(Boolean)
      .join(" ")
      .trim();
    return { text, segments };
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return { text: "", segments: [] };
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") {
        return parseTranscriptResponse(parsed);
      }
    } catch {
      return { text, segments: [] };
    }
    return { text, segments: [] };
  }
  if (typeof value === "object") {
    if (Array.isArray(value.response)) {
      return parseTranscriptResponse(value.response);
    }
    if (value.response && typeof value.response === "object") {
      return parseTranscriptResponse(value.response);
    }
    const segments = Array.isArray(value.segments)
      ? value.segments
      : Array.isArray(value.data)
        ? value.data
        : [];
    const text =
      String(value.text || "").trim() ||
      segments
        .map((segment) => String(segment?.text || "").trim())
        .filter(Boolean)
        .join(" ")
        .trim();
    return {
      text,
      segments,
    };
  }
  return { text: "", segments: [] };
}

function normalizeTrimJsonResult(payload, selectedTextOverride = "") {
  const root = Array.isArray(payload) ? payload[0] : payload;
  const top = root && typeof root === "object" ? root : {};
  const transcriptSource = top.transcript ?? top.response ?? null;
  let serviceResponse = top.service_response ?? top.clip ?? {};
  const rawClipValue = typeof top.clip === "string" ? top.clip.trim() : "";
  if (typeof serviceResponse === "string") {
    try {
      const parsed = JSON.parse(serviceResponse);
      if (parsed && typeof parsed === "object") {
        serviceResponse = parsed;
      }
    } catch {
      // keep raw string
    }
  }
  const nestedServiceResponse =
    serviceResponse && typeof serviceResponse === "object"
      ? serviceResponse.service_response ?? {}
      : {};
  const clipBase64 =
    rawClipValue ||
    serviceResponse?.base64 ||
    serviceResponse?.clip_base64 ||
    serviceResponse?.video_base64 ||
    nestedServiceResponse?.base64 ||
    nestedServiceResponse?.clip_base64 ||
    nestedServiceResponse?.video_base64 ||
    "";
  const clipMediaType =
    serviceResponse?.media_type ||
    nestedServiceResponse?.media_type ||
    "video/mp4";
  const transcript = parseTranscriptResponse(transcriptSource);
  const nestedTranscriptText = String(serviceResponse?.response || "").trim();
  const normalizedSegments = mergeTranscriptSegments(
    Array.isArray(transcript.segments) ? transcript.segments : []
  );
  const selectedText = String(selectedTextOverride || "").trim();
  const finalTranscriptText = transcript.text || nestedTranscriptText || selectedText;
  const finalSegments = normalizedSegments.length
    ? normalizedSegments
    : selectedText
      ? [
          {
            id: 0,
            start: 0,
            end: 0,
            text: selectedText,
            words: [],
          },
        ]
      : [];

  return {
    videoUrl: clipBase64 ? toVideoDataUrl(clipBase64, clipMediaType) : "",
    transcriptText: finalTranscriptText,
    transcriptSegments: finalSegments,
    raw: top,
  };
}

function generateRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function App() {
  const [videos, setVideos] = useState([]);
  const [selectedVideo, setSelectedVideo] = useState(null);
  const [segments, setSegments] = useState([]);
  const [query, setQuery] = useState("");
  const [isLoadingFeed, setIsLoadingFeed] = useState(false);
  const [isLoadingDetails, setIsLoadingDetails] = useState(false);
  const [error, setError] = useState("");

  const [trimForm, setTrimForm] = useState({
    video_id: "",
    request_id: "",
    segment_number: "1",
    selected_text: "",
    status: "running",
    source_video_url: "",
    youtube_url: "",
    cookies_base64: "",
    selection_scope: "segment",
  });
  const [isSubmittingTrim, setIsSubmittingTrim] = useState(false);
  const [isUploadingSource, setIsUploadingSource] = useState(false);
  const [trimError, setTrimError] = useState("");
  const [trimResult, setTrimResult] = useState(null);
  const [trimStatus, setTrimStatus] = useState("");

  const missingConfig = useMemo(() => getMissingConfig(), []);
  const fullText = useMemo(() => {
    if (!selectedVideo) return "";
    const value = String(selectedVideo.fullTranscript || "").trim();
    if (value) return value;
    return segments.map((segment) => segment.transcript || "").join(" ").trim();
  }, [selectedVideo, segments]);

  useEffect(() => {
    return () => {
      if (trimResult?.isObjectUrl && trimResult?.url) {
        URL.revokeObjectURL(trimResult.url);
      }
    };
  }, [trimResult]);

  const loadFeed = async () => {
    if (missingConfig.length) return;
    setIsLoadingFeed(true);
    setError("");
    try {
      const rows = await fetchVideosFeed({ limit: 100 });
      setVideos(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load videos feed.");
    } finally {
      setIsLoadingFeed(false);
    }
  };

  useEffect(() => {
    loadFeed();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!selectedVideo) return;
    const sourceUrl = String(selectedVideo.playableUrl || selectedVideo.rawUrl || "").trim();
    const embedSource = String(selectedVideo.rawUrl || selectedVideo.playableUrl || "").trim();
    const youtubeUrl = getYoutubeEmbedUrl(embedSource) ? embedSource : "";
    const nextRequestId = generateRequestId();
    setTrimForm({
      video_id: String(selectedVideo.id || ""),
      request_id: nextRequestId,
      segment_number: "1",
      selected_text: "",
      status: "running",
      source_video_url: sourceUrl,
      youtube_url: youtubeUrl,
      selection_scope: "segment",
    });
    setTrimError("");
    setTrimStatus("");
    setIsSubmittingTrim(false);
    if (trimResult?.isObjectUrl && trimResult?.url) {
      URL.revokeObjectURL(trimResult.url);
    }
    setTrimResult(null);
  }, [selectedVideo]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const handleSelection = () => {
      if (!selectedVideo) return;
      const selection = window.getSelection();
      if (!selection) return;
      const selectedText = selection.toString().trim();
      if (!selectedText) return;

      const anchor = selection.anchorNode;
      const element =
        anchor?.nodeType === Node.ELEMENT_NODE ? anchor : anchor?.parentElement || null;
      if (!element) return;
      if (element.closest(".trim-modal")) return;

      let resolvedSegment = null;
      const fullTextElement = element.closest("[data-full-text='true']");
      const segmentElement = element.closest("[data-segment-number]");
      if (fullTextElement) {
        resolvedSegment = 0;
      } else if (segmentElement) {
        const value = Number(segmentElement.getAttribute("data-segment-number"));
        if (Number.isFinite(value)) {
          resolvedSegment = value;
        }
      }

      setTrimForm((current) => ({
        ...current,
        video_id: String(selectedVideo.id || ""),
        selected_text: selectedText,
        segment_number:
          resolvedSegment !== null ? String(resolvedSegment) : current.segment_number,
        selection_scope: resolvedSegment === 0 ? "full_transcript" : current.selection_scope,
      }));
    };

    document.addEventListener("mouseup", handleSelection);
    return () => document.removeEventListener("mouseup", handleSelection);
  }, [selectedVideo]);

  const filteredVideos = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return videos;
    return videos.filter((video) =>
      [video.title, video.sourceLabel, video.rawUrl, video.playableUrl].join(" ").toLowerCase().includes(term)
    );
  }, [videos, query]);

  const analytics = useMemo(() => buildAnalytics(selectedVideo, segments), [selectedVideo, segments]);

  const openDetails = async (video) => {
    setSelectedVideo(video);
    setSegments([]);
    setError("");
    setIsLoadingDetails(true);
    try {
      const rows = await fetchSegmentsForVideoId(video.id, { allowEmpty: true });
      setSegments(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load segments.");
    } finally {
      setIsLoadingDetails(false);
    }
  };

  const closeDetails = () => {
    setSelectedVideo(null);
    setSegments([]);
    setError("");
  };

  const submitTrimRequest = async (event) => {
    event.preventDefault();
    if (!selectedVideo) return;

    const videoId = String(trimForm.video_id || selectedVideo.id || "").trim();
    const segmentNumberRaw = String(trimForm.segment_number || "").trim();
    const segmentNumberValue = Number(segmentNumberRaw);
    const isFullTranscriptSelection =
      segmentNumberRaw === "0" || !Number.isFinite(segmentNumberValue) || segmentNumberValue <= 0;
    const selectedText = String(trimForm.selected_text || "").trim();
    const requestId = String(trimForm.request_id || generateRequestId()).trim();

    if (!videoId) {
      setTrimError("video_id is required.");
      return;
    }
    if (!selectedText) {
      setTrimError("selected_text is required. Select text from transcript or page.");
      return;
    }
    if (!String(trimForm.source_video_url || "").trim()) {
      setTrimError("source_video_url is required.");
      return;
    }

    setTrimError("");
    setTrimStatus("running");
    setTrimForm((current) => ({ ...current, request_id: requestId, status: "running" }));
    setIsSubmittingTrim(true);
    if (trimResult?.isObjectUrl && trimResult?.url) {
      URL.revokeObjectURL(trimResult.url);
    }
    setTrimResult(null);

    try {
      const payload = {
        video_id: videoId,
        request_id: requestId,
        selected_text: selectedText,
        status: String(trimForm.status || "running"),
        source_video_url: String(trimForm.source_video_url || "").trim(),
        youtube_url: String(trimForm.youtube_url || "").trim(),
        selection_scope: isFullTranscriptSelection
          ? "full_transcript"
          : String(trimForm.selection_scope || "segment"),
        output_format: "json",
      };
      if (!isFullTranscriptSelection) {
        payload.segment_number = segmentNumberValue;
      }

      const response = await fetch(TRIM_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Trim request failed (${response.status}): ${body || "no body"}`);
      }
      setTrimStatus((response.headers.get("x-status") || "completed").toLowerCase());
      setTrimForm((current) => ({
        ...current,
        status: (response.headers.get("x-status") || "completed").toLowerCase(),
        request_id: response.headers.get("x-request-id") || requestId,
      }));

      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        throw new Error("Unexpected response type. Expected JSON with transcript and base64 clip.");
      }

      const responseJson = await response.json();
      const normalized = normalizeTrimJsonResult(responseJson, selectedText);

      if (!normalized.videoUrl) {
        const fallbackUrl = findClippedMp4Url(responseJson);
        if (!fallbackUrl) {
          setTrimResult({
            url: "",
            isObjectUrl: false,
            transcriptText: normalized.transcriptText,
            transcriptSegments: normalized.transcriptSegments,
            rawResponse: normalized.raw,
          });
          return;
        }
        setTrimResult({
          url: String(fallbackUrl),
          isObjectUrl: false,
          transcriptText: normalized.transcriptText,
          transcriptSegments: normalized.transcriptSegments,
          rawResponse: normalized.raw,
        });
        return;
      }

      setTrimResult({
        url: normalized.videoUrl,
        isObjectUrl: false,
        transcriptText: normalized.transcriptText,
        transcriptSegments: normalized.transcriptSegments,
        rawResponse: normalized.raw,
      });
    } catch (err) {
      setTrimStatus("failed");
      setTrimForm((current) => ({ ...current, status: "failed" }));
      setTrimError(err instanceof Error ? err.message : "Trim request failed.");
    } finally {
      setIsSubmittingTrim(false);
    }
  };

  const onUploadSourceVideo = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setTrimError("");
    setIsUploadingSource(true);
    try {
      const upload = await uploadVideoFile(file);
      setTrimForm((current) => ({
        ...current,
        source_video_url: upload.publicUrl,
      }));
    } catch (err) {
      setTrimError(err instanceof Error ? err.message : "Failed to upload source video.");
    } finally {
      setIsUploadingSource(false);
    }
  };

  return (
    <main className={`page ${selectedVideo ? "with-trim-panel" : ""}`}>
      <header className="hero">
        <p className="kicker">Video Feed</p>
        <h1>YouTube Video Library</h1>
        <p>Browse videos from Supabase, open details, inspect analytics, and review transcript segments.</p>
      </header>

      {missingConfig.length ? (
        <section className="panel">
          <h2>Configuration Required</h2>
          <p className="error">Missing configuration: {missingConfig.join(", ")}</p>
        </section>
      ) : null}

      {error ? (
        <section className="panel">
          <p className="error" role="alert">
            {error}
          </p>
        </section>
      ) : null}

      {!selectedVideo ? (
        <section className="panel">
          <div className="toolbar">
            <input
              type="search"
              placeholder="Search by title, source, or URL..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              disabled={isLoadingFeed}
            />
            <button type="button" onClick={loadFeed} disabled={isLoadingFeed}>
              {isLoadingFeed ? "Refreshing..." : "Refresh"}
            </button>
          </div>

          <div className="feed-grid">
            {filteredVideos.map((video) => {
              const embedUrl = getYoutubeEmbedUrl(video.playableUrl || video.rawUrl);
              return (
                <article className="feed-card" key={video.id}>
                  {embedUrl ? (
                    <iframe
                      className="feed-embed"
                      src={embedUrl}
                      title={video.title}
                      loading="lazy"
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                      referrerPolicy="strict-origin-when-cross-origin"
                      allowFullScreen
                    />
                  ) : (
                    <div className="feed-placeholder">No YouTube embed available</div>
                  )}
                  <h3>{video.title}</h3>
                  <p className="meta">{video.sourceLabel || "Unknown source"}</p>
                  <p className="meta">Video ID: {video.id}</p>
                  <button type="button" onClick={() => openDetails(video)}>
                    Open Details
                  </button>
                </article>
              );
            })}
          </div>

          {!isLoadingFeed && !filteredVideos.length ? (
            <p className="empty">No videos found in the selected dataset.</p>
          ) : null}
        </section>
      ) : (
        <section className="details">
          <div className="details-head">
            <button type="button" className="ghost-btn" onClick={closeDetails}>
              Back to Feed
            </button>
            <h2>{selectedVideo.title}</h2>
          </div>

          <article className="video-card">
            {getYoutubeEmbedUrl(selectedVideo.playableUrl || selectedVideo.rawUrl) ? (
              <iframe
                className="main-embed"
                src={getYoutubeEmbedUrl(selectedVideo.playableUrl || selectedVideo.rawUrl)}
                title={selectedVideo.title}
                loading="lazy"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                referrerPolicy="strict-origin-when-cross-origin"
                allowFullScreen
              />
            ) : (
              <div className="feed-placeholder">No embeddable YouTube URL for this video.</div>
            )}
            <p className="meta">URL: {selectedVideo.playableUrl || selectedVideo.rawUrl || "-"}</p>
            <p className="meta">Source: {selectedVideo.sourceLabel || "-"}</p>
          </article>

          <section className="analytics-grid">
            <article className="metric-card">
              <h3>Segments</h3>
              <p>{analytics.segmentsCount}</p>
            </article>
            <article className="metric-card">
              <h3>Total Duration</h3>
              <p>{formatDuration(analytics.totalDuration)}</p>
            </article>
            <article className="metric-card">
              <h3>Avg Segment</h3>
              <p>{formatDuration(analytics.avgDuration)}</p>
            </article>
            <article className="metric-card">
              <h3>Transcript Words</h3>
              <p>{analytics.totalWords}</p>
            </article>
          </section>

          <article className="panel">
            <h3>Full Transcript / Captions</h3>
            <p className="selectable-text" data-full-text="true">
              {fullText || "No full transcript available."}
            </p>
          </article>

          <article className="panel">
            <h3>Coverage</h3>
            <p className="meta">
              Start: {analytics.firstStart || "-"} | End: {analytics.lastEnd || "-"}
            </p>
            <h3>Segments List</h3>
            {isLoadingDetails ? <p>Loading segments...</p> : null}
            {!isLoadingDetails && !segments.length ? <p className="empty">No segments found.</p> : null}
            <div className="segment-list">
              {segments.map((segment) => (
                <article className="segment-item" key={segment.id}>
                  <h4>
                    Segment {segment.segmentNumber} ({segment.start} - {segment.end})
                  </h4>
                  <p className="selectable-text" data-segment-number={segment.segmentNumber}>
                    {segment.transcript || "No transcript text."}
                  </p>
                </article>
              ))}
            </div>
          </article>
        </section>
      )}

      {selectedVideo ? (
        <aside className="trim-modal" aria-live="polite">
          <h2>Trim Video</h2>
          <p className="meta">
            Text selection auto-fills <code>selected_text</code> and segment inference.
          </p>
          <form onSubmit={submitTrimRequest} className="trim-form">
            <label className="field">
              <span>selected_text</span>
              <textarea
                value={trimForm.selected_text}
                onChange={(event) =>
                  setTrimForm((current) => ({ ...current, selected_text: event.target.value }))
                }
                rows={5}
                placeholder="Select text from transcript/captions to auto-fill."
              />
            </label>

            <label className="field">
              <span>Upload Source Video To Supabase</span>
              <input type="file" accept="video/*" onChange={onUploadSourceVideo} />
            </label>

            <label className="field">
              <span>selection_scope</span>
              <select
                value={trimForm.selection_scope}
                onChange={(event) =>
                  setTrimForm((current) => ({ ...current, selection_scope: event.target.value }))
                }
              >
                <option value="segment">segment</option>
                <option value="full_transcript">full_transcript</option>
              </select>
            </label>

            <button type="submit" disabled={isSubmittingTrim}>
              {isSubmittingTrim ? "Submitting..." : "Trim via n8n"}
            </button>
          </form>

          {trimError ? <p className="error">{trimError}</p> : null}
          {isUploadingSource ? <p className="meta">Uploading source video to Supabase...</p> : null}

          {trimResult?.url || trimResult?.transcriptText || trimResult?.transcriptSegments?.length ? (
            <div className="trim-result">
              <h3>Trim Result</h3>
              {trimResult?.url ? (
                <video src={trimResult.url} controls preload="metadata" />
              ) : (
                <p className="meta">No clipped video in service response. Transcript is shown below.</p>
              )}
              {trimResult?.transcriptText ? (
                <p className="meta transcript-text">{trimResult.transcriptText}</p>
              ) : null}
              {Array.isArray(trimResult?.transcriptSegments) && trimResult.transcriptSegments.length ? (
                <div className="transcript-timeline">
                  <h4>Transcript + Timestamps</h4>
                  <div className="timeline-list">
                    {trimResult.transcriptSegments.map((segment, index) => (
                      <article
                        key={`${segment.id ?? index}-${segment.start ?? ""}-${segment.end ?? ""}`}
                        className="timeline-item"
                      >
                        <p className="meta">
                          {(segment.start ?? 0).toFixed ? segment.start.toFixed(3) : segment.start} -{" "}
                          {(segment.end ?? 0).toFixed ? segment.end.toFixed(3) : segment.end}
                        </p>
                        <p>{segment.text || ""}</p>
                      </article>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </aside>
      ) : null}
    </main>
  );
}

export default App;
