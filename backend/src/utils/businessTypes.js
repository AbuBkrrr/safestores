// What each kind of business needs. The store's business_type switches these
// tools on; everything else in the app works the same for all types.
//   measure    — sell by weight / volume / length (decimal quantities)
//   fresh      — shelf life in days + waste log
//   production — recipes: ingredients → product (ice-cream, bread)
//   breakdown  — one animal/carcass → cuts, with yield (abattoir, butchery)
//   jobs       — services & job orders with customer measurements (tailor, laundry)
const BUSINESS_TYPES = {
  general: { tools: [], defaultSoldBy: 'unit', defaultUnit: 'unit',
    categories: ['Groceries', 'Drinks', 'Toiletries', 'Household', 'Snacks'] },
  butchery: { tools: ['measure', 'fresh', 'breakdown'], defaultSoldBy: 'weight', defaultUnit: 'kg', shelfLifeDays: 3,
    categories: ['Beef', 'Goat meat', 'Chicken', 'Offal', 'Ram', 'Pork', 'Fish'] },
  abattoir: { tools: ['measure', 'fresh', 'breakdown'], defaultSoldBy: 'weight', defaultUnit: 'kg', shelfLifeDays: 2,
    categories: ['Live cattle', 'Live goats', 'Live rams', 'Carcass', 'Cuts', 'Offal', 'Hides & skins'] },
  fresh_produce: { tools: ['measure', 'fresh'], defaultSoldBy: 'weight', defaultUnit: 'kg', shelfLifeDays: 5,
    categories: ['Fruits', 'Vegetables', 'Tubers', 'Leafy greens', 'Peppers & tomatoes'] },
  ice_cream: { tools: ['measure', 'fresh', 'production'], defaultSoldBy: 'unit', defaultUnit: 'cup', shelfLifeDays: 60,
    categories: ['Ice cream', 'Yoghurt', 'Ingredients', 'Cones & cups', 'Toppings'] },
  bakery: { tools: ['fresh', 'production'], defaultSoldBy: 'unit', defaultUnit: 'loaf', shelfLifeDays: 4,
    categories: ['Bread', 'Cakes', 'Pastries', 'Ingredients', 'Packaging'] },
  tailor: { tools: ['jobs', 'measure'], defaultSoldBy: 'length', defaultUnit: 'yard',
    categories: ['Fabrics', 'Linings', 'Threads', 'Buttons & zips', 'Ready-made'] },
  laundry: { tools: ['jobs'], defaultSoldBy: 'unit', defaultUnit: 'item',
    categories: ['Detergents', 'Starch', 'Packaging', 'Hangers'] },
};
const TYPE_KEYS = Object.keys(BUSINESS_TYPES);
const toolsFor = (type) => (BUSINESS_TYPES[type] || BUSINESS_TYPES.general).tools;

module.exports = { BUSINESS_TYPES, TYPE_KEYS, toolsFor };
