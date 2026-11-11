"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Access = { isPlatformAdministrator: boolean; role: "owner" | "admin" | null; permissions: string[] };
type Administrator = { user_id: string; twitch_user_id: string; role: "owner" | "admin"; permissions: string[]; revoked_at: string | null };
type Report = {
  id: string; workspace_id: string; workspace_name: string; broadcaster_twitch_user_id: string;
  claimant_name: string; claimant_contact: string; provider_id: string; media_id: string;
  content_url: string | null; allegation: string; evidence: string[]; status: string;
  assigned_reviewer_user_id: string | null; assigned_reviewer_twitch_user_id: string | null;
  decision: string | null; decision_reason: string | null; created_at: string; updated_at: string;
  substantiated_case_count: number; repeat_infringer_threshold: number;
};
type Event = { id: string; actor_twitch_user_id: string | null; from_status: string | null; to_status: string; reason: string; details: Record<string, unknown>; created_at: string };
type RepeatSummary = { workspace_id: string; workspace_name: string; substantiated_case_count: number; threshold: number; threshold_reached: boolean; workspace_status: string };

const API = "/api";
const STATUSES = ["all", "received", "investigating", "decision_pending", "escalated", "closed"];
function csrfToken() { return document.cookie.split("; ").find((part) => part.startsWith("platform_csrf="))?.split("=")[1] ?? ""; }
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.method) headers.set("x-csrf-token", csrfToken());
  const response = await fetch(`${API}${path}`, { ...init, headers, credentials: "include", cache: "no-store" });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { message?: unknown } | null;
    throw new Error(typeof payload?.message === "string" ? payload.message : `Request failed (${response.status}).`);
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}
function displayDate(value: string) { return new Date(value).toLocaleString(); }
function actionBody(value: object) { return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) }; }

