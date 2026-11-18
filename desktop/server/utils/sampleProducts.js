// Generic sample products for trying the till in a new store. Category
// "Sample" makes them easy to find and archive later. Prices are plain
// numbers in whatever currency the store uses.
const SAMPLE_PRODUCTS = [
  { name: 'Bottled Water 75cl', sku: 'SAMPLE-WATER', category: 'Sample', unit: 'bottle', cost: 150, price: 200, stock: 48, reorder: 12, pack: 12 },
  { name: 'Bread (Sliced Loaf)', sku: 'SAMPLE-BREAD', category: 'Sample', unit: 'loaf', cost: 900, price: 1200, stock: 20, reorder: 5 },
  { name: 'Rice 5kg', sku: 'SAMPLE-RICE5', category: 'Sample', unit: 'bag', cost: 7500, price: 9000, stock: 15, reorder: 4 },
  { name: 'Vegetable Oil 1L', sku: 'SAMPLE-OIL1', category: 'Sample', unit: 'bottle', cost: 2200, price: 2700, stock: 24, reorder: 6, pack: 12 },
  { name: 'Sugar 1kg', sku: 'SAMPLE-SUGAR', category: 'Sample', unit: 'pack', cost: 1100, price: 1400, stock: 30, reorder: 8 },
  { name: 'Instant Noodles 70g', sku: 'SAMPLE-NOODLE', category: 'Sample', unit: 'pack', cost: 180, price: 250, stock: 120, reorder: 40, pack: 40 },
  { name: 'Milk Powder 400g', sku: 'SAMPLE-MILK', category: 'Sample', unit: 'tin', cost: 2600, price: 3200, stock: 18, reorder: 6, pack: 12 },
  { name: 'Soap Bar', sku: 'SAMPLE-SOAP', category: 'Sample', unit: 'bar', cost: 350, price: 500, stock: 60, reorder: 15, pack: 24 },
  { name: 'Toothpaste 100g', sku: 'SAMPLE-TPASTE', category: 'Sample', unit: 'tube', cost: 700, price: 950, stock: 30, reorder: 10 },
  { name: 'Soft Drink 50cl', sku: 'SAMPLE-SODA', category: 'Sample', unit: 'bottle', cost: 250, price: 350, stock: 72, reorder: 24, pack: 12 },
  { name: 'Eggs (Crate of 30)', sku: 'SAMPLE-EGGS', category: 'Sample', unit: 'crate', cost: 4200, price: 5000, stock: 10, reorder: 3 },
  { name: 'Tomato Paste 210g', sku: 'SAMPLE-TOMATO', category: 'Sample', unit: 'tin', cost: 400, price: 550, stock: 50, reorder: 12, pack: 50 },
];
module.exports = { SAMPLE_PRODUCTS };
