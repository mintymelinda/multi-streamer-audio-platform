'use client';

import Image from 'next/image';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

type SceneSnapshot = {
  sceneId: string;
  name: string;
  publishedState: unknown | null;
};

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL ?? '/api').replace(/\/+$/, '');

function apiUrl(path: string) {
  return `${API_BASE}${path}`;
}

function animationName(element: Record<string, unknown>, phase: "enter" | "exit") {
  const settings = element.animation && typeof element.animation === "object"
    ? element.animation as Record<string, unknown>
    : {};
  const selected = settings[phase];
  if (selected === undefined) return "overlay-fade";
  return selected === "fade" || selected === "slide" || selected === "scale" ? `overlay-${selected}` : "none";
}

function animationDuration(element: Record<string, unknown>) {
  const settings = element.animation && typeof element.animation === "object"
    ? element.animation as Record<string, unknown>
    : {};
  const value = typeof settings.durationMs === "number" && Number.isFinite(settings.durationMs)
    ? Math.min(5000, Math.max(0, settings.durationMs))
    : 240;
  return `${value}ms`;
}

function withoutAssetUrl(element: Record<string, unknown>) {
  const { assetUrl: _assetUrl, ...comparable } = element;
  return comparable;
}

function sceneStateKey(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return JSON.stringify(value) ?? String(value);
  const state = value as Record<string, unknown>;
  return JSON.stringify({
    ...state,
    elements: Array.isArray(state.elements)
      ? state.elements.map((element) => element && typeof element === 'object' && !Array.isArray(element)
        ? withoutAssetUrl(element as Record<string, unknown>)
        : element)
      : state.elements,
  });
}

function animationDelay(element: Record<string, unknown>) {
  const settings = element.animation && typeof element.animation === "object"
    ? element.animation as Record<string, unknown>
    : {};
  const value = typeof settings.delayMs === "number" && Number.isFinite(settings.delayMs)
    ? Math.min(5000, Math.max(0, settings.delayMs))
    : 0;
  return `${value}ms`;
}

