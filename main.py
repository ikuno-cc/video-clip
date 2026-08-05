import os
import re
import base64
import shutil
import subprocess
import tempfile
import uuid
import json
import time
import threading
import string
from difflib import SequenceMatcher
from pathlib import Path
from typing import Optional, Any
from urllib import parse as urllib_parse
from urllib import request as urllib_request
from urllib import error as urllib_error

from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from yt_dlp import YoutubeDL
import whisper

from app.config import (
    FRONTEND_DIST,
    WORKFLOW_URL,
    WORKFLOW_METHOD,
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_ANON_KEY,
    TRANSCRIPT_SCHEMA,
    VIDEOS_TABLE,
    SEGMENTS_TABLE,
    VIDEOS_URL_COLUMN,
    VIDEOS_SOURCE_COLUMN,
    SEGMENTS_VIDEO_ID_COLUMN,
    SEGMENTS_ORDER_COLUMN,
    WORKFLOW_TIMEOUT_SECONDS,
    WORKFLOW_POLL_SECONDS,
    N8N_REQUEST_TIMEOUT_SECONDS,
    SEGMENTS_WAIT_TIMEOUT_SECONDS,
    WHISPER_MODEL_NAME,
    WHISPER_MIN_OVERLAP,
    WHISPER_MIN_MATCH_COUNT,
    WHISPER_SELECTION_MIN_SCORE,
    WHISPER_SELECTION_PADDING_BEFORE,
    WHISPER_SELECTION_PADDING_AFTER,
    TRIM_MAX_CONCURRENCY,
    TRIM_STATUS_TTL_SECONDS,
)
from app.schemas import (
    ClipRequest,
    WorkflowRequest,
    WorkflowWaitRequest,
    SelectionClipRequest,
    TranscriptResponse,
    CutAudioRequest,
    TIME_RANGE_PATTERN,
)
from app.services.trim_state import TrimState, guarded_call


app = FastAPI(title="YouTube Clipper API", version="1.0.0")

_WHISPER_MODEL = None
_WHISPER_LOCK = threading.Lock()
trim_state = TrimState(TRIM_MAX_CONCURRENCY, TRIM_STATUS_TTL_SECONDS)


def parse_time_range(time_range: str) -> tuple[str, str]:
    match = TIME_RANGE_PATTERN.match(time_range)
    if not match:
        raise HTTPException(status_code=400, detail="Invalid time_range format.")
    start_time, end_time = match.groups()
    if to_seconds(end_time) <= to_seconds(start_time):
        raise HTTPException(status_code=400, detail="End time must be greater than start time.")
    return start_time, end_time


