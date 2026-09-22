# Deploying to Google Cloud Run

A concrete recipe for hosting the server on [Cloud Run](https://cloud.google.com/run). The
server is just a container, so adapt these steps to any platform.

## Prerequisites

```bash
gcloud auth login
gcloud config set project YOUR_PROJECT
gcloud services enable run.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com
```

## 1. Store the Lexware API key in Secret Manager

Keep the key out of the image and out of source control:

```bash
gcloud secrets create lexware-api-key --replication-policy=automatic
printf '%s' "YOUR_LEXWARE_KEY" | gcloud secrets versions add lexware-api-key --data-file=-
```

Grant the Cloud Run runtime service account access (default is the compute SA):

```bash
PROJECT_NUMBER=$(gcloud projects describe YOUR_PROJECT --format='value(projectNumber)')
gcloud secrets add-iam-policy-binding lexware-api-key \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

## 2. Deploy

Cloud Build builds the `Dockerfile` from source. Pick **one** auth mode:

**OAuth (recommended — enables the custom-connector UI / web / ChatGPT):**

```bash
gcloud run deploy lexware-mcp \
  --source . \
  --region europe-west1 \
  --allow-unauthenticated \
  --max-instances=1 \
  --set-secrets LEXWARE_API_KEY=lexware-api-key:latest \
  --set-env-vars OAUTH_ISSUER=https://YOUR-TENANT.example,OAUTH_RESOURCE=https://YOUR-PUBLIC-URL/mcp,OAUTH_ALLOWED_EMAIL_DOMAINS=example.com
```

`OAUTH_RESOURCE` is the MCP endpoint including `/mcp` — the URL users enter in Claude — and
must also be registered as a Resource Indicator with your provider, or every token fails the
audience check. See the README's "Connecting as a custom connector (OAuth)".

**Static bearer token (Claude Code / Desktop only):** store a token in Secret Manager and map
it instead of the OAuth env vars:

```bash
openssl rand -hex 32 | tr -d '\n' | gcloud secrets versions add mcp-auth-token --data-file=- # after `gcloud secrets create mcp-auth-token ...`
gcloud run deploy lexware-mcp --source . --region europe-west1 --allow-unauthenticated --max-instances=1 \
  --set-secrets LEXWARE_API_KEY=lexware-api-key:latest,MCP_AUTH_TOKEN=mcp-auth-token:latest
```

### Notes / Cloud-Run-specific gotchas

- `--allow-unauthenticated` is safe — the app's own auth middleware gates `/mcp`. (Cloud Run's
  IAM gate can't carry the OAuth/bearer flow MCP clients use.)
- **`--max-instances=1`** keeps the per-process ~2 req/s rate limiter accurate; multiple
  instances would aggregate beyond Lexware's limit and get throttled.
- Health check path is **`/status`**, not `/healthz` — Google Front End intercepts `/healthz`
  before it reaches the container.
- Cloud Run injects `PORT`; the server honors it.

## 3. (Optional) Custom domain

Cloud Run domain mappings are supported in a subset of regions (e.g. `europe-west1`):

```bash
gcloud beta run domain-mappings create --service=lexware-mcp --domain=lexware.example.com --region=europe-west1
gcloud beta run domain-mappings describe --domain=lexware.example.com --region=europe-west1 --format="json(status.resourceRecords)"
```

Add the returned record (a `CNAME` to `ghs.googlehosted.com.`) at your DNS provider; Google
then provisions a managed TLS certificate (usually minutes, up to ~an hour).

## 4. Connect

Point your MCP client at `https://YOUR-PUBLIC-URL/mcp`. For OAuth, add it as a custom
connector in the Claude app; for a static token, see the README's Claude Code/Desktop snippet.
