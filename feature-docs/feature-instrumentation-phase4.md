# Feature: Production Telemetry Consent & Ingestion Security

## Summary

Convert CS-Bridge's manual metrics reporting into a production-grade automatic telemetry system with proper user consent, background sync, and server-side security hardening. Users are presented with a first-launch consent modal to opt into anonymous telemetry (standard industry pattern). Opted-in metrics are synced automatically every 24 hours. The server validates all submissions using Microsoft identity tokens, derives reporter identity server-side, and applies layered defenses (rate limiting, schema validation, plausibility checks, anomaly flagging) to prevent bogus data ingestion.

## Context: What This Replaces

Previous phases introduced a user-initiated "Report" button and manual export flow. This feature replaces that model entirely:

- The **"Report" button is removed** from the Session Metrics dashboard. Reporting is now automatic and background.
- The **manual SQLite export from Phase 2 is removed** from the UI. (Team lead may retain it as a debug command if useful.)
- The **Session Metrics dashboard remains** as a local visibility tool for the user — it still shows their own instrumentation data. It no longer has any reporting controls.
- The **server-side ingestion endpoint (Phase 3)** gains authentication, validation, and rate-limiting layers.

## User Scenarios

### Beta Tester (CS-Bridge Extension)

1. **As a new user**, I want to be clearly asked whether I consent to anonymous telemetry so that I understand what data is collected and can make an informed choice.
   - AC: On first activation after install (or after an extension update that introduces this feature), a **modal dialog** is shown. The modal blocks interaction with the extension sidebar until the user responds.
   - AC: The modal text explains: what data is collected (usage metrics: job submissions, connection outcomes, errors — no personal files or code), that data is anonymized (name/email masked), and that the purpose is to improve CS-Bridge.
   - AC: Two buttons: "I Agree" (opts in) and "No Thanks" (opts out).
   - AC: The user's choice is persisted locally (e.g., in `~/.cybershuttle/` config or VS Code extension global state). The modal is not shown again unless the user resets the extension or the consent version changes.
   - AC: If the user has set VS Code's global `telemetry.telemetryLevel` to `off`, CS-Bridge respects this and does not show the modal or send telemetry, regardless of the extension-level setting.

2. **As a user who opted in**, I want telemetry to happen silently in the background so that it doesn't interrupt my workflow.
   - AC: The extension syncs unsent metrics to the server automatically every 24 hours.
   - AC: Sync occurs on extension activation if ≥24 hours have passed since the last successful sync. No periodic timers running in the background when the extension is idle.
   - AC: Sync is fully async and non-blocking. No notifications on success. No UI spinners.
   - AC: On sync failure (server unreachable, auth error, timeout), the extension silently retries on the next activation cycle. No user-facing error. Events are retained locally until successfully synced.
   - AC: The sync transmits all events recorded since the last successful sync timestamp. Events older than 90 days are still subject to TTL cleanup (Phase 1 behavior preserved).

3. **As a user who opted in**, I want to be able to opt out at any time so that I remain in control of my data.
   - AC: A VS Code extension setting `cybershuttle.telemetry.enabled` (boolean, default `true` after consent) is available in the standard VS Code Settings UI under the CS-Bridge section.
   - AC: Setting it to `false` immediately stops all background sync. No further data is transmitted.
   - AC: Local metric collection continues regardless of the telemetry setting — the user can always see their own data in the Session Metrics dashboard. Only server transmission is gated.
   - AC: The Session Metrics dashboard shows an informational line at the top: "Anonymous telemetry: Enabled · [Change in Settings]" (or "Disabled" if opted out). Clicking "Change in Settings" opens VS Code settings filtered to `cybershuttle.telemetry`.

4. **As a user who initially declined**, I want to be able to opt in later so that I can change my mind without reinstalling.
   - AC: The user can enable `cybershuttle.telemetry.enabled` in VS Code settings at any time.
   - AC: On the next activation cycle, sync resumes from the last successful sync timestamp (or from the beginning if never synced).