def normalize_timestamp(value: object) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    if re.match(r"^\d+(\.\d+)?$", text):
        total = float(text)
        h = int(total // 3600)
        m = int((total % 3600) // 60)
        s = total % 60
        if abs(s - int(s)) < 1e-6:
            return f"{h:02d}:{m:02d}:{int(s):02d}"
        return f"{h:02d}:{m:02d}:{s:06.3f}".replace(",", ".")
    match = re.match(r"^(\d{1,2}):(\d{2}):(\d{2})(\.\d{1,3})?$", text)
    if not match:
        return None
    h, m, s, ms = match.groups()
    return f"{int(h):02d}:{m}:{s}{ms or ''}"


def normalize_text(value: str) -> str:
    lowered = value.lower()
    table = str.maketrans("", "", string.punctuation)
    compact = lowered.translate(table)
    return " ".join(compact.split())


_VERIFY_STOPWORDS = {
    "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "that", "this",
    "is", "are", "was", "were", "be", "been", "it", "as", "at", "by", "from", "our", "their",
}


def verification_tokens(value: str) -> list[str]:
    out = []
    for token in normalize_text(value).split():
        if token.isdigit():
            out.append(token)
            continue
        if len(token) < 3:
            continue
        if token in _VERIFY_STOPWORDS:
            continue
        out.append(token)
    return out


def verify_selected_text(selected_text: str, transcription_text: str) -> tuple[bool, float, int, float]:
    selected_norm = normalize_text(selected_text)
    transcribed_norm = normalize_text(transcription_text)

    if selected_norm and selected_norm in transcribed_norm:
        tokens = verification_tokens(selected_norm)
        return True, 1.0, len(tokens), 1.0

    selected_tokens = verification_tokens(selected_norm)
    transcribed_tokens = verification_tokens(transcribed_norm)
    if not selected_tokens or not transcribed_tokens:
        return False, 0.0, 0, 0.0

    transcribed_set = set(transcribed_tokens)
    matched_tokens = [t for t in selected_tokens if t in transcribed_set]
    overlap = len(matched_tokens) / max(1, len(selected_tokens))
    dynamic_min_matches = min(
        WHISPER_MIN_MATCH_COUNT,
        max(2, int(round(len(selected_tokens) * 0.6))),
    )

    # Guardrail: compare selected text to the best matching local window
    # in the transcription instead of whole-text ratio (which can be very low
    # for long clips that include extra speech around the selected phrase).
    window_len = max(3, len(selected_tokens))
    best_window_ratio = 0.0
    if len(transcribed_tokens) <= window_len:
        best_window_ratio = SequenceMatcher(None, " ".join(selected_tokens), " ".join(transcribed_tokens)).ratio()
    else:
        selected_joined = " ".join(selected_tokens)
        for i in range(0, len(transcribed_tokens) - window_len + 1):
            window_joined = " ".join(transcribed_tokens[i : i + window_len])
            ratio = SequenceMatcher(None, selected_joined, window_joined).ratio()
            if ratio > best_window_ratio:
                best_window_ratio = ratio

    verified = (
        len(matched_tokens) >= dynamic_min_matches
        and overlap >= WHISPER_MIN_OVERLAP
        and best_window_ratio >= 0.60
    )
    return verified, overlap, len(matched_tokens), best_window_ratio


def parse_segment_range(value: object) -> tuple[Optional[str], Optional[str]]:
    if value is None:
        return None, None
    match = re.match(
        r"^\s*(\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)\s*-\s*(\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)\s*$",
        str(value).strip(),
    )
    if not match:
        return None, None
    return match.group(1), match.group(2)


def to_seconds(time_str: str) -> float:
    hours, minutes, seconds = time_str.split(":")
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def get_supabase_headers() -> dict[str, str]:
    token = SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY
    if not SUPABASE_URL or not token:
        raise HTTPException(
            status_code=500,
            detail="Missing Supabase server config. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
        )
    return {
        "apikey": token,
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept-Profile": TRANSCRIPT_SCHEMA,
        "Content-Profile": TRANSCRIPT_SCHEMA,
    }


def supabase_get(path: str) -> list[dict]:
    url = f"{SUPABASE_URL}{path}"
    req = urllib_request.Request(url, headers=get_supabase_headers(), method="GET")
    try:
        with urllib_request.urlopen(req, timeout=30) as response:
            raw = response.read().decode("utf-8")
            if not raw:
                return []
            data = json.loads(raw)
            return data if isinstance(data, list) else []
    except urllib_error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise HTTPException(status_code=502, detail=f"Supabase query failed ({exc.code}): {body}") from exc
    except urllib_error.URLError as exc:
        raise HTTPException(status_code=502, detail=f"Supabase connection failed: {exc.reason}") from exc


def map_segments(rows: list[dict]) -> list[dict]:
    mapped = []
    for idx, row in enumerate(rows, start=1):
        r_start, r_end = parse_segment_range(row.get("time_range"))
        start = normalize_timestamp(
            row.get("start_time")
            or row.get("start")
            or row.get("segment_start")
            or row.get("from")
            or r_start
        )
        end = normalize_timestamp(
            row.get("end_time")
            or row.get("end")
            or row.get("segment_end")
            or row.get("to")
            or r_end
        )
        if not start or not end:
            continue
        number = row.get("segment_number") or row.get("segment_no") or row.get("segment") or row.get("order_index") or idx
        try:
            number_int = int(number)
        except Exception:
            number_int = idx
        text = (
            row.get("transcript")
            or row.get("original_text")
            or row.get("text")
            or row.get("content")
            or row.get("arabic_translation")
            or ""
        )
        mapped.append(
            {
                "id": str(row.get("id") or f"{number}-{start}-{end}"),
                "segmentNumber": number_int,
                "start": start,
                "end": end,
                "transcript": str(text).strip(),
            }
        )
    mapped.sort(key=lambda x: x["segmentNumber"])
    return mapped


def fetch_segments_by_video_id(video_id: object) -> list[dict]:
    path = (
        f"/rest/v1/{SEGMENTS_TABLE}"
        f"?select=*"
        f"&{SEGMENTS_VIDEO_ID_COLUMN}=eq.{urllib_parse.quote(str(video_id), safe='')}"
        f"&order={SEGMENTS_ORDER_COLUMN}.asc"
    )
    rows = supabase_get(path)
    return map_segments(rows)


def fetch_segment_by_number(video_id: object, segment_number: int) -> Optional[dict]:
    path = (
        f"/rest/v1/{SEGMENTS_TABLE}"
        f"?select=*"
        f"&{SEGMENTS_VIDEO_ID_COLUMN}=eq.{urllib_parse.quote(str(video_id), safe='')}"
        f"&{SEGMENTS_ORDER_COLUMN}=eq.{segment_number}"
        f"&limit=1"
    )
    rows = supabase_get(path)
    mapped = map_segments(rows)
    if not mapped:
        return None
    return mapped[0]


def fetch_video_by_id(video_id: object) -> Optional[dict]:
    path = (
        f"/rest/v1/{VIDEOS_TABLE}"
        f"?select=*"
        f"&id=eq.{urllib_parse.quote(str(video_id), safe='')}"
        f"&limit=1"
    )
    rows = supabase_get(path)
    return rows[0] if rows else None


def fetch_video_by_url_or_source(video_url: str) -> Optional[dict]:
    encoded = urllib_parse.quote(video_url, safe="")
    path = (
        f"/rest/v1/{VIDEOS_TABLE}"
        f"?select=*"
        f"&or=({VIDEOS_URL_COLUMN}.eq.{encoded},{VIDEOS_SOURCE_COLUMN}.eq.{encoded})"
        f"&limit=1"
    )
    rows = supabase_get(path)
    return rows[0] if rows else None


def map_video_payload(video_row: Optional[dict]) -> dict:
    if not video_row:
        return {
            "id": None,
            "url": None,
            "source": None,
            "full_transcript": "",
        }
    return {
        "id": video_row.get("id"),
        "url": video_row.get(VIDEOS_URL_COLUMN),
        "source": video_row.get(VIDEOS_SOURCE_COLUMN),
        "full_transcript": str(video_row.get("full_transcript") or "").strip(),
    }


def is_url_like(value: object) -> bool:
    if value is None:
        return False
    text = str(value).strip()
    if not text:
        return False
    lower = text.lower()
    return lower.startswith("http://") or lower.startswith("https://")


def find_best_segment_for_selected_text(segments: list[dict], selected_text: str) -> Optional[dict]:
    selected_norm = normalize_text(selected_text)
    selected_tokens = selection_tokens(selected_text)
    if not selected_tokens:
        return None
    selected_set = set(selected_tokens)
    selected_joined = " ".join(selected_tokens)
    best = None
    for segment in segments:
        transcript_text = str(segment.get("transcript", "")).strip()
        transcript_norm = normalize_text(transcript_text)
        transcript_tokens = selection_tokens(transcript_text)
        if not transcript_tokens:
            continue
        overlap = len(selected_set.intersection(set(transcript_tokens))) / max(1, len(selected_set))
        ratio_full = SequenceMatcher(None, selected_joined, " ".join(transcript_tokens)).ratio()
        ratio_norm = SequenceMatcher(None, selected_norm, transcript_norm).ratio()
        inclusion_bonus = 1.0 if (selected_norm and selected_norm in transcript_norm) else 0.0
        score = (0.45 * overlap) + (0.25 * ratio_full) + (0.20 * ratio_norm) + (0.10 * inclusion_bonus)
        candidate = {"segment": segment, "score": score}
        if best is None or candidate["score"] > best["score"]:
            best = candidate
    return best["segment"] if best else None


def extract_video_id(workflow_response: Any) -> Optional[Any]:
    if not isinstance(workflow_response, dict):
        return None
    direct = workflow_response.get("video_id") or workflow_response.get("videoId") or workflow_response.get("id")
    if direct:
        return direct
    data = workflow_response.get("data")
    if isinstance(data, dict):
        return data.get("video_id") or data.get("videoId") or data.get("id")
    return None


def get_whisper_model():
    global _WHISPER_MODEL
    if _WHISPER_MODEL is not None:
        return _WHISPER_MODEL
    with _WHISPER_LOCK:
        if _WHISPER_MODEL is None:
            _WHISPER_MODEL = whisper.load_model(WHISPER_MODEL_NAME)
    return _WHISPER_MODEL


def transcribe_with_whisper(file_path: Path) -> str:
    model = get_whisper_model()
    result = model.transcribe(str(file_path), fp16=False)
    return str(result.get("text", "")).strip()


def transcribe_with_whisper_detail(file_path: Path) -> dict:
    model = get_whisper_model()
    return model.transcribe(str(file_path), fp16=False, word_timestamps=True)


def build_transcript_response(filename: str, whisper_result: dict) -> TranscriptResponse:
    segments = []
    max_end = 0.0
    for idx, segment in enumerate(whisper_result.get("segments", [])):
        start = float(segment.get("start") or 0.0)
        end = float(segment.get("end") or 0.0)
        max_end = max(max_end, end)
        segment_text = str(segment.get("text") or "").strip()
        if not segment_text:
            continue

        words = []
        for word in segment.get("words", []):
            word_text = str(word.get("word") or "").strip()
            if not word_text:
                continue
            words.append(
                {
                    "start": float(word.get("start") or 0.0),
                    "end": float(word.get("end") or 0.0),
                    "text": word_text,
                    "probability": word.get("probability"),
                }
            )

        segments.append(
            {
                "id": int(segment.get("id")) if segment.get("id") is not None else idx,
                "start": start,
                "end": end,
                "text": segment_text,
                "words": words,
            }
        )

    text = str(whisper_result.get("text") or "").strip()
    if not text:
        raise HTTPException(status_code=422, detail="Whisper returned an empty transcript.")

    return TranscriptResponse(
        filename=filename,
        language=str(whisper_result.get("language") or "").strip() or None,
        duration_seconds=max_end or None,
        text=text,
        segments=segments,
    )


def encode_file_base64(file_path: Path) -> str:
    with file_path.open("rb") as f:
        return base64.b64encode(f.read()).decode("ascii")


def build_selected_text_transcript_response(
    filename: str,
    selected_text: str,
    duration_seconds: float,
) -> TranscriptResponse:
    safe_duration = max(0.0, float(duration_seconds))
    return TranscriptResponse(
        filename=filename,
        language=None,
        duration_seconds=safe_duration,
        text=str(selected_text).strip(),
        segments=[
            {
                "id": 0,
                "start": 0.0,
                "end": safe_duration,
                "text": str(selected_text).strip(),
                "words": [],
            }
        ],
    )


def build_rewritten_whisper_transcript_response(
    filename: str,
    whisper_result: dict,
    selected_text: str,
) -> TranscriptResponse:
    selected_tokens = re.findall(r"\S+", str(selected_text or "").strip())
    token_index = 0
    segments = []
    max_end = 0.0

    for idx, segment in enumerate(whisper_result.get("segments", [])):
        start = float(segment.get("start") or 0.0)
        end = float(segment.get("end") or 0.0)
        max_end = max(max_end, end)

        words = []
        segment_words_text = []
        for word in segment.get("words", []):
            original_word = str(word.get("word") or "").strip()
            if not original_word:
                continue
            if token_index < len(selected_tokens):
                replaced_word = selected_tokens[token_index]
                token_index += 1
            else:
                replaced_word = original_word

            words.append(
                {
                    "start": float(word.get("start") or 0.0),
                    "end": float(word.get("end") or 0.0),
                    "text": replaced_word,
                    "probability": word.get("probability"),
                }
            )
            segment_words_text.append(replaced_word)

        segment_text = " ".join(segment_words_text).strip() or str(segment.get("text") or "").strip()
        if not segment_text:
            continue

        segments.append(
            {
                "id": int(segment.get("id")) if segment.get("id") is not None else idx,
                "start": start,
                "end": end,
                "text": segment_text,
                "words": words,
            }
        )

    return TranscriptResponse(
        filename=filename,
        language=str(whisper_result.get("language") or "").strip() or None,
        duration_seconds=max_end or None,
        text=str(selected_text or "").strip(),
        segments=segments,
    )


def selection_tokens(value: str) -> list[str]:
    return [token for token in normalize_text(value).split() if token]


def locate_selected_text_window(selected_text: str, whisper_result: dict) -> Optional[dict]:
    selected = selection_tokens(selected_text)
    if not selected:
        return None

    words = []
    for segment in whisper_result.get("segments", []):
        for word in segment.get("words", []):
            start = word.get("start")
            end = word.get("end")
            if start is None or end is None:
                continue
            normalized_word = normalize_text(str(word.get("word", "")))
            if not normalized_word:
                continue
            for token in normalized_word.split():
                words.append({"token": token, "start": float(start), "end": float(end)})

    if not words:
        return None

    selected_joined = " ".join(selected)
    selected_set = set(selected)
    n = len(selected)
    min_len = max(3, n - 3)
    max_len = min(len(words), n + 3)
    if min_len > max_len:
        min_len = max_len

    best = None
    for window_len in range(min_len, max_len + 1):
        for i in range(0, len(words) - window_len + 1):
            window = words[i : i + window_len]
            window_tokens = [w["token"] for w in window]
            window_joined = " ".join(window_tokens)
            ratio = SequenceMatcher(None, selected_joined, window_joined).ratio()
            overlap = len(selected_set.intersection(set(window_tokens))) / max(1, len(selected_set))
            score = (0.70 * ratio) + (0.30 * overlap)
            candidate = {
                "score": score,
                "ratio": ratio,
                "overlap": overlap,
                "start": float(window[0]["start"]),
                "end": float(window[-1]["end"]),
            }
            if best is None or candidate["score"] > best["score"]:
                best = candidate

    if best is None or best["score"] < WHISPER_SELECTION_MIN_SCORE:
        return None
    return best


def format_seconds(value: float) -> str:
    if value < 0:
        value = 0.0
    return f"{value:.3f}"


def ensure_ffmpeg_available() -> None:
    if shutil.which("ffmpeg") is None:
        raise HTTPException(
            status_code=500,
            detail="ffmpeg is not installed or not available in PATH.",
        )


def get_cookie_file_path() -> Optional[Path]:
    cookie_path = os.getenv("YTDLP_COOKIES_FILE", "").strip()
    candidates: list[Path] = []
    if cookie_path:
        candidates.append(Path(cookie_path))
    candidates.append(Path("cookies.txt"))
    for path in candidates:
        if path.exists():
            return path
    if cookie_path:
        raise HTTPException(
            status_code=500,
            detail=f"Configured cookie file does not exist: {cookie_path}",
        )
    return None


def decode_cookies_to_file(cookies_base64: str, output_dir: Path) -> Path:
    try:
        decoded = base64.b64decode(cookies_base64).decode("utf-8")
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid cookies_base64 encoding.") from exc
    cookie_file = output_dir / "cookies.txt"
    cookie_file.write_text(decoded, encoding="utf-8")
    return cookie_file


def is_direct_media_url(video_url: str) -> bool:
    parsed = urllib_parse.urlparse(video_url)
    path = (parsed.path or "").lower()
    return path.endswith((".mp4", ".mov", ".mkv", ".webm", ".m4v", ".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"))


def download_direct_media(video_url: str, output_dir: Path) -> Path:
    if video_url.startswith("file://"):
        raw_path = urllib_parse.unquote(video_url[7:])
        local_path = Path(raw_path.lstrip("/"))
        if not local_path.exists():
            local_path = Path(raw_path)
        if local_path.exists():
            suffix = local_path.suffix or ".mp4"
            output_path = output_dir / f"source_direct_{uuid.uuid4().hex}{suffix}"
            shutil.copyfile(local_path, output_path)
            return output_path

    unquoted_url = urllib_parse.unquote(video_url)
    if Path(unquoted_url).exists():
        local_path = Path(unquoted_url)
        suffix = local_path.suffix or ".mp4"
        output_path = output_dir / f"source_direct_{uuid.uuid4().hex}{suffix}"
        shutil.copyfile(local_path, output_path)
        return output_path

    suffix = Path(urllib_parse.urlparse(video_url).path).suffix or ".mp4"
    output_path = output_dir / f"source_direct_{uuid.uuid4().hex}{suffix}"
    request = urllib_request.Request(
        video_url,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/125.0.0.0 Safari/537.36"
            )
        },
    )
    try:
        with urllib_request.urlopen(request, timeout=180) as response, output_path.open("wb") as f:
            shutil.copyfileobj(response, f)
    except urllib_error.HTTPError as exc:
        raise HTTPException(status_code=500, detail=f"Direct media download failed with HTTP {exc.code}.") from exc
    except urllib_error.URLError as exc:
        raise HTTPException(status_code=500, detail=f"Direct media download failed: {exc.reason}") from exc

    if not output_path.exists() or output_path.stat().st_size == 0:
        raise HTTPException(status_code=500, detail="Direct media download produced an empty file.")
    return output_path


