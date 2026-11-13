# Privacy Policy — Draft for qualified legal review

<aside>
**Publication blocker:** This draft is based on the current product architecture and repository documentation. It is not a verified inventory of production processing and is not legal advice. The Operator must confirm every data flow, service provider, location, retention period, cookie, and integration before publication. Qualified privacy counsel must approve the policy for each intended territory.
</aside>

- **Controller / organization:** [Insert full legal name and business form]
- **Address:** [Insert legal address]
- **Privacy contact:** [Insert monitored privacy email or contact form]
- **Effective date:** [Insert date after approval]
- **Service URL:** [Insert production domain]

## 1. Scope and responsibility

This policy describes how the Operator collects, uses, stores, discloses, and protects personal information when people sign in to the hosted multi-streamer audio request and overlay platform (the **Service**), create or join a workspace, moderate requests, connect optional providers, or access published overlays.

The Operator's legal identity, establishment, and role for each processing activity must be confirmed. Depending on the applicable law and the workspace feature involved, the Operator may act as a controller/business, a service provider/processor, or another legally defined role. Workspace owners may independently determine what information they place in public overlays or submit about their viewers. [Counsel must define the allocation of responsibilities and any required data-processing terms.]

## 2. Information processed

The categories below describe the platform's intended processing. The Operator must verify the deployed implementation and remove or revise any category that is not actually collected.

### Account and sign-in information

- Stable numeric Twitch account identifier used to associate the platform account.
- Twitch username, display name, broadcaster/channel identity, and profile information where needed for the interface or a workspace feature.
- Server-side session identifiers and session lifecycle/security records.
- Workspace memberships, roles, invitations, acceptance/decline status, and account/workspace ownership relationships.

Basic sign-in is designed to establish identity with minimal Twitch authorization. Ongoing provider authorization is requested only when a user enables a feature that needs it.

### Workspace, request, and moderation information

- Workspace settings, feature configuration, provider/output assignments, scenes, and audit records.
- Track/video identifiers, titles, artists, album/video metadata, request source, requester identity where supplied, queue position/priority, moderation decisions, and playback status/history.
- Twitch EventSub delivery identifiers and event data needed to validate, deduplicate, process, and audit subscribed events.
- Moderator actions, reasons, authorization outcomes, and rights-holder reports or enforcement decisions.

A streamer or moderator may submit personal information about a viewer as part of a request or moderation record. Workspace owners should avoid submitting information that is unnecessary for the Service.

### Integration and provider information

When an integration is enabled, the Service may process the provider instance, account/device/player identity, authorization status, permitted scopes, connection health, and provider metadata needed to deliver the feature.

- **Twitch:** stable account/channel identifiers, authorization and EventSub data required for enabled channel features.
- **Spotify:** catalog metadata and, when personal Spotify Connect is enabled, account/device information and OAuth credentials required for the user-authorized Connect controls. Personal Connect control is separate from the platform broadcast audio route.
- **YouTube via Invidious:** video identifiers and metadata requests sent to the configured Invidious endpoint. Metadata resolution does not itself provide playback authorization.
- **Lyrion (optional):** configured server address, player identifiers, connection status, and playback-control data needed for the workspace's connected local server/player.

The Service should not collect credentials for integrations that are not enabled. Provider credentials intended for storage are designed to be encrypted and access-controlled. Production use remains subject to key provisioning, authorization-flow, and recovery prerequisites; this policy must describe the actual enabled integrations and credentials in production, not merely the intended design.

### User content and overlay information

- Uploaded artwork, images, backgrounds, and other assets, including object metadata required to store and display them.
- Scene layouts, component positions and settings, custom text, announcements, and published overlay configuration.
- Read-only scene access tokens are designed to be stored as hashes rather than plaintext. A valid published scene URL acts as a bearer access link.

A public or shared overlay may expose the information selected by the workspace owner to anyone who can access the scene URL. Do not put sensitive personal information in overlay content.

### Technical, security, and diagnostic information

The Service and its hosting providers may generate request timestamps, correlation identifiers, error records, health/availability metrics, authentication and security events, and other operational diagnostics. [Before publication, inventory actual reverse-proxy, hosting, API, CDN, anti-abuse, analytics, and error-monitoring logs, including whether IP addresses, user-agent strings, device information, or approximate location are recorded and for how long.]

## 3. Purposes of processing

Subject to the final deployed data inventory, information is used to:

- create and authenticate platform accounts and maintain secure sessions;
- create and operate workspaces, enforce roles, and administer invitations;
- receive, validate, deduplicate, moderate, queue, resolve, and report on requests;
- connect and operate integrations that a workspace or user has explicitly enabled;
- publish and update OBS browser-source scenes and assets selected by a workspace;
- provide notifications, export, deletion, account/workspace administration, and support;
- protect the Service, investigate abuse, enforce terms, respond to rights-holder reports, and preserve security/audit evidence;
- maintain backups, recover service, and prevent deleted or revoked access from being restored; and
- comply with legal obligations and establish, exercise, or defend legal claims where permitted.

[Counsel must state the applicable legal bases or statutory authorities for each purpose in each territory, including consent, contract, legitimate interests, legal obligation, or other applicable grounds, and must document any required balancing assessments.]

## 4. Cookies, sessions, and similar technologies

The Service uses a server-side session model with secure, HTTP-only browser cookies for authentication. The browser cookie is not intended to contain the platform's authoritative session state or provider access tokens. The Service also uses security protections such as CSRF validation and workspace authorization checks.

