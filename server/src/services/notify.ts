// One place that turns business events into an in-app notification row,
// a live WebSocket event, browser/app push, email and (for critical events) SMS.
import type { Ctx } from '../ctx.js';
import { layout } from '../providers/email.js';
import { isValidSubscription } from '../providers/webpush.js';
import { inQuietHours, localHm } from '../lib/phone.js';
import { provinceTz } from '../lib/tz.js';
import { findCity } from '../data/cities.js';

type Lang = 'ru' | 'en';
type Vars = Record<string, string | number>;

// title, body. {placeholders} are filled from vars.
const T: Record<string, Record<Lang, [string, string]>> = {
  new_order: { ru: ['Новый заказ рядом', '{route} · {price}'], en: ['New order nearby', '{route} · {price}'] },
  new_order_pro: { ru: ['Приоритет Pro: новый заказ', '{route} · {price}'], en: ['Pro priority: new order', '{route} · {price}'] },
  trip_request: { ru: ['Запрос на ваш рейс', '{route} · {price}. Подтвердите в приложении'], en: ['Request for your trip', '{route} · {price}. Confirm in the app'] },
  offer_from_driver: { ru: ['Новое предложение цены', 'Водитель {driver} предлагает {price} за заказ #{number}'], en: ['New price offer', 'Driver {driver} offers {price} for order #{number}'] },
  counter_from_client: { ru: ['Встречное предложение', 'Клиент предлагает {price} за заказ #{number}'], en: ['Counter-offer', 'Customer offers {price} for order #{number}'] },
  offer_declined: { ru: ['Предложение отклонено', 'Заказ #{number}: предложение {price} отклонено'], en: ['Offer declined', 'Order #{number}: the {price} offer was declined'] },
  order_confirmed: { ru: ['Заказ подтверждён', 'Заказ #{number}: водитель {driver}. Списано {price}'], en: ['Order confirmed', 'Order #{number}: driver {driver}. Charged {price}'] },
  job_confirmed: { ru: ['Заказ ваш', 'Заказ #{number}: {route}. Погрузка {window}'], en: ['The job is yours', 'Order #{number}: {route}. Loading {window}'] },
  payment_failed: { ru: ['Оплата не прошла', 'Заказ #{number}: карта отклонена. Обновите карту в приложении'], en: ['Payment failed', 'Order #{number}: card declined. Update your card in the app'] },
  payment_failed_driver: { ru: ['Заказ снова открыт', 'Заказ #{number}: оплата клиента не прошла'], en: ['Order reopened', "Order #{number}: the customer's payment failed"] },
  en_route: { ru: ['Водитель едет к вам', 'Заказ #{number}: {driver} выехал на погрузку'], en: ['Driver on the way', 'Order #{number}: {driver} is heading to pick up'] },
  picked_up: { ru: ['Груз забран', 'Заказ #{number}: груз у водителя, фото в приложении'], en: ['Picked up', 'Order #{number}: the driver has the cargo, photos in the app'] },
  in_transit: { ru: ['Груз в пути', 'Заказ #{number} в пути в {city}'], en: ['On the way', 'Order #{number} is on the way to {city}'] },
  recipient_in_transit: { ru: ['Вам едет груз', '{brand}: груз от {client} в пути. Назовите водителю PIN {pin}'], en: ['Delivery on the way', '{brand}: a delivery from {client} is on the way. Give the driver PIN {pin}'] },
  order_created: { ru: ['Заказ #{number} опубликован', '{route}. Погрузка {window}. Деньги спишем с карты, только когда водитель подтвердит заказ'], en: ['Order #{number} is posted', '{route}. Loading {window}. Your card is charged only when a driver confirms the order'] },
  driver_on_your_order: { ru: ['Водитель едет по вашему маршруту', '{driver} едет {route}, выезд {date}. Заказ #{number}: предложите ему ваш груз'], en: ['A driver is going your way', '{driver} is driving {route}, leaving {date}. Order #{number}: ask them to take it'] },
  driver_on_alert: { ru: ['Новый водитель по вашему маршруту', '{driver} едет {route}, выезд {date}. Отправьте груз с ним'], en: ['New driver on your route', '{driver} is driving {route}, leaving {date}. Send your item with them'] },
  new_order_on_trip: { ru: ['Груз по вашему маршруту', '{route} · {price}. Подходит к вашей поездке {trip}'], en: ['A load on your route', '{route} · {price}. Fits your trip {trip}'] },
  delivered: { ru: ['Доставлено', 'Заказ #{number} доставлен. Оцените водителя'], en: ['Delivered', 'Order #{number} delivered. Rate your driver'] },
  payout_sent: { ru: ['Выплата отправлена', 'Заказ #{number}: {amount} на ваш счёт'], en: ['Payout sent', 'Order #{number}: {amount} to your account'] },
  payout_held: { ru: ['Выплата задержана', 'Заказ #{number}: {reason}'], en: ['Payout on hold', 'Order #{number}: {reason}'] },
  cancelled_by_client: { ru: ['Клиент отменил заказ', 'Заказ #{number}. Компенсация вам: {amount}'], en: ['Customer cancelled', 'Order #{number}. Your compensation: {amount}'] },
  cancelled_refund: { ru: ['Заказ отменён', 'Заказ #{number}. Вернём на карту {amount}'], en: ['Order cancelled', 'Order #{number}. Refund to your card: {amount}'] },
  driver_dropped: { ru: ['Водитель отказался', 'Заказ #{number}: деньги возвращены, ищем другого водителя'], en: ['Driver dropped out', 'Order #{number}: money refunded, finding another driver'] },
  trip_request_expired: { ru: ['Водитель не подтвердил', 'Заказ #{number} открыт для всех водителей'], en: ['Driver did not confirm', 'Order #{number} is now open to all drivers'] },
  order_expired: { ru: ['Заказ не взят', 'Заказ #{number}: окно погрузки прошло, заказ закрыт без оплаты'], en: ['No driver found', 'Order #{number}: the loading window passed; closed with no charge'] },
  chat_message: { ru: ['Сообщение · заказ #{number}', '{text}'], en: ['Message · order #{number}', '{text}'] },
  doc_expiring_30: { ru: ['Полис скоро истекает', '{doc} истекает {date}. Загрузите новый'], en: ['Policy expiring soon', '{doc} expires on {date}. Upload the new one'] },
  doc_expiring_7: { ru: ['Полис истекает через неделю', '{doc} истекает {date}. Без него аккаунт встанет на паузу'], en: ['Policy expires in a week', '{doc} expires on {date}. Without it your account will be paused'] },
  account_paused: { ru: ['Аккаунт на паузе', '{reason}'], en: ['Account paused', '{reason}'] },
  insurance_lapsed: { ru: ['Аккаунт на паузе', 'Полис истёк. Загрузите продлённый полис, чтобы снова брать заказы'], en: ['Account paused', 'Your policy expired. Upload the renewed policy to take orders again'] },
  paused_drops: { ru: ['Аккаунт на паузе', '{n} отказа от заказов за 30 дней. Свяжитесь с поддержкой'], en: ['Account paused', '{n} dropped orders in 30 days. Contact support'] },
  tier_changed: { ru: ['Уровень изменён', 'Ваш уровень: {tier}'], en: ['Level changed', 'Your level: {tier}'] },
  driver_approved: { ru: ['Проверка пройдена', 'Можно брать заказы'], en: ['You are approved', 'You can take orders now'] },
  driver_rejected: { ru: ['Проверка не пройдена', '{reason}'], en: ['Application not approved', '{reason}'] },
  doc_rejected: { ru: ['Документ отклонён', '{doc}: {reason}'], en: ['Document rejected', '{doc}: {reason}'] },
  driver_submitted: { ru: ['Новая анкета водителя', '{name}'], en: ['New driver application', '{name}'] },
  dispute_opened: { ru: ['Открыт спор', 'Заказ #{number}: {reason}'], en: ['Dispute opened', 'Order #{number}: {reason}'] },
  dispute_resolved: { ru: ['Спор решён', 'Заказ #{number}: {resolution}'], en: ['Dispute resolved', 'Order #{number}: {resolution}'] },
  tax_info_needed: { ru: ['Нужны налоговые данные', 'Чтобы получить выплату, укажите SIN или BN — это требование CRA ко всем платформам'], en: ['Tax details needed', 'To get paid, add your SIN or BN. CRA requires this from every platform'] },
};

