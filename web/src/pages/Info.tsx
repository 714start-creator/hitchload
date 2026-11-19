// Static pages: for drivers, how it works, prices, safety, FAQ, terms and privacy (drafts for legal review).
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { Link, useApp } from '../lib/app';
import { money } from '../lib/format';
import { Notice } from '../lib/ui';

type Page = 'drive' | 'how' | 'pricing' | 'safety' | 'faq' | 'terms' | 'privacy';
type Rules = Awaited<ReturnType<typeof api.config>>['rules'];

export function Info({ page }: { page: Page }) {
  const { lang, site, me } = useApp();
  const [rules, setRules] = useState<Rules | null>(null);
  useEffect(() => void api.config().then((c) => setRules(c.rules)).catch(() => undefined), []);
  const brand = site?.brand ?? 'Hitchload';
  const email = site?.supportEmail ?? 'support@hitchload.ca';
  const fee = rules ? Math.round(rules.clientFeeRate * 100) : 5;
  const dfee = rules ? Math.round(rules.driverFeeRate * 100) : 5;
  const ins = rules ? (rules.insuranceRate * 100).toFixed(1).replace(/\.0$/, '') : '1.5';
  const insMin = rules ? money(rules.insuranceMinCents) : '$3.00';
  const late = rules?.cancelLateHours ?? 24;
  const v = { brand, email, fee, dfee, ins, insMin, late, driveTo: me?.driver ? '/driver/setup' : '/driver/setup' };
  const content = (lang === 'ru' ? RU : EN)[page](v);
  return <article className="page prose">{content}</article>;
}

interface V { brand: string; email: string; fee: number; dfee: number; ins: string; insMin: string; late: number; driveTo: string }

const Draft = ({ ru }: { ru?: boolean }) => <Notice>{ru ? 'Черновик для юриста. Не действует, пока юрист не утвердит текст.' : 'Draft for legal review. Not in force until approved by a lawyer.'}</Notice>;