[Before publication, confirm the actual cookie names, purpose, domain/path, Secure/HttpOnly/SameSite attributes, lifetime, renewal and logout behavior, and whether any analytics, advertising, preference, or third-party cookies are used. Provide a cookie notice or consent control where required. Do not state that the Service uses no analytics or tracking unless verified.]

## 5. Providers and disclosure

Personal information may be disclosed to the following categories only as needed for the Service, subject to the final provider inventory and contracts:

- **Twitch** for identity, channel authorization, and EventSub features enabled by the user/workspace.
- **Spotify** for catalog metadata and the separately authorized personal Spotify Connect feature.
- **The selected Invidious instance** for video search and metadata requests.
- **A workspace-configured Lyrion server** for optional local playback control.
- **Infrastructure and service providers** hosting the application, PostgreSQL, Redis/job processing, S3-compatible object storage, email delivery if enabled, monitoring, security, and support.
- **Professional advisers, regulators, law enforcement, rights holders, or other parties** where disclosure is legally required or reasonably necessary to investigate a report, protect users, enforce rights, or establish/defend legal claims, subject to applicable law.

The Operator does not control the independent privacy practices of third-party services. Their own policies and terms apply when you authorize or use those integrations. The Operator must publish a current subprocessor/service-provider list and identify which providers receive personal information.

## 6. International processing

The Service may use infrastructure and providers located in countries other than the country where a user resides. [Insert actual hosting regions, backup locations, provider processing locations, onward-transfer arrangements, and applicable safeguards after confirming contracts and infrastructure.] Where required, the Operator will use an approved transfer mechanism and provide information about it.

## 7. Retention

The Service's documented retention defaults include:

| Information | Current documented period or rule |
|---|---|
| Workspace configuration and settings | Until workspace deletion |
| Active requests and logical queue entries | Until terminal transition or workspace deletion; not automatically removed due to age |
| Terminal request and request-state history | 14-day default, configurable by workspace within supported options |
| Terminal provider queue state and playback operations | 30 days |
| Expired playback leases | 1 day after expiry |
| Processed EventSub deliveries and published outbox events | 30 days |
| User notification content | 90-day default, with user-configurable options |
| Terminal email outbox records | 30 days |
| Personal account export payload | 7 days; terminal metadata remains 30 days |
| Rights-holder reports, decisions, evidence, and platform audit/security records | No automatic expiry under the current policy; subject to separately approved legal/security retention |

These are repository-documented defaults, not a substitute for verifying actual production jobs and records. Workspace assets and settings persist until deletion. Backups and the deletion ledger may retain protected copies or tombstones for a separate recovery/retention period. The Operator must insert the actual backup lifecycle period and explain how deletion is applied during restore.

When information is no longer needed, the Operator will delete or de-identify it in accordance with the approved retention schedule, legal holds, and applicable law.

## 8. Security

The Service is designed with workspace-scoped access control, PostgreSQL row-level security, restricted database roles, server-side sessions, encrypted provider credential envelopes, secret redaction, read-only overlay links, and audit/security controls.

No system is perfectly secure. [The Operator must verify the implemented production controls, key custody and recovery, incident response plan, access review, vulnerability management, breach-notification process, encryption in transit and at rest, and relevant certifications before making public assurances.]

## 9. Access, correction, export, deletion, and choices

Depending on applicable law, you may have rights to access, correct, delete, restrict, object to, or obtain a portable copy of personal information, withdraw consent, or complain to a privacy regulator.

The Service provides:
- workspace export by the current workspace owner;
- permanent workspace deletion by the owner, subject to confirmation;
- account deletion, subject to deleting an owned workspace first and revoking active platform-administrator assignment where applicable;
- provider disconnect or disconnect-and-remove-data controls as supported by the integration; and
- controls for notification retention and other available preferences.

Workspace deletion and account deletion are different. Removing a platform account does not delete workspace content owned by another person. Provider disconnection removes platform-stored credential material as documented, but the Operator may not be able to confirm that every provider has revoked authorization until the provider reports that result.

Requests may be subject to identity verification, legal exceptions, and statutory response periods. [Insert the approved request channel, identity-verification process, response period, appeal process, and regulator contact details.]

## 10. Children and age restrictions

[Counsel and the Operator must set the Service's minimum age, assess whether the Service is directed to children, define parental/guardian consent where applicable, and specify how information relating to children is handled. Do not publish this policy with this section unresolved.]

## 11. Complaints and contact

For privacy questions, rights requests, or complaints, contact:

- Privacy contact: [Insert monitored email or web form]
- Postal address: [Insert legal address]
- Privacy officer / representative: [Insert role and contact if required]
- Relevant regulator: [Insert regulator and complaint pathway for the applicable jurisdiction]

## 12. Changes to this policy

The Operator may update this policy to reflect changes in the Service, providers, law, or processing. [Counsel must define advance notice, material-change notification, version history, effective dates, and renewed consent where required.]

---

## Operator completion notes — remove from the published policy

Before publication, complete the checklist in [Legal and privacy launch review](./legal-review-checklist.md). In particular, verify the live service's logging and analytics, hosting and backup regions, full subprocessor list, active OAuth scopes, cookie behavior, asset/object metadata, legal bases, age restrictions, privacy rights process, and the actual backup retention lifecycle. Do not turn product intentions or draft architectural safeguards into claims about live production behavior without evidence.