def download_video(video_url: str, output_dir: Path, cookies_base64: Optional[str]) -> Path:
    if is_direct_media_url(video_url):
        return download_direct_media(video_url, output_dir)

    output_template = str(output_dir / "source.%(ext)s")
    options = {
        "format": "bestvideo+bestaudio/best",
        "merge_output_format": "mp4",
        "outtmpl": output_template,
        "quiet": True,
        "noprogress": True,
        "http_headers": {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/125.0.0.0 Safari/537.36"
            )
        },
        "extractor_args": {
            "youtube": {
                "player_client": ["android", "web"],
            }
        },
    }
    proxy_url = os.getenv("YTDLP_PROXY_URL", "").strip()
    if proxy_url:
        options["proxy"] = proxy_url
    browser_name = os.getenv("YTDLP_COOKIES_FROM_BROWSER", "").strip().lower()
    use_browser_cookies = bool(browser_name)
    if use_browser_cookies:
        options["cookiesfrombrowser"] = (browser_name,)
    env_cookies_base64 = os.getenv("YTDLP_COOKIES_BASE64", "").strip()
    effective_cookies_base64 = cookies_base64 or env_cookies_base64 or None
    cookie_file = decode_cookies_to_file(effective_cookies_base64, output_dir) if effective_cookies_base64 else get_cookie_file_path()
    if cookie_file is not None:
        options["cookiefile"] = str(cookie_file)

    try:
        with YoutubeDL(options) as ydl:
            info = ydl.extract_info(video_url, download=True)
            downloaded_path = Path(ydl.prepare_filename(info))
    except Exception:
        fallback_options = {k: v for k, v in options.items() if k != "cookiesfrombrowser"}
        fallback_options["extractor_args"] = {
            "youtube": {
                "player_client": ["tv", "android", "web"],
            }
        }
        with YoutubeDL(fallback_options) as ydl:
            info = ydl.extract_info(video_url, download=True)
            downloaded_path = Path(ydl.prepare_filename(info))

    if downloaded_path.suffix.lower() != ".mp4":
        mp4_candidate = downloaded_path.with_suffix(".mp4")
        if mp4_candidate.exists():
            downloaded_path = mp4_candidate
    if not downloaded_path.exists():
        raise HTTPException(status_code=500, detail="Failed to download video.")
    return downloaded_path


