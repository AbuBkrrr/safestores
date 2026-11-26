import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { Badge, Toast } from '../components/ui.jsx';
import { useToast } from '../components/useToast.js';
import { useStoreProfile } from '../utils/useStoreTier.js';
import { jobTitlesFor } from '../utils/jobTitles.js';

export default function Users() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [users, setUsers] = useState([]);
  const [toast, showToast] = useToast();

  const load = () => api.get(`/stores/${user.storeId}/users`).then((r) => setUsers(r.data));
  const { businessType } = useStoreProfile();
  const canTitle = ['admin', 'manager'].includes(user.role);
  // Titles that keep the person's permissions (same role), so a title change never widens access.
  const titlesFor = (role) => jobTitlesFor(businessType).filter((x) => x.role === role);
  const setTitle = async (u, jobTitle) => {
    await api.patch(`/stores/${user.storeId}/users/${u.id}/title`, { jobTitle });
    setUsers((list) => list.map((x) => (x.id === u.id ? { ...x, job_title: jobTitle } : x)));
  };
  useEffect(() => { load(); }, [user.storeId]);

  const toggleStatus = async (u) => {
    const newStatus = u.status === 'active' ? 'disabled' : 'active';
    await api.patch(`/stores/${user.storeId}/users/${u.id}`, { status: newStatus });
    showToast(t('usersPage.statusChanged', { name: u.name, status: t(`common.status.${newStatus}`) }), 'success');
    load();
  };

  const setPassword = async (u) => {
    const password = prompt(t('usersPage.setPasswordPrompt', { name: u.name }));
    if (!password) return;
    try {
      const { data } = await api.patch(`/stores/${user.storeId}/users/${u.id}/password`, { password });
      showToast(data.message, 'success');
    } catch (err) {
      showToast(err.response?.data?.error || t('common.errorGeneric'), 'error');
    }
  };

  const removeUser = async (id) => {
    if (!confirm(t('usersPage.removeConfirm'))) return;
    await api.delete(`/stores/${user.storeId}/users/${id}`);
    load();
  };

  return (
    <div>
      <div className="topbar"><h1>{t('usersPage.title')}</h1></div>
      <div className="card">
        <table>
          <thead><tr><th>{t('usersPage.name')}</th><th>{t('usersPage.email')}</th><th>{t('usersPage.role')}</th><th>{t('usersPage.status')}</th><th>{t('usersPage.joined')}</th><th></th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td><td>{u.email}</td><td>
                  {canTitle && titlesFor(u.role).length > 1
                    ? (
                      <select value={u.job_title || ''} onChange={(e) => setTitle(u, e.target.value)} aria-label={t('invitesPage.jobTitle')} style={{ width: 'auto' }}>
                        <option value="">{t(`roles.${u.role}`, { defaultValue: u.role })}</option>
                        {titlesFor(u.role).map((x) => <option key={x.key} value={x.key}>{t(`jobTitles.${x.key}`)}</option>)}
                      </select>
                    )
                    : <span className="role-tag">{u.job_title ? t(`jobTitles.${u.job_title}`, { defaultValue: u.job_title }) : t(`roles.${u.role}`, { defaultValue: u.role })}</span>}
                </td>
                <td><Badge status={u.status === 'active' ? 'active' : 'suspended'} /></td>
                <td>{new Date(u.created_at).toLocaleDateString()}</td>
                <td className="flex">
                  {user.role === 'admin' && u.id !== user.id && (
                    <button className="btn small secondary" onClick={() => setPassword(u)}>{t('usersPage.setPassword')}</button>
                  )}
                  {u.role !== 'admin' && (
                    <>
                      <button className="btn small secondary" onClick={() => toggleStatus(u)}>
                        {u.status === 'active' ? t('usersPage.disable') : t('usersPage.enable')}
                      </button>
                      <button className="btn danger small" onClick={() => removeUser(u.id)}>{t('usersPage.remove')}</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Toast {...(toast || {})} />
    </div>
  );
}
