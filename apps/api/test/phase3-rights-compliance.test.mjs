import assert from 'node:assert/strict';
import test from 'node:test';
import { RightsComplianceService } from '../dist/compliance/rights-compliance.service.js';

function createService(overrides = {}) {
  const records = [];
  const events = [];
  let attested = false;
  const dependencies = {
    database: {
      transaction: async (_context, operation) =>
        operation({
          query: async (sql, values = []) => {
            records.push({ sql, values });
            if (sql.includes('SELECT 1 FROM workspace_rights_attestations')) {
              return { rows: attested ? [{ id: 'attestation-a' }] : [], rowCount: attested ? 1 : 0 };
            }
            if (sql.includes('INSERT INTO workspace_rights_attestations')) attested = true;
            if (sql.includes('INSERT INTO rights_holder_reports')) return { rows: [{ id: 'report-a' }], rowCount: 1 };
            return { rows: [], rowCount: 1 };
          },
        }),
    },
    outbox: { append: async (_client, event) => events.push(event) },
    policy: { repeatInfringerThreshold: 3, requireRightsAttestation: true },
    ...overrides,
  };
  return { service: new RightsComplianceService(dependencies), records, events };
}

test('requires an explicit, versioned streamer rights/use attestation before enabling playback', async () => {
  const { service } = createService();
  await assert.rejects(
    service.assertWorkspacePlaybackEligible({ workspaceId: 'workspace-a', actorId: 'user-a' }),
    (error) => error.code === 'RIGHTS_ATTESTATION_REQUIRED',
  );
  const result = await service.recordAttestation({
    workspaceId: 'workspace-a', actorId: 'user-a', policyVersion: '2026-11', accepted: true,
  });
  assert.equal(result.accepted, true);
  await service.assertWorkspacePlaybackEligible({ workspaceId: 'workspace-a', actorId: 'user-a' });
});

test('rejects an attestation for an obsolete policy version or a non-acceptance', async () => {
  const { service } = createService({
    policy: { repeatInfringerThreshold: 3, requireRightsAttestation: true, currentVersion: '2026-11' },
  });
  await assert.rejects(service.recordAttestation({
    workspaceId: 'workspace-a', actorId: 'user-a', policyVersion: '2025-01', accepted: true,
  }));
  await assert.rejects(service.recordAttestation({
    workspaceId: 'workspace-a', actorId: 'user-a', policyVersion: '2026-11', accepted: false,
  }));
});

test('accepts a rights-holder report with evidence and records a reviewable case', async () => {
  const { service, events, records } = createService();
  const report = await service.submitRightsHolderReport({
    workspaceId: 'workspace-a',
    claimant: { name: 'Rights holder', contact: 'legal@example.test' },
    content: { providerId: 'youtube', mediaId: 'media-123', url: 'https://example.test/media-123' },
    allegation: 'Unauthorized use', evidence: ['https://example.test/evidence'],
  });
  assert.equal(report.status, 'received');
  assert.equal(report.id, 'report-a');
  assert.equal(events[0]?.eventType, 'rights.report.received');
  assert.equal(records.some((record) => record.sql.includes('INSERT INTO rights_holder_reports')), true);
});

test('requires documented reasons and actor attribution for content blocking and workspace/provider restrictions', async () => {
  const { service, events } = createService();
  await assert.rejects(service.blockContent({
    workspaceId: 'workspace-a', contentId: 'media-123', actorId: 'admin-a', reason: ' ',
  }));
  await service.blockContent({
    workspaceId: 'workspace-a', contentId: 'media-123', actorId: 'admin-a',
    reason: 'Validated rights-holder claim',
  });
  await service.disableProviderPath({
    workspaceId: 'workspace-a', providerId: 'spotify', actorId: 'admin-a',
    reason: 'Provider path under rights review',
  });
  await service.suspendWorkspace({
    workspaceId: 'workspace-a', actorId: 'admin-a',
    reason: 'Repeated substantiated infringement',
  });
  assert.deepEqual(events.map((event) => event.eventType), [
    'rights.content.blocked', 'workspace.provider_path.disabled', 'workspace.suspended',
  ]);
});

test('applies repeat-infringer controls only after the configured threshold of substantiated cases', async () => {
  const { service } = createService();
  assert.deepEqual(service.evaluateRepeatInfringer({
    workspaceId: 'workspace-a', substantiatedCaseCount: 2,
  }), { actionRequired: false, threshold: 3 });
  assert.deepEqual(service.evaluateRepeatInfringer({
    workspaceId: 'workspace-a', substantiatedCaseCount: 3,
  }), { actionRequired: true, threshold: 3 });
});
