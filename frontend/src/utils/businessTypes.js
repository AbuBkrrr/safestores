// Mirrors backend/src/utils/businessTypes.js: what each kind of business
// switches on, and the starter units/categories it suggests.
export const BUSINESS_TYPES = {
  general: { icon: '🏪', tools: [], soldBy: 'unit', unit: 'unit', categories: ['Groceries', 'Drinks', 'Toiletries', 'Household', 'Snacks'] },
  butchery: { icon: '🥩', tools: ['measure', 'fresh', 'breakdown'], soldBy: 'weight', unit: 'kg', shelfLifeDays: 3, categories: ['Beef', 'Goat meat', 'Chicken', 'Offal', 'Ram', 'Pork', 'Fish'] },
  abattoir: { icon: '🐄', tools: ['measure', 'fresh', 'breakdown'], soldBy: 'weight', unit: 'kg', shelfLifeDays: 2, categories: ['Live cattle', 'Live goats', 'Live rams', 'Carcass', 'Cuts', 'Offal', 'Hides & skins'] },
  fresh_produce: { icon: '🍅', tools: ['measure', 'fresh'], soldBy: 'weight', unit: 'kg', shelfLifeDays: 5, categories: ['Fruits', 'Vegetables', 'Tubers', 'Leafy greens', 'Peppers & tomatoes'] },
  ice_cream: { icon: '🍦', tools: ['measure', 'fresh', 'production'], soldBy: 'unit', unit: 'cup', shelfLifeDays: 60, categories: ['Ice cream', 'Yoghurt', 'Ingredients', 'Cones & cups', 'Toppings'] },
  bakery: { icon: '🍞', tools: ['fresh', 'production'], soldBy: 'unit', unit: 'loaf', shelfLifeDays: 4, categories: ['Bread', 'Cakes', 'Pastries', 'Ingredients', 'Packaging'] },
  tailor: { icon: '🧵', tools: ['jobs', 'measure'], soldBy: 'length', unit: 'yard', categories: ['Fabrics', 'Linings', 'Threads', 'Buttons & zips', 'Ready-made'] },
  laundry: { icon: '👕', tools: ['jobs'], soldBy: 'unit', unit: 'item', categories: ['Detergents', 'Starch', 'Packaging', 'Hangers'] },
  mechanic: { icon: '🔧', tools: ['jobs', 'repair'], soldBy: 'unit', unit: 'piece', categories: ['Engine parts', 'Brake parts', 'Filters', 'Oils & fluids', 'Tyres', 'Electrical', 'Body parts'] },
  tech_repair: { icon: '📱', tools: ['jobs', 'repair'], soldBy: 'unit', unit: 'piece', categories: ['Screens', 'Batteries', 'Charging ports', 'Chargers & cables', 'Phone parts', 'Laptop parts', 'Accessories'] },
  engineering: { icon: '⚙️', tools: ['jobs', 'repair'], soldBy: 'unit', unit: 'piece', categories: ['Spare parts', 'Electrical', 'Plumbing', 'Welding', 'Consumables', 'Tools'] },
  restaurant: { icon: '🍲', tools: ['measure', 'fresh', 'production'], soldBy: 'unit', unit: 'plate', shelfLifeDays: 1, categories: ['Main dishes', 'Rice dishes', 'Soups & swallow', 'Grills', 'Drinks', 'Ingredients', 'Packaging'] },
  building_materials: { icon: '🧱', tools: ['measure'], soldBy: 'unit', unit: 'bag', categories: ['Cement', 'Iron rods', 'Blocks & bricks', 'Sand & gravel', 'Roofing', 'Doors', 'Windows & glass', 'Tiles', 'Plumbing', 'Sanitary ware', 'Electrical', 'Paint', 'Timber', 'Nails & fasteners', 'Tools & hardware'] },
};
export const SOLD_BY_UNITS = { unit: ['unit', 'piece', 'pack', 'cup', 'loaf', 'bottle', 'carton', 'head', 'plate', 'bag', 'sheet', 'length'], weight: ['kg', 'g', 'tonne'], volume: ['litre', 'ml'], length: ['yard', 'metre'] };
export const isFractional = (p) => ['weight', 'volume', 'length'].includes(p?.sold_by);
export const toolsFor = (type) => (BUSINESS_TYPES[type] || BUSINESS_TYPES.general).tools;
/** "1.35 kg", "3 cups" — quantity with its unit. */
export const fmtQty = (q, p) => {
  const n = Math.round(Number(q) * 1000) / 1000;
  const u = p?.unit && p.unit !== 'unit' ? ` ${p.unit}` : '';
  return `${n}${u}`;
};
