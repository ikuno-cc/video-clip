import re
from typing import Optional, Any

from pydantic import BaseModel, Field, field_validator, model_validator


TIME_RANGE_PATTERN = re.compile(
    r"^\s*(\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)\s*-\s*(\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)\s*$"
)


class ClipRequest(BaseModel):
    video_url: str = Field(..., min_length=5)
    time_range: str = Field(..., examples=["00:00:00.240 - 00:00:31.840"])
    cookies_base64: Optional[str] = Field(
        default=None,
        description="Optional base64-encoded Netscape cookies.txt content for yt-dlp auth.",
    )

    @field_validator("time_range")
    @classmethod
    def validate_time_range_format(cls, value: str) -> str:
        if not TIME_RANGE_PATTERN.match(value):
            raise ValueError("time_range must match 'HH:MM:SS(.mmm) - HH:MM:SS(.mmm)'")
        return value


class WorkflowRequest(BaseModel):
    youtube_url: Optional[str] = None
    video_url: Optional[str] = None
    url: Optional[str] = None


class WorkflowWaitRequest(BaseModel):
    youtube_url: str = Field(..., min_length=5)


class SelectionClipRequest(BaseModel):
    video_id: str = Field(..., min_length=1)
    request_id: Optional[str] = Field(default=None, min_length=1)
    segment_number: Optional[int] = Field(default=None, ge=1)
    selected_text: str = Field(..., min_length=1)
    source_video_url: Optional[str] = None
    youtube_url: Optional[str] = None
    selection_scope: Optional[str] = Field(default="segment")
    output_format: Optional[str] = Field(default="json")

    @field_validator("selection_scope")
    @classmethod
    def validate_scope(cls, value: Optional[str]) -> str:
        scope = (value or "segment").strip().lower()
        if scope not in {"segment", "full_transcript"}:
            raise ValueError("selection_scope must be 'segment' or 'full_transcript'")
        return scope

    @field_validator("output_format")
    @classmethod
    def validate_output_format(cls, value: Optional[str]) -> str:
        output_format = (value or "json").strip().lower()
        if output_format not in {"file", "json"}:
            raise ValueError("output_format must be 'file' or 'json'")
        return output_format


class TranscriptWord(BaseModel):
    start: float = Field(..., ge=0)
    end: float = Field(..., ge=0)
    text: str = Field(..., min_length=1)
    probability: Optional[float] = Field(default=None, ge=0, le=1)


class TranscriptSegment(BaseModel):
    id: Optional[int] = None
    start: float = Field(..., ge=0)
    end: float = Field(..., ge=0)
    text: str = Field(..., min_length=1)
    words: list[TranscriptWord] = Field(default_factory=list)


class TranscriptResponse(BaseModel):
    filename: str = Field(..., min_length=1)
    language: Optional[str] = None
    duration_seconds: Optional[float] = Field(default=None, ge=0)
    text: str = Field(..., min_length=1)
    segments: list[TranscriptSegment] = Field(default_factory=list)


class CutAudioRequest(BaseModel):
    audio_url: str = Field(..., description="URL of the audio or video file to cut")
    start: float = Field(..., ge=0, description="Start time in seconds")
    end: Optional[float] = Field(default=None, ge=0, description="End time in seconds")
    duration: Optional[float] = Field(default=None, gt=0, description="Duration in seconds (alternative to end time)")
    cookies_base64: Optional[str] = Field(
        default=None,
        description="Optional base64-encoded Netscape cookies.txt content for yt-dlp auth.",
    )

    @field_validator("start", "end", "duration", mode="before")
    @classmethod
    def parse_time_input(cls, value: Any) -> Optional[float]:
        if value is None or str(value).strip() == "":
            return None
        if isinstance(value, (int, float)):
            val = float(value)
            if val < 0:
                raise ValueError("Timestamp cannot be negative")
            return val
        text = str(value).strip()
        if ":" in text:
            parts = text.split(":")
            if len(parts) == 3:
                val = float(parts[0]) * 3600 + float(parts[1]) * 60 + float(parts[2])
            elif len(parts) == 2:
                val = float(parts[0]) * 60 + float(parts[1])
            else:
                raise ValueError("Invalid timestamp format")
            if val < 0:
                raise ValueError("Timestamp cannot be negative")
            return val
        val = float(text)
        if val < 0:
            raise ValueError("Timestamp cannot be negative")
        return val

    @model_validator(mode="after")
    def validate_and_compute_end(self) -> "CutAudioRequest":
        if self.end is None and self.duration is not None:
            self.end = self.start + self.duration
        elif self.end is None and self.duration is None:
            raise ValueError("Either 'end' or 'duration' must be provided.")

        if self.end <= self.start:
            raise ValueError(
                f"end time ({self.end}) must be greater than start time ({self.start}). "
                f"Check if values are swapped or if 'duration' was passed as 'end'."
            )
        return self

