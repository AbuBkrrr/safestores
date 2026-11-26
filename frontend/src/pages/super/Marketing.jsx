import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import api from '../../api/client.js';
import { Metric, Toast } from '../../components/ui.jsx';
import { useToast } from '../../components/useToast.js';

// Super Admin → Marketing: tracking links / QR codes per channel, whether a
// link is being reopened by the same phone or passed on to new people, who
// they are (country, phone, app they opened it in), leads, sign-ups, and
// tools to reach more shops in their own language.

const CHANNELS = [
  ['whatsapp', 'WhatsApp'], ['facebook', 'Facebook'], ['instagram', 'Instagram'], ['tiktok', 'TikTok'], ['x', 'X (Twitter)'],
  ['linkedin', 'LinkedIn'], ['telegram', 'Telegram'], ['youtube', 'YouTube'], ['email', 'Email'], ['sms', 'SMS'],
  ['flyer', 'Flyer / QR'], ['poster', 'Poster / banner'], ['event', 'Event / market visit'], ['radio', 'Radio / TV'], ['partner', 'Partner / agent'], ['other', 'Other'],
];
const PITCH = {
  en: 'Run your shop from your phone: sell, track stock and staff, even with no internet. Free to start 👉',
  fr: 'Gérez votre boutique depuis votre téléphone : ventes, stock et personnel, même sans internet. Gratuit pour commencer 👉',
  ha: 'Gudanar da shagonka daga wayarka: sayarwa, kaya da ma’aikata, ko babu intanet. Fara kyauta 👉',
  ig: 'Jiri ekwentị gị jikwaa ụlọ ahịa gị: ree ahịa, soro ngwaahịa na ndị ọrụ, ọbụna na-enweghị ịntanetị. Malite n’efu 👉',
  yo: 'Ṣe àkóso ṣọ́ọ̀bù rẹ láti orí fóònù: títà, ọjà àti òṣìṣẹ́, kódà láìsí ayélujára. Bẹ̀rẹ̀ lọ́fẹ̀ẹ́ 👉',
  sw: 'Endesha duka lako kwa simu: uza, fuatilia bidhaa na wafanyakazi, hata bila intaneti. Anza bure 👉',
  ar: 'أدر متجرك من هاتفك: البيع والمخزون والموظفين، حتى بدون إنترنت. ابدأ مجاناً 👉',
  zh: '用手机管理你的店铺：销售、库存和员工，即使没有网络也能用。免费开始 👉',
};
const LANGS = { en: 'English', fr: 'Français', ha: 'Hausa', ig: 'Igbo', yo: 'Yorùbá', sw: 'Kiswahili', ar: 'العربية', zh: '中文' };

const when = (d) => (d ? new Date(d).toLocaleString() : '—');
const pct = (a, b) => (b ? `${Math.round((a / b) * 1000) / 10}%` : '—');

function Bars({ title, rows }) {
  const max = Math.max(1, ...rows.map((r) => r.devices));
  return (
    <div className="card">
      <h3 style={{ marginBottom: 8 }}>{title}</h3>
      {rows.length === 0 && <p className="muted small">No opens yet.</p>}
      {rows.map((r) => (
        <div key={r.name} style={{ margin: '6px 0' }}>
          <div className="flex small" style={{ justifyContent: 'space-between' }}><span>{r.name}</span><span className="muted">{r.devices} devices · {r.opens} opens</span></div>
          <div style={{ height: 6, background: 'var(--border, #e5e7eb)', borderRadius: 3 }}><div style={{ width: `${(r.devices / max) * 100}%`, height: 6, background: 'var(--primary, #0f766e)', borderRadius: 3 }} /></div>
        </div>
      ))}
    </div>
  );
}

function shareLinks(url, text) {
  const t = encodeURIComponent(`${text} ${url}`);
  const u = encodeURIComponent(url);
  return [
    ['WhatsApp', `https://wa.me/?text=${t}`], ['Facebook', `https://www.facebook.com/sharer/sharer.php?u=${u}`],
    ['X', `https://twitter.com/intent/tweet?text=${t}`], ['LinkedIn', `https://www.linkedin.com/sharing/share-offsite/?url=${u}`],
    ['Telegram', `https://t.me/share/url?url=${u}&text=${encodeURIComponent(text)}`], ['Email', `mailto:?subject=${encodeURIComponent('SAFE Stores')}&body=${t}`],
    ['SMS', `sms:?&body=${t}`],
  ];
}