def candidate_video_urls(*values: Optional[str]) -> list[str]:
    urls: list[str] = []
    for value in values:
        text = str(value or "").strip()
        if not is_url_like(text):
            continue
        if text not in urls:
            urls.append(text)
    return urls


def download_video_from_candidates(urls: list[str], output_dir: Path, cookies_base64: Optional[str]) -> tuple[Path, str]:
    last_error: Optional[HTTPException] = None
    for video_url in urls:
        try:
            return download_video(video_url, output_dir, cookies_base64), video_url
        except HTTPException as exc:
            last_error = exc
            continue
    if last_error is not None:
        raise last_error
    raise HTTPException(status_code=422, detail="No playable URL candidates were provided.")


def save_uploaded_media(uploaded_file: UploadFile, output_dir: Path) -> Path:
    filename = os.path.basename(uploaded_file.filename or "uploaded_media.mp4")
    ext = Path(filename).suffix.lower()
    if ext not in {".mp4", ".mov", ".mkv", ".webm", ".m4v", ".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"}:
        ext = ".mp4"
    output_path = output_dir / f"uploaded_{uuid.uuid4().hex}{ext}"
    with output_path.open("wb") as f:
        shutil.copyfileobj(uploaded_file.file, f)
    if output_path.stat().st_size == 0:
        raise HTTPException(status_code=400, detail="Uploaded media file is empty.")
    return output_path


