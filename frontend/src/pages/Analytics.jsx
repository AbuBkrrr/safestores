import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Doughnut, Bar, Line, PolarArea } from 'react-chartjs-2';
import {
  Chart as ChartJS, ArcElement, BarElement, CategoryScale, LinearScale,
  PointElement, LineElement, RadialLinearScale, Tooltip, Legend,
} from 'chart.js';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useCurrency } from '../context/CurrencyContext.jsx';
import { Metric } from '../components/ui.jsx';

ChartJS.register(ArcElement, BarElement, CategoryScale, LinearScale, PointElement, LineElement, RadialLinearScale, Tooltip, Legend);

const COLORS = ['#0f7180', '#f0b429', '#1f7a4d', '#b33a3a', '#7a5cf0', '#3a8fb3'];

export default function Analytics() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { currency, formatCurrency } = useCurrency();
  const [category, setCategory] = useState([]);
  const [top, setTop] = useState([]);
  const [trends, setTrends] = useState([]);
  const [lowStock, setLowStock] = useState([]);
  const [summary, setSummary] = useState(null);
  const [movementCount, setMovementCount] = useState(null);

  const load = () => {
    const base = `/stores/${user.storeId}/analytics`;
    api.get(`${base}/stock-by-category`).then((r) => setCategory(r.data));
    api.get(`${base}/top-products`).then((r) => setTop(r.data));
    api.get(`${base}/movement-trends?days=30`).then((r) => setTrends(r.data));
    api.get(`${base}/low-stock-distribution`).then((r) => setLowStock(r.data));
    api.get(`${base}/summary`).then((r) => setSummary(r.data));
    // The endpoint itself doesn't return a movement count; the movements
    // list is already sorted/limited server-side (see Dashboard/Movements
    // pages), so its length is a real, if capped-at-500, total.
    api.get(`/stores/${user.storeId}/movements`).then((r) => setMovementCount(r.data.length));
  };
  useEffect(() => { load(); }, [user.storeId]);

  const days = [...new Set(trends.map((t) => t.day))].sort();
  const types = [...new Set(trends.map((t) => t.type))];

  return (
    <div>
      <div className="topbar">
        <h1>{t('analyticsPage.title')}</h1>
        <button className="btn secondary small" onClick={load}>{t('analyticsPage.refreshCharts')}</button>
      </div>

      <div className="grid grid-4">
        <Metric value={summary?.totalProducts ?? '—'} label={t('analyticsPage.totalProducts')} />
        <Metric value={summary ? formatCurrency(summary.totalStockValue) : '—'} label={t('analyticsPage.totalStockValue')} />
        <Metric value={movementCount ?? '—'} label={t('analyticsPage.totalMovements')} />
        <Metric value={category.length || '—'} label={t('analyticsPage.categories')} />
      </div>

      <div className="grid grid-2 mt-2">
        <div className="card">
          <h3 className="mt-1" style={{ marginBottom: 12 }}>{t('analyticsPage.stockByCategory')}</h3>
          <div className="chart-container">
            <Doughnut data={{
              labels: category.map((c) => c.category),
              datasets: [{ data: category.map((c) => c.value), backgroundColor: COLORS }],
            }} options={{ maintainAspectRatio: false }} />
          </div>
        </div>
        <div className="card">
          <h3 className="mt-1" style={{ marginBottom: 12 }}>{t('analyticsPage.topProducts')}</h3>
          <div className="chart-container">
            <Bar data={{
              labels: top.map((t) => t.name),
              datasets: [{ label: t('analyticsPage.stockValueSeries', { symbol: currency.symbol }), data: top.map((t) => t.value), backgroundColor: '#0f7180' }],
            }} options={{ maintainAspectRatio: false }} />
          </div>
        </div>
        <div className="card">
          <h3 className="mt-1" style={{ marginBottom: 12 }}>{t('analyticsPage.movementTrends')}</h3>
          <div className="chart-container">
            <Line data={{
              labels: days.map((d) => new Date(d).toLocaleDateString()),
              datasets: types.map((type, i) => ({
                label: type,
                data: days.map((d) => trends.find((t) => t.day === d && t.type === type)?.total || 0),
                borderColor: COLORS[i % COLORS.length],
                backgroundColor: COLORS[i % COLORS.length],
              })),
            }} options={{ maintainAspectRatio: false }} />
          </div>
        </div>
        <div className="card">
          <h3 className="mt-1" style={{ marginBottom: 12 }}>{t('analyticsPage.lowStockDistribution')}</h3>
          <div className="chart-container">
            <PolarArea data={{
              labels: lowStock.map((l) => l.category),
              datasets: [{ data: lowStock.map((l) => l.count), backgroundColor: COLORS }],
            }} options={{ maintainAspectRatio: false }} />
          </div>
        </div>
      </div>
    </div>
  );
}