export default function Marketing() {
  const [tab, setTab] = useState('overview');
  const [days, setDays] = useState(30);
  const [ov, setOv] = useState(null);
  const [links, setLinks] = useState([]);
  const [opens, setOpens] = useState([]);
  const [openFilter, setOpenFilter] = useState('');
  const [leads, setLeads] = useState([]);
  const [form, setForm] = useState({ label: '', channel: 'whatsapp', target: 'landing' });
  const [qr, setQr] = useState(null); // { link, dataUrl }
  const [lang, setLang] = useState('en');
  const [picked, setPicked] = useState([]);
  const [mail, setMail] = useState({ subject: 'Run your shop with SAFE Stores', body: 'Hello {{name}},\n\nThank you for your interest in SAFE Stores for {{shop}}. You can start free here: {{signup}}\n\nReply to this email or WhatsApp us and we will help you set up.\n' });
  const [toast, showToast] = useToast();
  const [urls, setUrls] = useState({ linkBase: '', landingUrl: '', signupUrl: '', effective: {} });
  useEffect(() => { api.get('/super/marketing/settings').then((r) => setUrls(r.data)).catch(() => {}); }, []);
  const saveUrls = async (e) => {
    e.preventDefault();
    try {
      const r = await api.put('/super/marketing/settings', urls);
      setUrls(r.data); loadAll();
      showToast('Saved — every link and QR code now uses this address', 'success');
    } catch (err) { showToast(err.response?.data?.error || 'Could not save', 'error'); }
  };

  const loadAll = () => {
    api.get('/super/marketing/overview', { params: { days } }).then((r) => setOv(r.data)).catch(() => {});
    api.get('/super/marketing/links').then((r) => setLinks(r.data)).catch(() => {});
    api.get('/super/marketing/leads').then((r) => setLeads(r.data)).catch(() => {});
  };
  const loadOpens = () => api.get('/super/marketing/opens', { params: openFilter === 'bots' ? { bots: 1, limit: 200 } : { link: openFilter || undefined, limit: 200 } }).then((r) => setOpens(r.data)).catch(() => {});
  useEffect(() => { loadAll(); const i = setInterval(loadAll, 30000); return () => clearInterval(i); }, [days]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadOpens(); const i = setInterval(loadOpens, 15000); return () => clearInterval(i); }, [openFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  const createLink = async (e) => {
    e.preventDefault();
    try {
      const r = await api.post('/super/marketing/links', form);
      setForm({ ...form, label: '' });
      showToast(`Link ready: ${r.data.url}`, 'success');
      loadAll();
      showQr(r.data);
    } catch (err) { showToast(err.response?.data?.error || 'Could not create the link', 'error'); }
  };
  const showQr = async (l) => setQr({ link: l, dataUrl: await QRCode.toDataURL(l.url, { width: 640, margin: 2, errorCorrectionLevel: 'M' }) });
  const archive = async (l) => { await api.delete(`/super/marketing/links/${l.id}`); loadAll(); };
  const copy = (text) => navigator.clipboard?.writeText(text).then(() => showToast('Copied', 'success'));
  const setLead = async (l, patch) => {
    const r = await api.patch(`/super/marketing/leads/${l.id}`, patch);
    setLeads((list) => list.map((x) => (x.id === l.id ? { ...x, ...r.data } : x)));
  };
  const sendMail = async () => {
    try {
      const r = await api.post('/super/marketing/outreach/email', { leadIds: picked, ...mail });
      showToast(`Sent ${r.data.sent} email(s)${r.data.skipped ? `, skipped ${r.data.skipped} (no email, no consent or unsubscribed)` : ''}`, 'success');
      setPicked([]); loadAll();
    } catch (err) { showToast(err.response?.data?.error || 'Could not send', 'error'); }
  };
  const downloadCsv = async () => {
    const r = await api.get('/super/marketing/leads.csv', { responseType: 'blob' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(r.data); a.download = 'safestores-leads.csv'; a.click();
  };

  const T = ov?.totals || {};
  const tracked = useMemo(() => links.filter((l) => l.id), [links]);

  return (
    <div>
      <Toast {...(toast || {})} />
      <div className="topbar">
        <div className="page-title"><h1>📣 Marketing</h1><div className="sub">Who opened your links, whether they were passed on, and who signed up</div></div>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period" style={{ width: "auto" }}>
          {[7, 30, 90, 365].map((d) => <option key={d} value={d}>Last {d} days</option>)}
        </select>
      </div>

      <div className="flex" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        {[['overview', '📊 Overview'], ['links', '🔗 Links & QR codes'], ['opens', '👀 Recent opens'], ['leads', `🧲 Leads (${leads.length})`], ['reach', '🌍 Reach more shops']].map(([k, l]) => (
          <button key={k} className={`btn small ${tab === k ? '' : 'secondary'}`} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      {tab === 'overview' && (
        <>
          <div className="grid grid-4">
            <Metric value={T.opens ?? '—'} label="Opens" />
            <Metric value={T.devices ?? '—'} label="Different devices" />
            <Metric value={T.repeat_opens ?? '—'} label="Repeat opens (same device)" />
            <Metric value={T.countries ?? '—'} label="Countries" />
            <Metric value={T.leads ?? '—'} label="Leads (asked to be contacted)" />
            <Metric value={T.signups ?? '—'} label={`Store sign-ups (${T.tracked_signups ?? 0} from links)`} />
            <Metric value={T.activated ?? '—'} label="Activated stores" />
            <Metric value={pct(T.signups || 0, T.devices || 0)} label="Devices → sign-up" />
            <Metric value={T.bots ?? '—'} label="🤖 Robots filtered out (previews, scanners)" />
          </div>
          <div className="card mt-1">
            <h3>Same device or shared?</h3>
            <table className="table">
              <thead><tr><th>Link</th><th>Opens</th><th>Different devices</th><th>Repeat opens</th><th>Verdict</th><th>Leads</th><th>Sign-ups</th></tr></thead>
              <tbody>
                {links.map((l) => (
                  <tr key={l.id || 'none'}>
                    <td>{l.label}<div className="muted small">{l.channel}</div></td>
                    <td>{l.opens}</td><td>{l.devices}</td><td>{l.repeat_opens}</td>
                    <td><span className={`badge ${l.devices > 1 ? 'active' : l.opens ? 'pending' : 'closed'}`}>{l.verdict}</span></td>
                    <td>{l.leads}</td><td>{l.signups}{l.active_stores ? ` (${l.active_stores} active)` : ''}</td>
                  </tr>
                ))}
                {links.length === 0 && <tr><td colSpan={7} className="muted">Create a link under “Links &amp; QR codes” to start tracking.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="grid grid-2 mt-1">
            <Bars title="🌍 Countries" rows={ov?.countries || []} />
            <Bars title="📲 Opened in (app / source)" rows={ov?.sources || []} />
            <Bars title="📱 Device type" rows={ov?.devices || []} />
            <Bars title="⚙️ System" rows={ov?.systems || []} />
            <Bars title="🗣️ Language" rows={ov?.languages || []} />
            <div className="card">
              <h3 style={{ marginBottom: 8 }}>🕒 Best time to post (opens by hour, server time)</h3>
              <div className="flex" style={{ alignItems: 'flex-end', gap: 2, height: 90 }}>
                {Array.from({ length: 24 }, (_, h) => {
                  const n = (ov?.hours || []).find((x) => x.hour === h)?.opens || 0;
                  const m = Math.max(1, ...(ov?.hours || []).map((x) => x.opens));
                  return <div key={h} title={`${h}:00 — ${n} opens`} style={{ flex: 1, height: `${(n / m) * 100}%`, minHeight: 2, background: 'var(--primary, #0f766e)', borderRadius: 2 }} />;
                })}
              </div>
              <div className="flex muted small" style={{ justifyContent: 'space-between' }}><span>0h</span><span>12h</span><span>23h</span></div>
            </div>
          </div>
        </>
      )}

      {tab === 'links' && (
        <>
          <form className="card" onSubmit={saveUrls} style={{ marginBottom: 16 }}>
            <h3>Link address</h3>
            <p className="muted small">The web address your links and QR codes use. Change it here (e.g. to your .com.ng domain) and every link updates — including ones already printed, as long as the old address still reaches this server. The domain must already point to this server.</p>
            <div className="grid grid-4">
              <div className="form-group"><label htmlFor="mk-base">Links look like</label><input id="mk-base" value={urls.linkBase} onChange={(e) => setUrls({ ...urls, linkBase: e.target.value })} placeholder={urls.effective?.base || 'https://app.safestores.com.ng'} /></div>
              <div className="form-group"><label htmlFor="mk-land">“Website” links open</label><input id="mk-land" value={urls.landingUrl} onChange={(e) => setUrls({ ...urls, landingUrl: e.target.value })} placeholder={urls.effective?.landing || 'https://safestores.com.ng'} /></div>
              <div className="form-group"><label htmlFor="mk-sign">“Sign-up” links open</label><input id="mk-sign" value={urls.signupUrl} onChange={(e) => setUrls({ ...urls, signupUrl: e.target.value })} placeholder={urls.effective?.signup || 'https://app.safestores.com.ng/signup'} /></div>
              <div className="form-group" style={{ alignSelf: 'end' }}><button className="btn secondary" style={{ width: '100%' }}>Save address</button></div>
            </div>
            <p className="muted small">Now: {urls.effective?.base}/go/… → website {urls.effective?.landing} · sign-up {urls.effective?.signup}</p>
          </form>
          <form className="card" onSubmit={createLink}>
            <h3>New tracking link</h3>
            <p className="muted small">One link per place you share it (a flyer, a WhatsApp group, an ad…) so you can see which one works.</p>
            <div className="grid grid-4">
              <div className="form-group"><label htmlFor="mk-label">Name</label><input id="mk-label" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Flyer – Kano market" required /></div>
              <div className="form-group"><label htmlFor="mk-ch">Channel</label><select id="mk-ch" value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })}>{CHANNELS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
              <div className="form-group"><label htmlFor="mk-t">Opens</label><select id="mk-t" value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })}><option value="landing">Website (with demo form)</option><option value="signup">Straight to sign-up</option></select></div>
              <div className="form-group" style={{ alignSelf: 'end' }}><button className="btn" style={{ width: '100%' }}>Create link + QR</button></div>
            </div>
          </form>
          <div className="card mt-1">
            <table className="table">
              <thead><tr><th>Link</th><th>Address</th><th>Opens</th><th>Devices</th><th>Verdict</th><th></th></tr></thead>
              <tbody>
                {tracked.map((l) => (
                  <tr key={l.id}>
                    <td>{l.label}<div className="muted small">{l.channel} · {l.target === 'signup' ? 'to sign-up' : 'to website'}</div></td>
                    <td><code className="small">{l.url}</code></td>
                    <td>{l.opens}</td><td>{l.devices}</td><td>{l.verdict}</td>
                    <td className="flex" style={{ gap: 6, flexWrap: 'wrap' }}>
                      <button className="btn secondary small" onClick={() => copy(l.url)}>Copy</button>
                      <button className="btn secondary small" onClick={() => showQr(l)}>QR code</button>
                      <button className="btn secondary small" onClick={() => { setOpenFilter(l.code); setTab('opens'); }}>Opens</button>
                      <button className="btn secondary small" onClick={() => archive(l)} title="Stop listing it (the link keeps working)">Hide</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {qr && (
            <div className="card mt-1" style={{ textAlign: 'center' }}>
              <h3>{qr.link.label}</h3>
              <img src={qr.dataUrl} alt={`QR code for ${qr.link.url}`} style={{ width: 260, height: 260 }} />
              <div><code>{qr.link.url}</code></div>
              <div className="flex mt-1" style={{ justifyContent: 'center', gap: 8, flexWrap: 'wrap' }}>
                <a className="btn small" href={qr.dataUrl} download={`qr-${qr.link.code}.png`}>Download QR (print on flyers)</a>
                <select value={lang} onChange={(e) => setLang(e.target.value)} aria-label="Message language">{Object.entries(LANGS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
                {shareLinks(qr.link.url, PITCH[lang]).map(([n, href]) => <a key={n} className="btn secondary small" href={href} target="_blank" rel="noreferrer">{n}</a>)}
              </div>
            </div>
          )}
        </>
      )}

      {tab === 'opens' && (
        <div className="card">
          <div className="flex" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <h3>Recent opens</h3>
            <select value={openFilter} onChange={(e) => setOpenFilter(e.target.value)} aria-label="Link">
              <option value="">All links</option>
              {tracked.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
              <option value="none">(no label)</option>
              <option value="bots">🤖 Robots (not counted)</option>
            </select>
          </div>
          <table className="table">
            <thead><tr><th>When</th><th>Link</th><th>Device</th><th>New or returning</th><th>Phone / system / browser</th><th>Opened in</th><th>Where</th><th>Language</th></tr></thead>
            <tbody>
              {opens.map((o) => (
                <tr key={o.id}>
                  <td className="small">{when(o.created_at)}</td>
                  <td>{o.label}</td>
                  <td><strong>#{o.device_no}</strong>{o.device_key_kind === 'signature' && <span className="muted small" title="No browser id; matched by phone model, screen, time zone and language"> ≈</span>}</td>
                  <td>{o.open_no === 1 ? <span className="badge active">New device</span> : <span className="badge pending">Same device · open #{o.open_no}</span>}</td>
                  <td className="small">{[o.model, o.os, o.browser].filter(Boolean).join(' · ')}<div className="muted">{o.device_type}{o.screen ? ` · ${o.screen}` : ''}</div></td>
                  <td className="small">{o.in_app || (o.referrer ? new URL(o.referrer, 'https://x').hostname : 'Direct / QR')}</td>
                  <td className="small">{o.country || '—'}<div className="muted">{o.timezone}</div></td>
                  <td className="small">{o.language}</td>
                </tr>
              ))}
              {opens.length === 0 && <tr><td colSpan={8} className="muted">No opens yet.</td></tr>}
            </tbody>
          </table>
          <p className="muted small">“Same device” = the same browser came back (it keeps a small random id; no personal data). A forwarded link opened on another phone shows as a new device. A private window, cleared browser data or a different browser on the same phone also shows as new, so treat “Shared” as a strong hint, not proof. “≈” = matched by phone model, screen, time zone and language because the browser blocked the id.</p>
        </div>
      )}

      {tab === 'leads' && (
        <>
          <div className="card">
            <div className="flex" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <h3>Leads from the website form</h3>
              <button className="btn secondary small" onClick={downloadCsv}>⬇️ Download CSV</button>
            </div>
            <table className="table">
              <thead><tr><th></th><th>Who</th><th>Contact</th><th>Wants</th><th>From link</th><th>Device opens</th><th>Status</th><th>Reach out</th></tr></thead>
              <tbody>
                {leads.map((l) => {
                  const wa = (l.phone || '').replace(/[^0-9]/g, '');
                  const hello = encodeURIComponent(`Hello ${l.name}, this is SAFE Stores. Thank you for your interest${l.shop ? ` for ${l.shop}` : ''}. When is a good time to show you how it works?`);
                  return (
                    <tr key={l.id}>
                      <td><input type="checkbox" aria-label={`Select ${l.name}`} checked={picked.includes(l.id)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, l.id] : p.filter((x) => x !== l.id)))} /></td>
                      <td>{l.name}<div className="muted small">{l.shop || '—'} · {l.country || '—'}</div><div className="muted small">{when(l.created_at)}</div></td>
                      <td className="small">{l.phone}<div>{l.email}</div>{!l.consent && <div className="muted">no marketing consent</div>}{l.unsubscribed_at && <div className="muted">unsubscribed</div>}</td>
                      <td className="small">{l.topic}<div className="muted">{(l.message || '').slice(0, 80)}</div></td>
                      <td className="small">{l.label}</td>
                      <td>{l.device_opens ? `${l.device_opens}×` : '—'}</td>
                      <td>
                        <select value={l.status} onChange={(e) => setLead(l, { status: e.target.value })} aria-label="Status">
                          <option value="new">New</option><option value="contacted">Contacted</option><option value="registered">Registered</option><option value="not_interested">Not interested</option>
                        </select>
                      </td>
                      <td className="flex" style={{ gap: 4, flexWrap: 'wrap' }}>
                        {wa && <a className="btn secondary small" href={`https://wa.me/${wa}?text=${hello}`} target="_blank" rel="noreferrer" onClick={() => setLead(l, { contacted: true, status: l.status === 'new' ? 'contacted' : l.status })}>💬</a>}
                        {l.phone && <a className="btn secondary small" href={`tel:${l.phone}`}>📞</a>}
                        {l.email && <a className="btn secondary small" href={`mailto:${l.email}?subject=SAFE%20Stores&body=${hello}`}>✉️</a>}
                      </td>
                    </tr>
                  );
                })}
                {leads.length === 0 && <tr><td colSpan={8} className="muted">No leads yet. They come from the “Talk to us” form on the website.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="card mt-1">
            <h3>Email the selected leads ({picked.length})</h3>
            <p className="muted small">Only leads who ticked “you may contact me”, have an email and have not unsubscribed get it. Each email has an unsubscribe link. Use {'{{name}}'}, {'{{shop}}'} and {'{{signup}}'} (your sign-up link).</p>
            <div className="form-group"><label htmlFor="mk-sub">Subject</label><input id="mk-sub" value={mail.subject} onChange={(e) => setMail({ ...mail, subject: e.target.value })} /></div>
            <div className="form-group"><label htmlFor="mk-body">Message</label><textarea id="mk-body" rows={6} value={mail.body} onChange={(e) => setMail({ ...mail, body: e.target.value })} /></div>
            <button className="btn" disabled={!picked.length} onClick={sendMail}>Send email</button>
          </div>
        </>
      )}

      {tab === 'reach' && (
        <div className="grid grid-2">
          <div className="card">
            <h3>Ready-made messages in 8 languages</h3>
            <p className="muted small">Pick a tracking link, then post the message where shop owners are: WhatsApp groups and status, Facebook market groups, TikTok, trade associations.</p>
            <select value={qr?.link?.code || ''} onChange={(e) => { const l = tracked.find((x) => x.code === e.target.value); if (l) showQr(l); }} aria-label="Link">
              <option value="">Choose a link…</option>{tracked.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
            </select>
            {Object.entries(PITCH).map(([k, text]) => (
              <div key={k} className="mt-1" style={{ borderTop: '1px solid var(--border, #e5e7eb)', paddingTop: 8 }}>
                <strong className="small">{LANGS[k]}</strong>
                <p className="small" dir={k === 'ar' ? 'rtl' : 'ltr'}>{text} {qr?.link?.url || '<link>'}</p>
                <div className="flex" style={{ gap: 6, flexWrap: 'wrap' }}>
                  <button className="btn secondary small" onClick={() => copy(`${text} ${qr?.link?.url || ''}`)}>Copy</button>
                  {qr?.link && shareLinks(qr.link.url, text).slice(0, 3).map(([n, href]) => <a key={n} className="btn secondary small" href={href} target="_blank" rel="noreferrer">{n}</a>)}
                </div>
              </div>
            ))}
          </div>
          <div className="card">
            <h3>A plan that works</h3>
            <ol className="small" style={{ paddingLeft: 18, lineHeight: 1.7 }}>
              <li><strong>One link per place.</strong> A different link for each market, WhatsApp group, ad and partner, so the table shows what works.</li>
              <li><strong>QR on paper.</strong> Print the QR on flyers, receipts and posters at markets; the opens show which area responds.</li>
              <li><strong>Watch “Shared”.</strong> Links that reach many devices are being passed on: put more there. “1 device, opened 5×” is a warm lead — call them.</li>
              <li><strong>Agents and partners.</strong> Give each agent or trade association its own link; pay per activated store (see sign-ups per link).</li>
              <li><strong>Their language.</strong> Use the Language and Countries charts to choose which message to post next.</li>
              <li><strong>Post at the busy hour.</strong> The opens-by-hour chart shows when people look.</li>
              <li><strong>Follow up the same day.</strong> New leads get a WhatsApp in one tap from the Leads tab; mark them Contacted.</li>
              <li><strong>Ads.</strong> For paid ads (Facebook, Google, TikTok), put the tracking link as the ad’s web address to compare cost per sign-up.</li>
            </ol>
          </div>
        </div>
      )}
    </div>
  );
}
