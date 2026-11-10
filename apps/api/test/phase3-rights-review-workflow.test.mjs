import assert from 'node:assert/strict';
import test from 'node:test';
import { RightsReviewWorkflowService } from '../dist/compliance/rights-review-workflow.service.js';

test('publishes source-specific use guidance and makes clear that platform acceptance is not permission', async () => {
  const service = new RightsReviewWorkflowService({
    guidance: {
      youtube: { permittedUse: 'Use only where rights and platform terms allow', restrictions: ['No circumvention'] },
      spotify: { permittedUse: 'Use only through approved Spotify authorization and playback flows', restrictions: ['No stream extraction'] },
      lyrion: { permittedUse: 'Operator-managed library and server', restrictions: ['Confirm rights for each source'] },
    },
  });
  for (const providerId of ['youtube', 'spotify', 'lyrion']) {
    const guidance = service.getProviderUseGuidance(providerId);
    assert.ok(guidance.permittedUse);
    assert.ok(guidance.restrictions.length > 0);
    assert.equal(guidance.platformOwnerRiskAcceptanceGrantsPermission, false);
  }
});

test('rights-holder reports move through documented triage, investigation, decision, and escalation', async () => {
  const transitions = [];
  const service = new RightsReviewWorkflowService({
    appendAudit: async (event) => transitions.push(event.to),
    assignReviewer: async () => 'reviewer-a',
  });
  const report = await service.receiveReport({
    workspaceId: 'workspace-a',
    claimant: { name: 'Rights holder', contact: 'rights@example.test' },
    content: { providerId: 'youtube', mediaId: 'media-a' },
    allegation: 'Unauthorized use', evidence: ['https://evidence.example.test/item'],
  });
  assert.equal(report.assignedReviewerId, 'reviewer-a');
  await service.transition({
    reportId: report.id, workspaceId: 'workspace-a', actorId: 'reviewer-a',
    to: 'investigating', reason: 'Evidence review started',
  });
  await service.transition({
    reportId: report.id, workspaceId: 'workspace-a', actorId: 'reviewer-a',
    to: 'decision_pending', reason: 'Evidence assessed',
  });
  await service.escalate({
    reportId: report.id, workspaceId: 'workspace-a', actorId: 'reviewer-a',
    reason: 'Requires legal review',
  });
  assert.deepEqual(transitions, ['received', 'investigating', 'decision_pending', 'escalated']);
});

test('takedown decisions block the identified content and preserve evidence and audit history', async () => {
  let blocked;
  const service = new RightsReviewWorkflowService({
    appendAudit: async () => undefined,
    blockContent: async (input) => { blocked = input; },
  });
  const report = await service.receiveReport({
    workspaceId: 'workspace-a',
    claimant: { name: 'Rights holder', contact: 'rights@example.test' },
    content: { providerId: 'youtube', mediaId: 'media-a' },
    allegation: 'Unauthorized use', evidence: [],
  });
  await service.transition({
    reportId: report.id, workspaceId: 'workspace-a', actorId: 'reviewer-a',
    to: 'investigating', reason: 'Evidence review started',
  });
  await service.transition({
    reportId: report.id, workspaceId: 'workspace-a', actorId: 'reviewer-a',
    to: 'decision_pending', reason: 'Evidence assessed',
  });
  await service.recordDecision({
    reportId: report.id, workspaceId: 'workspace-a', actorId: 'reviewer-a',
    outcome: 'takedown', contentId: 'media-a',
    reason: 'Substantiated rights-holder claim', preserveEvidence: true,
  });
  assert.equal(blocked.contentId, 'media-a');
  assert.equal(blocked.reason, 'Substantiated rights-holder claim');
  assert.equal(blocked.preserveEvidence, true);
});

test('requires qualified legal review of policies and operational procedures before public launch', async () => {
  const service = new RightsReviewWorkflowService({
    legalReview: { policyApproved: false, proceduresApproved: true, reviewerQualified: true },
  });
  await assert.rejects(service.assertPublicLaunchReady(), (error) => error.code === 'LEGAL_REVIEW_REQUIRED');
  service.setLegalReview({
    policyApproved: true, proceduresApproved: true, reviewerQualified: true, reviewedAt: new Date(),
  });
  assert.equal(await service.assertPublicLaunchReady(), true);
});

test('does not describe operational safeguards as a guarantee of legal compliance', async () => {
  const service = new RightsReviewWorkflowService();
  const disclosure = service.getComplianceDisclosure();
  assert.equal(disclosure.guaranteesLegalCompliance, false);
  assert.ok(disclosure.requiresQualifiedLegalReview);
});
