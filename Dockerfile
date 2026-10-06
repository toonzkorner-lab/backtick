# Backtick on Coolify / any Docker host.
#
# Deploy in Coolify as a Dockerfile build, set the exposed port to 8000,
# and add persistent storage mounted at /app/sessions so your Telegram
# login survives redeploys.

FROM python:3.12-slim

WORKDIR /app

# Dependencies first for better layer caching.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Application code.
COPY . .

# The Telegram session file lives here. Mount persistent storage on this
# path in Coolify (Service -> Storages) or you will have to sign in again
# after every redeploy.
VOLUME ["/app/sessions"]

EXPOSE 8000

# Single worker is REQUIRED: auth state lives in process memory, so
# --workers 2+ would break logins at random.
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