def clip_video(input_path: Path, output_path: Path, start: str, end: str) -> None:
    command = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        start,
        "-to",
        end,
        "-i",
        str(input_path),
        "-c",
        "copy",
        "-y",
        str(output_path),
    ]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise HTTPException(status_code=500, detail=f"ffmpeg failed: {result.stderr.strip()}")
    if not output_path.exists():
        raise HTTPException(status_code=500, detail="Clip file was not created.")


def clip_video_precise(input_path: Path, output_path: Path, start_seconds: float, end_seconds: float) -> None:
    if end_seconds <= start_seconds:
        raise HTTPException(status_code=400, detail="Invalid precise clip range.")
    command = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(input_path),
        "-ss",
        format_seconds(start_seconds),
        "-to",
        format_seconds(end_seconds),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        "-y",
        str(output_path),
    ]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise HTTPException(status_code=500, detail=f"ffmpeg precise clip failed: {result.stderr.strip()}")
    if not output_path.exists():
        raise HTTPException(status_code=500, detail="Precise clip file was not created.")


def get_media_duration_seconds(file_path: Path) -> float:
    command = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(file_path),
    ]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        return 0.0
    try:
        return max(0.0, float((result.stdout or "").strip()))
    except (TypeError, ValueError):
        return 0.0


@app.post("/clip")
def create_clip(payload: ClipRequest):
    ensure_ffmpeg_available()
    start_time, end_time = parse_time_range(payload.time_range)

    temp_dir = Path(tempfile.mkdtemp(prefix="ytclip_"))
    output_dir = Path(tempfile.gettempdir()) / "ytclip_outputs"
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"clip_{uuid.uuid4().hex}.mp4"

    try:
        input_video_path = download_video(payload.video_url, temp_dir, payload.cookies_base64)
        clip_video(input_video_path, output_path, start_time, end_time)
    except HTTPException:
        raise
    except Exception as exc:
        msg = str(exc)
        if "Sign in to confirm you're not a bot" in msg:
            raise HTTPException(
                status_code=502,
                detail=(
                    "YouTube requires authentication for this video. "
                    "Set YTDLP_COOKIES_FILE on the server to a valid Netscape cookie file."
                ),
            ) from exc
        raise HTTPException(status_code=500, detail=msg) from exc
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

    filename = os.path.basename(output_path)
    return FileResponse(
        path=str(output_path),
        media_type="video/mp4",
        filename=filename,
    )


def download_audio_source(audio_url: str, output_dir: Path, cookies_base64: Optional[str] = None) -> Path:
    if is_direct_media_url(audio_url):
        try:
            return download_direct_media(audio_url, output_dir)
        except Exception:
            pass
    try:
        return download_video(audio_url, output_dir, cookies_base64)
    except Exception:
        return download_direct_media(audio_url, output_dir)


def clip_audio_precise(input_path: Path, output_path: Path, start_seconds: float, end_seconds: float) -> None:
    if end_seconds <= start_seconds:
        raise HTTPException(status_code=400, detail="Invalid audio clip range.")
    command = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(input_path),
        "-ss",
        format_seconds(start_seconds),
        "-to",
        format_seconds(end_seconds),
        "-vn",
        "-c:a",
        "libmp3lame",
        "-q:a",
        "2",
        "-y",
        str(output_path),
    ]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        fallback_command = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(input_path),
            "-ss",
            format_seconds(start_seconds),
            "-to",
            format_seconds(end_seconds),
            "-vn",
            "-c:a",
            "mp3",
            "-y",
            str(output_path),
        ]
        result = subprocess.run(fallback_command, capture_output=True, text=True)
        if result.returncode != 0:
            raise HTTPException(status_code=500, detail=f"ffmpeg audio cut failed: {result.stderr.strip()}")
    if not output_path.exists() or output_path.stat().st_size == 0:
        raise HTTPException(status_code=500, detail="Audio clip file was not created or is empty.")


@app.post("/cut-audio")
@app.post("/cut_audio")
@app.post("/clip/audio")
def cut_audio_endpoint(payload: CutAudioRequest):
    ensure_ffmpeg_available()
    if not payload.audio_url or not payload.audio_url.strip():
        raise HTTPException(status_code=400, detail="audio_url is required.")
    if payload.end is None or payload.end <= payload.start:
        raise HTTPException(
            status_code=400,
            detail=f"end time ({payload.end}) must be greater than start time ({payload.start}).",
        )

    temp_dir = Path(tempfile.mkdtemp(prefix="ytaudio_"))
    output_dir = Path(tempfile.gettempdir()) / "ytaudio_outputs"
    output_dir.mkdir(parents=True, exist_ok=True)
    output_filename = f"audio_clip_{uuid.uuid4().hex}.mp3"
    output_path = output_dir / output_filename

    try:
        input_media_path = download_audio_source(payload.audio_url, temp_dir, payload.cookies_base64)
        clip_audio_precise(input_media_path, output_path, payload.start, payload.end)
    except HTTPException:
        raise
    except Exception as exc:
        msg = str(exc)
        if "Sign in to confirm you're not a bot" in msg:
            raise HTTPException(
                status_code=502,
                detail=(
                    "YouTube requires authentication for this video/audio. "
                    "Set YTDLP_COOKIES_FILE on the server to a valid Netscape cookie file."
                ),
            ) from exc
        raise HTTPException(status_code=500, detail=msg) from exc
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

    return FileResponse(
        path=str(output_path),
        media_type="audio/mpeg",
        filename=output_filename,
    )


