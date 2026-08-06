import { useEffect, useMemo, useState } from "react";
import {
  fetchClipsForVideoId,
  fetchSegmentsForVideoId,
  fetchVideosFeed,
  getMissingConfig,
} from "./lib/pipeline";

const TRIM_WEBHOOK_URL =
  import.meta.env.VITE_TRIM_WEBHOOK_URL ||
  import.meta.env.VITE_WORKFLOW_URL ||
  "https://n8n-kuno.169.58.4.250.sslip.io/webhook/video-trim";

function getYoutubeVideoId(url) {
  if (!url) return "";
  try {
    const parsed = new URL(String(url).trim());
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    if (host === "youtube.com" || host === "m.youtube.com" || host === "youtube-nocookie.com") {
      const v = parsed.searchParams.get("v");
      if (v) return v;

      const pathParts = parsed.pathname.split("/").filter(Boolean);
      if ((pathParts[0] === "shorts" || pathParts[0] === "embed" || pathParts[0] === "v") && pathParts[1]) {
        return pathParts[1];
      }
      if (pathParts.length > 0) {
        return pathParts[pathParts.length - 1];
      }
    }
    if (host === "youtu.be") {
      const pathParts = parsed.pathname.split("/").filter(Boolean);
      return pathParts[0] || "";
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

function getYoutubeThumbnailUrl(url) {
  const id = getYoutubeVideoId(url);
  return id ? `https://img.youtube.com/vi/${id}/hqdefault.jpg` : "";
}

function isShortsVideo(video) {
  if (!video) return false;
  const url = String(video.playableUrl || video.rawUrl || "").toLowerCase();
  const title = String(video.title || "").toLowerCase();
  if (url.includes("/shorts/") || url.includes("youtube.com/shorts")) return true;
  if (title.includes("#shorts") || title.includes("#short")) return true;
  return false;
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
  const [videoClips, setVideoClips] = useState([]);
  const [failedClips, setFailedClips] = useState({});
  const [detailSubTab, setDetailSubTab] = useState("overview"); // 'overview' | 'clips'
  const [query, setQuery] = useState("");
  const [activeTab, setActiveTab] = useState("all"); // 'all' | 'shorts' | 'standard'
  const [isLoadingFeed, setIsLoadingFeed] = useState(false);
  const [isLoadingDetails, setIsLoadingDetails] = useState(false);
  const [error, setError] = useState("");

  const [trimForm, setTrimForm] = useState({
    video_id: "",
    request_id: "",
    segment_number: "1",
    selected_text: "",
    status: "running",
    youtube_url: "",
    cookies_base64: "",
    selection_scope: "segment",
  });
  const [isSubmittingTrim, setIsSubmittingTrim] = useState(false);
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
    const embedSource = String(selectedVideo.rawUrl || selectedVideo.playableUrl || "").trim();
    const nextRequestId = generateRequestId();
    setTrimForm({
      video_id: String(selectedVideo.id || ""),
      request_id: nextRequestId,
      segment_number: "1",
      selected_text: "",
      youtube_url: embedSource,
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

  // Tab counts
  const tabCounts = useMemo(() => {
    const all = videos.length;
    const shorts = videos.filter(isShortsVideo).length;
    const standard = all - shorts;
    return { all, shorts, standard };
  }, [videos]);

  // Tab & search filtering
  const filteredVideos = useMemo(() => {
    let list = videos;
    if (activeTab === "shorts") {
      list = list.filter(isShortsVideo);
    } else if (activeTab === "standard") {
      list = list.filter((v) => !isShortsVideo(v));
    }

    const term = query.trim().toLowerCase();
    if (!term) return list;

    return list.filter((video) =>
      [video.title, video.sourceLabel, video.rawUrl, video.playableUrl, video.id]
        .join(" ")
        .toLowerCase()
        .includes(term)
    );
  }, [videos, activeTab, query]);

  const analytics = useMemo(() => buildAnalytics(selectedVideo, segments), [selectedVideo, segments]);

  const openDetails = async (video, initialSubTab = "overview") => {
    setSelectedVideo(video);
    setDetailSubTab(initialSubTab);
    setSegments([]);
    setVideoClips([]);
    setError("");
    setIsLoadingDetails(true);
    try {
      const [segRows, clipRows] = await Promise.all([
        fetchSegmentsForVideoId(video.id, { allowEmpty: true }),
        fetchClipsForVideoId(video.id).catch(() => []),
      ]);
      setSegments(segRows);
      setVideoClips(clipRows);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load video details.");
    } finally {
      setIsLoadingDetails(false);
    }
  };

  const closeDetails = () => {
    setSelectedVideo(null);
    setSegments([]);
    setVideoClips([]);
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

    setTrimError("");
    setTrimStatus("sent");
    setTrimForm((current) => ({ ...current, request_id: requestId, status: "sent" }));
    setIsSubmittingTrim(true);
    setTrimResult(null);

    const rawYoutubeUrl = String(
      selectedVideo?.rawUrl || selectedVideo?.playableUrl || trimForm.youtube_url || ""
    ).trim();

    const payload = {
      video_id: videoId,
      request_id: requestId,
      selected_text: selectedText,
      youtube_url: rawYoutubeUrl,
      selection_scope: isFullTranscriptSelection
        ? "full_transcript"
        : String(trimForm.selection_scope || "segment"),
      output_format: "json",
    };
    if (!isFullTranscriptSelection && Number.isFinite(segmentNumberValue) && segmentNumberValue > 0) {
      payload.segment_number = segmentNumberValue;
    }

    // Fire and forget request (do not wait for response)
    fetch(TRIM_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch((err) => {
      console.warn("Background trim request warning:", err);
    });

    // Immediately inform the user
    setTrimResult({
      message: "Trim request sent! The clipped video will appear in the Clips Page once processing completes.",
    });
    setIsSubmittingTrim(false);
  };

  return (
    <main className={`page ${selectedVideo ? "with-trim-panel" : ""}`}>
      {/* App Header */}
      <header className="app-header">
        <div className="header-top">
          <div className="brand-badge">
            <span className="dot"></span>
            Video Orchestrator 2.0
          </div>
          <p className="meta" style={{ margin: 0 }}>
            {videos.length} videos synced from Supabase
          </p>
        </div>
        <div>
          <h1>Video & Transcript Library</h1>
          <p>
            Browse standard YouTube videos and YouTube Shorts, inspect transcript segments, review analytics,
            and view generated clips.
          </p>
        </div>

        {/* Tab Navigation */}
        {!selectedVideo ? (
          <nav className="tabs-nav" aria-label="Video categories">
            <button
              type="button"
              className={`tab-btn ${activeTab === "all" ? "active" : ""}`}
              onClick={() => setActiveTab("all")}
            >
              <span>🌐 All Videos</span>
              <span className="badge-count">{tabCounts.all}</span>
            </button>

            <button
              type="button"
              className={`tab-btn tab-shorts ${activeTab === "shorts" ? "active" : ""}`}
              onClick={() => setActiveTab("shorts")}
            >
              <span>⚡ YouTube Shorts</span>
              <span className="badge-count">{tabCounts.shorts}</span>
            </button>

            <button
              type="button"
              className={`tab-btn ${activeTab === "standard" ? "active" : ""}`}
              onClick={() => setActiveTab("standard")}
            >
              <span>🎬 Long Videos</span>
              <span className="badge-count">{tabCounts.standard}</span>
            </button>
          </nav>
        ) : null}
      </header>

      {/* Configuration or Error Alerts */}
      {missingConfig.length ? (
        <section className="error-alert">
          <strong>Configuration Required:</strong> Missing {missingConfig.join(", ")}
        </section>
      ) : null}

      {error ? (
        <section className="error-alert" role="alert">
          {error}
        </section>
      ) : null}

      {/* Main Feed View */}
      {!selectedVideo ? (
        <>
          {/* Toolbar */}
          <div className="toolbar-panel">
            <div className="search-box">
              <span className="search-icon">🔍</span>
              <input
                type="search"
                className="search-input"
                placeholder={
                  activeTab === "shorts"
                    ? "Search YouTube Shorts..."
                    : activeTab === "standard"
                      ? "Search Long Videos..."
                      : "Search by title, source, or URL..."
                }
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                disabled={isLoadingFeed}
              />
            </div>
            <div className="action-btns">
              {query ? (
                <button type="button" className="btn-secondary" onClick={() => setQuery("")}>
                  Clear
                </button>
              ) : null}
              <button
                type="button"
                className="btn-primary"
                onClick={loadFeed}
                disabled={isLoadingFeed}
              >
                {isLoadingFeed ? "Refreshing..." : "🔄 Refresh Feed"}
              </button>
            </div>
          </div>

          {/* Video Cards Grid */}
          <div className="feed-grid">
            {filteredVideos.map((video) => {
              const isShort = isShortsVideo(video);
              const thumbUrl = getYoutubeThumbnailUrl(video.playableUrl || video.rawUrl);
              return (
                <article
                  className={`feed-card ${isShort ? "card-shorts" : ""}`}
                  key={video.id}
                  onClick={() => openDetails(video, "overview")}
                  style={{ cursor: "pointer" }}
                >
                  <div className="card-media">
                    {thumbUrl ? (
                      <img
                        src={thumbUrl}
                        alt={video.title}
                        className="thumbnail-img"
                        loading="lazy"
                      />
                    ) : null}
                    <div className="card-media-overlay">
                      <div className="play-btn-circle">▶</div>
                    </div>
                    <span className={`card-tag ${isShort ? "tag-shorts" : "tag-video"}`}>
                      {isShort ? "⚡ Short" : "🎬 Video"}
                    </span>
                  </div>

                  <div className="card-body">
                    <h3 className="card-title" title={video.title}>
                      {video.title}
                    </h3>

                    <div className="card-meta-bar">
                      <div className="card-source">
                        <span className="card-source-dot"></span>
                        <span>{video.sourceLabel || "Bloomberg TV"}</span>
                      </div>
                      <span className="meta">{video.createdAt ? new Date(video.createdAt).toLocaleDateString() : ""}</span>
                    </div>

                    <div className="card-actions" style={{ display: "flex", gap: "0.5rem" }}>
                      <button
                        type="button"
                        className="btn-open-card"
                        style={{ flex: 1 }}
                        onClick={(e) => {
                          e.stopPropagation();
                          openDetails(video, "overview");
                        }}
                      >
                        Inspect ▶
                      </button>
                      <button
                        type="button"
                        className="btn-open-card"
                        style={{
                          flex: 1,
                          background: "rgba(236, 72, 153, 0.15)",
                          borderColor: "rgba(236, 72, 153, 0.3)",
                          color: "#f472b6",
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          openDetails(video, "clips");
                        }}
                      >
                        🎬 Clips Page
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>

          {!isLoadingFeed && !filteredVideos.length ? (
            <div className="empty-box">
              <h3>No videos found</h3>
              <p style={{ marginTop: "0.5rem" }}>
                {activeTab === "shorts"
                  ? "No YouTube Shorts found in the current dataset."
                  : activeTab === "standard"
                    ? "No long videos found in the current dataset."
                    : "No videos match your search query."}
              </p>
            </div>
          ) : null}
        </>
      ) : (
        /* Video Details Container */
        <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
          {/* Details Header & Sub Navigation */}
          <div className="details-header" style={{ marginBottom: 0 }}>
            <button type="button" className="btn-back" onClick={closeDetails}>
              ← Back to {activeTab === "shorts" ? "Shorts" : activeTab === "standard" ? "Long Videos" : "Feed"}
            </button>
          </div>

          <nav className="sub-tabs-nav" aria-label="Video detail tabs">
            <button
              type="button"
              className={`sub-tab-btn ${detailSubTab === "overview" ? "active" : ""}`}
              onClick={() => setDetailSubTab("overview")}
            >
              📹 Overview & Transcript
            </button>
            <button
              type="button"
              className={`sub-tab-btn ${detailSubTab === "clips" ? "active" : ""}`}
              onClick={() => setDetailSubTab("clips")}
            >
              🎬 Clips Page ({videoClips.length})
            </button>
          </nav>

          {/* Sub-Tab 1: Overview & Transcript */}
          {detailSubTab === "overview" ? (
            <section className="details-grid">
              {/* Main Player & Analytics Column */}
              <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
                <article className="player-card">
                  <h2>{selectedVideo.title}</h2>
                  <div className="card-meta-bar" style={{ marginBottom: "0.5rem" }}>
                    <span className="meta">Source: {selectedVideo.sourceLabel || "Bloomberg TV"}</span>
                    <span className={`card-tag ${isShortsVideo(selectedVideo) ? "tag-shorts" : "tag-video"}`} style={{ position: "static" }}>
                      {isShortsVideo(selectedVideo) ? "⚡ YouTube Short" : "🎬 Long Video"}
                    </span>
                  </div>

                  <div className={`video-frame-container ${isShortsVideo(selectedVideo) ? "frame-shorts" : ""}`}>
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
                      <div className="empty-box">No embeddable YouTube URL for this video.</div>
                    )}
                  </div>

                  <p className="meta" style={{ wordBreak: "break-all" }}>
                    URL: <a href={selectedVideo.playableUrl || selectedVideo.rawUrl} target="_blank" rel="noreferrer" style={{ color: "#818cf8" }}>{selectedVideo.playableUrl || selectedVideo.rawUrl}</a>
                  </p>
                </article>

                {/* Metrics */}
                <div className="metrics-row">
                  <div className="metric-pill">
                    <div className="label">Segments</div>
                    <div className="val">{analytics.segmentsCount}</div>
                  </div>
                  <div className="metric-pill">
                    <div className="label">Total Duration</div>
                    <div className="val">{formatDuration(analytics.totalDuration)}</div>
                  </div>
                  <div className="metric-pill">
                    <div className="label">Avg Segment</div>
                    <div className="val">{formatDuration(analytics.avgDuration)}</div>
                  </div>
                  <div className="metric-pill">
                    <div className="label">Words</div>
                    <div className="val">{analytics.totalWords}</div>
                  </div>
                </div>

                {/* Full Transcript Card */}
                <article className="player-card">
                  <h3>Full Transcript</h3>
                  <p className="segment-text selectable-text" data-full-text="true" style={{ whiteSpace: "pre-wrap" }}>
                    {fullText || "No full transcript available."}
                  </p>
                </article>
              </div>

              {/* Segments Column */}
              <article className="transcript-card">
                <div className="transcript-header">
                  <h3>Transcript Segments ({segments.length})</h3>
                </div>

                {isLoadingDetails ? <p className="meta">Loading segments...</p> : null}
                {!isLoadingDetails && !segments.length ? (
                  <div className="empty-box">No transcript segments found for this video.</div>
                ) : null}

                <div className="segment-scroll-container">
                  {segments.map((segment) => (
                    <div className="segment-card-item" key={segment.id}>
                      <div className="segment-time-badge">
                        ⏱ Segment {segment.segmentNumber} ({segment.start} - {segment.end})
                      </div>
                      <p className="segment-text selectable-text" data-segment-number={segment.segmentNumber}>
                        {segment.transcript || "No transcript text."}
                      </p>
                    </div>
                  ))}
                </div>
              </article>
            </section>
          ) : (
            /* Sub-Tab 2: Clips Page for this video */
            <section style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
              <div className="toolbar-panel" style={{ background: "transparent", border: "none", padding: 0 }}>
                <div>
                  <h2 style={{ fontSize: "1.5rem" }}>Clips for "{selectedVideo.title}"</h2>
                  <p className="meta">All video clips generated from this video via AI workflow ({videoClips.length})</p>
                </div>
              </div>

              {isLoadingDetails ? <p className="meta">Loading video clips...</p> : null}

              {!isLoadingDetails && !videoClips.length ? (
                <div className="empty-box">
                  <h3>No clips generated yet</h3>
                  <p style={{ marginTop: "0.5rem", marginBottom: "1rem" }}>
                    Select text from the transcript overview or highlight any line to trim a new clip!
                  </p>
                  <button type="button" className="btn-primary" onClick={() => setDetailSubTab("overview")}>
                    ← Select Text to Create Clip
                  </button>
                </div>
              ) : null}

              <div className="clips-grid">
                {videoClips.map((clip, index) => {
                  const mainTrans = clip.transcripts?.[0];
                  const textSnippet =
                    mainTrans?.text ||
                    mainTrans?.transcript?.[0]?.text ||
                    "Trimmed video clip";
                  const startTime = mainTrans?.start ?? 0;
                  const endTime = mainTrans?.end ?? 0;

                  return (
                    <article className="clip-card" key={clip.id}>
                      <div className="clip-badge-bar">
                        <span className="clip-time-tag">
                          ⏱ Clip #{index + 1} ({typeof startTime === "number" ? startTime.toFixed(2) : startTime}s - {typeof endTime === "number" ? endTime.toFixed(2) : endTime}s)
                        </span>
                        <span className="meta">
                          {clip.createdAt ? new Date(clip.createdAt).toLocaleDateString() : ""}
                        </span>
                      </div>

                      {clip.clipPath && !failedClips[clip.id] ? (
                        <video
                          className="clip-player"
                          src={clip.clipPath}
                          controls
                          preload="metadata"
                          onError={() => setFailedClips((prev) => ({ ...prev, [clip.id]: true }))}
                        />
                      ) : clip.clipPath ? (
                        <div className="error-alert" style={{ padding: "0.85rem 1rem", fontSize: "0.82rem", borderRadius: "12px", background: "rgba(244, 63, 94, 0.12)", borderColor: "rgba(244, 63, 94, 0.25)" }}>
                          ⚠️ <strong>Playback Error (403 Forbidden):</strong>
                          <div style={{ marginTop: "0.35rem", opacity: 0.9 }}>
                            Cloudflare R2 bucket access is restricted for this URL. Ensure public access or signed URLs are enabled on R2.
                          </div>
                        </div>
                      ) : (
                        <div className="empty-box" style={{ padding: "1.5rem" }}>
                          No video file available for this clip
                        </div>
                      )}

                      <div className="clip-transcript-text">
                        "{textSnippet}"
                      </div>

                      <div className="clip-card-actions">
                        {clip.clipPath ? (
                          <a
                            className="btn-clip-action"
                            href={clip.clipPath}
                            target="_blank"
                            rel="noreferrer"
                          >
                            🔗 Open File
                          </a>
                        ) : null}
                        <button
                          type="button"
                          className="btn-clip-action"
                          onClick={() => {
                            if (clip.clipPath) {
                              navigator.clipboard.writeText(clip.clipPath);
                              alert("Clip URL copied to clipboard!");
                            }
                          }}
                        >
                          📋 Copy Link
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      )}

      {/* Floating Trim Drawer / Modal */}
      {selectedVideo ? (
        <aside className="trim-modal" aria-live="polite">
          <div className="trim-modal-head">
            <h3>✂️ AI Video Clipper</h3>
          </div>
          <p className="meta" style={{ marginBottom: "1rem" }}>
            Select any text from the transcript above to auto-fill the clip scope.
          </p>

          <form onSubmit={submitTrimRequest} className="trim-form">
            <div className="form-group">
              <label>Selected Text</label>
              <textarea
                className="form-textarea"
                value={trimForm.selected_text}
                onChange={(event) =>
                  setTrimForm((current) => ({ ...current, selected_text: event.target.value }))
                }
                rows={4}
                placeholder="Highlight text from transcript above to auto-fill."
              />
            </div>

            <div className="form-group">
              <label>Selection Scope</label>
              <select
                className="form-select"
                value={trimForm.selection_scope}
                onChange={(event) =>
                  setTrimForm((current) => ({ ...current, selection_scope: event.target.value }))
                }
              >
                <option value="segment">Segment Scope</option>
                <option value="full_transcript">Full Transcript Scope</option>
              </select>
            </div>

            <button type="submit" className="btn-primary" style={{ width: "100%", justifyContent: "center" }} disabled={isSubmittingTrim}>
              {isSubmittingTrim ? "Sending Request..." : "✨ Trim Clip"}
            </button>
          </form>

          {trimError ? <div className="error-alert" style={{ marginTop: "1rem" }}>{trimError}</div> : null}

          {trimResult?.message ? (
            <div className="trim-result" style={{ background: "rgba(52, 211, 153, 0.12)", border: "1px solid rgba(52, 211, 153, 0.3)", borderRadius: "12px", padding: "1rem", marginTop: "1rem" }}>
              <p style={{ color: "#6ee7b7", fontWeight: "600", margin: 0, fontSize: "0.9rem", lineHeight: "1.4" }}>
                🚀 {trimResult.message}
              </p>
            </div>
          ) : trimResult?.url || trimResult?.transcriptText || trimResult?.transcriptSegments?.length ? (
            <div className="trim-result">
              <h4 style={{ marginBottom: "0.5rem" }}>Trimmed Output</h4>
              {trimResult?.url ? (
                <video src={trimResult.url} controls preload="metadata" style={{ width: "100%", borderRadius: "10px" }} />
              ) : (
                <p className="meta">Transcript extracted successfully.</p>
              )}
              {trimResult?.transcriptText ? (
                <p className="meta transcript-text" style={{ marginTop: "0.5rem" }}>{trimResult.transcriptText}</p>
              ) : null}
            </div>
          ) : null}
        </aside>
      ) : null}
    </main>
  );
}

export default App;
