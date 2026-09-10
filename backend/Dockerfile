FROM python:3.11-slim

WORKDIR /app

# Install deps before copying source — better layer caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Bake GTFS into image at build time (read-only static data)
# load_gtfs.py resolves output path via __file__ → writes to /app/data/gtfs.db
RUN python scripts/load_gtfs.py

# Run as an unprivileged user
RUN adduser --system --uid 10001 --home /app --no-create-home appuser \
  && chown -R appuser /app
USER appuser

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD python -c "import urllib.request, os; urllib.request.urlopen(f'http://localhost:{os.environ.get(\"PORT\", \"8000\")}/health/ready')" || exit 1

EXPOSE 8000

# Railway injects PORT and routes public traffic to it; bind there, default 8000 for local runs
CMD ["./entrypoint.sh"]