@app.post("/clip/by-selection")
def clip_by_selection(payload: SelectionClipRequest):
    ensure_ffmpeg_available()
    request_id = str(payload.request_id or uuid.uuid4().hex)
    acquired = False
    finalized = False
    trim_state.begin(request_id)
    acquired = True
    # Resolve source URL from Supabase by video_id; request URLs are optional overrides only.
    video_row = guarded_call(trim_state, request_id, fetch_video_by_id, payload.video_id)
    if not video_row:
        trim_state.end(request_id, "failed", "video_id was not found in videos table.")
        finalized = True
        raise HTTPException(status_code=404, detail="video_id was not found in videos table.")
    mapped_video = map_video_payload(video_row)
    stored_url = mapped_video.get("url")
    stored_source = mapped_video.get("source")
    video_urls = candidate_video_urls(payload.source_video_url, payload.youtube_url, stored_url, stored_source)
    if not video_urls:
        trim_state.end(request_id, "failed", "No playable URL found for this video_id in videos.source/videos.url.")
        finalized = True
        raise HTTPException(
            status_code=422,
            detail="No playable URL found for this video_id in videos.source/videos.url.",
        )

    effective_segment_number = payload.segment_number if payload.selection_scope == "segment" else None

    segment = None
    if payload.selection_scope == "segment":
        if payload.segment_number is None:
            trim_state.end(request_id, "failed", "segment_number is required for segment scope.")
            finalized = True
            raise HTTPException(status_code=400, detail="segment_number is required for segment scope.")
        segment = guarded_call(trim_state, request_id, fetch_segment_by_number, payload.video_id, payload.segment_number)
        if not segment:
            trim_state.end(request_id, "failed", "Segment not found for given video_id and segment_number.")
            finalized = True
            raise HTTPException(status_code=404, detail="Segment not found for given video_id and segment_number.")
    else:
        all_segments = guarded_call(trim_state, request_id, fetch_segments_by_video_id, payload.video_id)
        if not all_segments:
            trim_state.end(request_id, "failed", "No segments found for given video_id.")
            finalized = True
            raise HTTPException(status_code=404, detail="No segments found for given video_id.")
        if payload.selection_scope == "full_transcript":
            start_candidate = all_segments[0].get("start")
            end_candidate = all_segments[-1].get("end")
            segment = {
                "segmentNumber": 0,
                "start": start_candidate,
                "end": end_candidate,
                "transcript": " ".join(str(item.get("transcript", "")).strip() for item in all_segments).strip(),
            }
        else:
            segment = find_best_segment_for_selected_text(all_segments, payload.selected_text)
            if not segment:
                trim_state.end(request_id, "failed", "Could not resolve selected text to a matching segment.")
                finalized = True
                raise HTTPException(
                    status_code=422,
                    detail="Could not resolve selected text to a matching segment.",
                )

    selected_normalized = normalize_text(payload.selected_text)
    transcript_normalized = normalize_text(segment.get("transcript", ""))
    if payload.selection_scope == "segment" and selected_normalized and selected_normalized not in transcript_normalized:
        trim_state.end(request_id, "failed", "Selected text does not match transcript for this segment.")
        finalized = True
        raise HTTPException(
            status_code=400,
            detail="Selected text does not match transcript for this segment.",
        )

    temp_dir = Path(tempfile.mkdtemp(prefix="ytclip_select_"))
    output_dir = Path(tempfile.gettempdir()) / "ytclip_outputs"
    output_dir.mkdir(parents=True, exist_ok=True)
    segment_output_path = temp_dir / f"segment_{payload.video_id}_{effective_segment_number}_{uuid.uuid4().hex}.mp4"
    output_path = output_dir / f"clip_{payload.video_id}_{effective_segment_number}_{uuid.uuid4().hex}.mp4"

    try:
        input_video_path, resolved_video_url = download_video_from_candidates(video_urls, temp_dir, None)
        clip_video(input_video_path, segment_output_path, segment["start"], segment["end"])
        detailed = transcribe_with_whisper_detail(segment_output_path)
        selected_window = locate_selected_text_window(payload.selected_text, detailed)
        if not selected_window:
            transcribed_full = str(detailed.get("text", "")).strip()
            trim_state.end(request_id, "failed", "Whisper selection alignment failed.")
            finalized = True
            raise HTTPException(
                status_code=422,
                detail=(
                    "Whisper selection alignment failed: could not locate selected text window "
                    f"within segment audio. transcription={transcribed_full}"
                ),
            )
        segment_start_seconds = to_seconds(segment["start"])
        segment_end_seconds = to_seconds(segment["end"])
        clip_start = max(segment_start_seconds, segment_start_seconds + selected_window["start"] - WHISPER_SELECTION_PADDING_BEFORE)
        clip_end = min(segment_end_seconds, segment_start_seconds + selected_window["end"] + WHISPER_SELECTION_PADDING_AFTER)
        clip_video_precise(input_video_path, output_path, clip_start, clip_end)
        if payload.selection_scope == "segment":
            transcribed = transcribe_with_whisper(output_path)
            verified, overlap_score, match_count, window_ratio = verify_selected_text(payload.selected_text, transcribed)
            if not verified:
                trim_state.end(request_id, "failed", "Whisper verification failed.")
                finalized = True
                raise HTTPException(
                    status_code=422,
                    detail=(
                        "Whisper verification failed: selected text not found in clipped audio. "
                        f"overlap={overlap_score:.2f}, matches={match_count}, window_ratio={window_ratio:.2f}, "
                        f"selection_score={selected_window['score']:.2f}, "
                        f"transcription={transcribed}"
                    ),
                )
    except HTTPException:
        raise
    except Exception as exc:
        trim_state.end(request_id, "failed", str(exc))
        finalized = True
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

    trim_state.end(request_id, "completed")
    finalized = True
    if payload.output_format == "json":
        transcript_payload = build_selected_text_transcript_response(
            filename=os.path.basename(output_path),
            selected_text=payload.selected_text,
            duration_seconds=max(0.0, clip_end - clip_start),
        )
        service_response = {
            "filename": os.path.basename(output_path),
            "media_type": "video/mp4",
            "size_bytes": int(output_path.stat().st_size),
            "base64": encode_file_base64(output_path),
        }
        return {
            "response": str(payload.selected_text).strip(),
            "service_response": service_response,
            "status": "completed",
            "request_id": request_id,
            "video_id": str(payload.video_id),
            "resolved_video_url": resolved_video_url,
            "requested_segment_number": effective_segment_number,
            "resolved_segment_number": int(segment["segmentNumber"]),
            "selection_scope": payload.selection_scope,
            "clip": service_response,
            "transcript": transcript_payload.model_dump(),
        }
    return FileResponse(
        path=str(output_path),
        media_type="video/mp4",
        filename=os.path.basename(output_path),
        headers={
            "X-Whisper-Verified": "true",
            "X-Status": "completed",
            "X-Request-Id": request_id,
            "X-Video-Id": str(payload.video_id),
            "X-Requested-Segment-Number": str(effective_segment_number or ""),
            "X-Segment-Number": str(segment["segmentNumber"]),
            "X-Selection-Scope": payload.selection_scope,
        },
    )


