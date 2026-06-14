# Arceus Flow-Tester — standalone browser-agent QA service.
# Runs its OWN Chromium (via Playwright/browser-use) so the browser never
# touches the slim Arceus API container. `playwright install --with-deps`
# pulls the OS libs (libglib etc.) that broke the old in-container probe.
FROM python:3.12-slim

WORKDIR /app

# Python deps first (layer cache).
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Chromium + its OS dependencies (handles the libglib/font friction).
RUN python -m playwright install --with-deps chromium

COPY . .

ENV PORT=8080 \
    PYTHONUNBUFFERED=1 \
    BROWSER_USE_HEADLESS=true

EXPOSE 8080
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8080}"]
