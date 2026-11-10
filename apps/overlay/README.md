# OBS overlay runtime

Each workspace scene receives a stable path at `/scene/<scene-id>` and a separate high-entropy bearer token.

The dashboard returns the complete OBS browser-source URL once as:

`<overlay-base>/scene/<scene-id>#<bearer-token>`

The token is placed in the URL fragment, never in a path or query parameter. Browsers do not send fragments in HTTP requests or Referer headers. The overlay runtime must read the fragment in the browser, remove it from the visible address bar as soon as practical, and send the token only in an Authorization bearer header when calling the read-only overlay API. Never forward it to analytics, logs, third-party resources, or referrer values.

Only the SHA-256 token hash is stored in PostgreSQL. Creating or rotating a token returns its plaintext value once; the dashboard holds it only in page memory. Rotating or revoking a token invalidates the previous value immediately.

When the overlay runtime is deployed on a separate host, configure the dashboard build with `NEXT_PUBLIC_OVERLAY_BASE_URL` set to that public HTTPS origin. If it is not set, the dashboard currently falls back to its own origin.

The scene route is a placeholder until Phase 5 item 46 implements token verification, published-state retrieval, and live updates.
