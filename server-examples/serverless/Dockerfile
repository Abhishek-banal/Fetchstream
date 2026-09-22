# Dockerfile for FetchStream Serverless Runner Environment
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Install dependencies, FFmpeg, and Python
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    ffmpeg \
    python3 \
    python3-pip \
    python3-venv \
    python3-dev \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Set up Python virtual environment and install packages
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

RUN pip install --no-cache-dir requests cryptography pyrogram tgcrypto boto3

CMD ["/bin/bash"]
