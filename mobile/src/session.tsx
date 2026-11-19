// Signed-in state, API client, language and live events, shared by every screen.
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, createApi, type Api } from './api';
import { errorText, translate, type Key, type Lang } from './i18n';
import { connectLive, type LiveEvent } from './realtime';
import type { Me } from './types';

const TOKEN_KEY = 'poputka.token';
const MODE_KEY = 'poputka.mode';

export const API_URL: string = (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl ?? 'http://localhost:8080';

type Mode = 'client' | 'driver';

interface SessionValue {
  ready: boolean;
  token: string | null;
  me: Me | null;
  api: Api;
  lang: Lang;
  t: (key: Key, vars?: Record<string, string | number>) => string;
  errorMessage: (e: unknown) => string;
  mode: Mode;
  setMode: (m: Mode) => void;
  signIn: (token: string, me: Me) => Promise<void>;
  signOut: () => Promise<void>;
  refreshMe: () => Promise<Me | null>;
  setMe: (me: Me) => void;
  subscribe: (fn: (e: LiveEvent) => void) => () => void;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [mode, setModeState] = useState<Mode>('client');
  const tokenRef = useRef<string | null>(null);
  tokenRef.current = token;
  const listeners = useRef(new Set<(e: LiveEvent) => void>());

  const api = useMemo(() => createApi(API_URL, () => tokenRef.current), []);
  const lang: Lang = me?.lang === 'en' ? 'en' : 'ru';
  const t = useCallback((key: Key, vars?: Record<string, string | number>) => translate(lang, key, vars), [lang]);
  const errorMessage = useCallback((e: unknown) => (e instanceof ApiError ? errorText(lang, e.code, e.message) : e instanceof Error ? e.message : String(e)), [lang]);

  const signOut = useCallback(async () => {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    tokenRef.current = null;
    setToken(null);
    setMe(null);
  }, []);

  const refreshMe = useCallback(async () => {
    if (!tokenRef.current) return null;
    try {
      const m = await api.me();
      setMe(m);
      return m;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) await signOut();
      return null;
    }
  }, [api, signOut]);

  useEffect(() => {
    (async () => {
      const [saved, savedMode] = await Promise.all([SecureStore.getItemAsync(TOKEN_KEY), SecureStore.getItemAsync(MODE_KEY)]);
      if (savedMode === 'driver' || savedMode === 'client') setModeState(savedMode);
      if (saved) {
        tokenRef.current = saved;
        setToken(saved);
        await refreshMe();
      }
      setReady(true);
    })();
  }, [refreshMe]);

  // live updates over WebSocket while signed in
  useEffect(() => {
    if (!token) return;
    return connectLive(API_URL, token, (e) => {
      for (const fn of listeners.current) fn(e);
    });
  }, [token]);

  const value: SessionValue = {
    ready,
    token,
    me,
    api,
    lang,
    t,
    errorMessage,
    mode,
    setMode: (m) => {
      setModeState(m);
      SecureStore.setItemAsync(MODE_KEY, m).catch(() => undefined);
    },
    signIn: async (tk, m) => {
      await SecureStore.setItemAsync(TOKEN_KEY, tk);
      tokenRef.current = tk;
      setToken(tk);
      setMe(m);
    },
    signOut,
    refreshMe,
    setMe,
    subscribe: (fn) => {
      listeners.current.add(fn);
      return () => {
        listeners.current.delete(fn);
      };
    },
  };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}

/** Loads data and reloads it on pull-to-refresh and on matching live events. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[], liveTypes: string[] = ['order']) {
  const { subscribe, errorMessage } = useSession();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await loadRef.current());
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [errorMessage]);
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => subscribe((e) => liveTypes.includes(e.type) && reload()), [subscribe, reload, liveTypes.join()]);
  return { data, setData, error, loading, reload };
}
