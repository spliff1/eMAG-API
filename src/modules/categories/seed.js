/** Reference data for the Categories module (dummy values — ids are NOT the production ones). */

// [id, en, ro]
export const CHARACTERISTICS = {
  color: { id: 1001, en: 'Color', ro: 'Culoare', type_id: 1, allow_new_value: false, filter: true, values: [['Black', 'Negru'], ['White', 'Alb'], ['Silver', 'Argintiu'], ['Blue', 'Albastru'], ['Red', 'Rosu'], ['Green', 'Verde'], ['Grey', 'Gri']] },
  display: { id: 1002, en: 'Display size', ro: 'Diagonala ecran', type_id: 1, allow_new_value: false, filter: true, values: [['13.3"', '13.3"'], ['14"', '14"'], ['15.6"', '15.6"'], ['16"', '16"'], ['17.3"', '17.3"'], ['43"', '43"'], ['55"', '55"'], ['65"', '65"']] },
  ram: { id: 1003, en: 'RAM memory', ro: 'Memorie RAM', type_id: 1, allow_new_value: false, filter: true, values: [['4 GB', '4 GB'], ['8 GB', '8 GB'], ['16 GB', '16 GB'], ['32 GB', '32 GB'], ['64 GB', '64 GB']] },
  storage: { id: 1004, en: 'Storage capacity', ro: 'Capacitate stocare', type_id: 1, allow_new_value: false, filter: true, values: [['128 GB', '128 GB'], ['256 GB', '256 GB'], ['512 GB', '512 GB'], ['1 TB', '1 TB'], ['2 TB', '2 TB']] },
  os: { id: 1005, en: 'Operating system', ro: 'Sistem de operare', type_id: 1, allow_new_value: false, filter: true, values: [['Windows 11', 'Windows 11'], ['macOS', 'macOS'], ['Android', 'Android'], ['iOS', 'iOS'], ['Linux', 'Linux'], ['No OS', 'Fara sistem de operare']] },
  material: { id: 1006, en: 'Material', ro: 'Material', type_id: 1, allow_new_value: true, filter: false, values: [['Plastic', 'Plastic'], ['Metal', 'Metal'], ['Textile', 'Textil'], ['Leather', 'Piele'], ['Glass', 'Sticla']] },
  power: { id: 1007, en: 'Power (W)', ro: 'Putere (W)', type_id: 2, allow_new_value: true, filter: true, values: [] },
  connectivity: { id: 1008, en: 'Connectivity', ro: 'Conectivitate', type_id: 1, allow_new_value: false, filter: true, values: [['Bluetooth', 'Bluetooth'], ['Wi-Fi', 'Wi-Fi'], ['Wired', 'Cablu']] },
  size: { id: 1009, en: 'Size', ro: 'Marime', type_id: 1, allow_new_value: false, filter: true, values: ['36', '37', '38', '39', '40', '41', '42', '43', '44', '45', '46', 'S', 'M', 'L', 'XL'].map((v) => [v, v]) },
  resolution: { id: 1010, en: 'Resolution', ro: 'Rezolutie', type_id: 1, allow_new_value: false, filter: true, values: [['HD', 'HD'], ['Full HD', 'Full HD'], ['4K UHD', '4K UHD'], ['8K', '8K']] },
  capacity: { id: 1011, en: 'Capacity (L)', ro: 'Capacitate (L)', type_id: 2, allow_new_value: true, filter: true, values: [] },
};