5. **As a user**, I want the telemetry system to respect platform-level telemetry preferences so that my OS and editor choices are honored.
   - AC: If VS Code's `telemetry.telemetryLevel` is set to `off`, CS-Bridge does not sync telemetry regardless of the extension-level setting.
   - AC: If `telemetry.telemetryLevel` is `error`, only failure events are synced (events with `status = 'failure'`). If `crash`, only events that represent unrecoverable errors (team lead to define which event types qualify). If `all`, normal behavior.

### Developer / Admin (cs-bridge-admin Server)

6. **As a developer**, I want to trust that incoming metrics are from real CS-Bridge users so that the admin dashboard reflects accurate data.
   - AC: Every sync request includes a valid Microsoft identity token (ID token from the DevTunnel auth flow) as gRPC metadata (e.g., `authorization` header).
   - AC: The server validates the token against Microsoft's public JWKS endpoint (`https://login.microsoftonline.com/common/discovery/v2.0/keys`). Invalid, expired, or missing tokens result in rejection with an `UNAUTHENTICATED` gRPC status.
   - AC: The server extracts the email claim from the validated token and derives the `reporter_id` server-side using `SHA-256(email + server_salt)`. The client does NOT send a reporter ID — the server computes it. This prevents reporter identity spoofing.
   - AC: The `server_salt` is a secret value stored in server-side configuration (environment variable), never shipped in the extension code.

7. **As a developer**, I want rate limiting on the ingestion endpoint so that no single user (or attacker) can flood the database.
   - AC: The server enforces a maximum of **1 sync per reporter per 24-hour rolling window**. Additional submissions within the window are rejected with a `RESOURCE_EXHAUSTED` gRPC status and a message indicating when the next submission will be accepted.
   - AC: Rate limiting is keyed by the server-derived `reporter_id`, not by IP address or client-provided identity.

8. **As a developer**, I want the server to validate incoming event data so that malformed or implausible data is rejected.
   - AC: **Schema validation:** Every event in the submission must have a valid `event_type` (from the known set: `job_submit`, `job_status_change`, `ssh_connect`, `tunnel_create`, `linkspan_deploy`, `auth_flow`, `session_reconnect`, `sinfo_fetch`, `extension_activate`). Unknown types are rejected.
   - AC: **Field validation:** `timestamp` must be valid ISO 8601 and within a reasonable window (not more than 91 days in the past, not in the future). `status` must be one of `success`, `failure`, `in_progress`. `duration_ms` must be non-negative if present.
   - AC: **Metadata structure validation:** The `metadata_json` field is parsed and validated against expected key sets per event type. Extra keys are stripped. Missing required keys cause the individual event to be dropped (not the whole submission). Cluster names are accepted as-is — users may connect to any academic, institutional, or private cluster, so no allowlist is enforced.
   - AC: Invalid individual events within a submission are dropped with a count returned in the `SubmissionResponse`. Valid events in the same submission are still ingested.

9. **As a developer**, I want anomalous reporting patterns flagged so that I can spot potential abuse without manually reviewing all data.
   - AC: The server flags reporters whose behavior deviates significantly from norms: event volume >10x the median reporter's volume in the same period, or sudden spikes in activity after extended inactivity.
   - AC: Flagged reporters appear in the admin dashboard with a visual indicator. Their data is NOT auto-rejected — it remains in the database for manual review.
   - AC: Anomaly thresholds are configurable via server-side configuration (not hardcoded).

10. **As a developer**, I want the server to register new reporters on first contact so that I have a record of the user base.
    - AC: On the first valid submission from a new `reporter_id`, the server creates a record in the `reporters` table with `first_seen` set to the current timestamp.
    - AC: No separate "registration" endpoint is needed. Registration is implicit on first successful sync. This eliminates the attack surface of a separate registration API.

## Technical Scope

### Components Affected in CS-Bridge (MODIFY)

> **Note to team lead:** This feature modifies the telemetry pipeline significantly. The "Report" button, manual export UI, and related `postMessage` handlers from Phases 2–3 are replaced. However, the underlying instrumentation (event recording, local SQLite storage, dashboard visualization) from Phase 1 is untouched. The local metrics system continues to work identically — only the server transmission path changes.

