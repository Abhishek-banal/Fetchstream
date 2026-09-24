FROM aiogram/telegram-bot-api:latest

USER root
ENV PYTHONUNBUFFERED=1 \
    PORT=8000

# Install Python, FFmpeg, curl, and build tools using Alpine's apk
RUN apk update && \
    apk add --no-cache \
        python3 \
        py3-pip \
        ffmpeg \
        curl \
        ca-certificates \
        gcc \
        musl-dev \
        python3-dev \
        libffi-dev

WORKDIR /app

# Install Python dependencies
COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt --break-system-packages || pip3 install --no-cache-dir -r requirements.txt

# Copy runner script, server application, and start wrapper
COPY server.py .
COPY server_uploader.py .
COPY start.sh .

RUN chmod +x start.sh

EXPOSE 8000


# Override the aiogram entrypoint so we can run both services
ENTRYPOINT []
CMD ["./start.sh"]