@app.post("/clip/by-selection-upload")
def clip_by_selection_upload(
    video_file: UploadFile = File(...),
    video_id: str = Form(...),
    request_id: Optional[str] = Form(default=None),
    segment_number: Optional[int] = Form(default=None),
    selected_text: str = Form(...),
    status: Optional[str] = Form(default=None),
    selection_scope: str = Form(default="segment"),
):
    ensure_ffmpeg_available()
    request_id = str(request_id or uuid.uuid4().hex)
    trim_state.begin(request_id)
    selection_scope = (selection_scope or "segment").strip().lower()
    if selection_scope not in {"segment", "full_transcript"}:
        trim_state.end(request_id, "failed", "selection_scope must be 'segment' or 'full_transcript'")
        raise HTTPException(status_code=400, detail="selection_scope must be 'segment' or 'full_transcript'")
    if segment_number == 0:
        # Allow callers to use 0 as a full-transcript indicator.
        selection_scope = "full_transcript"
        segment_number = None
    if segment_number is not None and segment_number < 0:
        trim_state.end(request_id, "failed", "segment_number must be >= 1.")
        raise HTTPException(status_code=400, detail="segment_number must be >= 1.")

    effective_segment_number = segment_number if selection_scope == "segment" else None

    segment = None
    if selection_scope == "segment":
        if segment_number is None:
            trim_state.end(request_id, "failed", "segment_number is required for segment scope.")
            raise HTTPException(status_code=400, detail="segment_number is required for segment scope.")
        segment = guarded_call(trim_state, request_id, fetch_segment_by_number, video_id, segment_number)
        if not segment:
            trim_state.end(request_id, "failed", "Segment not found for given video_id and segment_number.")
            raise HTTPException(status_code=404, detail="Segment not found for given video_id and segment_number.")
    else:
        all_segments = guarded_call(trim_state, request_id, fetch_segments_by_video_id, video_id)
        if not all_segments:
            trim_state.end(request_id, "failed", "No segments found for given video_id.")
            raise HTTPException(status_code=404, detail="No segments found for given video_id.")
        if selection_scope == "full_transcript":
            start_candidate = all_segments[0].get("start")
            end_candidate = all_segments[-1].get("end")
            segment = {
                "segmentNumber": 0,
                "start": start_candidate,
                "end": end_candidate,
                "transcript": " ".join(str(item.get("transcript", "")).strip() for item in all_segments).strip(),
            }
        else:
            segment = find_best_segment_for_selected_text(all_segments, selected_text)
            if not segment:
                trim_state.end(request_id, "failed", "Could not resolve selected text to a matching segment.")
                raise HTTPException(
                    status_code=422,
                    detail="Could not resolve selected text to a matching segment.",
                )

    selected_normalized = normalize_text(selected_text)
    transcript_normalized = normalize_text(segment.get("transcript", ""))
    if selection_scope == "segment" and selected_normalized and selected_normalized not in transcript_normalized:
        trim_state.end(request_id, "failed", "Selected text does not match transcript for this segment.")
        raise HTTPException(
            status_code=400,
            detail="Selected text does not match transcript for this segment.",
        )

    temp_dir = Path(tempfile.mkdtemp(prefix="ytclip_upload_"))
    output_dir = Path(tempfile.gettempdir()) / "ytclip_outputs"
    output_dir.mkdir(parents=True, exist_ok=True)
    segment_output_path = temp_dir / f"segment_{video_id}_{effective_segment_number}_{uuid.uuid4().hex}.mp4"
    output_path = output_dir / f"clip_{video_id}_{effective_segment_number}_{uuid.uuid4().hex}.mp4"

    try:
        input_video_path = save_uploaded_media(video_file, temp_dir)
        clip_video(input_video_path, segment_output_path, segment["start"], segment["end"])
        detailed = transcribe_with_whisper_detail(segment_output_path)
        selected_window = locate_selected_text_window(selected_text, detailed)
        if not selected_window:
            transcribed_full = str(detailed.get("text", "")).strip()
            trim_state.end(request_id, "failed", "Whisper selection alignment failed.")
            raise HTTPException(
                status_code=422,
                detail=(
                    "Whisper selection alignment failed: could not locate selected text window "
                    f"within segment audio. transcription={transcribed_full}"
                ),
            )
        segment_start_seconds = to_seconds(segment["start"])
        segment_end_seconds = to_seconds(segment["end"])
        clip_start = max(segment_start_seconds, segment_start_seconds + selected_window["start"] - WHISPER_SELECTION_PADDING_BEFORE)
        clip_end = min(segment_end_seconds, segment_start_seconds + selected_window["end"] + WHISPER_SELECTION_PADDING_AFTER)
        clip_video_precise(input_video_path, output_path, clip_start, clip_end)
        if selection_scope == "segment":
            transcribed = transcribe_with_whisper(output_path)
            verified, overlap_score, match_count, window_ratio = verify_selected_text(selected_text, transcribed)
            if not verified:
                trim_state.end(request_id, "failed", "Whisper verification failed.")
                raise HTTPException(
                    status_code=422,
                    detail=(
                        "Whisper verification failed: selected text not found in clipped audio. "
                        f"overlap={overlap_score:.2f}, matches={match_count}, window_ratio={window_ratio:.2f}, "
                        f"selection_score={selected_window['score']:.2f}, "
                        f"transcription={transcribed}"
                    ),
                )
    except HTTPException:
        raise
    except Exception as exc:
        trim_state.end(request_id, "failed", str(exc))
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        try:
            video_file.file.close()
        except Exception:
            pass
        shutil.rmtree(temp_dir, ignore_errors=True)

    trim_state.end(request_id, "completed")
    return FileResponse(
        path=str(output_path),
        media_type="video/mp4",
        filename=os.path.basename(output_path),
        headers={
            "X-Whisper-Verified": "true",
            "X-Status": "completed",
            "X-Request-Id": request_id,
            "X-Video-Id": str(video_id),
            "X-Requested-Segment-Number": str(effective_segment_number or ""),
            "X-Segment-Number": str(segment["segmentNumber"]),
            "X-Selection-Scope": selection_scope,
        },
    )