const EN: Record<Page, (v: V) => ReactNode> = {
  drive: (v) => (
    <>
      <h1>Drive with {v.brand}: get paid for the trips you already make</h1>
      <p className="lead">Post the route you are driving. We show you loads along the way and tell people who need something sent on that route that you are going. You set when you go; we bring the cargo.</p>
      <div className="row"><Link to={v.driveTo} className="btn primary">Apply to drive</Link><Link to="/loads" className="btn">See open loads</Link></div>
      <h2>What you earn</h2>
      <p>You keep {100 - v.dfee}% of the agreed price. The platform fee is {v.dfee}%. Payouts go to your bank account through Stripe after each delivery.</p>
      <h2>Two levels</h2>
      <ul>
        <li><b>Basic</b>: a personal auto policy with a delivery endorsement. Local and intercity loads with declared value up to $1,000 (up to $5,000 when the customer buys cargo insurance).</li>
        <li><b>Pro</b>: commercial auto and cargo policies. You see new orders first (about 2–3 minutes in town, 30 minutes for intercity) and can take loads up to your cargo policy limit.</li>
      </ul>
      <h2>What you need</h2>
      <ul>
        <li>A valid driver’s licence and your vehicle registration</li>
        <li>Insurance that covers paid deliveries (a delivery endorsement or a commercial policy)</li>
        <li>A criminal record check</li>
        <li>Photo ID and a selfie (checked by Stripe), and a bank account for payouts</li>
        <li>Your SIN or business number before the first payout: every platform must report drivers’ earnings to CRA each year</li>
      </ul>
      <h2>How a job works</h2>
      <ol>
        <li>Take a load at its price or offer yours; the customer can make one counter-offer.</li>
        <li>When you confirm, the customer’s card is charged. Pick up and take photos of the item.</li>
        <li>Hand it over when the recipient tells you the right PIN. Your payout starts right away.</li>
      </ol>
      <p className="small muted">Drivers are independent contractors. You decide which jobs to take and are responsible for your vehicle, insurance, permits and taxes.</p>
    </>
  ),
  how: (v) => (
    <>
      <h1>How {v.brand} works</h1>
      <h2>For people sending things</h2>
      <ol>
        <li><b>Find a trip or post an order.</b> Enter where from, where to and the loading window. You see drivers already driving that route, with their departure time and when they pass each city.</li>
        <li><b>Agree on the price.</b> Take the suggested price or set your own. Drivers accept, or offer another price; each side gets one counter-offer.</li>
        <li><b>Payment.</b> You add a card when you sign up. Nothing is charged while you wait; the card is charged at the moment a driver confirms.</li>
        <li><b>Pickup and delivery.</b> The driver photographs the item at pickup. The recipient gets a PIN by SMS and the driver hands the item over only with that PIN.</li>
        <li><b>Route alerts.</b> No driver on your route yet? Press “Notify me”: we email you and send a browser notification the moment someone posts a trip through your cities.</li>
      </ol>
      <h2>For drivers</h2>
      <ol>
        <li>Apply and get verified (licence, registration, insurance, ID check, criminal record check).</li>
        <li>Post a trip: start, stops on the way, destination and departure time.</li>
        <li>We match loads along your trip and tell shippers on that route. New loads posted later are sent to you as notifications.</li>
      </ol>
      <h2>All communication stays on {v.brand}</h2>
      <p>Phone numbers, emails and links are hidden in the chat. This keeps payment protection, insurance and dispute handling working for both sides.</p>
    </>
  ),
  pricing: (v) => (
    <>
      <h1>Prices and fees</h1>
      <h2>For customers</h2>
      <ul>
        <li><b>The price to the driver</b> is what you agree on. We suggest one based on size and distance; on-the-way trips are usually cheaper.</li>
        <li><b>Service fee: {v.fee}%</b> of the driver price, charged with the order.</li>
        <li><b>Cargo insurance (optional): {v.ins}%</b> of the declared value, minimum {v.insMin}. Available at any value, even $20.</li>
      </ul>
      <h2>For drivers</h2>
      <p>Platform fee <b>{v.dfee}%</b> of the agreed price. You receive the rest after delivery.</p>
      <h2>Cancellation by the customer</h2>
      <table className="table">
        <tbody>
          <tr><td>Before a driver confirms</td><td>Free</td></tr>
          <tr><td>After confirmation, more than {v.late} h before loading</td><td>5% to the driver, 5% to the platform</td></tr>
          <tr><td>Less than {v.late} h before loading, or the driver has set off</td><td>30% to the driver, 10% to the platform</td></tr>
          <tr><td>Driver arrived and there was no item</td><td>40% to the driver, 10% to the platform</td></tr>
        </tbody>
      </table>
      <p>After confirmation the {v.fee}% service fee is not refunded. Everything else comes back to your card.</p>
      <h2>If the driver cancels</h2>
      <p>You get a full refund and the order goes back to other drivers.</p>
    </>
  ),
  safety: (v) => (
    <>
      <h1>Safety and insurance</h1>
      <h2>Who drives</h2>
      <p>Every driver passes a photo ID and selfie check (Stripe Identity), uploads a licence, vehicle registration and insurance policy, and a criminal record check. Our team reviews each document before the first job. Expired insurance pauses the account automatically.</p>
      <h2>Protection during the job</h2>
      <ul>
        <li>Photos of the item at pickup and delivery are stored with the order.</li>
        <li>The item is handed over only with the recipient’s PIN.</li>
        <li>The customer sees the driver’s position while the job is active.</li>
        <li>Both sides rate each other after delivery.</li>
      </ul>
      <h2>Insurance</h2>
      <p>Drivers carry their own insurance: Basic drivers a policy that covers deliveries, Pro drivers commercial auto and cargo policies. Customers can add cargo insurance to any order. {v.brand} is a marketplace and does not transport goods itself.</p>
      <h2>What cannot be sent</h2>
      <p>Dangerous goods (explosives, flammable liquids, gas cylinders, corrosives), weapons and ammunition, illegal items, cannabis and alcohol, prescription drugs, cash, live animals, human remains, and anything a driver is not allowed to carry by law.</p>
      <h2>Problems</h2>
      <p>Use “Report a problem” on the order page or write to <a href={`mailto:${v.email}`}>{v.email}</a>. Payments for disputed orders can be held while we review them.</p>
    </>
  ),
  faq: (v) => (
    <>
      <h1>Questions</h1>
      <h3>When is my card charged?</h3><p>When a driver confirms your order. Posting an order is free.</p>
      <h3>What if nobody takes my order?</h3><p>If no driver confirms before the loading window ends, the order closes and nothing is charged.</p>
      <h3>Can I talk to the driver by phone?</h3><p>Use the chat on the order page. Contacts are hidden to keep payment protection and insurance in place.</p>
      <h3>Is my item insured?</h3><p>The driver’s policy covers it up to its limits. For more certainty add cargo insurance to the order: {v.ins}% of the declared value, minimum {v.insMin}.</p>
      <h3>Which cities do you cover?</h3><p>All of Canada: local deliveries in cities and intercity and interprovincial trips. Availability depends on drivers on your route; route alerts tell you when one appears.</p>
      <h3>I am a driver. Do I need a commercial licence?</h3><p>For most cars, SUVs, pickups and vans a regular licence is enough. Heavier vehicles and interprovincial commercial trips may need a carrier safety certificate; check your province’s rules.</p>
      <h3>Why do you ask drivers for a SIN or BN?</h3><p>Canadian law requires platforms to report sellers’ earnings to CRA every year. Without it we must hold payouts.</p>
    </>
  ),
  terms: (v) => (
    <>
      <h1>Terms of Service</h1>
      <Draft />
      <h2>1. What {v.brand} is</h2>
      <p>{v.brand} is an online marketplace that connects people who want items moved (“Customers”) with independent drivers (“Drivers”). {v.brand} does not transport goods, is not a carrier, freight forwarder or insurer, and is not a party to the transport agreement between a Customer and a Driver.</p>
      <h2>2. Accounts</h2>
      <p>You must be at least 18 and give accurate information. You are responsible for activity on your account. One person, one account.</p>
      <h2>3. Orders, prices and payment</h2>
      <p>Customers set or accept a price. A Driver may accept it or make one counter-offer, and the Customer may make one counter-offer. When a Driver confirms an order, the Customer’s card is charged the agreed price, the {v.fee}% service fee and any cargo insurance. Payments are processed by Stripe. Drivers receive the agreed price minus the {v.dfee}% platform fee after delivery.</p>
      <h2>4. Cancellation</h2>
      <p>Customer cancellations are free before a Driver confirms. After confirmation: more than {v.late} hours before loading, 5% of the price goes to the Driver and 5% to {v.brand}; less than {v.late} hours before loading or after the Driver has set off, 30% to the Driver and 10% to {v.brand}; if the Driver arrives and the item is not available, 40% to the Driver and 10% to {v.brand}. The service fee is not refunded after confirmation. If a Driver cancels, the Customer is refunded in full.</p>
      <h2>5. Drivers</h2>
      <p>Drivers are independent contractors, not employees or agents of {v.brand}. Drivers are responsible for their vehicle, licences, permits, insurance, taxes and for the safe handling of items in their care. Drivers must keep valid insurance that covers paid deliveries and must stop taking jobs when it lapses.</p>
      <h2>6. Items</h2>
      <p>Customers must describe items accurately, declare their value honestly, package them adequately and not send prohibited items (see Safety). Drivers may refuse items that do not match the description or are unsafe.</p>
      <h2>7. Communication and off-platform dealings</h2>
      <p>Users must communicate and pay through {v.brand}. Arranging jobs off the platform with users met on {v.brand} is not allowed and removes payment protection.</p>
      <h2>8. Liability</h2>
      <p>To the extent permitted by law, {v.brand} is not liable for loss of or damage to items, delays, or the acts of users. Claims for loss or damage are made against the Driver’s insurance or the cargo insurance purchased with the order. {v.brand} may help resolve disputes and may hold or reverse payments for disputed orders.</p>
      <h2>9. Suspension</h2>
      <p>We may suspend accounts for fraud, safety concerns, repeated cancellations, expired insurance or breach of these terms.</p>
      <h2>10. Law</h2>
      <p>These terms are governed by the laws of the Province of Alberta and the federal laws of Canada that apply there.</p>
      <h2>11. Contact</h2>
      <p><a href={`mailto:${v.email}`}>{v.email}</a></p>
    </>
  ),
  privacy: (v) => (
    <>
      <h1>Privacy Policy</h1>
      <Draft />
      <p>{v.brand} handles personal information in line with Canada’s Personal Information Protection and Electronic Documents Act (PIPEDA) and applicable provincial law.</p>
      <h2>What we collect</h2>
      <ul>
        <li>All users: phone number, name, email, language, ratings, messages in order chats, notification settings.</li>
        <li>Customers: pickup and drop-off addresses, item descriptions and photos, recipient name and phone. Card details are collected and stored by Stripe; we keep only the card brand and last four digits.</li>
        <li>Drivers: legal name, date of birth, address, vehicle details, licence, registration, insurance documents, criminal record check, ID and selfie check results (performed by Stripe), payout account (held by Stripe), location while a job is active, and SIN or business number for tax reporting (encrypted).</li>
      </ul>
      <h2>Why</h2>
      <p>To run the marketplace: verify drivers, match orders and trips, process payments and payouts, send confirmations and alerts, prevent fraud, resolve disputes, and meet legal duties such as reporting drivers’ earnings to the Canada Revenue Agency.</p>
      <h2>Who we share it with</h2>
      <p>The other party to an order (only what is needed for the job, for example addresses after confirmation), and service providers acting for us: Stripe (payments, payouts, identity checks), Twilio (SMS), our email provider, cloud hosting and storage in Canada where available, and the Canada Revenue Agency as required by law. We do not sell personal information.</p>
      <h2>How long we keep it</h2>
      <p>For as long as the account is active and afterwards as long as needed for legal, tax and dispute purposes (generally up to 7 years for payment and tax records).</p>
      <h2>Your choices</h2>
      <p>You can access and correct your information, switch off route-alert emails and browser notifications in your account, and ask us to delete your account. Write to <a href={`mailto:${v.email}`}>{v.email}</a>.</p>
      <h2>Cookies and storage</h2>
      <p>We store your sign-in token and language in your browser. We do not use advertising trackers.</p>
    </>
  ),
};

