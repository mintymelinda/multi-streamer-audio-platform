# OBS overlay runtime

Each workspace scene receives a stable path at `/scene/<scene-id>` and a separate high-entropy bearer token.

The dashboard returns the complete OBS browser-source URL once as:

`<overlay-base>/scene/<scene-id>#<bearer-token>`

The overlay reads the fragment in the browser, removes it from the visible address bar immediately, and sends the token only in an Authorization bearer header or the Socket.IO namespace authentication payload. The token is never sent in a path, query string, Referer header, analytics event, or application log. The browser client does not persist it in local storage or cookies.

Only the SHA-256 token hash is stored in PostgreSQL. Creating or rotating a token returns its plaintext value once; the dashboard holds it only in page memory. Rotating or revoking a token invalidates the previous value. Revocation and rotation publish a PostgreSQL notification that disconnects existing overlay sockets after the transaction commits.

## Runtime configuration

- `NEXT_PUBLIC_API_BASE_URL`: API origin or same-origin API prefix, defaulting to `/api`. The API origin must route both REST requests and the Socket.IO `/socket.io/` endpoint.
- `NEXT_PUBLIC_OVERLAY_BASE_URL`: public HTTPS origin for this independently deployable Next.js app, configured in the dashboard build.

The API exposes `GET /overlay/scenes/:sceneId/snapshot`. It accepts only a bearer token, checks the current hash on every snapshot request, returns a non-cacheable read-only scene snapshot, and intentionally returns the same not-found response for invalid, unknown, and revoked credentials.

The overlay Socket.IO namespace is `/overlay`. It authenticates the same scene ID and bearer token during connection, listens for workspace outbox invalidations, revalidates the token before sending updates, and disconnects on token rotation or revocation. The client reconnects with bounded exponential backoff and fetches the latest snapshot after every successful connection, so it recovers after missed events or a temporary outage.

Migration `0030_overlay_scene_runtime.sql` adds the nullable published-state snapshot column and narrowly scoped SECURITY DEFINER lookup functions. These functions are executable only by the runtime database role; the underlying scene table remains FORCE-RLS protected.

A newly created scene has no published state until item 47 implements draft/publish. The runtime displays an unpublished placeholder rather than exposing draft data. The snapshot contract is ready for item 47 to populate the last published version.
