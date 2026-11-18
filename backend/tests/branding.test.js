const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin } = require('./helpers/factories');
const { pool } = require('../src/config/db');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4500000000049454e44ae426082', 'hex');

describe('Shop branding', () => {
  it('store sets colours/font/theme and uploads a logo; storefront returns them; bad values and other stores are refused', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    await pool.query('UPDATE stores SET marketplace_enabled = true WHERE id = $1', [store.id]);
    const S = `Bearer ${token}`;

    expect((await request().patch(`/api/stores/${store.id}/marketplace-profile`).set('Authorization', S).send({ brandColor: 'red' })).status).toBe(400);
    expect((await request().patch(`/api/stores/${store.id}/marketplace-profile`).set('Authorization', S).send({ font: 'Comic Sans' })).status).toBe(400);
    const saved = await request().patch(`/api/stores/${store.id}/marketplace-profile`).set('Authorization', S)
      .send({ brandColor: '#aa3366', bgColor: '#fff4e6', font: 'Poppins', theme: 'light' });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ shop_brand_color: '#aa3366', shop_bg_color: '#fff4e6', shop_font: 'Poppins', shop_theme: 'light' });

    const up = await request().post(`/api/stores/${store.id}/branding/logo`).set('Authorization', S)
      .attach('image', PNG, { filename: 'logo.png', contentType: 'image/png' });
    expect(up.status).toBe(200);
    expect(up.body.url).toMatch(/^\/uploads\//);

    const pub = await request().get(`/api/public/stores/${store.id}`);
    expect(pub.body).toMatchObject({ shop_logo_url: up.body.url, shop_brand_color: '#aa3366', shop_font: 'Poppins' });

    // Clearing resets to the default look.
    await request().patch(`/api/stores/${store.id}/marketplace-profile`).set('Authorization', S).send({ logoUrl: '', brandColor: '' });
    const after = await request().get(`/api/public/stores/${store.id}`);
    expect(after.body.shop_logo_url).toBeNull();
    expect(after.body.shop_brand_color).toBeNull();

    const other = await createActiveStoreWithAdmin();
    const cross = await request().post(`/api/stores/${store.id}/branding/logo`).set('Authorization', `Bearer ${other.token}`)
      .attach('image', PNG, { filename: 'x.png', contentType: 'image/png' });
    expect(cross.status).toBe(403);
  });
});
