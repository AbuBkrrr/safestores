import { useEffect, useState } from 'react';
import api from '../../api/client.js';
import { Toast } from '../../components/ui.jsx';
import { useToast } from '../../components/useToast.js';

export default function AllUsers() {
  const [users, setUsers] = useState([]);
  const [stores, setStores] = useState([]);
  const [storeFilter, setStoreFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [toast, showToast] = useToast();

  const load = () => {
    const params = {};
    if (storeFilter) params.storeId = storeFilter;
    if (roleFilter) params.role = roleFilter;
    api.get('/super/users', { params }).then((r) => setUsers(r.data));
  };
  useEffect(() => { load(); }, [storeFilter, roleFilter]);
  useEffect(() => { api.get('/super/stores').then((r) => setStores(r.data)); }, []);

  const toggleStatus = async (u) => {
    const next = u.status === 'active' ? 'disabled' : 'active';
    await api.patch(`/super/users/${u.id}`, { status: next });
    showToast(`${u.name} ${next === 'active' ? 'reactivated' : 'disabled'}`, 'success');
    load();
  };

  const remove = async (u) => {
    if (!window.confirm(`Permanently delete ${u.name} (${u.role} at ${u.store_name})?`)) return;
    try {
      await api.delete(`/super/users/${u.id}`);
      showToast('User deleted', 'success');
      load();
    } catch (err) {
      showToast(err.response?.data?.error || 'Failed to delete user', 'error');
    }
  };

  const roles = Array.from(new Set(users.map((u) => u.role))).sort();

  return (
    <div>
      <div className="topbar"><h1>👥 All Users</h1></div>
      <div className="card">
        <div className="grid grid-2">
          <div className="form-group">
            <label>Store</label>
            <select value={storeFilter} onChange={(e) => setStoreFilter(e.target.value)}>
              <option value="">All stores</option>
              {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label>Role</label>
            <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}>
              <option value="">All roles</option>
              {roles.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
        </div>
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Store</th><th>Status</th><th>Joined</th><th></th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td>{u.email || '—'}</td>
                <td style={{ textTransform: 'capitalize' }}>{u.role.replace(/_/g, ' ')}</td>
                <td>{u.store_name}</td>
                <td>{u.status === 'active' ? '🟢 Active' : '⚪ Disabled'}</td>
                <td>{new Date(u.created_at).toLocaleDateString()}</td>
                <td className="flex">
                  <button className="btn secondary small" onClick={() => toggleStatus(u)}>
                    {u.status === 'active' ? 'Disable' : 'Reactivate'}
                  </button>
                  <button className="btn danger small" onClick={() => remove(u)}>Delete</button>
                </td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 20 }}>No users match this filter.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <Toast {...(toast || {})} />
    </div>
  );
}