const RU: Record<Page, (v: V) => ReactNode> = {
  drive: (v) => (
    <>
      <h1>Возите с {v.brand}: получайте деньги за поездки, которые вы и так делаете</h1>
      <p className="lead">Укажите маршрут, по которому едете. Мы покажем грузы по пути и сообщим тем, кому нужно что-то отправить по этому направлению, что вы едете. Когда ехать — решаете вы, груз находим мы.</p>
      <div className="row"><Link to={v.driveTo} className="btn primary">Подать анкету</Link><Link to="/loads" className="btn">Открытые грузы</Link></div>
      <h2>Сколько вы получаете</h2>
      <p>Вам остаётся {100 - v.dfee}% согласованной цены. Комиссия платформы — {v.dfee}%. Выплаты приходят на банковский счёт через Stripe после каждой доставки.</p>
      <h2>Два уровня</h2>
      <ul>
        <li><b>Basic</b>: личный полис с дополнением на доставку. Заказы по городу и межгород со стоимостью груза до $1 000 (до $5 000, если клиент купил страховку груза).</li>
        <li><b>Pro</b>: коммерческий автополис и полис на груз. Вы видите новые заказы первыми (около 2–3 минут по городу, 30 минут по межгороду) и берёте грузы до лимита своего полиса.</li>
      </ul>
      <h2>Что нужно</h2>
      <ul>
        <li>Действующие права и регистрация машины</li>
        <li>Страховка, покрывающая платные доставки (дополнение на доставку или коммерческий полис)</li>
        <li>Справка о несудимости</li>
        <li>Документ с фото и селфи (проверяет Stripe) и банковский счёт для выплат</li>
        <li>SIN или номер бизнеса до первой выплаты: каждая платформа обязана ежегодно сообщать в CRA о доходах водителей</li>
      </ul>
      <h2>Как проходит заказ</h2>
      <ol>
        <li>Возьмите груз по его цене или предложите свою; клиент может сделать одно встречное предложение.</li>
        <li>Когда вы подтвердили, с карты клиента списываются деньги. Заберите груз и сфотографируйте его.</li>
        <li>Отдайте груз, когда получатель назовёт правильный PIN. Выплата начинается сразу.</li>
      </ol>
      <p className="small muted">Водители — независимые подрядчики. Вы сами решаете, какие заказы брать, и отвечаете за свою машину, страховку, разрешения и налоги.</p>
    </>
  ),
  how: (v) => (
    <>
      <h1>Как работает {v.brand}</h1>
      <h2>Для тех, кто отправляет</h2>
      <ol>
        <li><b>Найдите поездку или разместите заказ.</b> Укажите откуда, куда и окно погрузки. Вы увидите водителей, которые уже едут по этому маршруту, время выезда и когда они будут в каждом городе.</li>
        <li><b>Договоритесь о цене.</b> Согласитесь с рекомендованной ценой или назовите свою. Водитель принимает или предлагает другую цену; у каждой стороны одно встречное предложение.</li>
        <li><b>Оплата.</b> Карта добавляется при регистрации. Пока вы ждёте, ничего не списывается; деньги списываются в момент, когда водитель подтвердил заказ.</li>
        <li><b>Погрузка и доставка.</b> Водитель фотографирует груз при погрузке. Получатель получает PIN по SMS, и водитель отдаёт груз только по этому коду.</li>
        <li><b>Оповещения о маршруте.</b> На вашем маршруте пока нет водителя? Нажмите «Сообщить мне»: пришлём письмо и уведомление в браузере, как только кто-то опубликует поездку через ваши города.</li>
      </ol>
      <h2>Для водителей</h2>
      <ol>
        <li>Подайте анкету и пройдите проверку (права, регистрация, страховка, проверка документа, справка о несудимости).</li>
        <li>Опубликуйте поездку: откуда, города по пути, куда и время выезда.</li>
        <li>Мы подберём грузы по пути и сообщим отправителям на этом маршруте. О новых грузах вы узнаете из уведомлений.</li>
      </ol>
      <h2>Всё общение — на {v.brand}</h2>
      <p>Телефоны, email и ссылки в чате скрываются. Так для обеих сторон работают защита оплаты, страховка и разбор споров.</p>
    </>
  ),
  pricing: (v) => (
    <>
      <h1>Цены и комиссии</h1>
      <h2>Для клиентов</h2>
      <ul>
        <li><b>Цена водителю</b> — та, о которой вы договорились. Мы предлагаем цену по размеру и расстоянию; попутные поездки обычно дешевле.</li>
        <li><b>Сервисный сбор: {v.fee}%</b> от цены водителю, списывается вместе с заказом.</li>
        <li><b>Страховка груза (по желанию): {v.ins}%</b> от объявленной стоимости, минимум {v.insMin}. Доступна при любой стоимости, даже $20.</li>
      </ul>
      <h2>Для водителей</h2>
      <p>Комиссия платформы <b>{v.dfee}%</b> от согласованной цены. Остальное вы получаете после доставки.</p>
      <h2>Отмена клиентом</h2>
      <table className="table">
        <tbody>
          <tr><td>До подтверждения водителем</td><td>Бесплатно</td></tr>
          <tr><td>После подтверждения, больше чем за {v.late} ч до погрузки</td><td>5% водителю, 5% платформе</td></tr>
          <tr><td>Меньше чем за {v.late} ч до погрузки или водитель уже выехал</td><td>30% водителю, 10% платформе</td></tr>
          <tr><td>Водитель приехал, а груза нет</td><td>40% водителю, 10% платформе</td></tr>
        </tbody>
      </table>
      <p>После подтверждения сервисный сбор {v.fee}% не возвращается. Всё остальное вернётся на карту.</p>
      <h2>Если отказался водитель</h2>
      <p>Деньги возвращаются полностью, заказ снова видят другие водители.</p>
    </>
  ),
  safety: (v) => (
    <>
      <h1>Безопасность и страховка</h1>
      <h2>Кто везёт</h2>
      <p>Каждый водитель проходит проверку документа с фото и селфи (Stripe Identity), загружает права, регистрацию машины, страховой полис и справку о несудимости. Наша команда проверяет каждый документ до первого заказа. Истёкшая страховка автоматически ставит аккаунт на паузу.</p>
      <h2>Защита во время заказа</h2>
      <ul>
        <li>Фото груза при погрузке и доставке сохраняются в заказе.</li>
        <li>Груз отдаётся только по PIN-коду получателя.</li>
        <li>Клиент видит, где водитель, пока заказ выполняется.</li>
        <li>После доставки стороны оценивают друг друга.</li>
      </ul>
      <h2>Страховка</h2>
      <p>Водители страхуются сами: Basic — полисом, покрывающим доставки, Pro — коммерческим автополисом и полисом на груз. Клиент может добавить страховку груза к любому заказу. {v.brand} — площадка и сама грузы не перевозит.</p>
      <h2>Что нельзя отправлять</h2>
      <p>Опасные грузы (взрывчатые вещества, легковоспламеняющиеся жидкости, газовые баллоны, едкие вещества), оружие и боеприпасы, незаконные предметы, каннабис и алкоголь, рецептурные лекарства, наличные, живых животных, останки и всё, что водителю запрещено перевозить по закону.</p>
      <h2>Проблемы</h2>
      <p>Нажмите «Сообщить о проблеме» на странице заказа или напишите на <a href={`mailto:${v.email}`}>{v.email}</a>. На время разбора оплата по спорному заказу может быть задержана.</p>
    </>
  ),
  faq: (v) => (
    <>
      <h1>Вопросы</h1>
      <h3>Когда списываются деньги?</h3><p>Когда водитель подтвердил заказ. Разместить заказ — бесплатно.</p>
      <h3>Что если заказ никто не возьмёт?</h3><p>Если водитель не подтвердит заказ до конца окна погрузки, заказ закроется и ничего не спишется.</p>
      <h3>Можно поговорить с водителем по телефону?</h3><p>Используйте чат на странице заказа. Контакты скрываются, чтобы работали защита оплаты и страховка.</p>
      <h3>Застрахован ли мой груз?</h3><p>Его покрывает полис водителя в пределах лимитов. Для надёжности добавьте страховку груза: {v.ins}% от объявленной стоимости, минимум {v.insMin}.</p>
      <h3>В каких городах вы работаете?</h3><p>По всей Канаде: доставка по городу, межгород и между провинциями. Наличие водителей зависит от маршрута; оповещения сообщат, когда водитель появится.</p>
      <h3>Я водитель. Нужны ли коммерческие права?</h3><p>Для большинства легковых, внедорожников, пикапов и фургонов достаточно обычных прав. Для тяжёлых машин и коммерческих поездок между провинциями может понадобиться сертификат безопасности перевозчика; проверьте правила своей провинции.</p>
      <h3>Зачем водителям указывать SIN или BN?</h3><p>Закон Канады обязывает платформы ежегодно сообщать в CRA о доходах продавцов. Без этого мы обязаны задерживать выплаты.</p>
    </>
  ),
  terms: (v) => (
    <>
      <h1>Условия использования</h1>
      <Draft ru />
      <p className="small muted">Юридически действующей будет английская версия; это перевод для удобства.</p>
      <h2>1. Что такое {v.brand}</h2>
      <p>{v.brand} — онлайн-площадка, которая соединяет тех, кому нужно перевезти вещи («Клиенты»), с независимыми водителями («Водители»). {v.brand} не перевозит грузы, не является перевозчиком, экспедитором или страховщиком и не является стороной договора перевозки между Клиентом и Водителем.</p>
      <h2>2. Аккаунты</h2>
      <p>Пользователю должно быть не меньше 18 лет, данные должны быть достоверными. Вы отвечаете за действия в своём аккаунте. Один человек — один аккаунт.</p>
      <h2>3. Заказы, цены и оплата</h2>
      <p>Клиент назначает или принимает цену. Водитель может принять её или сделать одно встречное предложение, Клиент — тоже одно. Когда Водитель подтверждает заказ, с карты Клиента списываются согласованная цена, сервисный сбор {v.fee}% и страховка груза, если она выбрана. Платежи обрабатывает Stripe. Водитель получает согласованную цену за вычетом комиссии {v.dfee}% после доставки.</p>
      <h2>4. Отмена</h2>
      <p>До подтверждения Водителем отмена бесплатна. После подтверждения: больше чем за {v.late} ч до погрузки — 5% цены Водителю и 5% {v.brand}; меньше чем за {v.late} ч или после выезда Водителя — 30% Водителю и 10% {v.brand}; если Водитель приехал, а груза нет — 40% Водителю и 10% {v.brand}. После подтверждения сервисный сбор не возвращается. Если отказывается Водитель, Клиенту возвращаются все деньги.</p>
      <h2>5. Водители</h2>
      <p>Водители — независимые подрядчики, а не сотрудники или агенты {v.brand}. Водители отвечают за свою машину, права, разрешения, страховку, налоги и сохранность груза. Водитель обязан иметь действующую страховку, покрывающую платные доставки, и прекратить брать заказы, когда она истекла.</p>
      <h2>6. Грузы</h2>
      <p>Клиент обязан точно описать груз, честно указать его стоимость, надёжно упаковать и не отправлять запрещённые предметы. Водитель может отказаться от груза, который не совпадает с описанием или небезопасен.</p>
      <h2>7. Общение вне площадки</h2>
      <p>Пользователи общаются и платят только через {v.brand}. Договариваться о заказах вне площадки с пользователями, найденными на {v.brand}, запрещено; такие сделки лишаются защиты оплаты.</p>
      <h2>8. Ответственность</h2>
      <p>В пределах, допустимых законом, {v.brand} не отвечает за утрату или повреждение груза, задержки и действия пользователей. Претензии об утрате или повреждении предъявляются к страховке Водителя или к страховке груза, купленной с заказом. {v.brand} может помогать в разборе споров и задерживать или возвращать платежи по спорным заказам.</p>
      <h2>9. Блокировка</h2>
      <p>Мы можем приостановить аккаунт за мошенничество, угрозу безопасности, частые отмены, истёкшую страховку или нарушение этих условий.</p>
      <h2>10. Право</h2>
      <p>Условия регулируются законами провинции Альберта и применимыми федеральными законами Канады.</p>
      <h2>11. Контакты</h2>
      <p><a href={`mailto:${v.email}`}>{v.email}</a></p>
    </>
  ),
  privacy: (v) => (
    <>
      <h1>Политика конфиденциальности</h1>
      <Draft ru />
      <p className="small muted">Юридически действующей будет английская версия; это перевод для удобства.</p>
      <p>{v.brand} обрабатывает персональные данные по канадскому закону PIPEDA и применимым законам провинций.</p>
      <h2>Что мы собираем</h2>
      <ul>
        <li>Все пользователи: телефон, имя, email, язык, оценки, сообщения в чатах заказов, настройки уведомлений.</li>
        <li>Клиенты: адреса погрузки и доставки, описание и фото груза, имя и телефон получателя. Данные карты собирает и хранит Stripe; у нас — только тип карты и последние 4 цифры.</li>
        <li>Водители: полное имя, дата рождения, адрес, данные машины, права, регистрация, страховые документы, справка о несудимости, результат проверки документа и селфи (проводит Stripe), счёт для выплат (хранится в Stripe), местоположение во время активного заказа, SIN или номер бизнеса для налоговой отчётности (в зашифрованном виде).</li>
      </ul>
      <h2>Зачем</h2>
      <p>Чтобы работала площадка: проверять водителей, подбирать заказы и поездки, проводить платежи и выплаты, отправлять подтверждения и оповещения, предотвращать мошенничество, разбирать споры и выполнять требования закона, например отчитываться в CRA о доходах водителей.</p>
      <h2>Кому передаём</h2>
      <p>Другой стороне заказа (только то, что нужно для работы, например адреса после подтверждения) и подрядчикам, работающим от нашего имени: Stripe (платежи, выплаты, проверка личности), Twilio (SMS), почтовому сервису, облачному хостингу и хранилищу (в Канаде, где это возможно), а также CRA по требованию закона. Мы не продаём персональные данные.</p>
      <h2>Сколько храним</h2>
      <p>Пока аккаунт активен, а затем столько, сколько нужно для юридических, налоговых целей и разбора споров (обычно до 7 лет для платёжных и налоговых записей).</p>
      <h2>Ваши права</h2>
      <p>Вы можете получить и исправить свои данные, отключить письма-оповещения и уведомления в браузере в профиле, попросить удалить аккаунт. Пишите на <a href={`mailto:${v.email}`}>{v.email}</a>.</p>
      <h2>Cookies и хранилище</h2>
      <p>В браузере хранятся токен входа и язык. Рекламных трекеров нет.</p>
    </>
  ),
};
