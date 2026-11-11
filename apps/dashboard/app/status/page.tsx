"use client";

import { useEffect, useState } from "react";

type Incident = {
  id: string; title: string; summary: string;
  status: "investigating" | "identified" | "monitoring" | "resolved";
  impact: "degraded" | "partial_outage" | "major_outage";
  affected_services: string[]; created_at: string; updated_at: string; resolved_at: string | null;
};
type Maintenance = {
  id: string; title: string; summary: string; expected_impact: string;
  affected_services: string[]; starts_at: string; ends_at: string | null;
  created_at: string; updated_at: string; state: "scheduled" | "in_progress" | "completed";
};
type ServiceStatus = {
  status: "operational" | "degraded" | "partial_outage" | "major_outage";
  incidents: Incident[];
  maintenance: Maintenance[];
};

const SERVICE_NAMES: Record<string, string> = {
  all: "All services", api: "API", dashboard: "Dashboard", overlay: "OBS overlay",
  playback: "Playback", authentication: "Authentication", twitch: "Twitch integration",
  spotify: "Spotify integration", lyrion: "Lyrion integration",
};
function label(value: string) { return value.replaceAll("_", " "); }
function dateTime(value: string) {
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export default function PublicStatusPage() {
  const [data, setData] = useState<ServiceStatus | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/status", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("The service status could not be loaded.");
        return response.json() as Promise<ServiceStatus>;
      })
      .then(setData)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "The service status could not be loaded."))
      .finally(() => setLoading(false));
  }, []);

  return (
    <main className="shell status-shell">
      <header className="topbar">
        <a className="brand status-brand" href="/"><span>♫</span> Streamer Audio</a>
        <nav className="page-nav"><a href="/">Dashboard</a></nav>
      </header>
      <section className="welcome">
        <div><p className="eyebrow">PUBLIC SERVICE HEALTH</p><h1>Service status</h1><p className="subheading">Current platform availability, planned maintenance, and incident updates.</p></div>
      </section>
      {loading ? <div className="panel"><p>Checking service status…</p></div> : error ? (
        <div className="error-banner" role="alert">{error}</div>
      ) : data && (
        <>
          <section className={`status-overview status-overview--${data.status}`}>
            <span className="status-overview-mark">{data.status === "operational" ? "✓" : "!"}</span>
            <div><strong>{data.status === "operational" ? "No active incidents reported" : "Some systems are experiencing issues"}</strong><p>{data.status === "operational" ? "No active incidents have been published." : "Our team is investigating or addressing the incidents below."}</p></div>
            <span className="status-overview-label">{label(data.status)}</span>
          </section>
          <section className="panel status-incidents">
            <div className="panel-heading"><div><p className="eyebrow">UPCOMING & ACTIVE</p><h2>Planned maintenance</h2></div></div>
            {data.maintenance.length === 0 ? <div className="quiet-empty"><p>No planned maintenance</p><small>There are no upcoming or recent maintenance windows.</small></div> : data.maintenance.map((item) => (
              <article className="status-incident" key={item.id}>
                <div className="status-incident-heading"><div><h3>{item.title}</h3><div className="status-incident-meta"><span>{label(item.state)}</span><span>{item.affected_services.map((service) => SERVICE_NAMES[service] ?? service).join(", ")}</span></div></div><time dateTime={item.starts_at}>{dateTime(item.starts_at)}</time></div>
                <p>{item.summary}</p><p><strong>Expected impact:</strong> {item.expected_impact}</p>
                <small>Start: {dateTime(item.starts_at)}{item.ends_at ? ` · Expected end: ${dateTime(item.ends_at)}` : " · End time not yet confirmed"}</small>
              </article>
            ))}
          </section>
          <section className="panel status-incidents">
            <div className="panel-heading"><div><p className="eyebrow">INCIDENT HISTORY</p><h2>Incident updates</h2></div></div>
            {data.incidents.length === 0 ? <div className="quiet-empty"><span>✓</span><p>No incidents reported</p><small>There are no current service notices.</small></div> : data.incidents.map((incident) => (
              <article className="status-incident" key={incident.id}>
                <div className="status-incident-heading"><div><h3>{incident.title}</h3><div className="status-incident-meta"><span>{label(incident.status)}</span><span>{label(incident.impact)}</span><span>{incident.affected_services.map((service) => SERVICE_NAMES[service] ?? service).join(", ")}</span></div></div><time dateTime={incident.updated_at}>{dateTime(incident.updated_at)}</time></div>
                <p>{incident.summary}</p>
                {incident.resolved_at && <small>Resolved {dateTime(incident.resolved_at)}</small>}
              </article>
            ))}
          </section>
        </>
      )}
      <footer className="footer"><span>Streamer Audio Platform</span><span>Operator-published notices; not live component telemetry</span></footer>
    </main>
  );
}
