FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir --no-compile --upgrade "pip<26" "setuptools<81" "wheel<0.46" \
    && grep -v '^openai-whisper==' /app/requirements.txt > /app/requirements.runtime.txt \
    && pip install --no-cache-dir --no-compile --extra-index-url https://download.pytorch.org/whl/cpu -r /app/requirements.runtime.txt \
    && pip install --no-cache-dir --no-compile --no-build-isolation openai-whisper==20231117

COPY main.py /app/main.py
COPY app /app/app
COPY client/dist /app/client_dist

EXPOSE 8081

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8081"]
