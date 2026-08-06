FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Step 1: Pin setuptools<70 so pkg_resources is available for setup.py
RUN pip install --no-cache-dir --no-compile "pip<26" "setuptools<70" "wheel<0.46"

# Step 2: Web server, utilities, and Whisper runtime dependencies
RUN pip install --no-cache-dir --no-compile fastapi uvicorn python-multipart yt-dlp numba tiktoken tqdm more-itertools

# Step 3: Scientific & ML dependencies (installed in stages to prevent RAM exhaustion)
RUN pip install --no-cache-dir --no-compile numpy==1.26.4
RUN pip install --no-cache-dir --no-compile --extra-index-url https://download.pytorch.org/whl/cpu torch==1.13.1+cpu

# Step 4: Install openai-whisper with --no-build-isolation so setuptools<70 is used
RUN pip install --no-cache-dir --no-compile --no-deps --no-build-isolation openai-whisper==20231117

COPY main.py /app/main.py
COPY app /app/app
COPY client_dist /app/client_dist

EXPOSE 8080

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
