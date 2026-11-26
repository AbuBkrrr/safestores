// Job titles each kind of business actually uses (a restaurant has chefs and
// waiters, a repair shop has technicians and a front desk). Each title sits
// on one of the system's permission roles, which decides what the person
// can open and do — so the security rules stay the same, while invites,
// the staff list and each person's home screen speak the business's language.
//
//   role: the permission role behind the title (see backend usersController)
//   home: the shortcuts on that person's dashboard, in order
//
// Shortcut keys → page: see HOME_LINKS below.
export const HOME_LINKS = {
  sell: ['🛒', '/checkout'], sales: ['🧮', '/sales'], shift: ['⏰', '/shifts'],
  jobs: ['📋', '/jobs'], produce: ['🍳', '/production'], breakdown: ['🔪', '/production'], waste: ['🗑️', '/waste'],
  receive: ['🚚', '/stock-arrival'], invoice: ['🧾', '/receipts'], shelf: ['📦', '/products'], handover: ['🔀', '/handovers'],
  labels: ['🏷️', '/labels'], online: ['🛍️', '/marketplace'], exit: ['🛡️', '/exit-check'], count: ['⏱️', '/cycle-counting'],
  products: ['📦', '/products'], customers: ['🧾', '/customers'], report: ['📅', '/daily-report'],
};

const T = (key, role, home) => ({ key, role, home });
const COMMON_TOP = [T('co_owner', 'admin', [])];

