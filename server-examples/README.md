# FetchStream Remote Runner & Backend Architecture

Welcome to the **FetchStream Remote Runner** developer documentation.

FetchStream uses a decoupled client and optional runner architecture:
* The **Chrome Extension** handles local inspection, download, and upload workflows.
* The **Remote Runner** is an optional companion backend for users who want **Server-Side cloud downloading** (downloading streams and uploading to cloud hosts entirely on a remote server without using local internet bandwidth).

Because Server Upload uses a documented JSON REST protocol, you can use one of the provided examples or build a compatible server in Python, Go, Node.js, Rust, or another language.

> **Disclaimer:** The serverless and Docker backend examples are reference implementations. Review and secure them before deploying a runner.

---

## 🏗️ Example Backend Blueprints

| Feature | Example A: Docker / VPS Server | Example B: Serverless Cloud Runner |
| :--- | :--- | :--- |
| **Hosting Cost** | Self-hosted ($0 on home PC/NAS, or $3–$5/mo VPS) | Serverless compute provider |
| **Startup Delay** | Instant (<1 second) | ~10 seconds for cloud VM provisioning |
| **File Size Limit** | Limited by Disk Space | Depends on cloud runner disk limits |
| **Setup Difficulty**| 1 command (`docker compose up -d`) | Depends on cloud provider |
| **Best For** | Power users, VPS owners, home labs, NAS | Casual users wanting cloud downloads |
| **Folder Location** | [`server-examples/docker/`](./docker/) | [`server-examples/serverless/`](./serverless/) |

> **Note on Destination File Hosts**: The table above reflects runner server disk capacity. The maximum upload size accepted by third-party storage destinations (e.g. GoFile, Catbox, Pixeldrain, Telegram) is determined independently by those hosts. Please consult each provider's official documentation for current limits.

---

## 📡 The Universal API Contract

Any remote server that implements the following two endpoints can serve as a FetchStream Remote Runner.

### 1. Dispatch Download Job
* **Method**: `POST`
* **Path**: `/api/server-relay` (or `/api/tasks`)
* **Headers**:
  * `Content-Type: application/json`
  * `Authorization: Bearer <YOUR_API_KEY>` *(Optional)*
  * `X-API-Key: <YOUR_API_KEY>` *(Optional)*

#### Request Payload:
```json
{
  "jobId": "fetchstream_1725950000000_abc12",
  "mediaUrl": "https://example.com/stream.m3u8",
  "fileName": "lecture_video.mp4",
  "type": "hls",
  "format": "mp4",
  "service": "gofile.io",
  "description": "Optional custom description or caption for Telegram uploads",
  "threads": 8,
  "headers": {
    "User-Agent": "Mozilla/5.0 ...",
    "Referer": "https://example.com/"
  },
  "credentials": {},
  "useFallbackProxy": true
}
```

#### Response (Success):
* **Status**: `200 OK`
```json
{
  "jobId": "fetchstream_1725950000000_abc12",
  "status": "QUEUED",
  "message": "Job successfully received and queued."
}
```

---

### 2. Poll Job Status
* **Method**: `GET`
* **Path**: `/api/server-status?jobId={jobId}`
* **Headers**:
  * `Authorization: Bearer <YOUR_API_KEY>` *(Optional)*
  * `X-API-Key: <YOUR_API_KEY>` *(Optional)*

#### Response (In Progress):
* **Status**: `200 OK`
```json
{
  "jobId": "fetchstream_1725950000000_abc12",
  "status": "RUNNING",
  "stage": "DOWNLOADING",
  "progress": 42.5,
  "speed": "14.2 MB/s",
  "completedSegments": 425,
  "totalSegments": 1000,
  "fileName": "lecture_video.mp4",
  "fileSize": 104857600
}
```

