import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useRealtimeEvents, useSocket } from '../context/SocketContext.jsx';
import { Alert, Toast } from '../components/ui.jsx';
import { useToast } from '../components/useToast.js';

const SYNC_EVENTS = ['audit:created', 'product:created', 'product:updated', 'product:deleted'];
const CLAIM_REFRESH_MS = 25 * 1000; // re-announce periodically so the claim doesn't look stale to others
const CLAIM_STALE_MS = 75 * 1000;   // safety-net cleanup if a release message is ever missed
const UNASSIGNED = '__unassigned__';

export default function ShelfAudit() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { socket } = useSocket();
  const [products, setProducts] = useState([]);
  const [audits, setAudits] = useState([]);
  const [locationFilter, setLocationFilter] = useState('');
  const [form, setForm] = useState({
    productId: '', countedQty: '', confidenceSource: 'manual_count', autoAdjust: true,
    area: 'shelf', floorNumber: '', shelfNumber: '', rowNumber: '', zone: '',
  });
  const [error, setError] = useState('');
  const [noEngagement, setNoEngagement] = useState(false);
  const [toast, showToast] = useToast();
  const [activeClaims, setActiveClaims] = useState({}); // productId -> { userId, userName, at }
  const [conflicts, setConflicts] = useState([]);
  const [recountFor, setRecountFor] = useState(null); // conflict object being recounted, or null

  const loadConflicts = () => {
    api.get(`/stores/${user.storeId}/audits/conflicts`).then((r) => setConflicts(r.data)).catch(() => {});
  };

  const load = () => {
    api.get(`/stores/${user.storeId}/products`).then((r) => setProducts(r.data));
    api.get(`/stores/${user.storeId}/audits`).then((r) => setAudits(r.data)).catch((err) => {
      if (err.response?.data?.code === 'NO_ACTIVE_ENGAGEMENT') setNoEngagement(true);
    });
    loadConflicts();
  };
  useEffect(() => { load(); }, [user.storeId]);

  const acceptConflict = async (groupId) => {
    try {
      const { data } = await api.post(`/stores/${user.storeId}/audits/conflicts/${groupId}/accept`);
      showToast(data.resolved ? t('shelfAuditPage.recountAccepted') : t('shelfAuditPage.acceptedWaiting'), 'success');
      loadConflicts();
    } catch (err) {
      showToast(err.response?.data?.error || t('shelfAuditPage.acceptFailed'), 'error');
    }
  };

  const startRecount = (conflict) => {
    setRecountFor(conflict);
    setForm({
      productId: conflict.product_id, countedQty: '', confidenceSource: 'manual_count', autoAdjust: true,
      area: conflict.area, floorNumber: conflict.floor_number || '', shelfNumber: conflict.shelf_number || '',
      rowNumber: conflict.row_number || '', zone: conflict.zone || '',
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  if (noEngagement) {
    return (
      <div>
        <div className="topbar"><h1>{t('shelfAuditPage.title')}</h1></div>
        <div className="card">
          <p>{t('shelfAuditPage.notAvailable')}</p>
          <Link className="btn small mt-1" to="/auditor-tab">{t('shelfAuditPage.goToAuditorTab')}</Link>
        </div>
      </div>
    );
  }

  // If a teammate is counting stock on another device right now, their
  // audit (and any auto-adjustment it makes) shows up here immediately —
  // so "expected" quantities never go stale mid-count.
  useRealtimeEvents(SYNC_EVENTS, (event, payload) => {
    load();
    if (event === 'audit:created' && payload.performed_by !== user.id) {
      showToast(t('shelfAuditPage.teammateCounted', {
        name: payload.product_name || t('shelfAuditPage.aProduct'),
        sign: payload.discrepancy > 0 ? '+' : '',
        discrepancy: payload.discrepancy,
      }), 'info');
    }
  });

  // --- Live "someone's already counting this" signal ------------------
  // Separate from SYNC_EVENTS above: these are ephemeral presence pings,
  // not saved records, so they get their own lightweight socket listener
  // instead of triggering a full reload.
  useEffect(() => {
    if (!socket) return undefined;
    const onClaim = (payload) => {
      if (payload.userId === user.id) return;
      setActiveClaims((c) => ({ ...c, [payload.productId]: { userId: payload.userId, userName: payload.userName, at: Date.now() } }));
    };
    const onRelease = (payload) => {
      setActiveClaims((c) => {
        const next = { ...c };
        for (const [pid, claim] of Object.entries(next)) {
          if (claim.userId === payload.userId && (payload.all || pid === payload.productId)) delete next[pid];
        }
        return next;
      });
    };
    socket.on('section:claim', onClaim);
    socket.on('section:release', onRelease);
    return () => { socket.off('section:claim', onClaim); socket.off('section:release', onRelease); };
  }, [socket, user.id]);

  // Prune claims we haven't heard a refresh for (covers the rare case a
  // disconnect event is delayed) so a stale "Jane is counting this" banner
  // never lingers forever.
  useEffect(() => {
    const t = setInterval(() => {
      setActiveClaims((c) => {
        const next = {};
        for (const [pid, claim] of Object.entries(c)) {
          if (Date.now() - claim.at < CLAIM_STALE_MS) next[pid] = claim;
        }
        return next;
      });
    }, 15000);
    return () => clearInterval(t);
  }, []);

  // Announce which product the current user has selected, so teammates
  // counting at the same time see it's already being worked and pick a
  // different item/section instead of duplicating the count.
  useEffect(() => {
    if (!socket || !form.productId) return undefined;
    const product = products.find((p) => p.id === form.productId);
    const announce = () => socket.emit('section:claim', { productId: form.productId, productName: product?.name, userName: user.name });
    announce();
    const interval = setInterval(announce, CLAIM_REFRESH_MS);
    return () => {
      clearInterval(interval);
      socket.emit('section:release', { productId: form.productId });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, form.productId]);

  // Distinct locations across all products, for splitting stock-taking
  // work by physical section instead of everyone working off one long list.
  const locations = useMemo(() => {
    const set = new Set(products.filter((p) => p.location).map((p) => p.location));
    return Array.from(set).sort();
  }, [products]);

  const visibleProducts = useMemo(() => {
    if (!locationFilter) return products;
    if (locationFilter === UNASSIGNED) return products.filter((p) => !p.location);
    return products.filter((p) => p.location === locationFilter);
  }, [products, locationFilter]);

  const today = new Date().toDateString();
  const countedTodayByProduct = useMemo(() => {
    const map = {};
    for (const a of audits) {
      if (new Date(a.created_at).toDateString() !== today) continue;
      // Keep the most recent count per product (list is already newest-first)
      if (!map[a.product_id]) map[a.product_id] = a;
    }
    return map;
  }, [audits, today]);

  const selected = products.find((p) => p.id === form.productId);
  const selectedClaim = form.productId ? activeClaims[form.productId] : null;
  const selectedCountedToday = form.productId ? countedTodayByProduct[form.productId] : null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      const { data } = await api.post(`/stores/${user.storeId}/audits`, {
        ...form, countedQty: Number(form.countedQty),
        conflictGroupId: recountFor?.conflict_group_id || undefined,
      });
      if (recountFor) {
        showToast(t('shelfAuditPage.recountSubmitted'), 'success');
      } else {
        showToast(data.flaggedForRecount ? t('shelfAuditPage.flaggedForRecount') : (data.discrepancy === 0 ? t('shelfAuditPage.noDiscrepancy') : t('shelfAuditPage.discrepancyRecorded', { count: data.discrepancy })), data.flaggedForRecount ? 'warning' : 'success');
      }
      setRecountFor(null);
      setForm({
        productId: '', countedQty: '', confidenceSource: 'manual_count', autoAdjust: true,
        area: form.area, floorNumber: '', shelfNumber: '', rowNumber: '', zone: '',
      });
      load();
    } catch (err) {
      setError(err.response?.data?.error || t('shelfAuditPage.recordFailed'));
    }
  };

  return (
    <div>
      <div className="topbar"><h1>{t('shelfAuditPage.title')}</h1></div>

      {conflicts.length > 0 && (
        <div className="card" style={{ background: 'var(--offline-bg)', borderColor: '#e6c860' }}>
          <h3 style={{ marginBottom: 12, color: '#a56511' }}>{t('shelfAuditPage.recountNeeded', { count: conflicts.length })}</h3>
          {conflicts.map((c) => {
            const location = c.area === 'shelf'
              ? [c.floor_number && `Floor ${c.floor_number}`, c.shelf_number && `Shelf ${c.shelf_number}`, c.row_number && `Row ${c.row_number}`].filter(Boolean).join(', ') || 'shelf'
              : (c.zone || c.area);
            const latest = c.entries[c.entries.length - 1];
            const iAmLatest = latest.performedBy === user.id;
            const iAlreadyAccepted = c.acceptances.includes(user.id);
            return (
              <div key={c.conflict_group_id} style={{ padding: '10px 0', borderBottom: '1px solid #e6c860' }}>
                <strong>{c.product_name}</strong> {t('shelfAuditPage.at')} {location} — {t('shelfAuditPage.countsDisagree')}
                <ul style={{ margin: '6px 0 6px 20px' }}>
                  {c.entries.map((e) => (
                    <li key={e.id}>{t('shelfAuditPage.countedByAt', { qty: e.countedQty, name: e.performedByName || t('shelfAuditPage.someone'), time: new Date(e.createdAt).toLocaleString() })}</li>
                  ))}
                </ul>
                <p className="muted">{t('shelfAuditPage.recountInstructions')}</p>
                <div className="flex">
                  <button className="btn small" onClick={() => startRecount(c)}>{t('shelfAuditPage.submitRecount')}</button>
                  {!iAmLatest && !iAlreadyAccepted && (
                    <button className="btn secondary small" onClick={() => acceptConflict(c.conflict_group_id)}>
                      {t('shelfAuditPage.acceptAsCorrect', { qty: latest.countedQty })}
                    </button>
                  )}
                  {!iAmLatest && iAlreadyAccepted && <span className="muted">{t('shelfAuditPage.alreadyAccepted')}</span>}
                  {iAmLatest && <span className="muted">{t('shelfAuditPage.waitingOnOthers')}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {recountFor && (
        <Alert type="warning">
          {t('shelfAuditPage.recountingProduct', { name: recountFor.product_name })}
          <button className="btn secondary small" style={{ marginLeft: 12 }} onClick={() => { setRecountFor(null); setForm({ ...form, productId: '', countedQty: '' }); }}>{t('common.cancel')}</button>
        </Alert>
      )}

      <div className="card">
        <div className="form-group" style={{ maxWidth: 360 }}>
          <label>{t('shelfAuditPage.workingSection')}</label>
          <select value={locationFilter} onChange={(e) => setLocationFilter(e.target.value)}>
            <option value="">{t('shelfAuditPage.allLocations', { count: products.length })}</option>
            {locations.map((loc) => (
              <option key={loc} value={loc}>{loc} ({products.filter((p) => p.location === loc).length})</option>
            ))}
            {products.some((p) => !p.location) && (
              <option value={UNASSIGNED}>{t('shelfAuditPage.noLocationSet', { count: products.filter((p) => !p.location).length })}</option>
            )}
          </select>
        </div>
      </div>

      <div className="card">
        <Alert type="error">{error}</Alert>
        <form onSubmit={handleSubmit}>
          <div className="grid grid-2">
            <div className="form-group">
              <label>{t('shelfAuditPage.whereCounting')}</label>
              <select value={form.area} onChange={(e) => setForm({ ...form, area: e.target.value })}>
                <option value="shelf">{t('shelfAuditPage.areaShelf')}</option>
                <option value="backroom">{t('shelfAuditPage.areaBackroom')}</option>
                <option value="warehouse">{t('shelfAuditPage.areaWarehouse')}</option>
              </select>
            </div>
            <div className="form-group">
              <label>{t('shelfAuditPage.product')}</label>
              <select value={form.productId} onChange={(e) => setForm({ ...form, productId: e.target.value })} required>
                <option value="">{t('shelfAuditPage.selectProduct')}</option>
                {visibleProducts.map((p) => {
                  const claim = activeClaims[p.id];
                  const countedToday = countedTodayByProduct[p.id];
                  const tags = [
                    p.location ? `📍 ${p.location}` : null,
                    countedToday ? t('shelfAuditPage.countedTodayBy', { name: countedToday.performed_by_name || t('shelfAuditPage.someone') }) : null,
                    claim ? t('shelfAuditPage.countingNow', { name: claim.userName }) : null,
                  ].filter(Boolean).join(' · ');
                  const systemQty = form.area === 'shelf' ? p.shelf_qty : p.backroom_qty;
                  return (
                    <option key={p.id} value={p.id}>
                      {p.name} ({form.area === 'shelf' ? t('shelfAuditPage.systemSaysShelf', { qty: systemQty }) : t('shelfAuditPage.systemSaysBackroom', { qty: systemQty })}){tags ? ` — ${tags}` : ''}
                    </option>
                  );
                })}
              </select>
            </div>
            <div className="form-group">
              <label>{t('shelfAuditPage.countedQuantity')} {selected && t('shelfAuditPage.expectedQty', { qty: form.area === 'shelf' ? selected.shelf_qty : selected.backroom_qty })}</label>
              <input type="number" value={form.countedQty} onChange={(e) => setForm({ ...form, countedQty: e.target.value })} required />
            </div>
            {form.area === 'shelf' ? (
              <>
                <div className="form-group">
                  <label>{t('shelfAuditPage.floorNumber')}</label>
                  <input value={form.floorNumber} onChange={(e) => setForm({ ...form, floorNumber: e.target.value })} placeholder={t('shelfAuditPage.floorPlaceholder')} />
                </div>
                <div className="form-group">
                  <label>{t('shelfAuditPage.shelfNumber')}</label>
                  <input value={form.shelfNumber} onChange={(e) => setForm({ ...form, shelfNumber: e.target.value })} placeholder={t('shelfAuditPage.shelfPlaceholder')} />
                </div>
                <div className="form-group">
                  <label>{t('shelfAuditPage.rowNumber')}</label>
                  <input value={form.rowNumber} onChange={(e) => setForm({ ...form, rowNumber: e.target.value })} placeholder={t('shelfAuditPage.rowPlaceholder')} />
                </div>
              </>
            ) : (
              <div className="form-group">
                <label>{form.area === 'warehouse' ? t('shelfAuditPage.warehouseZone') : t('shelfAuditPage.backroomSection')}</label>
                <input value={form.zone} onChange={(e) => setForm({ ...form, zone: e.target.value })} placeholder={t('shelfAuditPage.zonePlaceholder')} />
              </div>
            )}
            <div className="form-group">
              <label>{t('shelfAuditPage.confidenceSource')}</label>
              <select value={form.confidenceSource} onChange={(e) => setForm({ ...form, confidenceSource: e.target.value })}>
                <option value="manual_count">{t('shelfAuditPage.manualCount')}</option>
                <option value="staff_estimate">{t('shelfAuditPage.staffEstimate')}</option>
                <option value="camera_scan">{t('shelfAuditPage.cameraScan')}</option>
              </select>
            </div>
            <div className="form-group">
              <label>
                <input type="checkbox" style={{ width: 'auto', marginRight: 8 }}
                  checked={form.autoAdjust} onChange={(e) => setForm({ ...form, autoAdjust: e.target.checked })} />
                {t('shelfAuditPage.autoAdjustLabel')}
              </label>
            </div>
          </div>

          {selectedClaim && (
            <div className="card" style={{ background: 'var(--offline-bg)', borderColor: '#e6c860', marginBottom: 16 }}>
              {t('shelfAuditPage.claimWarning', { name: selectedClaim.userName })}
            </div>
          )}
          {selectedCountedToday && !selectedClaim && (
            <div className="card" style={{ background: '#eef7ee', borderColor: '#8fc98f', marginBottom: 16 }}>
              {t('shelfAuditPage.alreadyCountedToday', {
                name: selectedCountedToday.performed_by_name || t('shelfAuditPage.teammate'),
                time: new Date(selectedCountedToday.created_at).toLocaleTimeString(),
                qty: selectedCountedToday.counted_qty,
              })}
            </div>
          )}

          <button className="btn">{t('shelfAuditPage.submitAudit')}</button>
        </form>
      </div>

      <div className="card">
        <div className="flex" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 className="mt-1" style={{ marginBottom: 12 }}>{t('shelfAuditPage.auditHistory')}</h3>
          <Link className="btn secondary small" to="/audit-report">{t('shelfAuditPage.comprehensiveReport')}</Link>
        </div>
        <table>
          <thead><tr><th>{t('shelfAuditPage.product')}</th><th>{t('shelfAuditPage.area')}</th><th>{t('shelfAuditPage.physicalLocation')}</th><th>{t('shelfAuditPage.productLocation')}</th><th>{t('shelfAuditPage.counted')}</th><th>{t('shelfAuditPage.expected')}</th><th>{t('shelfAuditPage.discrepancy')}</th><th>{t('shelfAuditPage.source')}</th><th>{t('shelfAuditPage.adjusted')}</th><th>{t('shelfAuditPage.countedBy')}</th><th>{t('shelfAuditPage.date')}</th></tr></thead>
          <tbody>
            {audits.map((a) => {
              const physicalLocation = a.area === 'shelf'
                ? [a.floor_number && `Floor ${a.floor_number}`, a.shelf_number && `Shelf ${a.shelf_number}`, a.row_number && `Row ${a.row_number}`].filter(Boolean).join(', ') || '—'
                : (a.zone || '—');
              return (
                <tr key={a.id}>
                  <td>{a.product_name}</td>
                  <td style={{ textTransform: 'capitalize' }}>{a.area === 'backroom' ? t('shelfAuditPage.areaBackroom') : a.area === 'warehouse' ? t('shelfAuditPage.areaWarehouse') : t('shelfAuditPage.areaShelf')}</td>
                  <td>{physicalLocation}</td>
                  <td>{a.location || '—'}</td>
                  <td>{a.counted_qty}</td><td>{a.expected_qty}</td>
                  <td style={{ color: a.discrepancy !== 0 ? '#b33a3a' : 'inherit', fontWeight: a.discrepancy !== 0 ? 700 : 400 }}>
                    {a.discrepancy > 0 ? '+' : ''}{a.discrepancy}
                  </td>
                  <td>{a.confidence_source === 'manual_count' ? t('shelfAuditPage.manualCount') : a.confidence_source === 'staff_estimate' ? t('shelfAuditPage.staffEstimate') : a.confidence_source === 'camera_scan' ? t('shelfAuditPage.cameraScan') : a.confidence_source.replace(/_/g, ' ')}</td>
                  <td>{a.auto_adjusted ? '✅' : '—'}</td>
                  <td>{a.performed_by_name || '—'}</td>
                  <td>{new Date(a.created_at).toLocaleString()}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Toast {...(toast || {})} />
    </div>
  );
}
