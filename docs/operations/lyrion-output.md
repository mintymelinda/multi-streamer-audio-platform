# Lyrion playback output

Lyrion is an output provider. YouTube/Invidious remains a separate media-source resolver; the metadata adapter does not issue playback commands.

## Configure an output

An owner or workspace admin can configure an output. Set `INVIDIOUS_INSTANCE_URL` in the API environment first; configuration verifies the instance and provisions a workspace-scoped YouTube source instance with metadata/resolution capability only:

`POST /workspaces/{workspaceId}/providers/lyrion`

The request requires `instanceKey`, `baseUrl`, `outputId`, and `playerId`. `username` and `password` are optional but must be supplied together. Omit both to preserve existing credentials; set `removeCredentials: true` to explicitly delete saved credentials.

The endpoint checks the LMS JSON-RPC endpoint before activating the provider and assigning its output/player. Output and player assignments are unique within a workspace. Reassigning an existing Lyrion instance updates its assignment.

Disconnect with:

`DELETE /workspaces/{workspaceId}/providers/lyrion/{providerInstanceId}`

Disconnect removes encrypted credentials and disables the provider while preserving its non-secret endpoint configuration and output assignment for reconnect.

## Endpoint security

- In production, Lyrion endpoints must use HTTPS.
- Production endpoints must match the operator-managed `LYRION_ALLOWED_HOSTS` list. Entries are exact hostnames or wildcard suffixes such as `*.example.net`, comma-separated.
- Localhost and `.local` endpoints are accepted only outside production.
- URL userinfo, query strings, and fragments are rejected. HTTP redirects are not followed.
- Optional HTTP Basic credentials are stored through the encrypted provider-credential store, not in provider instance configuration.
- The operator allowlist is a security boundary. Do not approve arbitrary tenant-controlled hosts.

The base URL may include a reverse-proxy path prefix; the adapter appends `/jsonrpc.js`.

## Playback behavior

The Lyrion adapter resolves YouTube media through the configured Invidious resolver, then replaces the Lyrion player's provider playlist with the resolved audio stream and starts it. Pause, resume, skip, and seek are sent as LMS commands. The platform's PostgreSQL logical request queue remains authoritative.

A matching LMS stream URL confirms only the media identity, not the logical request identity. Because repeat requests for the same media are allowed, the adapter never treats a URL match alone as proof that a particular request generation started. If the outcome of a command is ambiguous, the Coordinator keeps it uncertain rather than risking a duplicate start.

After a confirmed start, the adapter records LMS `playlist_timestamp` as a provider-session marker. It is not a logical request ID: the monitor compares it with the stored play-operation result and refuses to complete a request if the playlist has changed. The worker polls active Lyrion sessions every 5 seconds by default (`PROVIDER_PLAYBACK_MONITOR_INTERVAL_MS` can set 1,000–60,000 ms). Automatic completion requires the same playlist marker, a stopped player, and reported progress within 1.5 seconds or 5% of the reported track duration. If the marker or timing data is missing, or the playlist changes, the request stays active for moderator recovery rather than being guessed complete.

This first output adapter supports YouTube/Invidious source media. It does not enable Spotify catalog playback, and it does not change either metadata adapter's declared playback capability.
