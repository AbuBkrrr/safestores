import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BrandFooter } from '../components/ui.jsx';

// ------------------------------------------------------------
// Terms of Service, Privacy Policy and open-source licence notices.
//
// IMPORTANT FOR THE OPERATOR: the Terms and Privacy text below is a
// plain-language starting point written to match how this software
// actually handles data. It is not legal advice. Have it reviewed by a
// lawyer for every country you operate in (e.g. Nigeria's NDPA 2023,
// the EU/UK GDPR) before launch. Operator name, contact and governing
// law come from build-time variables so they can be set without code
// changes: VITE_LEGAL_ENTITY, VITE_LEGAL_CONTACT, VITE_LEGAL_COUNTRY.
// ------------------------------------------------------------
const ENTITY = import.meta.env.VITE_LEGAL_ENTITY || 'A I Brains Ventures';
const CONTACT = import.meta.env.VITE_LEGAL_CONTACT || `support@${typeof window !== 'undefined' ? window.location.hostname.replace(/^www\.|^app\./, '') : 'example.com'}`;
const COUNTRY = import.meta.env.VITE_LEGAL_COUNTRY || 'the Federal Republic of Nigeria';
const UPDATED = '8 November 2026';

function Shell({ title, children }) {
  useEffect(() => { document.title = `${title} — SAFE Stores`; }, [title]);
  return (
    <div className="legal">
      <p><Link to="/">← SAFE Stores</Link></p>
      <h1>{title}</h1>
      <p className="muted">Last updated: {UPDATED}</p>
      {children}
      <hr />
      <p className="muted"><Link to="/terms">Terms</Link> · <Link to="/privacy">Privacy</Link> · <Link to="/licenses">Open-source licences</Link></p>
      <BrandFooter />
    </div>
  );
}

export function Terms() {
  return (
    <Shell title="Terms of Service">
      <p>These terms are an agreement between you and {ENTITY} (&quot;we&quot;, &quot;us&quot;) for the use of SAFE Stores — the web app, the Android app and the desktop app (the &quot;Service&quot;). By creating an account or using the Service you agree to them. If you use it for a business, you confirm you can bind that business.</p>
      <h2>1. Accounts</h2>
      <p>You are responsible for your account and for everyone you invite to your store, and for keeping passwords and invite codes private. Turn on two-factor sign-in for admin accounts. Tell us straight away at {CONTACT} if you think an account has been misused.</p>
      <h2>2. Your data</h2>
      <p>Your store&apos;s data (products, stock, sales, customers) belongs to you. You give us permission to store and process it only to run the Service for you, as described in our <Link to="/privacy">Privacy Policy</Link>. You can export it at any time and close your store from My Account; closed stores are permanently deleted after a 30-day grace period.</p>
      <h2>3. Acceptable use</h2>
      <p>Do not use the Service to break the law, sell prohibited goods, send spam, collect people&apos;s data without a lawful basis, or try to access other stores&apos; data or disrupt the Service. You are responsible for the products you list, the prices you charge, the taxes you collect and remit, and the receipts you issue.</p>
      <h2>4. Plans, billing and suspension</h2>
      <p>Paid plans are billed as shown in the app. If a charge stays unpaid after its grace period your store may be locked until it is paid; you can still view billing, export your data and close your store. We may suspend accounts that breach these terms.</p>
      <h2>5. Online marketplace and storefronts</h2>
      <p>Orders placed on a store&apos;s storefront are contracts between the shopper and that store. The store is responsible for fulfilment, payment collection, refunds and consumer-law obligations. We provide the software only.</p>
      <h2>6. Lending partners and auditors</h2>
      <p>Lending partners and independent auditors listed in the Service are separate businesses. Any loan or audit is between you and them; we do not lend money, give financial advice or guarantee their services. We only share your data with a partner after you opt in, and you can withdraw consent at any time.</p>
      <h2>7. Availability</h2>
      <p>We work to keep the Service available and your data backed up, and the apps keep working offline, but we cannot promise uninterrupted service. Keep your own exports of important records.</p>
      <h2>8. Liability</h2>
      <p>To the extent the law allows, the Service is provided &quot;as is&quot; and our total liability for any claim is limited to the fees you paid us in the 12 months before it. We are not liable for indirect losses such as lost profits. Nothing here limits liability that cannot be limited by law.</p>
      <h2>9. Changes and ending</h2>
      <p>We may update these terms; we will tell you in the app before material changes take effect. You can stop using the Service and close your store at any time.</p>
      <h2>10. Law</h2>
      <p>These terms are governed by the laws of {COUNTRY}, without affecting any mandatory consumer protections where you live. Contact: {CONTACT}.</p>
    </Shell>
  );
}

