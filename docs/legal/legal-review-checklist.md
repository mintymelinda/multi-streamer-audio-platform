# Legal and privacy launch review

**Status: NOT APPROVED FOR PUBLICATION.** This checklist is the acceptance gate for roadmap Phase 7, item 67. Repository drafts do not constitute qualified legal review.

## Operator identity and scope

- [ ] Confirm full legal operator name, entity form, address, jurisdiction, and contact details.
- [ ] Identify the person/entity deciding purposes and means of processing, and any workspace-owner/controller or processor allocation.
- [ ] List intended countries/territories and confirm where the Service is offered or restricted.
- [ ] Set minimum age and any guardian-consent or child-directed-service requirements.
- [ ] Identify consumer-law, accessibility, electronic-marketing, privacy, and records obligations for each territory.

## Verify actual data processing

- [ ] Trace all account and authentication fields, session cookies, IP/user-agent collection, security logs, and analytics.
- [ ] Inventory all workspace/member/request/moderation/rights-report data and which fields may relate to viewers.
- [ ] Confirm Twitch OAuth scopes, EventSub subscriptions, event payloads, and the actual Twitch data shared back.
- [ ] Confirm Spotify metadata scopes separately from personal Spotify Connect scopes and document the independent broadcast-path restriction.
- [ ] Confirm YouTube/Invidious endpoints, whether instances are operator-selected or workspace-configured, and the metadata sent to them.
- [ ] Confirm Lyrion connection endpoints, credentials, server/player metadata, and whether local-network addresses are stored.
- [ ] Inventory uploaded assets, object metadata, tags, ACLs, presigned URLs, scene content, token handling, and public overlay exposure.
- [ ] Inventory every hosting, email, monitoring, CDN, support, security, and backup subprocessor, including legal entity and processing location.
- [ ] Confirm whether any data is sold, shared for cross-context behavioral advertising, used for model training, or accessed by support. Do not make a public claim until fact-checked.

## Retention, deletion, and recovery

- [ ] Reconcile the public retention table against actual database jobs and object lifecycle rules.
- [ ] Set and disclose backup retention, offsite copy retention, WAL lifecycle, and the time required for backup copies to expire.
- [ ] Confirm the independent deletion ledger and replay procedure prevent restored backups from reinstating deleted identities or access.
- [ ] Confirm rights-holder evidence and security/audit retention periods have a defined legal basis, access limits, and review date.
- [ ] Verify export/deletion behavior for database rows, assets, caches, queues, provider credentials, notifications, and third-party authorization revocation.
- [ ] Document exception handling for legal holds, fraud/security investigations, and statutory record retention.

## Legal and provider review

- [ ] Have qualified counsel review the Terms of Service and Privacy Policy for every territory in scope.
- [ ] Review current Twitch developer terms, data-use restrictions, privacy terms, and EventSub expectations.
- [ ] Review current Spotify Developer Terms and policy restrictions, especially the separation of personal Connect control from broadcast audio.
- [ ] Review the selected Invidious instance's terms and the relevant YouTube terms before enabling any media use.
- [ ] Review Lyrion licensing and workspace responsibilities for media rights in connected libraries.
- [ ] Confirm music/video rights, performance/broadcast/synchronization responsibilities, notice-and-takedown workflows, repeat-infringer procedures, and evidence retention with counsel.
- [ ] Complete required processor agreements, data-processing addenda, transfer mechanisms, cookie consent language, and vendor due diligence.

## Security and user operations

- [ ] Verify published security statements match production controls and independent test evidence.
- [ ] Complete privacy request intake, identity verification, response deadlines, appeal, and regulator complaint routing.
- [ ] Complete breach response, regulator/user notification, and incident evidence procedures for applicable jurisdictions.
- [ ] Confirm material policy changes can be versioned, notified, and accepted where required.
- [ ] Verify public overlay warnings clearly explain that a published URL is a bearer access link.
- [ ] Confirm moderator/admin roles and support access are properly disclosed.

## Approval record

- Legal reviewer / firm: [Name]
- Privacy/security reviewer: [Name]
- Operator approver: [Name]
- Jurisdictions reviewed: [List]
- Policy versions and effective dates: [List]
- Outstanding exceptions: [List]
- Approval date: [Date]

Do not mark Phase 7 item 67 complete, remove this publication blocker, or enable public registration until the approval record is complete and all release-blocking actions are resolved.