/** chars: characteristic keys, suffix "*" = mandatory. gen = hints for the product generators. */
export const CATEGORIES = [
  { id: 10, parent_id: 0, en: 'Laptops, Tablets & Phones', ro: 'Laptop, Tablete & Telefoane' },
  { id: 20, parent_id: 0, en: 'TV, Audio & Video', ro: 'TV, Audio-Video' },
  { id: 30, parent_id: 0, en: 'Home Appliances', ro: 'Electrocasnice' },
  { id: 40, parent_id: 0, en: 'Fashion', ro: 'Moda' },
  { id: 50, parent_id: 0, en: 'Home, Garden & Toys', ro: 'Casa, Gradina & Jucarii' },
  {
    id: 506, parent_id: 10, en: 'Laptops', ro: 'Laptopuri', ean: true, warranty: true, chars: ['display*', 'ram', 'storage', 'os', 'color'],
    gen: { noun: 'Laptop', brands: ['Lenovo', 'HP', 'ASUS', 'Acer', 'Dell', 'Apple'], models: ['IdeaPad 3', 'ThinkPad E14', 'ProBook 450', 'VivoBook 15', 'Aspire 5', 'Inspiron 15', 'MacBook Air'], price: [1800, 8500] },
  },
  {
    id: 575, parent_id: 10, en: 'Smartphones', ro: 'Telefoane mobile', ean: true, warranty: true, chars: ['ram', 'storage', 'os', 'color'],
    gen: { noun: 'Telefon mobil', brands: ['Samsung', 'Apple', 'Xiaomi', 'Motorola', 'Honor', 'OnePlus'], models: ['Galaxy S24', 'iPhone 15', 'Redmi Note 13', 'Moto G84', 'Magic6 Lite', 'Nord CE 3'], price: [700, 5200] },
  },
  {
    id: 3, parent_id: 10, en: 'Tablets', ro: 'Tablete', ean: true, warranty: true, chars: ['ram', 'storage', 'os', 'color'],
    gen: { noun: 'Tableta', brands: ['Samsung', 'Apple', 'Lenovo', 'Xiaomi'], models: ['Galaxy Tab A9', 'iPad 10', 'Tab M10', 'Pad 6'], price: [500, 4200] },
  },
  {
    id: 21, parent_id: 20, en: 'Televisions', ro: 'Televizoare', ean: true, warranty: true, chars: ['display*', 'resolution', 'connectivity'],
    gen: { noun: 'Televizor LED Smart', brands: ['Samsung', 'LG', 'Sony', 'Philips', 'Hisense'], models: ['Crystal UHD', 'OLED C3', 'Bravia X75', 'The One', 'A6K'], price: [900, 9000] },
  },
  {
    id: 4, parent_id: 20, en: 'Headphones', ro: 'Casti', ean: true, warranty: true, chars: ['color', 'connectivity'],
    gen: { noun: 'Casti', brands: ['Sony', 'JBL', 'Bose', 'Apple', 'Sennheiser'], models: ['WH-1000XM5', 'Tune 520BT', 'QuietComfort', 'AirPods Pro', 'Momentum 4'], price: [90, 1700] },
  },
  {
    id: 22, parent_id: 20, en: 'Speakers', ro: 'Boxe portabile', ean: false, warranty: true, chars: ['power', 'connectivity', 'color'],
    gen: { noun: 'Boxa portabila', brands: ['JBL', 'Sony', 'Anker', 'Marshall'], models: ['Flip 6', 'SRS-XB13', 'Soundcore 3', 'Emberton'], price: [80, 1200] },
  },
  {
    id: 31, parent_id: 30, en: 'Coffee machines', ro: 'Espressoare', ean: true, warranty: true, chars: ['power', 'color', 'capacity'],
    gen: { noun: 'Espressor', brands: ['DeLonghi', 'Philips', 'Krups', 'Nespresso', 'Beko'], models: ['Magnifica S', 'Series 3200', 'Essenza Mini', 'Vertuo Pop', 'CEG 5301'], price: [250, 4500] },
  },
  {
    id: 32, parent_id: 30, en: 'Vacuum cleaners', ro: 'Aspiratoare', ean: true, warranty: true, chars: ['power', 'color'],
    gen: { noun: 'Aspirator', brands: ['Dyson', 'Philips', 'Bosch', 'Samsung', 'Rowenta'], models: ['V12 Detect', 'XC7043', 'Unlimited 7', 'Jet 90', 'X-Force Flex'], price: [300, 3500] },
  },
  {
    id: 33, parent_id: 30, en: 'Air fryers', ro: 'Friteuze cu aer cald', ean: true, warranty: true, chars: ['power', 'capacity', 'color'],
    gen: { noun: 'Friteuza cu aer cald', brands: ['Philips', 'Tefal', 'Ninja', 'Xiaomi'], models: ['Airfryer XL', 'Easy Fry', 'AF300EU', 'Smart 6L'], price: [180, 1100] },
  },
  {
    id: 41, parent_id: 40, en: 'Sneakers', ro: 'Pantofi sport', ean: false, warranty: false, chars: ['size*', 'color', 'material'],
    gen: { noun: 'Pantofi sport', brands: ['Nike', 'Adidas', 'Puma', 'New Balance', 'Reebok'], models: ['Air Max 90', 'Superstar', 'Suede Classic', '574', 'Club C 85'], price: [150, 800] },
  },
  {
    id: 42, parent_id: 40, en: 'T-shirts', ro: 'Tricouri', ean: false, warranty: false, chars: ['size*', 'color', 'material'],
    gen: { noun: 'Tricou', brands: ['Nike', 'Adidas', 'Puma', 'Levi\'s', 'Tommy Hilfiger'], models: ['Essentials', 'Trefoil', 'Classic Logo', 'Batwing', 'Slim Fit'], price: [40, 260] },
  },
  {
    id: 51, parent_id: 50, en: 'Power tools', ro: 'Scule electrice', ean: true, warranty: true, chars: ['power', 'color'],
    gen: { noun: 'Bormasina', brands: ['Bosch', 'Makita', 'DeWalt', 'Black+Decker'], models: ['GSB 13 RE', 'HP1631', 'DCD777', 'BCD001'], price: [150, 1500] },
  },
  {
    id: 52, parent_id: 50, en: 'Toys', ro: 'Jucarii', ean: true, warranty: false, chars: [],
    gen: { noun: 'Set de constructie', brands: ['LEGO', 'Playmobil', 'Hasbro', 'Mattel'], models: ['City 60349', 'Novelmore', 'Monopoly', 'Hot Wheels Track'], price: [30, 900] },
  },
];

/** Dummy VAT ids (RO rates as of Aug 2025 + legacy inactive ones). */
export const VAT_RATES = [
  { vat_id: 1, vat_rate: '0.2100', status: 'active' },
  { vat_id: 2, vat_rate: '0.1100', status: 'active' },
  { vat_id: 3, vat_rate: '0.0000', status: 'active' },
  { vat_id: 4, vat_rate: '0.1900', status: 'inactive' },
  { vat_id: 5, vat_rate: '0.0900', status: 'inactive' },
  { vat_id: 6, vat_rate: '0.0500', status: 'inactive' },
];

export const HANDLING_TIMES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 14, 21, 30];
