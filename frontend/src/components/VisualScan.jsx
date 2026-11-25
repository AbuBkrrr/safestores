import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { mediaUrl } from '../utils/media.js';
import { lookOf, packLook, rankProducts, isConfident } from '../utils/visualMatch.js';

/**
 * Point the phone/till camera at an item (held up or on the counter) and tap
 * the picture: the item is recognised from how it looks — no barcode needed.
 * Sure matches are added straight away; otherwise the cashier taps one of the
 * best guesses, or searches, and the picture teaches the app for next time.
 */
export default function VisualScan({ storeId, products, onPick }) {
  const { t } = useTranslation();
  const videoRef = useRef();
  const [looks, setLooks] = useState([]);
  const [guesses, setGuesses] = useState(null); // [{ productId, score }]
  const [pendingLook, setPendingLook] = useState(null);
  const [search, setSearch] = useState('');
  const [note, setNote] = useState('');
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  useEffect(() => {
    api.get(`/stores/${storeId}/product-looks`).then((r) => setLooks(Array.isArray(r.data) ? r.data : [])).catch(() => {});
    let stream;
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 640 } } }).then((s) => {
      stream = s;
      if (videoRef.current) videoRef.current.srcObject = s;
    }).catch(() => setNote(t('visualScan.cameraError')));
    return () => stream?.getTracks().forEach((tr) => tr.stop());
  }, [storeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const teach = (productId, look) => {
    if (!look) return;
    const sig = packLook(look);
    setLooks((l) => [{ product_id: productId, sig }, ...l]);
    api.post(`/stores/${storeId}/products/${productId}/looks`, { sig }).catch(() => {});
  };

  const pick = (productId, look = pendingLook) => {
    onPick(productId);
    teach(productId, look);
    setGuesses(null); setPendingLook(null); setSearch('');
  };

  const capture = () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const look = lookOf(v);
    const ranked = rankProducts(look, looks.filter((l) => byId.has(l.product_id)));
    if (isConfident(ranked)) {
      const p = byId.get(ranked[0].productId);
      setNote(t('visualScan.added', { name: p.name }));
      pick(ranked[0].productId, look);
      return;
    }
    setPendingLook(look);
    setGuesses(ranked.filter((r) => r.score > 0.55));
    setNote(looks.length ? '' : t('visualScan.teachFirst'));
  };

  const found = search.trim().length >= 2
    ? products.filter((p) => p.name.toLowerCase().includes(search.trim().toLowerCase())).slice(0, 6) : [];

  return (
    <div className="mt-1">
      <div style={{ position: 'relative' }}>
        <video ref={videoRef} autoPlay playsInline muted onClick={capture}
          style={{ width: '100%', borderRadius: 8, background: '#000', maxHeight: 260, objectFit: 'cover', cursor: 'pointer' }} />
        {/* the square the item should fill */}
        <div style={{ position: 'absolute', inset: '8% 20%', border: '2px dashed rgba(255,255,255,.7)', borderRadius: 8, pointerEvents: 'none' }} />
      </div>
      <button className="btn small mt-1" onClick={capture} style={{ width: '100%' }}>📸 {t('visualScan.capture')}</button>
      <p className="muted small mt-1">{note || t('visualScan.hint')}</p>

      {guesses && (
        <div className="card mt-1">
          <strong>{guesses.length ? t('visualScan.isItOneOf') : t('visualScan.notRecognised')}</strong>
          <div className="flex mt-1" style={{ flexWrap: 'wrap', gap: 8 }}>
            {guesses.map((g) => {
              const p = byId.get(g.productId);
              return p && (
                <button key={g.productId} className="btn secondary small" onClick={() => pick(g.productId)} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {p.image_url && <img src={mediaUrl(p.image_url)} alt="" style={{ width: 32, height: 32, objectFit: 'cover', borderRadius: 4 }} />}
                  {p.name}
                </button>
              );
            })}
          </div>
          <div className="form-group mt-1">
            <label htmlFor="visual-search">{t('visualScan.searchToTeach')}</label>
            <input id="visual-search" value={search} onChange={(e) => setSearch(e.target.value)} autoComplete="off" />
          </div>
          {found.map((p) => (
            <div key={p.id} style={{ padding: '6px 0', cursor: 'pointer' }} onClick={() => pick(p.id)}>{p.name}</div>
          ))}
          <button className="btn secondary small mt-1" onClick={() => { setGuesses(null); setPendingLook(null); }}>{t('common.cancel')}</button>
        </div>
      )}
    </div>
  );
}