- `src/instrumentation/telemetry.ts` (NEW — replaces `report.ts` from Phase 3) — Automatic telemetry sync module. Contains:
  - **Consent manager:** Reads/writes the consent state (first-launch decision, VS Code setting, global telemetry level). Exposes `isEnabled(): boolean` that checks all three layers (consent given AND extension setting enabled AND VS Code telemetry level allows).
  - **Sync scheduler:** On extension activation, checks if ≥24 hours since last successful sync. If yes and telemetry is enabled, triggers a sync. Stores `last_sync_timestamp` in local config (e.g., `~/.cybershuttle/telemetry-state.json` or VS Code global state).
  - **Sync executor:** Queries local SQLite for events with `timestamp > last_sync_timestamp`, applies PII anonymization (reuses Phase 2 anonymizer — name/email masking), serializes to protobuf, attaches the Microsoft ID token as gRPC metadata, and submits. On success, updates `last_sync_timestamp`. On failure, logs internally and does nothing (retry on next activation).
  - **Token accessor:** Retrieves the current valid Microsoft ID token from the DevTunnel auth context. If the token is expired or unavailable, sync is silently skipped (user may not be signed in).

- `src/instrumentation/report.ts` (REMOVE) — Replaced by `telemetry.ts`. The manual report flow is no longer needed.

- `src/instrumentation/export.ts` (REMOVE from UI — team lead may keep as internal utility) — Manual SQLite export is no longer user-facing.

- `src/webview-dashboard/` (MODIFY) — Remove "Report" button. Remove cleanup checkbox. Add informational telemetry status line with link to VS Code settings. Dashboard now purely shows local data with filter/refresh controls.

- `src/extension.ts` or main activation file (MODIFY) — On activation:
  1. Check if consent has been given. If not (first launch or post-update), show the consent modal.
  2. If telemetry is enabled, trigger the sync scheduler check.
  3. Register the `cybershuttle.telemetry.enabled` setting in `package.json` contributes.

- `package.json` (MODIFY) — Add `contributes.configuration` entry for `cybershuttle.telemetry.enabled` with description, type boolean, default true. Add `cybershuttle.telemetry.consentVersion` (internal, used to re-prompt if consent terms change in future releases).

### Components Affected in cs-bridge-admin (MODIFY)

- `server/internal/ingestion/` (MODIFY) — gRPC handler gains:
  - **Token validation middleware:** Extracts the Microsoft ID token from gRPC metadata, validates against Microsoft's JWKS endpoint (cache the JWKS keys with a reasonable TTL, e.g., 24 hours). Rejects unauthenticated requests.
  - **Reporter ID derivation:** Extracts email claim from validated token, computes `SHA-256(email + server_salt)`, uses this as the `reporter_id`. Creates a new `reporters` record if this ID is new.
  - **Rate limiter:** Checks the `reporters` table or a lightweight cache (in-memory or Redis if needed later) for the last submission time. Rejects if within the 24-hour window.
  - **Schema/field validator:** Validates each event in the submission against the known event types, field constraints, and metadata structures. Drops invalid individual events, ingests valid ones, returns counts in the response.

- `server/internal/ingestion/validator.go` (NEW) — Dedicated validation module. Contains: event type allowlist, field range checks, metadata schema definitions per event type. Separated from the handler for testability.

- `server/internal/ingestion/anomaly.go` (NEW) — Anomaly detection module. Runs after successful ingestion. Compares the reporter's activity against aggregate baselines. Flags anomalous reporters by setting a flag in the `reporters` table. Thresholds loaded from server config.

- `server/internal/ingestion/msauth.go` (NEW) — Microsoft token validation. Fetches and caches JWKS keys from Microsoft's well-known endpoint. Validates token signature, expiry, audience, and issuer. Extracts email claim.

