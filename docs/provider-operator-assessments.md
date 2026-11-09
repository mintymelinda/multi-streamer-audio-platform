# First-release provider operator assessments

These are required operator documentation deliverables for Phase 3. They must be completed and reviewed against the actual adapter implementation and current provider terms before enabling a provider in production. This checklist is not legal advice and does not grant permission.

## YouTube via Invidious

- **Technical:** The initial adapter supports video search and metadata resolution through the documented `/api/v1/search`, `/api/v1/videos/:id`, and `/api/v1/stats` endpoints. Direct playback remains disabled. Up to five operator-configured instances are tried in order, preserving the requested video ID.
- **Authorization:** The metadata adapter does not request YouTube OAuth credentials. Invidious access does not grant YouTube authorization.
- **Availability:** Operator-configured instance health is checked; network and server failures can fall back to the next configured instance. Public instances are not trusted by default.
- **Contractual:** Review applicable YouTube terms and the selected Invidious instance's terms and policies before enabling a playback path.
- **Rights and use:** Search and metadata do not establish rights to play or broadcast a work. Direct playback capability is intentionally false pending an approved playback design and operator review.

## Spotify

- **Technical:** The initial adapter supports track search and metadata resolution through Spotify Web API `/search` and `/tracks/{id}`. It accepts a short-lived access token supplied by the credential/token boundary, supports an optional ISO country market, normalizes track IDs/URIs/URLs, and preserves Spotify attribution links. It does not download, proxy, or extract audio.
- **Authorization:** Spotify Web API requests require OAuth access tokens. Token acquisition, refresh, revocation, and storage remain the responsibility of the integration credential boundary; tokens are never returned in adapter results or errors. Request only scopes required by the enabled feature.
- **Availability:** Requests are subject to Spotify API availability, application access mode, market availability, and rate limits. HTTP 401 is surfaced as authorization expiry, 403 as denied access, and 429 as rate limiting.
- **Contractual:** Review current Spotify Developer Terms and endpoint-specific restrictions before enabling the integration.
- **Rights and use:** Spotify's developer policies prohibit non-interactive broadcasting and synchronizing Spotify content with visual media. Consequently this adapter declares playback, pause, resume, seek, and queue capabilities false. Spotify catalog metadata must link back to Spotify and retain required attribution. Do not use Spotify as an audio source for the Twitch/OBS broadcast path.

## Lyrion (optional)

- **Technical:** Document supported server/player versions, JSON-RPC behavior, player discovery, and command limitations.
- **Authorization:** Document server authentication and local network trust boundaries.
- **Availability:** Document dependency on operator-managed server/player availability.
- **Contractual:** Review applicable software licenses and relevant media/provider terms.
- **Rights and use:** The operator must verify rights to each library source and intended use.

For each provider, record: assessment owner, date, source links, known limitations, data processed, scopes/secrets stored, outage and recovery behavior, contractual review status, rights-use review status, and explicit enable/disable decision.

The platform owner's acceptance of operational risk is not provider authorization, a license, or rights-holder permission. A provider remains disabled if required assessment fields are incomplete or if authorization/contractual/rights-use review has not been completed.

Public launch requires qualified legal review of both the product policies and operational procedures. Software controls and tests are not a guarantee of legal compliance.