#### Response (Completed):
* **Status**: `200 OK`
```json
{
  "jobId": "fetchstream_1725950000000_abc12",
  "status": "COMPLETED",
  "stage": "COMPLETED",
  "progress": 100,
  "speed": "Complete",
  "fileName": "lecture_video.mp4",
  "fileSize": 245890120,
  "url": "https://gofile.io/d/xyz789",
  "links": [
    {
      "service": "gofile.io",
      "name": "GoFile",
      "url": "https://gofile.io/d/xyz789",
      "directUrl": "https://srv.gofile.io/download/web/xyz789/video.mp4"
    }
  ]
}
```

#### Response (Failed):
* **Status**: `200 OK`
```json
{
  "jobId": "fetchstream_1725950000000_abc12",
  "status": "FAILED",
  "stage": "FAILED",
  "progress": 0,
  "error": "Failed to process HLS stream: origin server returned HTTP 403 Forbidden"
}
```

---

### 3. Webhook Callback (Runner Workers)
* **Method**: `POST`
* **Path**: `/api/server-callback`
* **Headers**: `Content-Type: application/json`

Used by backend runner scripts (`server_uploader.py`) to report granular progress, stages (`DOWNLOADING`, `CONVERTING`, `UPLOADING`, `COMPLETED`), and resulting destination URLs back to the server or Edge Provider KV store:

```json
{
  "jobId": "fetchstream_1725950000000_abc12",
  "status": "RUNNING",
  "stage": "UPLOADING",
  "progress": 82.5,
  "speed": "Telegram • 45.2/60.0MB (75%)"
}
```

---

### 4. Cancel Running Job
* **Method**: `POST` (or `GET`)
* **Path**: `/api/server-cancel` (or `/api/tasks/{job_id}/cancel`)
* **Query / Body**: `{"jobId": "fetchstream_1725950000000_abc12"}`

Aborts in-flight download processes and subprocess workers immediately.

---

### 5. Health Check
* **Method**: `GET`
* **Path**: `/health` (or `/`)

Returns the operational status, version, and active background worker load of the runner:

```json
{
  "status": "healthy",
  "service": "FetchStream Remote Runner",
  "version": "1.0.0",
  "active_jobs": 0,
  "total_jobs": 5,
  "auth_enabled": true
}
```

---

## 🔒 Security Best Practices

1. **Authentication**: Set an `API_KEY` in your server environment. The extension automatically sends it via `Authorization: Bearer <key>` and `X-API-Key: <key>`.
2. **CORS**: Ensure your server responds with standard CORS headers:
   ```http
   Access-Control-Allow-Origin: *
   Access-Control-Allow-Headers: Content-Type, Authorization, X-API-Key
   Access-Control-Allow-Methods: GET, POST, OPTIONS
   ```
3. **HTTPS / SSL**: Browsers restrict cross-origin requests from Chrome extensions to `https://` (or `http://localhost`). When deploying to a VPS, always use SSL (e.g. via Edge Tunnel, Caddy, or Nginx with Let's Encrypt).
4. **Stream Session Headers & Cookies**: When dispatching stream jobs, the extension may forward captured playback request headers (including `Cookie` and `Authorization` bearer tokens) inside `headers` so that FFmpeg and python download workers can retrieve authenticated stream segments without encountering HTTP 403 Forbidden errors. Runners should treat incoming job payloads as confidential and never store or leak user session tokens.
5. **Authorized Content Only**: Remote runners must only be utilized to process streams and media assets that the operator is legally authorized to access and download under applicable copyright laws. Runner operators must not utilize instances to facilitate copyright infringement.

---

## Documentation & Setup Guides
* Live Web Documentation: [https://fetchstream.in/documentation](https://fetchstream.in/documentation)
* Frequently Asked Questions (FAQ): [https://fetchstream.in#faq](https://fetchstream.in#faq)
* Self-Hosted Docker Guide: [`server-examples/docker/README.md`](./docker/README.md)
* Serverless Guide: [`server-examples/serverless/README.md`](./serverless/README.md)


