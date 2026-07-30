# Video Segment Orchestrator UI

React + Vite frontend for upload/URL intake, n8n workflow trigger, Supabase transcript retrieval, clipping, and clip review.

## Run

```bash
cd client
npm install
cp .env.example .env
npm run dev
```

## Required env

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

## Default flow

1. Upload video to Supabase Storage (`videos` bucket) or use a direct URL.
2. Trigger n8n workflow with `{ "video_url": "..." }`.
3. Resolve `transcript.videos.id` by matching URL/source, then query `transcript.segments` by `video_id`.
4. Call clip API (`POST /clip`) for each segment range.
5. Upload generated clips to `clips` bucket.
6. Delete original uploaded source from `videos` bucket.
