"use client";

import { useCallback, useEffect, useState } from "react";

type Access = { isPlatformAdministrator: boolean; permissions: string[] };
type Incident = {
  id: string;
  title: string;
  summary: string;
  status: "investigating" | "identified" | "monitoring" | "resolved";
  impact: "degraded" | "partial_outage" | "major_outage";
  affected_services: string[];
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
};
type FormState = {
  title: string;
  summary: string;
  status: Incident["status"];
  impact: Incident["impact"];
  affectedServices: string[];
};
const API = "/api";
const SERVICES = [
  ["all", "All services"], ["api", "API"], ["dashboard", "Dashboard"],
  ["overlay", "OBS overlay"], ["playback", "Playback"],
  ["authentication", "Authentication"], ["twitch", "Twitch"],
  ["spotify", "Spotify"], ["lyrion", "Lyrion"],
] as const;
const EMPTY: FormState = {
  title: "",
  summary: "",
  status: "investigating",
  impact: "degraded",
  affectedServices: ["all"],
};

function csrfToken() {
  return document.cookie.split("; ").find((part) => part.startsWith("platform_csrf="))?.split("=")[1] ?? "";
}

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

export default function PlatformIncidentsPage() {
  const [access, setAccess] = useState<Access | null>(null);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const current = await request<Access>("/platform-admin/me");
      setAccess(current);
      if (current.isPlatformAdministrator && current.permissions.includes("status.manage")) {
        setIncidents(await request<Incident[]>("/platform-admin/incidents"));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load incident management.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function edit(incident: Incident) {
    setEditingId(incident.id);
    setForm({
      title: incident.title,
      summary: incident.summary,
      status: incident.status,
      impact: incident.impact,
      affectedServices: incident.affected_services,
    });
    setMessage("");
    setError("");
  }

  function toggleService(service: string) {
    setForm((current) => {
      const selected = current.affectedServices.includes(service)
        ? current.affectedServices.filter((item) => item !== service)
        : [...current.affectedServices.filter((item) => item !== "all" && service !== "all"), service];
      return { ...current, affectedServices: selected };
    });
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await request(editingId ? `/platform-admin/incidents/${editingId}` : "/platform-admin/incidents", {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      setForm(EMPTY);
      setEditingId(null);
      setMessage(editingId ? "Incident update published." : "Incident published.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the incident.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <main className="shell"><div className="loading">Loading incident management…</div></main>;

  return (
    <main className="shell">
      <header className="topbar"><div className="brand"><span>♫</span> Streamer Audio</div><nav className="page-nav"><a href="/platform-admin">Platform administration</a><a href="/status">Public status page</a><a href="/">Workspace dashboard</a></nav></header>
      <section className="welcome"><div><p className="eyebrow">PLATFORM OPERATIONS</p><h1>Service incidents</h1><p className="subheading">Publish platform-wide incident updates. Only the information entered here is made public.</p></div></section>
      {error && <div className="error-banner" role="alert">{error}</div>}
      {message && <div className="success-banner" role="status">{message}</div>}
      {!access?.isPlatformAdministrator || !access.permissions.includes("status.manage") ? (
        <section className="panel"><h2>Access restricted</h2><p>This account does not have permission to manage public service incidents.</p></section>
      ) : (
        <>
          <section className="panel">
            <div className="panel-heading"><div><p className="eyebrow">{editingId ? "UPDATE" : "NEW PUBLIC NOTICE"}</p><h2>{editingId ? "Update incident" : "Publish an incident"}</h2></div>{editingId && <button className="text-button" type="button" onClick={() => { setEditingId(null); setForm(EMPTY); }}>Cancel edit</button>}</div>
            <form className="settings-form" onSubmit={save}>
              <label>Public title<input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} minLength={5} maxLength={160} required /></label>
              <label>Public update<textarea value={form.summary} onChange={(event) => setForm({ ...form, summary: event.target.value })} minLength={10} maxLength={2000} rows={4} required /></label>
              <div className="incident-form-grid">
                <label>Incident state<select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as FormState["status"] })}><option value="investigating">Investigating</option><option value="identified">Identified</option><option value="monitoring">Monitoring</option><option value="resolved">Resolved</option></select></label>
                <label>Impact<select value={form.impact} onChange={(event) => setForm({ ...form, impact: event.target.value as FormState["impact"] })}><option value="degraded">Degraded performance</option><option value="partial_outage">Partial outage</option><option value="major_outage">Major outage</option></select></label>
              </div>
              <fieldset><legend>Affected services</legend><div className="incident-service-options">{SERVICES.map(([key, label]) => <label className="checkbox-row" key={key}><input type="checkbox" checked={form.affectedServices.includes(key)} onChange={() => toggleService(key)} />{label}</label>)}</div></fieldset>
              <button className="primary-button" type="submit" disabled={busy || !form.title.trim() || !form.summary.trim() || form.affectedServices.length === 0}>{busy ? "Publishing…" : editingId ? "Publish update" : "Publish incident"}</button>
            </form>
          </section>
          <section className="panel">
            <div className="panel-heading"><div><p className="eyebrow">PUBLIC COMMUNICATIONS</p><h2>Incident history</h2></div><a href="/status">View public page</a></div>
            {incidents.length === 0 ? <div className="quiet-empty"><p>No incidents published</p><small>New incidents will appear here.</small></div> : incidents.map((incident) => (
              <article className="status-incident" key={incident.id}>
                <div className="status-incident-heading"><div><h3>{incident.title}</h3><div className="status-incident-meta"><span>{incident.status.replaceAll("_", " ")}</span><span>{incident.impact.replaceAll("_", " ")}</span></div></div><button className="text-button" onClick={() => edit(incident)}>Edit / update</button></div>
                <p>{incident.summary}</p><small>Updated {new Date(incident.updated_at).toLocaleString()}</small>
              </article>
            ))}
          </section>
        </>
      )}
    </main>
  );
}