/** Types whose push is skipped during a driver's quiet hours (the in-app list still gets them). */
const QUIET_TYPES = new Set(['new_order', 'new_order_pro', 'new_order_on_trip']);
/** Types that also go out by email (to a confirmed address). */
const EMAIL_TYPES = new Set([
  'order_created', 'order_confirmed', 'job_confirmed', 'payment_failed', 'delivered', 'payout_sent', 'payout_held', 'cancelled_by_client', 'cancelled_refund',
  'driver_dropped', 'order_expired', 'trip_request', 'offer_from_driver', 'counter_from_client', 'driver_approved', 'driver_rejected', 'doc_rejected',
  'doc_expiring_30', 'doc_expiring_7', 'account_paused', 'insurance_lapsed', 'paused_drops', 'dispute_opened', 'dispute_resolved', 'tax_info_needed', 'tier_changed',
  'driver_on_your_order', 'driver_on_alert', 'new_order_on_trip', 'driver_submitted',
]);
/** Matching suggestions: the user can switch these emails off. */
const ALERT_TYPES = new Set(['driver_on_your_order', 'driver_on_alert', 'new_order_on_trip']);
/** Types that also go out as SMS. */
const SMS_TYPES = new Set(['payment_failed', 'delivered', 'doc_expiring_7', 'account_paused', 'insurance_lapsed', 'paused_drops', 'trip_request', 'cancelled_by_client', 'driver_dropped']);

