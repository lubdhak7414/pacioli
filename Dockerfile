FROM python:3.12-slim

WORKDIR /app

# Install dependencies first for better layer caching.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the application.
COPY . .

# The ledger and SQLite DB live here; mount a volume to persist them.
VOLUME ["/app/data"]

EXPOSE 8000

# GOOGLE_API_KEY must be provided at runtime:
#   docker run -e GOOGLE_API_KEY=... -p 8000:8000 ai-accountant
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
