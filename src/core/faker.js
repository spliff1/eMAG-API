import { rnd, md5 } from './util.js';

const FIRST_M = ['Andrei', 'Mihai', 'Ion', 'Alexandru', 'Cristian', 'Vlad', 'Florin', 'Radu', 'Bogdan', 'Gabriel', 'Stefan', 'Marius', 'Adrian', 'Daniel', 'Catalin'];
const FIRST_F = ['Maria', 'Elena', 'Ioana', 'Andreea', 'Ana', 'Cristina', 'Mihaela', 'Alexandra', 'Daniela', 'Raluca', 'Simona', 'Laura', 'Gabriela', 'Diana', 'Roxana'];
const LAST = ['Popescu', 'Ionescu', 'Popa', 'Stan', 'Dumitru', 'Gheorghe', 'Constantin', 'Marin', 'Radu', 'Stoica', 'Diaconu', 'Matei', 'Georgescu', 'Munteanu', 'Barbu', 'Lungu', 'Tudor', 'Preda', 'Neagu', 'Dobre'];
const STREETS = ['Strada Victoriei', 'Strada Libertatii', 'Bulevardul Unirii', 'Strada Primaverii', 'Calea Dorobantilor', 'Strada Mihai Eminescu', 'Strada Garii', 'Strada Republicii', 'Aleea Trandafirilor', 'Strada Independentei', 'Bulevardul Revolutiei', 'Strada Florilor'];
const COMPANIES = ['Alfa Trade', 'Delta Logistic', 'Nova Retail', 'Prime Solutions', 'Omega Tech', 'Vega Import Export', 'Apex Distributie', 'Zenith Comert'];
const BANKS = ['Banca Transilvania', 'BCR', 'BRD', 'ING Bank', 'Raiffeisen Bank', 'CEC Bank'];
const IBAN_BANKS = ['BTRL', 'RNCB', 'BRDE', 'INGB', 'RZBR', 'CECE'];

export const person = (gender = rnd.pick(['M', 'F'])) => ({
  gender,
  name: `${rnd.pick(LAST)} ${rnd.pick(gender === 'M' ? FIRST_M : FIRST_F)}`,
});
export const phone = () => `07${rnd.pick(['2', '3', '4', '5', '6', '7', '8'])}${rnd.digits(7)}`;
export const street = () => `${rnd.pick(STREETS)} nr. ${rnd.int(1, 180)}${rnd.chance(0.3) ? `, bl. ${rnd.alnum(1)}${rnd.int(1, 9)}, ap. ${rnd.int(1, 60)}` : ''}`;
export const company = () => `${rnd.pick(COMPANIES)} S.R.L.`;
export const cui = () => `RO${rnd.digits(rnd.int(6, 9))}`;
export const regNumber = () => `J${rnd.int(1, 40)}/${rnd.int(10, 9999)}/${rnd.int(2005, 2024)}`;
export const iban = () => `RO${rnd.digits(2)}${rnd.pick(IBAN_BANKS)}${rnd.digits(16)}`;
export const bank = () => rnd.pick(BANKS);
export const maskedEmail = (seed = Math.random()) => `${md5(seed).slice(0, 16)}@mkt.emag.ro`;
export const sentence = () => rnd.pick([
  'Produs nou, sigilat, in cutie originala.',
  'Garantie inclusa conform legislatiei in vigoare.',
  'Livrare rapida din stocul propriu.',
  'Ambalaj securizat pentru transport.',
  'Compatibil cu standardele europene.',
]);
