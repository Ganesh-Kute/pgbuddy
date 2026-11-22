# PG Buddy WhatsApp Server

Express HTTP gateway wrapping `whatsapp-web.js` (`LocalAuth` + Puppeteer) to send login OTPs, instant messages, queued bulk campaigns, and PDF receipt documents.

## Configuration

Set these environment variables (via `.env` or process environment) before running `node server.js`:

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `SERVER_SECRET` | Yes | — | Shared secret for `/api/*` authentication (must not be empty or placeholder). |
| `SUPABASE_URL` | Yes | — | Supabase project URL for the `whatsapp_message_queue` worker. |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | — | Supabase service role key used to poll and update `whatsapp_message_queue`. |
| `PORT` | No | `3001` | HTTP listen port. |
| `OTP_COOLDOWN_MS` | No | `30000` | Per-recipient cooldown window (ms) for `POST /api/send-otp`. |
| `BRAND_NAME` | No | `PG Buddy` | Brand name rendered in OTP message copy. |

```bash
npm install
npm start
```

## Security & Limits

- **Authentication**: All `/api/*` endpoints require `SERVER_SECRET` via `x-server-secret: <secret>`, `Authorization: Bearer <secret>`, or JSON body `secret`, verified with constant-time SHA-256 comparison (`401 Unauthorized`).
- **Rate Limiting**: All `/api/*` routes are limited to `60` requests per `60` seconds per IP (`429`). `POST /api/send-otp` additionally enforces `OTP_COOLDOWN_MS` per phone number.
- **JSON Body Limits**: All routes use Express default `100kb` JSON limit except `POST /api/send-document`, which selectively applies `express.json({ limit: "2mb" })` for base64 PDF transport.

## Endpoints

### `GET /health`

Unauthenticated readiness check.

- `200`: `{ "status": "ready" | "not_ready", "message": "WhatsApp is connected" | "WhatsApp is not connected yet" }`

### `POST /api/send-otp`

Sends a formatted OTP message immediately.

- **Body**: `{ "phoneNumber": "9876543210", "otp": "123456" }`
- **Responses**: `200` `{ "success": true, "message": "OTP sent successfully" }`, `400`, `401`, `404`, `429`, `503`, `500`

### `POST /api/send-instant`

Sends an immediate text or local media message (optional `imagePath`, `imagePaths`, `videoPath` resolved strictly inside the server directory, plus `isCampaign`).

- **Body**: `{ "phoneNumber": "9876543210", "message": "Hello" }`
- **Responses**: `200` `{ "success": true, "message": "Message sent" }`, `400`, `401`, `404`, `429`, `503`, `500`

### `POST /api/send-document`

Sends a base64-encoded PDF attachment (such as a rent receipt) over WhatsApp as a document.

- **JSON Body Limit**: `2mb` (strictly scoped to this route)
- **Headers**: `Content-Type: application/json`, `x-server-secret: <SERVER_SECRET>` (or `Authorization: Bearer <SERVER_SECRET>`)
- **Request Body**:

```json
{
  "phoneNumber": "9876543210",
  "base64": "JVBERi0xLjQK...",
  "mimetype": "application/pdf",
  "filename": "PGB-2026-04-001.pdf",
  "caption": "Rent receipt for April 2026"
}
```

- **Validation Rules** (all return `400` `{ "error": "..." }`):
  - `phoneNumber`: Required, 10–15 digits (normalized to `91<last10>@c.us`).
  - `mimetype`: Must be `"application/pdf"` (trimmed, case-insensitive).
  - `filename`: Required string, no leading `.`, no `..`, must match `/^[\w\- .]{1,80}\.pdf$/`.
  - `base64`: Required canonical padded base64 string (whitespace ignored); decoded byte length must be `1..1048576` (`1 MB`) and begin with the `%PDF-` magic header.
  - `caption`: Optional string; trimmed length max `4096` characters.
- **Delivery Behaviour**:
  - Wraps content with `new MessageMedia("application/pdf", cleanBase64, filename)` and calls `client.sendMessage(formattedPhone, media, { caption, sendMediaAsDocument: true })` (omitting `caption` if empty).
  - Never logs PDF base64 bytes; logs masked last-4 phone digits and filename on success.
- **Responses**:
  - `200`: `{ "sent": true, "success": true }`
  - `400`: Validation error
  - `401`: Unauthorized (missing or invalid secret)
  - `404`: Phone number is not registered on WhatsApp
  - `429`: Rate limit exceeded
  - `503`: WhatsApp client not ready yet
  - `500`: Failed to send document

```bash
curl -X POST http://localhost:3001/api/send-document \
  -H "Content-Type: application/json" \
  -H "x-server-secret: $SERVER_SECRET" \
  -d "{"phoneNumber":"9876543210","mimetype":"application/pdf","filename":"receipt.pdf","base64":"$(base64 -w0 receipt.pdf)","caption":"Your PG Buddy rent receipt"}"
```

### `POST /api/bulk-message`

Queues messages in Supabase table `whatsapp_message_queue` processed asynchronously (~1 every 45 seconds).

- **Body**: `{ "phoneNumbers": ["9876543210"], "message": "Notice", "templateType": "announcement" }`
- **Responses**: `200` `{ "success": true, "queued": 1, "message": "1 messages queued. Will be sent ~1 per 45 seconds." }`, `400`, `401`, `429`, `500`