- `server/internal/api/` (MODIFY) — Add an endpoint or filter for the admin frontend to show flagged reporters. Extend the reporters list view to include anomaly indicators.

- `server/config/` or environment variables (MODIFY) — Add configuration for: `SERVER_SALT` (secret for reporter ID hashing), `MS_JWKS_URL` (Microsoft JWKS endpoint), `ANOMALY_VOLUME_MULTIPLIER` (default 10), `RATE_LIMIT_WINDOW_HOURS` (default 24).

- `frontend/` (MODIFY) — Add anomaly flag indicator on reporter list/drill-down views.

- `proto/metrics.proto` (MODIFY) — Update `SubmissionResponse` to include a count of dropped events and optionally the reasons. Remove the `reporter_id` field from `SubmissionRequest` (server now derives it).

### Dependencies Between Components

```
Dependency graph:

[proto/metrics.proto — remove client reporter_id, update response shape]
         |
         ├──> CS-BRIDGE SIDE:
         │      [telemetry.ts — consent + scheduler + sync + token attachment]
         │            |
         │            ├──> [webview-dashboard/ — remove Report button, add status line]
         │            ├──> [extension.ts — consent modal, activation sync trigger, setting registration]
         │            └──> [package.json — telemetry setting contribution]
         │
         └──> ADMIN SIDE:
                [msauth.go — Microsoft token validation + JWKS cache]
                      |
                      ├──> [ingestion handler — integrate token validation, server-side reporter derivation]
                      │         |
                      │         ├──> [validator.go — schema, field, cluster, metadata validation]
                      │         └──> [anomaly.go — post-ingestion anomaly flagging]
                      │
                      ├──> [rate limiter — per-reporter 24h window]
                      │
                      └──> [frontend + API — anomaly indicators, unverified cluster markers]
```

The CS-Bridge side and admin side can be built in parallel once the proto contract is updated. Within each side, the dependencies are sequential as shown.

### API Contract Changes

**Updated gRPC `SubmissionRequest`:**

```protobuf
// reporter_id removed — server derives it from the validated token

message SubmissionRequest {
  ExportMetadata metadata = 1;
  repeated Event events = 2;
}

// gRPC call metadata (headers):
// "authorization": "Bearer <Microsoft_ID_token>"
```

**Updated `SubmissionResponse`:**

```protobuf
message SubmissionResponse {
  bool success = 1;
  string receipt_id = 2;
  string error = 3;
  int32 events_accepted = 4;
  int32 events_dropped = 5;
  string next_allowed_submission = 6;  // ISO 8601 timestamp, populated on rate limit rejection
}
```

### Data Model Changes

**CS-Bridge local (new file or VS Code global state):**

Telemetry consent and sync state. Can be stored in `~/.cybershuttle/telemetry-state.json` or via VS Code's `ExtensionContext.globalState`. Team lead to decide based on existing patterns.

```json
{
  "consent_given": true,
  "consent_version": "1.0",
  "consent_timestamp": "2026-03-05T12:00:00Z",
  "last_sync_timestamp": "2026-03-04T12:00:00Z"
}
```

**cs-bridge-admin Postgres — `reporters` table changes:**

| Column (new) | Type | Description |
|---|---|---|
| `anomaly_flagged` | BOOLEAN DEFAULT FALSE | Set by anomaly detection module |
| `anomaly_reasons` | JSONB NULL | Array of reason strings when flagged |
| `last_submission_at` | TIMESTAMPTZ | Used for rate limiting (replaces or supplements `last_seen`) |

**cs-bridge-admin — server config (environment variables):**

| Variable | Description | Default |
|---|---|---|
| `SERVER_SALT` | Secret salt for reporter ID hashing | (required, no default) |
| `MS_TENANT_ID` | Microsoft tenant ID for token validation (`common` for multi-tenant) | `common` |
| `ANOMALY_VOLUME_MULTIPLIER` | Flag reporters with volume > N × median | `10` |
| `RATE_LIMIT_WINDOW_HOURS` | Minimum hours between submissions per reporter | `24` |

## Non-Functional Requirements

