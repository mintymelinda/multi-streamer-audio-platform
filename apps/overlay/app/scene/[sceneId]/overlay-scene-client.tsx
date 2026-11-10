'use client';

import { useCallback, useEffect, useState } from 'react';

type SceneSnapshot = {
  sceneId: string;
  name: string;
  publishedState: unknown | null;
};

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL ?? '/api').replace(/\/+$/, '');

function apiUrl(path: string) {
  return `${API_BASE}${path}`;
}

export function OverlaySceneClient({ sceneId }: { sceneId: string }) {
  const [token, setToken] = useState('');
  const [snapshot, setSnapshot] = useState<SceneSnapshot | null>(null);
  const [status, setStatus] = useState<'connecting' | 'ready' | 'unauthorized' | 'error'>('connecting');

  const loadSnapshot = useCallback(async (accessToken: string) => {
    const response = await fetch(apiUrl(`/overlay/scenes/${sceneId}/snapshot`), {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
      credentials: 'omit',
    });
    if (response.status === 404 || response.status === 401) {
      setStatus('unauthorized');
      return;
    }
    if (!response.ok) throw new Error(`Overlay request failed (${response.status}).`);
    setSnapshot((await response.json()) as SceneSnapshot);
    setStatus('ready');
  }, [sceneId]);

  useEffect(() => {
    const fragmentToken = window.location.hash.slice(1);
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    if (!/^[A-Za-z0-9_-]{43}$/.test(fragmentToken)) {
      setStatus('unauthorized');
      return;
    }
    setToken(fragmentToken);
    void loadSnapshot(fragmentToken).catch(() => setStatus('error'));
  }, [loadSnapshot]);

  useEffect(() => {
    if (!token) return;
    let stopped = false;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = 1_000;
    let rejected = false;

    const connect = () => {
      if (stopped) return;
      const socketUrl = new URL(`${API_BASE}/socket.io/?EIO=4&transport=websocket`, window.location.href);
      socketUrl.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(socketUrl);
      socket.addEventListener('open', () => {
        retryDelay = 1_000;
      });
      socket.addEventListener('message', (message) => {
        const packet = String(message.data);
        if (packet.startsWith('0')) {
          socket?.send(`40/overlay,${JSON.stringify({ sceneId, token })}`);
        } else if (packet === '2') {
          socket?.send('3');
        } else if (packet.startsWith('40/overlay')) {
          setStatus('ready');
          void loadSnapshot(token).catch(() => setStatus('error'));
        } else if (packet.startsWith('42/overlay,')) {
          try {
            const [eventName] = JSON.parse(packet.slice('42/overlay,'.length)) as [string, unknown];
            if (eventName === 'overlay:invalidate') {
              void loadSnapshot(token).catch(() => setStatus('error'));
            }
          } catch {
            // Ignore malformed realtime packets; the next reconnect fetches a fresh snapshot.
          }
        } else if (packet.startsWith('44/overlay') || packet.startsWith('41/overlay')) {
          rejected = true;
          setStatus('unauthorized');
          socket?.close();
        }
      });
      socket.addEventListener('close', () => {
        if (stopped || rejected) return;
        setStatus((current) => current === 'unauthorized' ? current : 'connecting');
        retryTimer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30_000);
      });
      socket.addEventListener('error', () => socket?.close());
    };

    connect();
    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
    };
  }, [loadSnapshot, sceneId, token]);

  if (status === 'unauthorized') return <main className="overlay-message">This overlay URL is invalid or has been revoked.</main>;
  if (status === 'error') return <main className="overlay-message">The overlay is temporarily unavailable. Reconnecting…</main>;
  if (!snapshot) return <main className="overlay-message">Connecting to overlay…</main>;

  const publishedState = snapshot.publishedState && typeof snapshot.publishedState === "object"
    ? snapshot.publishedState as Record<string, unknown>
    : null;
  const elements = publishedState && Array.isArray(publishedState.elements)
    ? publishedState.elements.filter((element): element is Record<string, unknown> =>
        typeof element === "object" && element !== null && !Array.isArray(element),
      )
    : [];

  return (
    <main className="overlay-scene" aria-label={snapshot.name} data-scene-id={snapshot.sceneId}>
      {snapshot.publishedState === null
        ? <p className="overlay-message">This scene has not been published yet.</p>
        : elements.map((element, index) => {
            const number = (value: unknown, fallback: number) =>
              typeof value === "number" && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : fallback;
            const type = typeof element.type === "string" ? element.type : "custom-text";
            const text = typeof element.text === "string" ? element.text : "";
            const imageUrl = typeof element.src === "string" && /^https?:\/\//i.test(element.src) ? element.src : null;
            return <section
              className={`overlay-component overlay-component--${type}`}
              key={typeof element.id === "string" ? element.id : index}
              style={{
                left: `${number(element.x, 5)}%`,
                top: `${number(element.y, 5)}%`,
                width: `${number(element.width, 42)}%`,
                height: `${number(element.height, 18)}%`,
              }}
            >
              {type === "now-playing" && <div className="overlay-now-playing">
                <div className="overlay-artwork">♫</div>
                <div className="overlay-track-copy"><strong>{text || "Now Playing"}</strong><span>Artist · Album</span><div className="overlay-progress"><span /></div></div>
              </div>}
              {(type === "request-queue" || type === "recent-tracks") && <div className="overlay-list-component">
                <strong>{text || (type === "request-queue" ? "Request Queue" : "Recently Played")}</strong>
                <span>{type === "request-queue" ? "Upcoming requests will appear here" : "Recently played tracks will appear here"}</span>
              </div>}
              {type === "announcement" && <div className="overlay-announcement">{text}</div>}
              {type === "custom-text" && <div className="overlay-custom-text">{text}</div>}
              {type === "custom-image" && (imageUrl
                ? <img className="overlay-custom-image" src={imageUrl} alt={text || "Custom scene image"} />
                : <div className="overlay-image-placeholder">Add an image URL in the editor</div>)}
              {type === "background" && <div className="overlay-background-label">{text}</div>}
              {type === "decoration" && <div className="overlay-decoration" aria-hidden="true" />}
            </section>;
          })}
    </main>
  );
}
