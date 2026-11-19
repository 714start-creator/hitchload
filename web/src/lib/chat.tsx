// Order chat. Contacts are hidden by the server; new messages arrive over the live connection.
import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { useApp } from './app';
import { time } from './format';
import type { Message } from './types';
import { Button, ErrorBox } from './ui';

export function Chat({ orderId, closed }: { orderId: string; closed?: boolean }) {
  const { t, lang, onLive } = useApp();
  const [items, setItems] = useState<Message[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState<unknown>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.messages(orderId).then(setItems).catch(setError);
    return onLive((e) => {
      if (e.type === 'message' && e.data?.orderId === orderId) {
        const m = e.data as Message; // already addressed per recipient: me / them / system
        setItems((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
      }
    });
  }, [orderId, onLive]);

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [items.length]);

  const hidden = items.some((m) => m.contactHidden);
  return (
    <div className="card">
      <div className="label">{t('chat')}</div>
      <div className="chat" ref={list}>
        {items.length === 0 ? <div className="msg sys">{t('chatWarn')}</div> : null}
        {items.map((m) => (
          <div key={m.id} className={`msg ${m.from === 'me' ? 'me' : m.from === 'system' ? 'sys' : ''}`}>
            {m.body.split('[contact hidden]').join(`[${t('contactHidden')}]`)}
            {m.from !== 'system' ? <span className="time">{time(m.createdAt, lang)}</span> : null}
          </div>
        ))}
      </div>
      {hidden ? <div className="notice wait small">{t('chatWarn')}</div> : null}
      {!closed ? (
        <form className="row" onSubmit={async (e) => {
          e.preventDefault();
          if (!text.trim()) return;
          setError(null);
          try {
            const m = await api.sendMessage(orderId, text);
            setItems((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
            setText('');
          } catch (x) {
            setError(x);
          }
        }}>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder={t('chatPh')} aria-label={t('chatPh')} className="grow" maxLength={1000} />
          <Button kind="primary" small type="submit" disabled={!text.trim()}>{t('send')}</Button>
        </form>
      ) : null}
      <ErrorBox error={error} />
    </div>
  );
}
