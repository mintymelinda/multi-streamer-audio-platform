# First-release provider operator assessments

These are required operator documentation deliverables for Phase 3. They must be completed and reviewed against the actual adapter implementation and current provider terms before enabling a provider in production. This checklist is not legal advice and does not grant permission.

| Provider | Technical assessment | Authorization | Availability | Contractual / terms | Rights and use |
|---|---|---|---|---|---|
| YouTube via Invidious | Document selected Invidious instance/API behavior, supported media resolution, rate limits, failure modes, and instance replacement strategy | Document whether the chosen instance requires credentials and what account access is used; do not assume an Invidious instance grants YouTube authorization | Document instance operator, uptime dependency, fallback, and outage behavior | Review applicable YouTube terms and the selected Invidious instance's terms/policies | Verify rights for requested media and permitted playback/use; do not treat public availability as a license |
| Spotify | Document supported Web API/player capabilities and restrictions; do not extract or proxy Spotify streams | Document OAuth scopes, token refresh, revocation, and authorization-expiry behavior | Document account/device/region/plan constraints and API availability dependencies | Review current Spotify Developer terms and applicable user/account requirements | Verify permitted use and playback model; API access does not convey rights to stream or publicly perform content |
| Lyrion (optional) | Document supported server/player versions, JSON-RPC behavior, player discovery, and command limitations | Document server authentication and local network trust boundaries | Document dependency on operator-managed server/player availability | Review applicable software licenses and any relevant media/provider terms | Operator must verify rights to each library source and intended use |

For each provider, record: assessment owner, date, source links, known limitations, data processed, scopes/secrets stored, outage and recovery behavior, contractual review status, rights-use review status, and explicit enable/disable decision.

The platform owner's acceptance of operational risk is not provider authorization, a license, or rights-holder permission. A provider remains disabled if required assessment fields are incomplete or if authorization/contractual/rights-use review has not been completed.

Public launch requires qualified legal review of both the product policies and operational procedures. Software controls and tests are not a guarantee of legal compliance.