export default function RightsReportsPage() {
  const [access, setAccess] = useState<Access | null>(null);
  const [reports, setReports] = useState<Report[]>([]);
  const [administrators, setAdministrators] = useState<Administrator[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [reviewerId, setReviewerId] = useState("");
  const [reason, setReason] = useState("");
  const [decision, setDecision] = useState("takedown");
  const [preserveEvidence, setPreserveEvidence] = useState(true);
  const [providerId, setProviderId] = useState("spotify");
  const [repeat, setRepeat] = useState<RepeatSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const selected = useMemo(() => reports.find((report) => report.id === selectedId) ?? null, [reports, selectedId]);
  const reviewers = administrators.filter((admin) => !admin.revoked_at && (admin.role === "owner" || admin.permissions.includes("rights_reports.manage")));

  const load = useCallback(async () => {
    setError("");
    try {
      const current = await request<Access>("/platform-admin/me");
      setAccess(current);
      if (current.isPlatformAdministrator && current.permissions.includes("rights_reports.manage")) {
        const [items, admins] = await Promise.all([
          request<Report[]>(`/platform-admin/rights-reports?status=${filter === "all" ? "" : encodeURIComponent(filter)}&search=${encodeURIComponent(search.trim())}`),
          request<Administrator[]>("/platform-admin/administrators"),
        ]);
        setReports(items);
        setAdministrators(admins);
        setSelectedId((old) => items.some((item) => item.id === old) ? old : items[0]?.id ?? "");
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load rights-holder reports."); }
    finally { setLoading(false); }
  }, [filter, search]);
  useEffect(() => { void load(); }, [load]);

  const loadDetails = useCallback(async (report: Report) => {
    try {
      const [history, summary] = await Promise.all([
        request<Event[]>(`/platform-admin/rights-reports/${report.id}/events`),
        request<RepeatSummary>(`/platform-admin/rights-reports/workspaces/${report.workspace_id}/repeat-infringer`),
      ]);
      setEvents(history);
      setRepeat(summary);
      setReviewerId(report.assigned_reviewer_user_id ?? "");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load report history."); }
  }, []);
  useEffect(() => { if (selected) void loadDetails(selected); else { setEvents([]); setRepeat(null); } }, [selected, loadDetails]);

  async function perform(path: string, body: object, success: string) {
    setBusy(true); setError(""); setMessage("");
    try { await request(path, actionBody(body)); setMessage(success); setReason(""); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The rights operation failed."); }
    finally { setBusy(false); }
  }
  function requireReason() {
    if (reason.trim().length < 10) { setError("Enter a documented reason of at least 10 characters."); return false; }
    return true;
  }
  async function assign() {
    if (!selected || !reviewerId || !requireReason()) return;
    await perform(`/platform-admin/rights-reports/${selected.id}/assign`, { reviewerUserId: reviewerId, reason }, "Reviewer assignment recorded.");
  }
  async function transition(status: string) {
    if (!selected || !requireReason()) return;
    await perform(`/platform-admin/rights-reports/${selected.id}/status`, { status, reason }, `Report moved to ${status.replaceAll("_", " ")}.`);
  }
  async function decide() {
    if (!selected || !requireReason()) return;
    const label = decision === "takedown" ? "Block this content and close the report?" : "Record this decision and close the report?";
    if (!window.confirm(label)) return;
    await perform(`/platform-admin/rights-reports/${selected.id}/decision`, { decision, reason, preserveEvidence }, `Decision recorded: ${decision.replaceAll("_", " ")}.`);
  }
  async function disableProvider() {
    if (!selected || !requireReason()) return;
    if (!window.confirm(`Disable ${providerId} playback for workspace ${selected.workspace_name}?`)) return;
    await perform("/platform-admin/rights-reports/provider-path", { workspaceId: selected.workspace_id, providerId, reason }, "Provider playback path disabled for this workspace.");
  }
  async function restrictWorkspace() {
    if (!selected || !repeat?.threshold_reached || !requireReason()) return;
    if (!window.confirm(`Restrict workspace ${repeat.workspace_name} for repeat infringement? This is an audited workspace restriction, not deletion.`)) return;
    await perform(`/platform-admin/rights-reports/workspaces/${selected.workspace_id}/restrict`, { reason }, "Repeat-infringer workspace restriction recorded.");
  }

  if (loading) return <main className="shell"><div className="loading">Loading rights-holder operations…</div></main>;
  return (
    <main className="shell">
      <header className="topbar"><div className="brand"><span>♫</span> Streamer Audio</div><nav className="page-nav"><a href="/platform-admin">Administration</a><a href="/platform-admin/restrictions">Account & workspace controls</a><a href="/platform-admin/support">Diagnostics & support</a><a href="/">Workspace dashboard</a></nav></header>
      <section className="welcome"><div><p className="eyebrow">PLATFORM OPERATIONS</p><h1>Rights-holder reports</h1><p className="subheading">Review claims, document decisions, block reported content, and escalate repeat infringement.</p></div>{access?.role && <span className="status status--good">{access.role}</span>}</section>
      {error && <div className="error-banner" role="alert">{error}</div>}{message && <div className="success-banner" role="status">{message}</div>}
      {!access?.isPlatformAdministrator || !access.permissions.includes("rights_reports.manage") ? (
        <section className="panel"><h2>Access restricted</h2><p>This account does not have permission to manage rights-holder reports.</p></section>
      ) : <>
        <section className="panel">
          <div className="panel-heading"><div><p className="eyebrow">INTAKE QUEUE</p><h2>Reports</h2></div><button className="secondary-button" disabled={busy} onClick={() => void load()}>Refresh</button></div>
          <div className="incident-form-grid">
            <label>Status<select value={filter} onChange={(event) => setFilter(event.target.value)}>{STATUSES.map((status) => <option key={status} value={status}>{status.replaceAll("_", " ")}</option>)}</select></label>
            <label>Search<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Workspace, provider, media ID, claimant" /></label>
          </div>
          {reports.length === 0 ? <div className="quiet-empty"><p>No matching rights-holder reports</p><small>New reports will appear here when submitted.</small></div> : <div className="table-wrap"><table><thead><tr><th>Received</th><th>Workspace</th><th>Content</th><th>Status</th><th>Reviewer</th><th /></tr></thead><tbody>{reports.map((report) => <tr key={report.id}><td>{displayDate(report.created_at)}</td><td>{report.workspace_name}<small> · {report.broadcaster_twitch_user_id}</small></td><td>{report.provider_id} / {report.media_id}</td><td>{report.status.replaceAll("_", " ")}</td><td>{report.assigned_reviewer_twitch_user_id ?? "Unassigned"}</td><td><button className="text-button" onClick={() => setSelectedId(report.id)}>Review</button></td></tr>)}</tbody></table></div>}
        </section>
        {selected && <section className="panel">
          <div className="panel-heading"><div><p className="eyebrow">CASE REVIEW</p><h2>{selected.workspace_name} · {selected.provider_id}</h2></div><span className="status">{selected.status.replaceAll("_", " ")}</span></div>
          <p><strong>Claimant:</strong> {selected.claimant_name} · <a href={`mailto:${selected.claimant_contact}`}>{selected.claimant_contact}</a></p>
          <p><strong>Broadcaster Twitch ID:</strong> {selected.broadcaster_twitch_user_id}</p>
          <p><strong>Media ID:</strong> {selected.media_id}</p>
          {selected.content_url && <p><strong>Content:</strong> <a href={selected.content_url} target="_blank" rel="noreferrer">Open reported content</a></p>}
          <p><strong>Allegation:</strong></p><p>{selected.allegation}</p>
          <p><strong>Evidence:</strong></p>{selected.evidence.length ? <ul>{selected.evidence.map((url) => <li key={url}><a href={url} target="_blank" rel="noreferrer">{url}</a></li>)}</ul> : <p>No evidence links supplied.</p>}
          {selected.decision && <p><strong>Decision:</strong> {selected.decision.replaceAll("_", " ")} — {selected.decision_reason}</p>}
          <div className="incident-form-grid">
            <label>Assign reviewer<select value={reviewerId} onChange={(event) => setReviewerId(event.target.value)}><option value="">Choose reviewer</option>{reviewers.map((admin) => <option key={admin.user_id} value={admin.user_id}>{admin.twitch_user_id} ({admin.role})</option>)}</select></label>
            <button className="secondary-button" disabled={busy || !reviewerId} onClick={() => void assign()}>Assign reviewer</button>
          </div>
          {selected.status !== "closed" && <div className="incident-form-grid">
            <button className="secondary-button" disabled={busy} onClick={() => void transition("investigating")}>Start / resume investigation</button>
            <button className="secondary-button" disabled={busy} onClick={() => void transition("decision_pending")}>Mark decision pending</button>
            <button className="secondary-button" disabled={busy} onClick={() => void transition("escalated")}>Escalate case</button>
          </div>}
          {["decision_pending", "escalated"].includes(selected.status) && <div className="settings-form">
            <label>Decision<select value={decision} onChange={(event) => setDecision(event.target.value)}><option value="takedown">Takedown / block content</option><option value="no_action">No action</option><option value="insufficient_evidence">Insufficient evidence</option></select></label>
            <label className="checkbox-row"><input type="checkbox" checked={preserveEvidence} onChange={(event) => setPreserveEvidence(event.target.checked)} />Preserve evidence with the content block</label>
            <button className="primary-button" disabled={busy} onClick={() => void decide()}>Record decision and close report</button>
          </div>}
          <div className="settings-form">
            <label>Documented reason<textarea value={reason} onChange={(event) => setReason(event.target.value)} minLength={10} maxLength={1000} rows={3} placeholder="Record the factual basis and action taken." /></label>
          </div>
          <div className="incident-form-grid">
            <label>Provider path<select value={providerId} onChange={(event) => setProviderId(event.target.value)}><option value="youtube">YouTube / Invidious</option><option value="spotify">Spotify</option><option value="lyrion">Lyrion</option></select></label>
            <button className="secondary-button" disabled={busy} onClick={() => void disableProvider()}>Disable provider for workspace</button>
          </div>
          {repeat && <div className="panel"><p className="eyebrow">REPEAT-INFRINGER REVIEW</p><h3>{repeat.workspace_name}</h3><p>{repeat.substantiated_case_count} distinct substantiated takedown cases · threshold {repeat.threshold} · workspace status: {repeat.workspace_status}</p>{repeat.threshold_reached && repeat.workspace_status === "active" && <button className="primary-button" disabled={busy} onClick={() => void restrictWorkspace()}>Restrict repeat infringer workspace</button>}</div>}
          <div className="panel"><h3>Case history</h3>{events.length === 0 ? <p>No recorded events.</p> : events.map((event) => <article className="status-incident" key={event.id}><div className="status-incident-heading"><strong>{event.from_status ? `${event.from_status} → ${event.to_status}` : event.to_status}</strong><small>{displayDate(event.created_at)}</small></div><p>{event.reason}</p><small>{event.actor_twitch_user_id ? `Operator Twitch ID ${event.actor_twitch_user_id}` : "System intake"}</small></article>)}</div>
        </section>}
      </>}
    </main>
  );
}
