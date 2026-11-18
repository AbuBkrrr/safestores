import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useCurrency } from '../context/CurrencyContext.jsx';
import { Alert } from '../components/ui.jsx';
import { useStoreProfile } from '../utils/useStoreTier.js';
import { fmtQty } from '../utils/businessTypes.js';

// Production: recipes (ingredients → product: ice-cream, bread) and
// break-downs (animal/carcass → cuts with yield: abattoir, butchery).
export default function Production() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { formatCurrency } = useCurrency();
  const { tools } = useStoreProfile();
  const base = `/stores/${user.storeId}/production`;
  const defaultKind = tools.includes('breakdown') && !tools.includes('production') ? 'breakdown' : 'recipe';
  const canDesign = ['admin', 'manager', 'store_manager'].includes(user.role);
  const [recipes, setRecipes] = useState([]);
  const [runs, setRuns] = useState([]);
  const [products, setProducts] = useState([]);
  const [msg, setMsg] = useState({});
  const [making, setMaking] = useState(null); // { recipe, batches, outputs: {productId: qty} }
  const [form, setForm] = useState(null);

  const load = () => {
    api.get(`${base}/recipes`).then((r) => setRecipes(r.data)).catch(() => {});
    api.get(`${base}/runs`).then((r) => setRuns(r.data)).catch(() => {});
  };
  useEffect(() => { load(); api.get(`/stores/${user.storeId}/products`).then((r) => setProducts(r.data)).catch(() => {}); }, [user.storeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const newForm = () => setForm({ name: '', kind: defaultKind, lines: [{ productId: '', role: 'input', quantity: '' }, { productId: '', role: 'output', quantity: '' }] });
  const setLine = (i, patch) => setForm({ ...form, lines: form.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const saveRecipe = async (e) => {
    e.preventDefault(); setMsg({});
    try { await api.post(`${base}/recipes`, form); setForm(null); setMsg({ type: 'success', text: t('production.saved') }); load(); }
    catch (err) { setMsg({ type: 'error', text: err.response?.data?.error || t('production.failed') }); }
  };
  const startMaking = (r) => setMaking({ recipe: r, batches: '1', outputs: {} });
  const run = async (e) => {
    e.preventDefault(); setMsg({});
    const b = Number(making.batches) || 1;
    const outputs = making.recipe.kind === 'breakdown'
      ? making.recipe.lines.filter((l) => l.role === 'output').map((l) => ({ productId: l.product_id, quantity: making.outputs[l.product_id] ?? Number(l.quantity) * b }))
      : undefined;
    try {
      const { data } = await api.post(`${base}/runs`, { recipeId: making.recipe.id, batches: b, outputs });
      setMaking(null);
      setMsg({ type: 'success', text: data.yieldPct != null && making.recipe.kind === 'breakdown'
        ? t('production.doneYield', { pct: data.yieldPct, cost: formatCurrency(data.inputCost) })
        : t('production.done', { cost: formatCurrency(data.inputCost) }) });
      load();
    } catch (err) { setMsg({ type: 'error', text: err.response?.data?.error || t('production.failed') }); }
  };
  const productById = (id) => products.find((p) => p.id === id);

  return (
    <div>
      <div className="topbar"><div className="page-title"><h1>🏭 {t('production.title')}</h1><div className="sub">{t(defaultKind === 'breakdown' ? 'production.subBreakdown' : 'production.sub')}</div></div>
        {canDesign && !form && <button className="btn" onClick={newForm}>+ {t(defaultKind === 'breakdown' ? 'production.newBreakdown' : 'production.newRecipe')}</button>}</div>
      <Alert type={msg.type}>{msg.text}</Alert>

      {form && (
        <form className="card" onSubmit={saveRecipe}>
          <h3>{t('production.newTitle')}</h3>
          <div className="grid grid-2">
            <div className="form-group"><label htmlFor="rc-name">{t('production.name')}</label><input id="rc-name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t(form.kind === 'breakdown' ? 'production.namePhB' : 'production.namePh')} /></div>
            <div className="form-group"><label htmlFor="rc-kind">{t('production.kind')}</label>
              <select id="rc-kind" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                <option value="recipe">{t('production.kindRecipe')}</option><option value="breakdown">{t('production.kindBreakdown')}</option>
              </select></div>
          </div>
          <p className="muted" style={{ fontSize: 13 }}>{t(form.kind === 'breakdown' ? 'production.linesHelpB' : 'production.linesHelp')}</p>
          {form.lines.map((l, i) => (
            <div key={i} className="flex" style={{ gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
              <select aria-label={t('production.role')} value={l.role} onChange={(e) => setLine(i, { role: e.target.value })}>
                <option value="input">{t('production.in')}</option><option value="output">{t('production.out')}</option>
              </select>
              <select aria-label={t('production.product')} value={l.productId} onChange={(e) => setLine(i, { productId: e.target.value })} style={{ flex: 1, minWidth: 180 }}>
                <option value="">{t('production.chooseProduct')}</option>
                {products.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.unit})</option>)}
              </select>
              <input type="number" step="any" min="0" aria-label={t('production.qty')} placeholder={t('production.qty')} value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} style={{ width: 110 }} />
              <span className="muted" style={{ alignSelf: 'center', minWidth: 40 }}>{productById(l.productId)?.unit || ''}</span>
              {form.lines.length > 2 && <button type="button" className="btn small secondary" onClick={() => setForm({ ...form, lines: form.lines.filter((_, j) => j !== i) })}>✕</button>}
            </div>
          ))}
          <div className="flex" style={{ gap: 8 }}>
            <button type="button" className="btn small secondary" onClick={() => setForm({ ...form, lines: [...form.lines, { productId: '', role: 'input', quantity: '' }] })}>+ {t('production.addInput')}</button>
            <button type="button" className="btn small secondary" onClick={() => setForm({ ...form, lines: [...form.lines, { productId: '', role: 'output', quantity: '' }] })}>+ {t('production.addOutput')}</button>
          </div>
          <div className="flex mt-1" style={{ gap: 8 }}><button className="btn" type="submit">{t('production.save')}</button><button type="button" className="btn secondary" onClick={() => setForm(null)}>{t('common.cancel', { defaultValue: 'Cancel' })}</button></div>
        </form>
      )}

      <div className="card">
        <h3>{t('production.recipes')}</h3>
        {recipes.length === 0 ? <p className="muted">{t('production.noRecipes')}</p> : recipes.map((r) => (
          <div key={r.id} className="card mt-1" style={{ background: 'var(--bg)' }}>
            <div className="flex" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <strong>{r.kind === 'breakdown' ? '🔪' : '🥣'} {r.name}</strong>
              {making?.recipe.id !== r.id && <button className="btn small" onClick={() => startMaking(r)}>{r.kind === 'breakdown' ? t('production.breakDown') : t('production.make')}</button>}
            </div>
            <div className="muted" style={{ fontSize: 13 }}>
              {r.lines.filter((l) => l.role === 'input').map((l) => fmtQty(l.quantity, l) + ' ' + l.name).join(' + ')} → {r.lines.filter((l) => l.role === 'output').map((l) => fmtQty(l.quantity, l) + ' ' + l.name).join(', ')}
            </div>
            {making?.recipe.id === r.id && (
              <form className="mt-1" onSubmit={run}>
                <div className="form-group" style={{ maxWidth: 200 }}><label htmlFor={`mk-${r.id}`}>{r.kind === 'breakdown' ? t('production.howMany') : t('production.batches')}</label>
                  <input id={`mk-${r.id}`} type="number" step="any" min="0" value={making.batches} onChange={(e) => setMaking({ ...making, batches: e.target.value })} /></div>
                {r.kind === 'breakdown' && (
                  <table><thead><tr><th>{t('production.cut')}</th><th>{t('production.expected')}</th><th>{t('production.actual')}</th></tr></thead>
                    <tbody>{r.lines.filter((l) => l.role === 'output').map((l) => {
                      const exp = Number(l.quantity) * (Number(making.batches) || 0);
                      return (<tr key={l.product_id}><td>{l.name}</td><td>{fmtQty(exp, l)}</td>
                        <td><input type="number" step="any" min="0" aria-label={t('production.actualOf', { name: l.name })} value={making.outputs[l.product_id] ?? ''} placeholder={String(exp)} onChange={(e) => setMaking({ ...making, outputs: { ...making.outputs, [l.product_id]: e.target.value } })} style={{ width: 110 }} /> {l.unit}</td></tr>);
                    })}</tbody></table>
                )}
                <p className="muted" style={{ fontSize: 12 }}>{t('production.uses')}: {r.lines.filter((l) => l.role === 'input').map((l) => `${fmtQty(Number(l.quantity) * (Number(making.batches) || 0), l)} ${l.name} (${t('production.inStock', { n: Math.round(Number(l.in_stock) * 1000) / 1000 })})`).join(', ')}</p>
                <div className="flex" style={{ gap: 8 }}><button className="btn" type="submit">✅ {t('production.record')}</button><button type="button" className="btn secondary" onClick={() => setMaking(null)}>{t('common.cancel', { defaultValue: 'Cancel' })}</button></div>
              </form>
            )}
          </div>
        ))}
      </div>

      <div className="card">
        <h3>{t('production.history')}</h3>
        {runs.length === 0 ? <p className="muted">{t('production.noRuns')}</p> : (
          <div style={{ overflowX: 'auto' }}><table>
            <thead><tr><th>{t('production.when')}</th><th>{t('production.name')}</th><th>{t('production.usedCol')}</th><th>{t('production.madeCol')}</th><th>{t('production.cost')}</th><th>{t('production.by')}</th></tr></thead>
            <tbody>{runs.map((r) => {
              const outs = r.lines.filter((l) => l.role === 'output');
              const exp = outs.reduce((s, l) => s + Number(l.expected || 0), 0);
              const act = outs.reduce((s, l) => s + Number(l.quantity || 0), 0);
              return (<tr key={r.id}><td>{new Date(r.created_at).toLocaleString()}</td><td>{r.recipe_name}{r.kind === 'breakdown' && exp > 0 && <div className="muted" style={{ fontSize: 11 }}>{t('production.yield', { pct: Math.round((act / exp) * 1000) / 10 })}</div>}</td>
                <td style={{ fontSize: 12 }}>{r.lines.filter((l) => l.role === 'input').map((l) => `${fmtQty(l.quantity, l)} ${l.name}`).join(', ')}</td>
                <td style={{ fontSize: 12 }}>{outs.map((l) => `${fmtQty(l.quantity, l)} ${l.name}`).join(', ')}</td>
                <td>{formatCurrency(r.input_cost)}</td><td>{r.performed_by_name || '—'}</td></tr>);
            })}</tbody>
          </table></div>
        )}
      </div>
    </div>
  );
}