export const JOB_TITLES = {
  general: [T('manager', 'manager', ['sell', 'receive', 'report']), T('cashier', 'cashier', ['sell', 'sales', 'shift']), T('checkout_clerk', 'checkout', ['sell']),
    T('sales_attendant', 'staff', ['shelf', 'receive', 'count']), T('storekeeper', 'store_manager', ['invoice', 'receive', 'handover']),
    T('shelf_stocker', 'shelf_manager', ['handover', 'labels']), T('online_orders', 'marketplace_manager', ['online']), T('security_guard', 'security', ['exit'])],
  butchery: [T('shop_manager', 'manager', ['sell', 'breakdown', 'report']), T('butcher', 'staff', ['breakdown', 'waste']), T('meat_cutter', 'staff', ['breakdown', 'waste']),
    T('cashier', 'cashier', ['sell', 'sales', 'shift']), T('sales_attendant', 'checkout', ['sell']), T('cold_room_keeper', 'store_manager', ['receive', 'waste']),
    T('online_orders', 'marketplace_manager', ['online']), T('security_guard', 'security', ['exit'])],
  abattoir: [T('abattoir_manager', 'manager', ['breakdown', 'sell', 'report']), T('slaughterman', 'staff', ['breakdown', 'waste']), T('butcher', 'staff', ['breakdown', 'waste']),
    T('weighbridge_clerk', 'checkout', ['sell']), T('cashier', 'cashier', ['sell', 'sales', 'shift']), T('cold_room_keeper', 'store_manager', ['receive', 'waste']),
    T('hides_handler', 'shelf_manager', ['handover']), T('security_guard', 'security', ['exit'])],
  fresh_produce: [T('manager', 'manager', ['sell', 'receive', 'report']), T('sales_attendant', 'staff', ['shelf', 'waste']), T('cashier', 'cashier', ['sell', 'sales', 'shift']),
    T('weigh_clerk', 'checkout', ['sell']), T('sorter_packer', 'shelf_manager', ['handover', 'labels']), T('storekeeper', 'store_manager', ['receive', 'waste']),
    T('online_orders', 'marketplace_manager', ['online']), T('security_guard', 'security', ['exit'])],
  ice_cream: [T('manager', 'manager', ['produce', 'sell', 'report']), T('ice_cream_maker', 'staff', ['produce', 'waste']), T('server', 'checkout', ['sell']),
    T('cashier', 'cashier', ['sell', 'sales', 'shift']), T('storekeeper', 'store_manager', ['receive', 'invoice']), T('online_orders', 'marketplace_manager', ['online'])],
  bakery: [T('head_baker', 'manager', ['produce', 'sell', 'report']), T('baker', 'staff', ['produce', 'waste']), T('sales_attendant', 'checkout', ['sell']),
    T('cashier', 'cashier', ['sell', 'sales', 'shift']), T('storekeeper', 'store_manager', ['receive', 'invoice']), T('online_orders', 'marketplace_manager', ['online'])],
  restaurant: [T('restaurant_manager', 'manager', ['sell', 'produce', 'report']), T('chef', 'staff', ['produce', 'waste']), T('kitchen_assistant', 'staff', ['produce', 'waste']),
    T('waiter', 'checkout', ['sell']), T('cashier', 'cashier', ['sell', 'sales', 'shift']), T('storekeeper', 'store_manager', ['receive', 'invoice']),
    T('online_orders', 'marketplace_manager', ['online']), T('security_guard', 'security', ['exit'])],
  tailor: [T('master_tailor', 'manager', ['jobs', 'sell', 'report']), T('tailor', 'staff', ['jobs']), T('apprentice', 'staff', ['jobs']),
    T('front_desk', 'cashier', ['jobs', 'sell', 'sales']), T('storekeeper', 'store_manager', ['receive', 'invoice']), T('online_orders', 'marketplace_manager', ['online'])],
  laundry: [T('laundry_manager', 'manager', ['jobs', 'sell', 'report']), T('washer', 'staff', ['jobs']), T('ironer', 'staff', ['jobs']),
    T('front_desk', 'cashier', ['jobs', 'sell', 'sales']), T('online_orders', 'marketplace_manager', ['online'])],
  mechanic: [T('workshop_manager', 'manager', ['jobs', 'sell', 'report']), T('mechanic', 'staff', ['jobs']), T('auto_electrician', 'staff', ['jobs']),
    T('service_advisor', 'checkout', ['jobs', 'sell']), T('secretary', 'cashier', ['jobs', 'sell', 'sales']), T('parts_storekeeper', 'store_manager', ['receive', 'invoice']),
    T('security_guard', 'security', ['exit'])],
  tech_repair: [T('manager', 'manager', ['jobs', 'sell', 'report']), T('technician', 'staff', ['jobs']), T('engineer', 'staff', ['jobs']),
    T('secretary', 'cashier', ['jobs', 'sell', 'sales']), T('sales_attendant', 'checkout', ['sell']), T('parts_storekeeper', 'store_manager', ['receive', 'invoice']),
    T('online_orders', 'marketplace_manager', ['online'])],
  engineering: [T('project_manager', 'manager', ['jobs', 'sell', 'report']), T('engineer', 'staff', ['jobs']), T('technician', 'staff', ['jobs']),
    T('secretary', 'cashier', ['jobs', 'sell', 'sales']), T('storekeeper', 'store_manager', ['receive', 'invoice']), T('security_guard', 'security', ['exit'])],
  building_materials: [T('manager', 'manager', ['sell', 'receive', 'report']), T('sales_rep', 'checkout', ['sell']), T('cashier', 'cashier', ['sell', 'sales', 'shift']),
    T('storekeeper', 'store_manager', ['invoice', 'receive']), T('yard_supervisor', 'shelf_manager', ['handover', 'labels']), T('loader', 'staff', ['receive', 'shelf']),
    T('online_orders', 'marketplace_manager', ['online']), T('security_guard', 'security', ['exit'])],
};

/** Job titles for a business type, in hiring order, with the co-owner last. */
export function jobTitlesFor(businessType) {
  return [...(JOB_TITLES[businessType] || JOB_TITLES.general), ...COMMON_TOP];
}

/** A person's title definition (key stored on the user / invite). */
export function titleDef(businessType, key) {
  if (!key) return null;
  return jobTitlesFor(businessType).find((x) => x.key === key) || Object.values(JOB_TITLES).flat().find((x) => x.key === key) || null;
}
