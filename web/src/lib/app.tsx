// Site-wide state: routing, session, language, live events, toasts.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, getToken, setToken, setUnauthorizedHandler } from './api';
import { errorText, isLang, langInfo, translate, type Key, type Lang } from './i18n';
import type { City, Me, SiteConfig } from './types';

// ---------------------------------------------------------------- router

const listeners = new Set<() => void>();
export function navigate(to: string, replace = false) {
  if (to === location.pathname + location.search) return;
  if (replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  window.scrollTo(0, 0);
  listeners.forEach((l) => l());
}
addEventListener('popstate', () => listeners.forEach((l) => l()));

export function useLocation() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return { path: location.pathname, query: new URLSearchParams(location.search) };
}

/** Matches "/orders/:id" style patterns. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split('/').filter(Boolean);
  const b = path.split('/').filter(Boolean);
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.startsWith(':')) params[a[i]!.slice(1)] = decodeURIComponent(b[i]!);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

export function Link({ to, children, className, onClick, ...rest }: { to: string; children: ReactNode; className?: string; onClick?: () => void; 'aria-current'?: 'page' | undefined; id?: string }) {
  return (
    <a
      href={to}
      className={className}
      {...rest}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        onClick?.();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

// ---------------------------------------------------------------- session

interface Toast {
  id: number;
  title: string;
  body?: string;
  link?: string | null;
  tone?: 'ok' | 'error' | 'info';
}

interface LiveEvent {
  type: string;
  data: any;
}

interface AppState {
  site: SiteConfig | null;
  me: Me | null;
  ready: boolean;
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (k: Key, vars?: Record<string, string | number>) => string;
  err: (e: unknown) => string;
  refreshMe: () => Promise<Me | null>;
  signedIn: (token: string, me: Me) => void;
  signOut: () => void;
  cities: City[];
  toast: (t: Omit<Toast, 'id'>) => void;
  /** subscribe to live server events (order changes, messages, notifications) */
  onLive: (f: (e: LiveEvent) => void) => () => void;
  unread: number;
  setUnread: (n: number) => void;
}

const Ctx = createContext<AppState | null>(null);
export const useApp = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error('useApp outside provider');
  return c;
};

const LANG_KEY = 'hl.lang';
function initialLang(): Lang {
  try {
    const s = localStorage.getItem(LANG_KEY);
    if (isLang(s)) return s;
  } catch {
    /* ignore */
  }
  for (const n of navigator.languages ?? [navigator.language]) {
    const code = n?.toLowerCase().slice(0, 2);
    if (isLang(code)) return code;
  }
  return 'en';
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [site, setSite] = useState<SiteConfig | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const [lang, setLangState] = useState<Lang>(initialLang);
  const [cities, setCities] = useState<City[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [unread, setUnread] = useState(0);
  const live = useRef(new Set<(e: LiveEvent) => void>());
  const toastId = useRef(0);

  const t = useCallback((k: Key, vars?: Record<string, string | number>) => translate(lang, k, vars), [lang]);
  const err = useCallback((e: unknown) => errorText(lang, e), [lang]);
  const toast = useCallback((x: Omit<Toast, 'id'>) => {
    const id = ++toastId.current;
    setToasts((l) => [...l.slice(-3), { ...x, id }]);
    setTimeout(() => setToasts((l) => l.filter((y) => y.id !== id)), 7000);
  }, []);

  const refreshMe = useCallback(async () => {
    if (!getToken()) {
      setMe(null);
      return null;
    }
    try {
      const m = await api.me();
      setMe(m);
      return m;
    } catch {
      return null;
    }
  }, []);

  const signOut = useCallback(() => {
    setToken(null);
    setMe(null);
    navigate('/');
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setToken(null);
      setMe(null);
    });
    Promise.all([api.site().then(setSite).catch(() => undefined), api.cities().then(setCities).catch(() => undefined), refreshMe()]).finally(() => setReady(true));
  }, [refreshMe]);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = langInfo(lang).dir;
  }, [lang]);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(LANG_KEY, l);
    } catch {
      /* ignore */
    }
    if (getToken()) api.updateMe({ lang: l }).then(setMe).catch(() => undefined);
  }, []);

  // live events over WebSocket while signed in
  useEffect(() => {
    if (!me) return;
    let ws: WebSocket | null = null;
    let stopped = false;
    let retry = 1000;
    const connect = () => {
      const tok = getToken();
      if (!tok || stopped) return;
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/v1/ws?token=${encodeURIComponent(tok)}`);
      ws.onmessage = (m) => {
        let e: LiveEvent;
        try {
          e = JSON.parse(String(m.data));
        } catch {
          return;
        }
        if (e.type === 'notification') {
          setUnread((n) => n + 1);
          toast({ title: e.data.title, body: e.data.body, link: e.data.link, tone: 'info' });
        }
        live.current.forEach((f) => f(e));
      };
      ws.onopen = () => (retry = 1000);
      ws.onclose = () => {
        if (!stopped) setTimeout(connect, (retry = Math.min(retry * 2, 30000)));
      };
    };
    connect();
    api.notifications().then((l) => setUnread(l.filter((n) => !n.read).length)).catch(() => undefined);
    return () => {
      stopped = true;
      ws?.close();
    };
  }, [me?.id, toast]);

  const onLive = useCallback((f: (e: LiveEvent) => void) => {
    live.current.add(f);
    return () => void live.current.delete(f);
  }, []);

  const signedIn = useCallback((tok: string, m: Me) => {
    setToken(tok);
    setMe(m);
    if (m.lang !== lang) api.updateMe({ lang }).then(setMe).catch(() => undefined);
  }, [lang]);

  const value = useMemo<AppState>(() => ({ site, me, ready, lang, setLang, t, err, refreshMe, signedIn, signOut, cities, toast, onLive, unread, setUnread }), [site, me, ready, lang, setLang, t, err, refreshMe, signedIn, signOut, cities, toast, onLive, unread]);

  useEffect(() => {
    if (site?.brand) document.title = `${site.brand} · ${translate(lang, 'tagline')}`;
  }, [site?.brand, lang]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((x) => (
          <div key={x.id} className={`toast ${x.tone ?? 'info'}`} role="status">
            <div>
              <b>{x.title}</b>
              {x.body ? <div className="small">{x.body}</div> : null}
            </div>
            {x.link ? (
              <button className="btn small" onClick={() => { setToasts((l) => l.filter((y) => y.id !== x.id)); navigate(x.link!); }}>
                {translate(lang, 'continue')}
              </button>
            ) : null}
            <button className="x" aria-label={translate(lang, 'close')} onClick={() => setToasts((l) => l.filter((y) => y.id !== x.id))}>×</button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

/** Load data with loading / error state and a reload function. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const reload = useCallback(() => {
    const n = ++seq.current;
    setLoading(true);
    setError(null);
    return load()
      .then((d) => {
        if (n === seq.current) setData(d);
      })
      .catch((e) => {
        if (n === seq.current) setError(e);
      })
      .finally(() => {
        if (n === seq.current) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}

/** Ticks every second (for countdowns). */
export function useNow(active = true) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, [active]);
  return now;
}