@app.post("/transcript", response_model=TranscriptResponse)
async def create_transcript(
    request: Request,
    file: UploadFile = File(...),
    selected_text: Optional[str] = Form(default=None),
):
    temp_dir = Path(tempfile.mkdtemp(prefix="ytclip_transcript_"))

    try:
        input_media_path = save_uploaded_media(file, temp_dir)
        selected_text_value = str(selected_text or "").strip()
        if not selected_text_value:
            try:
                form_data = await request.form()
                for key in ("selected_text", "selectedText", "text", "original_text", "response"):
                    value = str(form_data.get(key) or "").strip()
                    if value:
                        selected_text_value = value
                        break
            except Exception:
                pass
        if not selected_text_value:
            raise HTTPException(
                status_code=400,
                detail="selected_text is required for /transcript.",
            )
        whisper_result = transcribe_with_whisper_detail(input_media_path)
        return build_rewritten_whisper_transcript_response(
            filename=os.path.basename(file.filename or input_media_path.name),
            whisper_result=whisper_result,
            selected_text=selected_text_value,
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        try:
            file.file.close()
        except Exception:
            pass
        shutil.rmtree(temp_dir, ignore_errors=True)


def run_workflow_request(payload: WorkflowRequest, timeout_seconds: int) -> dict:
    body = {
        "youtube_url": payload.youtube_url,
        "video_url": payload.video_url,
        "url": payload.url,
    }
    body = {k: v for k, v in body.items() if v}

    def _perform(method: str):
        if method == "GET":
            query = urllib_parse.urlencode(body)
            target_url = f"{WORKFLOW_URL}?{query}" if query else WORKFLOW_URL
            req = urllib_request.Request(target_url, method="GET")
        else:
            req = urllib_request.Request(
                WORKFLOW_URL,
                data=json.dumps(body).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
        with urllib_request.urlopen(req, timeout=timeout_seconds) as response:
            raw = response.read()
            content_type = response.headers.get("content-type", "")
            if "application/json" in content_type:
                try:
                    return {"status_code": response.status, "payload": json.loads(raw.decode("utf-8"))}
                except Exception:
                    return {"status_code": response.status, "payload": {"status": "ok", "body": raw.decode("utf-8", errors="replace")}}
            return {"status_code": response.status, "payload": {"status": "ok", "body": raw.decode("utf-8", errors="replace")}}

    primary = WORKFLOW_METHOD if WORKFLOW_METHOD in ("GET", "POST") else "POST"
    secondary = "GET" if primary == "POST" else "POST"
    try:
        return _perform(primary)
    except urllib_error.HTTPError as exc:
        message = exc.read().decode("utf-8", errors="replace")
        lower = message.lower()
        if exc.code == 404 and ("did you mean to make a get request" in lower or "did you mean to make a post request" in lower):
            try:
                return _perform(secondary)
            except urllib_error.HTTPError as exc2:
                message2 = exc2.read().decode("utf-8", errors="replace")
                raise HTTPException(
                    status_code=502,
                    detail=f"Workflow proxy failed ({exc2.code}): {message2 or 'no body'}",
                ) from exc2
        raise HTTPException(
            status_code=502,
            detail=f"Workflow proxy failed ({exc.code}): {message or 'no body'}",
        ) from exc
    except urllib_error.URLError as exc:
        raise HTTPException(status_code=502, detail=f"Workflow proxy connection failed: {exc.reason}") from exc


@app.post("/workflow")
def run_workflow(payload: WorkflowRequest):
    result = run_workflow_request(payload, timeout_seconds=120)
    return JSONResponse(status_code=result["status_code"], content=result["payload"])


@app.post("/workflow/segments")
def workflow_and_segments(payload: WorkflowWaitRequest):
    youtube_url = payload.youtube_url.strip()
    existing_video = fetch_video_by_url_or_source(youtube_url)
    if existing_video:
        existing_segments = fetch_segments_by_video_id(existing_video.get("id"))
        if existing_segments:
            return {
                "status": "done",
                "video_id": existing_video.get("id"),
                "video": map_video_payload(existing_video),
                "workflow_response": {"status": "skipped", "reason": "video already exists"},
                "segments": existing_segments,
            }

    result = run_workflow_request(
        WorkflowRequest(
            youtube_url=youtube_url,
            video_url=youtube_url,
            url=youtube_url,
        ),
        timeout_seconds=N8N_REQUEST_TIMEOUT_SECONDS,
    )

    workflow_payload = result["payload"]
    video_id = extract_video_id(workflow_payload)
    if video_id is None:
        raise HTTPException(
            status_code=502,
            detail=f"Workflow response did not include video_id. Response: {workflow_payload}",
        )

    deadline = None if SEGMENTS_WAIT_TIMEOUT_SECONDS <= 0 else (time.time() + SEGMENTS_WAIT_TIMEOUT_SECONDS)
    while True:
        segments = fetch_segments_by_video_id(video_id)
        if segments:
            video_row = fetch_video_by_id(video_id)
            return {
                "status": "done",
                "video_id": video_id,
                "video": map_video_payload(video_row),
                "workflow_response": workflow_payload,
                "segments": segments,
            }
        if deadline is not None and time.time() >= deadline:
            raise HTTPException(
                status_code=504,
                detail=f"Timed out waiting for segments for video_id={video_id}.",
            )
        time.sleep(WORKFLOW_POLL_SECONDS)


@app.get("/health")
def health_check():
    return {"status": "ok"}


@app.get("/trim/status/{request_id}")
def trim_status(request_id: str):
    item = trim_state.get_status(request_id)
    if not item:
        raise HTTPException(status_code=404, detail="request_id not found.")
    return item


@app.get("/")
def root():
    if FRONTEND_DIST.exists():
        return FileResponse(str(FRONTEND_DIST / "index.html"))
    return {
        "service": "YouTube Clipper API",
        "status": "ok",
        "endpoints": {
            "health": "/health",
            "clip": "/clip",
            "transcript": "/transcript",
            "clip_by_selection": "/clip/by-selection",
            "clip_by_selection_upload": "/clip/by-selection-upload",
            "trim_status": "/trim/status/{request_id}",
            "workflow": "/workflow",
            "workflow_segments": "/workflow/segments",
        },
    }


if FRONTEND_DIST.exists() and (FRONTEND_DIST / "assets").exists():
    app.mount("/assets", StaticFiles(directory=str(FRONTEND_DIST / "assets")), name="assets")


@app.get("/{full_path:path}")
def spa_fallback(full_path: str):
    # Keep API/docs routes untouched; serve SPA for client-side routes.
    if full_path.startswith(("clip", "transcript", "workflow", "health", "docs", "redoc", "openapi.json")):
        return JSONResponse(status_code=404, content={"detail": "Not Found"})
    if FRONTEND_DIST.exists():
        return FileResponse(str(FRONTEND_DIST / "index.html"))
    return JSONResponse(status_code=404, content={"detail": "Not Found"})