export function Privacy() {
  return (
    <Shell title="Privacy Policy">
      <p>This policy explains what personal data SAFE Stores handles, why, and your rights. {ENTITY} is the controller for account data of store owners and staff. For the data a store keeps about its own customers (names, phone numbers, purchases), the store is the controller and we process it on the store&apos;s behalf.</p>
      <h2>What we collect</h2>
      <ul>
        <li><strong>Account data:</strong> name, email, password (stored only as a one-way hash), role, two-factor settings.</li>
        <li><strong>Store data:</strong> products, stock, sales, receipts, suppliers, and the store&apos;s customer records and loyalty points.</li>
        <li><strong>Activity records:</strong> who changed prices, gave refunds or discounts, and similar actions, kept for the store&apos;s accountability.</li>
        <li><strong>Technical data:</strong> IP address and device information in security logs; crash reports if error monitoring is enabled.</li>
        <li><strong>Shoppers:</strong> name, contact details and delivery address you enter when ordering from a storefront.</li>
      </ul>
      <h2>Why we use it</h2>
      <p>To provide the Service you asked for (contract), to keep it secure and prevent fraud (legitimate interest), to send service emails such as password resets and receipts (contract), and to meet legal obligations such as tax records. We do not sell personal data and we do not use advertising trackers.</p>
      <h2>Cookies and storage</h2>
      <p>We use only storage that is necessary for the app to work: your sign-in session, language, theme and the offline copy of your store data on your device. No advertising or analytics cookies are used.</p>
      <h2>Who we share it with</h2>
      <p>Service providers who host or operate parts of the Service for us (hosting, database, email delivery, file storage, crash reporting, payment processing), under contracts that protect your data. Lending partners or auditors only if the store opts in. Authorities where the law requires.</p>
      <h2>International transfers</h2>
      <p>Our providers may store data outside your country. Where they do, we use appropriate safeguards required by law.</p>
      <h2>How long we keep it</h2>
      <p>For as long as your account is active. A closed store is permanently deleted after a 30-day grace period; deleted staff accounts are anonymised immediately. Backups roll off within 35 days. Records we must keep by law (e.g. invoices for our own billing) are kept for the period the law requires.</p>
      <h2>Your rights</h2>
      <p>You can access and download your data (My Account → Download my data, and Export for stores), correct it, delete your account, object to or restrict certain processing, and complain to your data-protection authority (in Nigeria, the Nigeria Data Protection Commission). Shoppers and store customers should contact the store first; we will help the store respond. Contact us at {CONTACT}.</p>
      <h2>Security</h2>
      <p>Passwords are hashed, connections are encrypted, two-factor sign-in is available, sessions can be revoked, and access is limited by role. No system is perfectly secure; we will notify you and the authorities of a breach as the law requires.</p>
      <h2>Children</h2>
      <p>The Service is for businesses and is not directed at children under 16.</p>
    </Shell>
  );
}

export function Licenses() {
  const [data, setData] = useState(null);
  useEffect(() => { fetch('/third-party-licenses.json').then((r) => (r.ok ? r.json() : null)).then(setData).catch(() => setData(null)); }, []);
  return (
    <Shell title="Open-source licences">
      <p>SAFE Stores is built with open-source software. We are grateful to its authors. The packages included in this app and their licences are listed below; each licence permits commercial use and requires its notice to be reproduced, which this page does.</p>
      {!data ? <p className="muted">The licence list is generated when the app is built.</p> : (
        <>
          <p className="muted">{data.packages.length} packages.</p>
          {data.packages.map((p) => (
            <details key={`${p.name}@${p.version}`}>
              <summary><strong>{p.name}</strong> {p.version} — {p.license}</summary>
              {p.homepage && <p className="muted">{p.homepage}</p>}
              {p.notice && <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{p.notice}</pre>}
            </details>
          ))}
        </>
      )}
    </Shell>
  );
}