export function render(type: string, lang: string, vars: Vars, brand = 'Hitchload'): { title: string; body: string } {
  const entry = T[type];
  const l: Lang = lang === 'ru' ? 'ru' : 'en';
  if (!entry) return { title: type, body: '' };
  const all: Vars = { brand, ...vars };
  const fill = (s: string) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(all[k] ?? ''));
  return { title: fill(entry[l][0]), body: fill(entry[l][1]) };
}

export interface NotifyOptions {
  orderId?: string;
  sms?: boolean;
  /** site path the email button and push tap open; default: the order or the notification list */
  link?: string;
  /** one-click unsubscribe URL for alert emails */
  unsubscribe?: string;
}

export async function notify(ctx: Ctx, userId: string, type: string, vars: Vars = {}, o: NotifyOptions = {}): Promise<void> {
  const rows = await ctx.db.query<{ lang: string; phone: string; email: string | null; email_verified_at: string | null; email_alerts: boolean; quiet_from: string | null; quiet_to: string | null; home_city: string | null }>(
    `SELECT u.lang, u.phone, u.email, u.email_verified_at, u.email_alerts, d.quiet_from, d.quiet_to, d.home_city FROM users u LEFT JOIN drivers d ON d.user_id = u.id WHERE u.id = $1`,
    [userId],
  );
  const u = rows[0];
  if (!u) return;
  const msg = render(type, u.lang, vars, ctx.cfg.brand);
  const path = o.link ?? (o.orderId ? `/o/${o.orderId}` : '/notifications');
  const [row] = await ctx.db.query<{ id: number; created_at: string }>(
    `INSERT INTO notifications(user_id, type, order_id, data) VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
    [userId, type, o.orderId ?? null, { ...vars, title: msg.title, body: msg.body, link: path }],
  );
  ctx.hub.publish(userId, 'notification', { id: row?.id, type, orderId: o.orderId ?? null, title: msg.title, body: msg.body, link: path, createdAt: row?.created_at });

  // quiet hours are in the driver's own time zone (from their home city)
  const tz = u.home_city ? provinceTz(findCity(u.home_city)?.province, ctx.timeZone) : ctx.timeZone;
  const quiet = QUIET_TYPES.has(type) && inQuietHours(localHm(ctx.now(), tz), u.quiet_from, u.quiet_to);
  if (!quiet) await sendPush(ctx, userId, type, msg, o.orderId ?? null, path).catch((e) => ctx.log('push failed', e));
  if (u.email && u.email_verified_at && EMAIL_TYPES.has(type) && !(ALERT_TYPES.has(type) && !u.email_alerts)) {
    await sendEmail(ctx, u.email, u.lang, msg, path, o.unsubscribe).catch((e) => ctx.log('email failed', e));
  }
  if (o.sms ?? SMS_TYPES.has(type)) {
    await ctx.sms.send(u.phone, `${msg.title}. ${msg.body}`).catch((e) => ctx.log('sms failed', e));
  }
}

async function sendPush(ctx: Ctx, userId: string, type: string, msg: { title: string; body: string }, orderId: string | null, path: string) {
  const tokens = await ctx.db.query<{ token: string; platform: string }>('SELECT token, platform FROM push_tokens WHERE user_id = $1', [userId]);
  const app = tokens.filter((t) => t.platform !== 'web');
  const web = tokens.filter((t) => t.platform === 'web');
  if (app.length) {
    const channelId = type === 'chat_message' ? 'chat' : type.startsWith('doc_') || type.startsWith('driver_') || type === 'account_paused' ? 'account' : 'orders';
    const { invalidTokens } = await ctx.push.send(app.map((t) => ({ to: t.token, title: msg.title, body: msg.body, data: { type, orderId }, channelId })));
    if (invalidTokens.length) await ctx.db.query('DELETE FROM push_tokens WHERE token = ANY($1::text[])', [invalidTokens]);
  }
  for (const t of web) {
    let sub: unknown;
    try {
      sub = JSON.parse(t.token);
    } catch {
      sub = null;
    }
    if (!isValidSubscription(sub)) continue;
    const r = await ctx.webPush.send(sub, { title: msg.title, body: msg.body, url: path, tag: orderId ?? type }).catch((e) => {
      ctx.log('web push failed', e);
      return 'ok' as const;
    });
    if (r === 'gone') await ctx.db.query('DELETE FROM push_tokens WHERE token = $1', [t.token]);
  }
}

async function sendEmail(ctx: Ctx, to: string, lang: string, msg: { title: string; body: string }, path: string, unsubscribe?: string) {
  const site = ctx.cfg.publicUrl;
  const ru = lang === 'ru';
  const esc = (x: string) => x.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const footer = (ru
    ? `Вы получили это письмо, потому что у вас есть аккаунт на ${esc(ctx.cfg.brand)}. <a href="${esc(site)}/account" style="color:#0b6b45">Настройки уведомлений</a>`
    : `You are receiving this because you have an account on ${esc(ctx.cfg.brand)}. <a href="${esc(site)}/account" style="color:#0b6b45">Notification settings</a>`)
    + (unsubscribe ? ` · <a href="${esc(unsubscribe)}" style="color:#0b6b45">${ru ? 'Отписаться от этого маршрута' : 'Stop alerts for this route'}</a>` : '')
    + `<br>${esc(ctx.cfg.brand)} · ${esc(ctx.cfg.supportEmail)}`;
  const m = layout({ brand: ctx.cfg.brand, title: msg.title, body: msg.body, button: { text: ru ? 'Открыть' : 'Open', url: site + path }, footer });
  await ctx.email.send({ to, subject: msg.title, html: m.html, text: m.text });
}

/** Send an SMS to a phone that may not belong to a user (e.g. the recipient). */
export async function smsTo(ctx: Ctx, phone: string, type: string, lang: string, vars: Vars): Promise<void> {
  const msg = render(type, lang, vars, ctx.cfg.brand);
  await ctx.sms.send(phone, msg.body).catch((e) => ctx.log('sms failed', e));
}

export async function notifyAdmins(ctx: Ctx, type: string, vars: Vars, orderId?: string): Promise<void> {
  const admins = await ctx.db.query<{ id: string }>('SELECT id FROM users WHERE is_admin');
  for (const a of admins) await notify(ctx, a.id, type, vars, { orderId, sms: false });
}
