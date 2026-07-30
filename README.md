# YouTube Clip API (FastAPI)

FastAPI service that can clip a YouTube video and can also transcribe an uploaded audio/video clip with Whisper timestamps.

## Input format

```json
{
  "video_url": "https://www.youtube.com/watch?v=YOUR_VIDEO_ID",
  "time_range": "00:00:00.240 - 00:00:31.840"
}
```

## Requirements

- Python 3.10+
- `ffmpeg` installed and available in `PATH`
- For restricted YouTube videos, provide cookies via `YTDLP_COOKIES_FILE`

## Install

```bash
pip install -r requirements.txt
```

## Run

```bash
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

With cookies:

```bash
YTDLP_COOKIES_FILE=/path/to/cookies.txt uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

## Endpoints

- `GET /health`
- `POST /clip`
- `POST /transcript`

## Example request

```bash
curl -X POST "http://127.0.0.1:8000/clip" \
  -H "Content-Type: application/json" \
  -d "{\"video_url\":\"https://www.youtube.com/watch?v=dQw4w9WgXcQ\",\"time_range\":\"00:00:00.240 - 00:00:31.840\"}" \
  --output clip.mp4
```

## Transcript upload example

```bash
curl -X POST "http://127.0.0.1:8000/transcript" \
  -F "file=@sample.mp4"
```