function OverflowMarquee({ text, className }: { text: string; className?: string }) {
  const viewportRef = useRef<HTMLSpanElement | null>(null);
  const contentRef = useRef<HTMLSpanElement | null>(null);
  const [overflow, setOverflow] = useState(0);

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;

    const measure = () => {
      setOverflow(Math.max(0, content.scrollWidth - viewport.clientWidth));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  const scrolling = overflow > 1;
  const style = scrolling
    ? {
        "--marquee-distance": `${overflow}px`,
        "--marquee-duration": `${Math.max(6, overflow / 18)}s`,
      } as CSSProperties
    : undefined;

  return (
    <span ref={viewportRef} className={`overlay-marquee ${className ?? ""}`}>
      <span
        ref={contentRef}
        className={`overlay-marquee__content ${scrolling ? "is-scrolling" : ""}`}
        style={style}
      >
        {text}
      </span>
    </span>
  );
}

export function OverlaySceneClient({ sceneId }: { sceneId: string }) {
  const [token, setToken] = useState('');
  const [snapshot, setSnapshot] = useState<SceneSnapshot | null>(null);
  const [status, setStatus] = useState<'connecting' | 'ready' | 'unauthorized' | 'error'>('connecting');
  const [renderedElements, setRenderedElements] = useState<Record<string, unknown>[]>([]);
  const [exitingIds, setExitingIds] = useState<string[]>([]);
  const [animatedIds, setAnimatedIds] = useState<string[]>([]);
  const [sceneTransitionActive, setSceneTransitionActive] = useState(false);
  const [overlayEvent, setOverlayEvent] = useState({ type: "", sequence: 0 });
  const previousElements = useRef<Record<string, unknown>[]>([]);
  const previousSceneState = useRef<string | null>(null);
  const lastHandledEvent = useRef(0);

  const loadSnapshot = useCallback(async (accessToken: string): Promise<boolean> => {
    const response = await fetch(apiUrl(`/overlay/scenes/${sceneId}/snapshot`), {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
      credentials: 'omit',
    });
    if (response.status === 404 || response.status === 401) {
      setStatus('unauthorized');
      return false;
    }
    if (!response.ok) throw new Error(`Overlay request failed (${response.status}).`);
    setSnapshot((await response.json()) as SceneSnapshot);
    setStatus('ready');
    return true;
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
    const refreshTimer = window.setInterval(() => {
      void loadSnapshot(token).catch(() => setStatus('error'));
    }, 45 * 60 * 1000);

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
            const [eventName, eventPayload] = JSON.parse(packet.slice('42/overlay,'.length)) as [string, unknown];
            if (eventName === 'overlay:invalidate') {
              const eventType = eventPayload && typeof eventPayload === "object" && "eventType" in eventPayload
                && typeof (eventPayload as { eventType?: unknown }).eventType === "string"
                ? (eventPayload as { eventType: string }).eventType
                : "";
              setOverlayEvent((current) => ({ type: eventType, sequence: current.sequence + 1 }));
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
        // A server-side access revocation closes the authenticated socket. Check
        // the bearer token before reconnecting so the overlay switches to its
        // revoked state instead of retrying an invalid token forever.
        void loadSnapshot(token).then((authorized) => {
          if (stopped || !authorized) {
            rejected = true;
            return;
          }
          setStatus('connecting');
          retryTimer = setTimeout(connect, retryDelay);
          retryDelay = Math.min(retryDelay * 2, 30_000);
        }).catch(() => {
          if (stopped || rejected) return;
          setStatus('error');
          retryTimer = setTimeout(connect, retryDelay);
          retryDelay = Math.min(retryDelay * 2, 30_000);
        });
      });
      socket.addEventListener('error', () => socket?.close());
    };

    const handleOnline = () => {
      if (stopped) return;
      // A websocket can survive browser network emulation or a brief interface
      // transition without closing. Refresh the published snapshot explicitly,
      // then force a fresh socket handshake so missed invalidations are recovered.
      void loadSnapshot(token).catch(() => setStatus('error'));
      socket?.close();
    };

    window.addEventListener('online', handleOnline);
    connect();
    return () => {
      stopped = true;
      window.removeEventListener('online', handleOnline);
      if (retryTimer) clearTimeout(retryTimer);
      window.clearInterval(refreshTimer);
      socket?.close();
    };
  }, [loadSnapshot, sceneId, token]);

  useEffect(() => {
    if (!snapshot) return;
    const current = sceneStateKey(snapshot.publishedState);
    const changed = previousSceneState.current !== null && previousSceneState.current !== current;
    previousSceneState.current = current;
    if (!changed) {
      setSceneTransitionActive(false);
      return;
    }
    const transition = snapshot.publishedState && typeof snapshot.publishedState === "object"
      ? (snapshot.publishedState as Record<string, unknown>).transition
      : null;
    const configuredDuration = transition && typeof transition === "object"
      ? (transition as Record<string, unknown>).durationMs
      : 320;
    setSceneTransitionActive(true);
    const timer = window.setTimeout(
      () => setSceneTransitionActive(false),
      typeof configuredDuration === "number" ? Math.min(5000, Math.max(0, configuredDuration)) + 80 : 400,
    );
    return () => window.clearTimeout(timer);
  }, [snapshot]);

  useEffect(() => {
    if (!snapshot) return;
    const state = snapshot.publishedState && typeof snapshot.publishedState === 'object'
      ? snapshot.publishedState as Record<string, unknown>
      : null;
    const next = state && Array.isArray(state.elements)
      ? state.elements.filter((element): element is Record<string, unknown> =>
          typeof element === 'object' && element !== null && !Array.isArray(element),
        )
      : [];
    const keyOf = (element: Record<string, unknown>, index: number) =>
      typeof element.id === 'string' ? element.id : String(index);
    const previous = previousElements.current;
    const previousByKey = new Map(previous.map((element, index) => [keyOf(element, index), element]));
    const nextKeys = new Set(next.map(keyOf));
    const removed = previous.filter((element, index) => !nextKeys.has(keyOf(element, index)));
    const exitElements = removed.filter((element) => animationName(element, 'exit') !== 'none');
    const exitIds = exitElements.map((element) => keyOf(element, previous.indexOf(element)));
    const entering = next.filter((element, index) => {
      const key = keyOf(element, index);
      const before = previousByKey.get(key);
      if (!before) return true;
      const animation = element.animation && typeof element.animation === 'object'
        ? element.animation as Record<string, unknown>
        : {};
      const trigger = animation.trigger;
      const changed = JSON.stringify(withoutAssetUrl(before)) !== JSON.stringify(withoutAssetUrl(element));
      const freshEvent = overlayEvent.sequence > lastHandledEvent.current;
      const newSongEvent = ['playback.session.started', 'playback.track.started', 'playback.track.changed', 'track.started', 'song.started'].includes(overlayEvent.type);
      const announcementEvent = ['announcement.created', 'announcement.published', 'overlay.announcement.created'].includes(overlayEvent.type);
      return (trigger === 'content-change' && changed)
        || (freshEvent && trigger === 'new-song' && element.type === 'now-playing' && newSongEvent)
        || (freshEvent && trigger === 'announcement' && element.type === 'announcement' && announcementEvent);
    }).filter((element) => animationName(element, 'enter') !== 'none');
    if (overlayEvent.sequence > lastHandledEvent.current) lastHandledEvent.current = overlayEvent.sequence;
    previousElements.current = next;
    const reduceMotion = state?.reducedMotion === true
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) {
      setRenderedElements(next);
      setExitingIds([]);
      setAnimatedIds([]);
      return;
    }
    setRenderedElements([...next, ...exitElements]);
    setExitingIds(exitIds);
    const enteringIds = entering.map((element) => keyOf(element, next.indexOf(element)));
    setAnimatedIds(enteringIds);
    const allAnimated = [...exitElements, ...entering];
    const longest = Math.max(0, ...allAnimated.map((element) => {
      const animation = element.animation && typeof element.animation === 'object'
        ? element.animation as Record<string, unknown>
        : {};
      const duration = typeof animation.durationMs === 'number' ? animation.durationMs : 240;
      const delay = typeof animation.delayMs === 'number' ? animation.delayMs : 0;
      return Math.min(5000, Math.max(0, duration + delay));
    }));
    if (allAnimated.length) {
      const timer = window.setTimeout(() => {
        setRenderedElements(next);
        setExitingIds([]);
        setAnimatedIds([]);
      }, longest + 80);
      return () => window.clearTimeout(timer);
    }
    setRenderedElements(next);
    setExitingIds([]);
    setAnimatedIds([]);
    return undefined;
  }, [snapshot, overlayEvent]);

  if (status === 'unauthorized') return <main className="overlay-message">This overlay URL is invalid or has been revoked.</main>;
  if (status === 'error') return <main className="overlay-message">The overlay is temporarily unavailable. Reconnecting…</main>;
  if (!snapshot) return <main className="overlay-message">Connecting to overlay…</main>;

  const publishedState = snapshot.publishedState && typeof snapshot.publishedState === "object"
    ? snapshot.publishedState as Record<string, unknown>
    : null;
  const elements = renderedElements;
  const canvas = publishedState?.canvas && typeof publishedState.canvas === "object"
    ? publishedState.canvas as Record<string, unknown>
    : {};
  const fixedCanvas = canvas.mode === "fixed";
  const canvasWidth = typeof canvas.width === "number" && Number.isFinite(canvas.width) ? Math.min(7680, Math.max(320, canvas.width)) : 1920;
  const canvasHeight = typeof canvas.height === "number" && Number.isFinite(canvas.height) ? Math.min(4320, Math.max(180, canvas.height)) : 1080;
  const transition = publishedState?.transition && typeof publishedState.transition === "object"
    ? publishedState.transition as Record<string, unknown>
    : {};
  const transitionDuration = typeof transition.durationMs === "number"
    ? Math.min(5000, Math.max(0, transition.durationMs))
    : 320;

  return (
    <main
      className={`overlay-scene ${fixedCanvas ? "is-fixed-canvas" : "is-responsive-canvas"} ${sceneTransitionActive ? "is-transitioning" : ""}`}
      data-transition={typeof publishedState?.transition === "object" && publishedState.transition !== null ? String((publishedState.transition as Record<string, unknown>).type ?? "none") : "none"}
      data-reduced-motion={publishedState?.reducedMotion === true ? "true" : "false"}
      aria-label={snapshot.name}
      data-scene-id={snapshot.sceneId}
      style={{
        ...(fixedCanvas ? { width: `${canvasWidth}px`, height: `${canvasHeight}px`, minHeight: 0 } : {}),
        "--scene-transition-duration": `${transitionDuration}ms`,
      } as CSSProperties}
    >
      {snapshot.publishedState === null
        ? <p className="overlay-message">This scene has not been published yet.</p>
        : elements.map((element, index) => {
            const number = (value: unknown, fallback: number, maximum: number) =>
              typeof value === "number" && Number.isFinite(value) ? Math.min(maximum, Math.max(0, value)) : fallback;
            const type = typeof element.type === "string" ? element.type : "custom-text";
            const text = typeof element.text === "string" ? element.text : "";
            const candidateImageUrl = typeof element.assetUrl === "string" ? element.assetUrl : element.src;
            const imageUrl = typeof candidateImageUrl === "string" && /^https?:\/\//i.test(candidateImageUrl) ? candidateImageUrl : null;
            return <section
              className={`overlay-component overlay-component--${type} ${exitingIds.includes(typeof element.id === "string" ? element.id : String(index)) ? "is-exiting" : animatedIds.includes(typeof element.id === "string" ? element.id : String(index)) ? "is-entering" : ""}`}
              key={typeof element.id === "string" ? element.id : index}
              style={{
                "--component-enter": animationName(element, "enter"),
                "--component-exit": animationName(element, "exit"),
                "--component-duration": animationDuration(element),
                "--component-delay": animationDelay(element),
                animationName: exitingIds.includes(typeof element.id === "string" ? element.id : String(index))
                  ? animationName(element, "exit")
                  : animatedIds.includes(typeof element.id === "string" ? element.id : String(index))
                    ? animationName(element, "enter")
                    : "none",
                animationDuration: animationDuration(element),
                animationDelay: animationDelay(element),
                animationFillMode: "both",
                animationDirection: exitingIds.includes(typeof element.id === "string" ? element.id : String(index)) ? "reverse" : "normal",
                left: `${number(element.x, fixedCanvas ? 96 : 5, fixedCanvas ? canvasWidth : 100)}${fixedCanvas ? "px" : "%"}`,
                top: `${number(element.y, fixedCanvas ? 54 : 5, fixedCanvas ? canvasHeight : 100)}${fixedCanvas ? "px" : "%"}`,
                width: `${number(element.width, fixedCanvas ? 806 : 42, fixedCanvas ? canvasWidth : 100)}${fixedCanvas ? "px" : "%"}`,
                height: `${number(element.height, fixedCanvas ? 194 : 18, fixedCanvas ? canvasHeight : 100)}${fixedCanvas ? "px" : "%"}`,
              } as CSSProperties}
            >
              {type === "now-playing" && <div className="overlay-now-playing">
                <div className="overlay-artwork" aria-label="Album artwork unavailable">
                  <span aria-hidden="true">♫</span>
                </div>
                <div className="overlay-track-copy">
                  <OverflowMarquee text={text || "Now Playing"} className="overlay-track-title" />
                  <div className="overlay-track-metadata">
                    <OverflowMarquee text="Artist" className="overlay-track-artist" />
                    <OverflowMarquee text="Album" className="overlay-track-album" />
                  </div>
                  <div className="overlay-playback-progress">
                    <div className="overlay-progress" role="progressbar" aria-label="Track progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={0}>
                      <span />
                    </div>
                    <div className="overlay-track-times">
                      <span>0:00</span>
                      <span>-0:00</span>
                    </div>
                  </div>
                </div>
              </div>}
              {(type === "request-queue" || type === "recent-tracks") && <div className="overlay-list-component">
                <strong>{text || (type === "request-queue" ? "Request Queue" : "Recently Played")}</strong>
                <span>{type === "request-queue" ? "Upcoming requests will appear here" : "Recently played tracks will appear here"}</span>
              </div>}
              {type === "announcement" && <div className="overlay-announcement">{text}</div>}
              {type === "custom-text" && <div className="overlay-custom-text">{text}</div>}
              {type === "custom-image" && (imageUrl
                ? <Image className="overlay-custom-image" src={imageUrl} alt={text || "Custom scene image"} width={640} height={360} unoptimized />
                : <div className="overlay-image-placeholder">Choose an image asset in the editor</div>)}
              {type === "background" && <div className="overlay-background-label">{text}</div>}
              {type === "decoration" && <div className="overlay-decoration" aria-hidden="true" />}
            </section>;
          })}
    </main>
  );
}
