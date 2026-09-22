# ☁️ Example Reference Blueprint B: Serverless Cloud Runner

This directory provides an example reference implementation of a serverless cloud runner using Edge API functions and a serverless CI/CD Pipeline provider.

This setup demonstrates how you can download high-bitrate media streams and upload directly to cloud hosts using ephemeral cloud infrastructure.

> **Disclaimer:** This backend is a reference implementation. Review and secure it before deploying a runner.

---

## 📁 Blueprint Files

This directory contains ready-to-deploy blueprints for your private serverless runner:

* [**`workflows/server-relay.yml`**](./workflows/server-relay.yml): Example GitHub Actions workflow that provisions an Ubuntu container with FFmpeg and Python 3.11, downloads stream chunks in parallel, processes AES-128 keys, and streams to destination cloud hosts.
* [**`workflows/build-runner-image.yml`**](./workflows/build-runner-image.yml): Example CI/CD workflow that builds the custom Docker environment for the runner.
* [**`Dockerfile`**](./Dockerfile): The Dockerfile containing the FFmpeg and Python environment.
* [**`functions/api/`**](./functions/api/): The Edge CDN Workers edge functions implementing the standard FetchStream REST API:
  * [`server-relay.js`](./functions/api/server-relay.js): Handles `POST /api/server-relay` and dispatches jobs to your CI/CD runner via API.
  * [`server-status.js`](./functions/api/server-status.js): Handles `GET /api/server-status` for real-time progress polling.
  * [`server-callback.js`](./functions/api/server-callback.js): Internal webhook endpoint for progress updates from the runner.
  * [`stream-proxy.js`](./functions/api/stream-proxy.js): Edge fallback proxy when origin CDNs restrict datacenter IP ranges.

---

## 🛠️ Architecture Overview

```text
[ FetchStream Chrome Extension ]
              │
              │  1. Dispatch Job (POST /api/server-relay)
              ▼
[ Edge CDN Workers Function (Edge Worker) ]
              │
              │  2. Triggers Pipeline Job via Provider API
              ▼
[ Private CI/CD Runner (Custom Docker Container) ]
              │  • Native FFmpeg stream parsing & AES-128 processing
              │  • Multi-threaded chunk downloading (2 to 24 threads)
              │  • Direct cloud upload (GoFile, Buzzheavier, Pixeldrain, Catbox, S3, Telegram)
              │  • Real-time progress callbacks to /api/server-callback
              ▼
[ Destination Cloud Storage Provider ]
```

---

## 📋 Step-by-Step Deployment Guide

You can deploy this runner to your own private repository and connect it to Edge CDN Workers.

### Step 1: Create Your Private Runner Repository
1. Create a new repository on your preferred provider and set visibility to **Private**.
2. Copy the contents of the `server-examples/serverless/` directory into your new repository root. Your new repository should look like this:
   * `.github/workflows/server-relay.yml` (Move from `workflows/`)
   * `.github/workflows/build-runner-image.yml` (Move from `workflows/`)
   * `Dockerfile`
   * `functions/api/`
   * `server_uploader.py`
3. Commit and push these files to the `main` branch of your repository. Ensure your repository permissions allow workflow execution.

---

### Step 2: Build the Runner Docker Image
Execute the environment build workflow in your CI provider. This builds and publishes the Docker environment image. 
*(Note: The server-relay workflow relies on this image being present to execute rapidly without installing dependencies on each run).*

---

### Step 3: Create a CI/CD Provider API Token
Edge CDN Workers needs permission to dispatch jobs to your private repository:
1. Generate a Personal Access Token or API Token in your CI/CD provider.
2. Ensure the token has scopes for repository read/write and workflow dispatch.
3. Keep this token secure.

---

### Step 4: Deploy to an Edge Worker
Deploy the provided `functions/api` scripts to your preferred Edge compute provider (e.g., Edge CDN Workers, Vercel, Cloud Provider Lambda). 

For example, to deploy on Edge CDN Workers:
1. Log in to the Edge Provider Dashboard.
2. Go to **Workers & Pages ➔ Create Application ➔ Pages ➔ Connect to Git**.
3. Select your private runner repository.
4. Set the build configuration:
   * **Project name**: `my-fetchstream-runner`
   * **Production branch**: `main`
   * **Framework preset**: `None`
   * **Build command**: *(leave empty)*
   * **Build output directory**: `public` (or any folder containing a basic `index.html`)
5. Click **Environment variables (advanced)** and add:
   * `CI_TOKEN`: Your copied API token from Step 3.
   * `CI_REPO`: `your-username/your-runner-repo-name` (Format: `owner/repo-name`)
   * `API_KEY`: *(Optional but strongly recommended)* A secret token (e.g. `my_secret_token_123`) to password-protect your runner from unauthorized access.
6. Click **Save and Deploy**. Your provider will assign you an HTTPS domain.

#### Required: Bind Edge Provider D1 SQL Database
To enable detailed progress updates, stage badges, transfer speeds, and cancellation state, bind a D1 SQL database.

For Edge Provider (D1):
1. Navigate to **Storage & Databases -> D1**.
2. Click **Create database**, enter a name (e.g., `fetchstream_db`), and click **Create**.
3. Create the required schema by opening your database, navigating to the **Console** tab, pasting the entire contents of [`database.sql`](./database.sql), and clicking **Execute**.
4. Return to your Pages project: go to **Settings -> Functions -> D1 database bindings**.
5. Click **Add binding**:
   * **Variable name**: `DB` *(must match exactly)*
   * **D1 database**: Select your created database
6. Click **Save**.

---

### Step 5: Connect to the FetchStream Extension
1. Open the **FetchStream** extension popup in your browser.
2. Click the **Settings (gear icon)**.
3. In the **Server-Side Upload (Cloud Runner)** section, paste your Pages URL:
   ```text
   Remote Server URL: https://my-fetchstream-runner.pages.dev
   ```
4. If you configured an `API_KEY` in Step 4, enter the exact same secret token into **Server API Key / Token (Optional)**.
5. Click outside the panel to save.

When you click **`[ Server Upload ]`** on a detected stream or file, the configured runner can download and upload the asset, while reporting available progress to the extension popup.

---

## Security & Privacy Practices

1. **Private Repository**: Keep your runner repository private when its logs, artifacts, or configuration contain sensitive information.
2. **Session Cookies & Authorization Tokens**: Authenticated video streams may require session cookies (`Cookie`) and bearer tokens (`Authorization`). The extension can forward captured headers to the configured runner, so treat that runner as trusted infrastructure and protect its logs and payloads.
3. **API Key Protection**: Setting an `API_KEY` environment variable in Edge CDN Workers ensures that every incoming request is validated at the edge. Requests without the correct token are rejected immediately with HTTP `401 Unauthorized`, safeguarding your compute minutes and Edge Provider bandwidth against unauthorized discovery or abuse.
4. **Lawful Archival Only**: Use your runner exclusively for content you are authorized to access and archive. Make sure to abide by the Terms of Service of your chosen CI/CD provider.

---

## Related Resources
* [Full REST API Specification](https://fetchstream.in/documentation#api-protocol)
* [Self-Hosted Docker Runner Blueprint](../docker/)
* [Online FAQ](https://fetchstream.in#faq)