- **Privacy compliance:** Consent is collected before any data leaves the device. Consent state is persisted and auditable (timestamped). Users can opt out at any time with immediate effect. VS Code platform telemetry settings are respected. PII masking (name/email) continues to apply to all transmitted data.
- **Performance (extension):** Consent modal renders within 200ms. Sync is fully async and non-blocking. Sync timeout: 30 seconds. No background timers or polling — sync only triggers on activation. Zero impact on extension responsiveness during normal use.
- **Performance (server):** Token validation must cache JWKS keys (avoid per-request network calls to Microsoft). Rate limit checks must be fast (in-memory or single indexed query). Schema validation must process 10,000 events in under 1 second. Anomaly detection runs asynchronously after ingestion response is sent (does not block the client).
- **Security:** Microsoft token validation is mandatory — no fallback to unauthenticated submission. Server salt is a deployment secret, never in source code (load from environment variable). JWKS cache has a TTL (24 hours recommended) to pick up key rotations. The server never trusts client-provided identity — all identity is derived from the validated token.
- **Reliability:** Sync failures are silent and retry on next activation. Local data is never lost due to sync failures. If the Microsoft token is unavailable (user not signed in to DevTunnel), sync is silently skipped — no error shown. The consent modal only appears once per consent version; it must not re-appear on every launch due to state corruption.
- **Compatibility:** Consent modal and telemetry setting must work on all platforms (macOS, Linux, Windows). Microsoft JWKS validation must handle both v1 and v2 token endpoints.

## Out of Scope

- **Custom IDP or Keycloak integration.** Token validation relies on Microsoft's public JWKS. Own IDP is a future concern.
- **Real-time streaming telemetry.** Sync is batch-based (24-hour cadence), not streaming.
- **Server-side automated responses to anomalies** (e.g., auto-banning reporters). Anomalies are flagged for manual review only.
- **Encrypted local storage of consent/sync state.** The local telemetry state file is not sensitive (no tokens, no PII).
- **GDPR data deletion requests.** If a user wants their server-side data deleted, it's a manual process for now. Automated deletion API is a future concern.
- **Per-event opt-in granularity** (e.g., "send SSH events but not job events"). Telemetry is all-or-nothing.
- **Changes to the local instrumentation layer (Phase 1).** Event recording, local SQLite storage, and the Session Metrics dashboard visualization are unchanged.

## Open Questions

- [ ] **Consent modal implementation:** VS Code extension API offers `window.showInformationMessage` with modal option, or a custom webview modal. The built-in modal is simpler but limited in formatting (plain text, no links or rich content). A webview modal allows richer explanation with formatting and links to a privacy page. Team lead to decide — recommendation is the built-in modal for simplicity, with a link to a hosted privacy notice if richer explanation is needed.
- [ ] **Consent version scheme:** When the consent terms change (e.g., new event types are added), should the modal re-appear? The `consent_version` field supports this, but the policy needs to be defined: re-prompt on every change, or only on material changes? Recommendation: only re-prompt if the nature of collected data changes materially (new PII categories, new third-party sharing). Adding a new event type does not require re-consent.
- [ ] **VS Code `telemetry.telemetryLevel` granularity:** Scenario 5 maps `error` level to "only failure events" and `crash` to "only unrecoverable errors." These mappings are interpretive. Team lead to define which event types qualify for each level, or simplify to: `off` = no telemetry, anything else = full telemetry.
- [ ] **Token scope for sync vs DevTunnel:** The Microsoft token used for DevTunnel auth may have a specific audience/scope that differs from what the ingestion server expects. Team lead to verify that the ID token (not the access token) is usable for validation and contains the email claim. If the DevTunnel flow only yields an access token, an additional token request may be needed.
- [ ] **Anomaly detection baseline:** The anomaly module needs a baseline to compare against (e.g., "median event volume"). On a fresh deployment with few reporters, every reporter looks anomalous. Team lead to decide on a minimum reporter count before anomaly detection activates (e.g., only flag anomalies once ≥10 reporters exist).