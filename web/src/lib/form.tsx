// Form validation: which fields are wrong, red outlines, a summary above the button,
// scroll + focus to the first wrong field. Server validation errors map onto the same fields.
import { useCallback, useState } from 'react';
import { useApp } from './app';

export type Errors = Record<string, string>;

export function useFormErrors() {
  const { err: errText, t } = useApp();
  const [errors, setErrors] = useState<Errors>({});

  /** Show errors (field → message). Returns true when there are none. */
  const check = useCallback((e: Errors) => {
    const clean = Object.fromEntries(Object.entries(e).filter(([, v]) => Boolean(v)));
    setErrors(clean);
    const first = Object.keys(clean)[0];
    if (first) {
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>(`[data-field="${first}"]`);
        if (!el) return;
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el.querySelector<HTMLElement>('input:not([type=hidden]):not([hidden]), select, textarea, button')?.focus({ preventScroll: true });
      });
    }
    return !first;
  }, []);

  /** Forget the error of one field as soon as the person edits it. */
  const clear = useCallback((key: string) => setErrors((x) => {
    if (!(key in x)) return x;
    const y = { ...x };
    delete y[key];
    return y;
  }), []);

  /**
   * Put a server error on the right field. `codes` maps error codes to fields (e.g. invalid_sin → number),
   * `paths` maps request field names to form fields. Returns false when the error matched no field.
   */
  const fromServer = useCallback((raw: unknown, codes: Record<string, string>, paths: Record<string, string> = {}, message?: string) => {
    const e = raw as { code?: string; message?: string; details?: unknown };
    if (e?.code && codes[e.code]) {
      check({ [codes[e.code]!]: message ?? errText(e) });
      return true;
    }
    if (e?.code === 'validation_failed' && Array.isArray(e.details)) {
      const out: Errors = {};
      for (const i of e.details as { path: string; message: string }[]) {
        const top = i.path.split('.')[0] ?? '';
        const field = paths[top] ?? paths[i.path];
        if (field && !out[field]) out[field] = t('errCheckField');
      }
      if (Object.keys(out).length) {
        check(out);
        return true;
      }
    }
    return false;
  }, [check, errText, t]);

  return { errors, check, clear, fromServer, setErrors };
}

/** "Please fix: pickup address, date" above the submit button. */
export function ErrorSummary({ errors, labels }: { errors: Errors; labels: Record<string, string> }) {
  const { t } = useApp();
  const keys = Object.keys(errors);
  if (!keys.length) return null;
  return (
    <div className="notice bad error-summary" role="alert">
      {t('fixFields', { list: keys.map((k) => labels[k] ?? k).join(', ') })}
    </div>
  );
}

/** Small helpers used by the forms. */
export const isPhone = (v: string) => v.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '').length === 10;
export const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim());
