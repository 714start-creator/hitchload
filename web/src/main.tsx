// Website entry: layout and routes.
import { useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppProvider, Link, match, navigate, useApp, useLocation } from './lib/app';
import { LangSelect } from './lib/ui';
import { registerSW, resyncPush } from './lib/push';
import { Account, Notifications } from './pages/Account';
import { Home } from './pages/Home';
import { Info } from './pages/Info';
import { Loads } from './pages/Loads';
import { NewOrder } from './pages/NewOrder';
import { OrderLink, OrderPage, Orders } from './pages/Orders';
import { Send } from './pages/Send';
import { SignIn } from './pages/SignIn';
import { DriverHome } from './pages/driver/Feed';
import { Job, Jobs } from './pages/driver/Jobs';
import { Earnings, Tax } from './pages/driver/Money';
import { Setup } from './pages/driver/Setup';
import { Trips } from './pages/driver/Trips';

type Route = [string, (p: Record<string, string>) => ReactNode];
const ROUTES: Route[] = [
  ['/', () => <Home />],
  ['/send', () => <Send />],
  ['/send/new', () => <NewOrder />],
  ['/loads', () => <Loads />],
  ['/drive', () => <Info page="drive" />],
  ['/how-it-works', () => <Info page="how" />],
  ['/pricing', () => <Info page="pricing" />],
  ['/safety', () => <Info page="safety" />],
  ['/faq', () => <Info page="faq" />],
  ['/terms', () => <Info page="terms" />],
  ['/privacy', () => <Info page="privacy" />],
  ['/sign-in', () => <SignIn />],
  ['/account', () => <Account />],
  ['/notifications', () => <Notifications />],
  ['/orders', () => <Orders />],
  ['/orders/:id', (p) => <OrderPage id={p.id!} />],
  ['/o/:id', (p) => <OrderLink id={p.id!} />],
  ['/driver', () => <DriverHome />],
  ['/driver/setup', () => <Setup />],
  ['/driver/trips', () => <Trips />],
  ['/driver/jobs', () => <Jobs />],
  ['/driver/jobs/:id', (p) => <Job id={p.id!} />],
  ['/driver/earnings', () => <Earnings />],
  ['/driver/tax', () => <Tax />],
];

function Header() {
  const { me, t, site, unread } = useApp();
  const { path } = useLocation();
  const [open, setOpen] = useState(false);
  const isDriver = Boolean(me?.driver);
  const nav: [string, string][] = [
    ['/send', t('navSend')],
    ['/loads', t('navLoads')],
    [isDriver ? '/driver' : '/drive', isDriver ? t('navDriver') : t('navDrive')],
  ];
  if (me) nav.push(['/orders', t('navOrders')]);
  const brand = site?.brand ?? 'Hitchload';
  return (
    <header className="site-head">
      <div className="head-inner">
        <Link to="/" className="brand" aria-label={brand}>
          <span className="sign">{brand.toUpperCase()}</span>
        </Link>
        <nav className={`nav ${open ? 'open' : ''}`} aria-label="Main">
          {nav.map(([to, label]) => (
            <Link key={to} to={to} className={path === to || (to !== '/' && path.startsWith(to + '/')) ? 'on' : ''} onClick={() => setOpen(false)} aria-current={path === to ? 'page' : undefined}>{label}</Link>
          ))}
          <div className="nav-lang"><LangSelect id="lang-menu" /></div>
        </nav>
        <div className="head-tools">
          <LangSelect id="lang-head" compact />
          {me ? (
            <>
              <Link to="/notifications" className="bell" aria-label={t('navNotifications')}>
                <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5.5-6.84V3a1.5 1.5 0 0 0-3 0v1.16A7 7 0 0 0 5 11v5l-2 2v1h18v-1l-2-2Z" /></svg>
                {unread > 0 ? <span className="badge">{unread > 9 ? '9+' : unread}</span> : null}
              </Link>
              <Link to="/account" className="btn small">{me.name?.split(' ')[0] ?? t('navAccount')}</Link>
            </>
          ) : (
            <Link to={`/sign-in?next=${encodeURIComponent(path === '/' ? '/send' : path)}`} className="btn small primary">{t('signIn')}</Link>
          )}
          <button className="btn small ghost burger" aria-label="Menu" aria-expanded={open} onClick={() => setOpen(!open)}>☰</button>
        </div>
      </div>
    </header>
  );
}

function Footer() {
  const { t, site } = useApp();
  const brand = site?.brand ?? 'Hitchload';
  return (
    <footer className="site-foot">
      <div className="foot-inner">
        <div>
          <span className="sign small">{brand.toUpperCase()}</span>
          <p className="small muted">{t('footerAbout')}</p>
          <p className="small muted">{t('footerLegal')}</p>
        </div>
        <nav className="foot-links small" aria-label="Footer">
          <Link to="/how-it-works">{t('howPage')}</Link>
          <Link to="/pricing">{t('pricingPage')}</Link>
          <Link to="/safety">{t('safetyPage')}</Link>
          <Link to="/faq">{t('faqPage')}</Link>
          <Link to="/drive">{t('navDrive')}</Link>
          <Link to="/terms">{t('termsPage')}</Link>
          <Link to="/privacy">{t('privacyPage')}</Link>
          {site?.supportEmail ? <a href={`mailto:${site.supportEmail}`}>{t('contact')}: {site.supportEmail}</a> : null}
        </nav>
      </div>
      <p className="small muted copy">© {new Date().getFullYear()} {brand}</p>
    </footer>
  );
}

function NotFound() {
  const { t } = useApp();
  return (
    <div className="center-page">
      <h1>{t('notFound')}</h1>
      <Link to="/" className="btn primary">{t('goHome')}</Link>
    </div>
  );
}

function App() {
  const { path } = useLocation();
  const { me } = useApp();
  useEffect(() => {
    void registerSW();
  }, []);
  useEffect(() => {
    if (me) void resyncPush();
  }, [me?.id]);
  // old links from emails: /driver/loads/:id → the job page
  useEffect(() => {
    const m = match('/driver/loads/:id', path);
    if (m) navigate(`/driver/jobs/${m.id}`, true);
  }, [path]);
  let page: ReactNode = null;
  for (const [pattern, render] of ROUTES) {
    const p = match(pattern, path);
    if (p) {
      page = render(p);
      break;
    }
  }
  return (
    <>
      <Header />
      <main className={path === '/' ? 'main home' : 'main'}>{page ?? <NotFound />}</main>
      <Footer />
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <AppProvider>
    <App />
  </AppProvider>,
);
