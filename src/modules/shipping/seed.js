import { fmtDateTime } from '../../core/util.js';

/** "name|region2 (county)|zip|iso2 code" — county seats + a few extras. */
const RO = `Alba Iulia|Alba|510001|AB;Arad|Arad|310001|AR;Pitesti|Arges|110001|AG;Bacau|Bacau|600001|BC;Oradea|Bihor|410001|BH;Bistrita|Bistrita-Nasaud|420001|BN;Botosani|Botosani|710001|BT;Brasov|Brasov|500001|BV;Braila|Braila|810001|BR;Buzau|Buzau|120001|BZ;Resita|Caras-Severin|320001|CS;Calarasi|Calarasi|910001|CL;Cluj-Napoca|Cluj|400001|CJ;Constanta|Constanta|900001|CT;Sfantu Gheorghe|Covasna|520001|CV;Targoviste|Dambovita|130001|DB;Craiova|Dolj|200001|DJ;Galati|Galati|800001|GL;Giurgiu|Giurgiu|080001|GR;Targu Jiu|Gorj|210001|GJ;Miercurea Ciuc|Harghita|530001|HR;Deva|Hunedoara|330001|HD;Slobozia|Ialomita|920001|IL;Iasi|Iasi|700001|IS;Baia Mare|Maramures|430001|MM;Drobeta-Turnu Severin|Mehedinti|220001|MH;Targu Mures|Mures|540001|MS;Piatra Neamt|Neamt|610001|NT;Slatina|Olt|230001|OT;Ploiesti|Prahova|100001|PH;Satu Mare|Satu Mare|440001|SM;Zalau|Salaj|450001|SJ;Sibiu|Sibiu|550001|SB;Suceava|Suceava|720001|SV;Alexandria|Teleorman|140001|TR;Timisoara|Timis|300001|TM;Tulcea|Tulcea|820001|TL;Vaslui|Vaslui|730001|VS;Ramnicu Valcea|Valcea|240001|VL;Focsani|Vrancea|620001|VN;Voluntari|Ilfov|077190|IF;Otopeni|Ilfov|075100|IF;Buftea|Ilfov|070000|IF;Sectorul 1|Bucuresti|010011|B;Sectorul 2|Bucuresti|020011|B;Sectorul 3|Bucuresti|030011|B;Sectorul 4|Bucuresti|040011|B;Sectorul 5|Bucuresti|050011|B;Sectorul 6|Bucuresti|060011|B`;

const OTHER = [
  ['Sofia', 'Sofia', '1000', 'BG', 'BG-22'], ['Plovdiv', 'Plovdiv', '4000', 'BG', 'BG-16'], ['Varna', 'Varna', '9000', 'BG', 'BG-03'],
  ['Budapest', 'Budapest', '1011', 'HU', 'HU-BU'], ['Debrecen', 'Hajdu-Bihar', '4024', 'HU', 'HU-HB'],
  ['Warszawa', 'Mazowieckie', '00-001', 'PL', 'PL-MZ'], ['Berlin', 'Berlin', '10115', 'DE', 'DE-BE'], ['Athina', 'Attiki', '10431', 'EL', 'GR-I'],
];
const COUNTRY = { RO: 'Romania', BG: 'Bulgaria', HU: 'Hungary', PL: 'Poland', DE: 'Germany', EL: 'Greece' };

export function localityDocs() {
  const now = fmtDateTime();
  const rows = [
    ...RO.split(';').map((s) => s.split('|')).map(([name, region, zip, code]) => [name, region, zip, 'RO', `RO-${code}`]),
    ...OTHER,
  ];
  return rows.map(([name, region2, zipcode, country_code, iso2], i) => ({
    emag_id: i + 1,
    name,
    name_latin: name,
    region1: COUNTRY[country_code],
    region1_latin: COUNTRY[country_code],
    region2,
    region2_latin: region2,
    region3: '',
    region3_latin: '',
    region4: '',
    region4_latin: '',
    geoid: 680000 + i,
    modified: now,
    zipcode,
    country_code,
    iso2,
  }));
}

export function courierDocs() {
  const now = fmtDateTime();
  return [
    { account_id: 1001, account_display_name: 'Fan Courier - main account', courier_account_type: 3, courier_name: 'Fan Courier', courier_account_properties: [0, 2], created: now, status: 1, pickup_country_code: 'RO' },
    { account_id: 1002, account_display_name: 'Sameday - lockers & home', courier_account_type: 3, courier_name: 'Sameday', courier_account_properties: [0, 2, 6], created: now, status: 1, pickup_country_code: 'RO' },
    { account_id: 1003, account_display_name: 'Cargus - orders', courier_account_type: 2, courier_name: 'Cargus', courier_account_properties: [0], created: now, status: 1, pickup_country_code: 'RO' },
    { account_id: 1004, account_display_name: 'DPD - returns only', courier_account_type: 1, courier_name: 'DPD', courier_account_properties: [0], created: now, status: 1, pickup_country_code: 'RO' },
    { account_id: 1005, account_display_name: 'GLS (inactive)', courier_account_type: 3, courier_name: 'GLS', courier_account_properties: [0], created: now, status: 0, pickup_country_code: 'RO' },
  ];
}

export function addressDocs(loc) {
  const base = { country_id: 1, country_code: 'RO', locality_id: loc.emag_id, suburb: loc.region2, city: loc.name, zipcode: loc.zipcode, quarter: '', is_default: true };
  return [
    { address_id: '1001', address_type_id: 2, address: 'Strada Depozitului nr. 10', floor: '', ...base },
    { address_id: '1002', address_type_id: 1, address: 'Strada Depozitului nr. 10', floor: '', ...base },
    { address_id: '1003', address_type_id: 3, address: 'Bulevardul Unirii nr. 1', floor: '2', ...base },
  ];
}

export const packageDocs = () => [
  { label: 'XS', length: 20, width: 15, height: 5, weight: 0.5, is_default: false },
  { label: 'S', length: 30, width: 20, height: 10, weight: 1, is_default: false },
  { label: 'M', length: 40, width: 30, height: 20, weight: 3, is_default: true },
  { label: 'L', length: 60, width: 40, height: 30, weight: 8, is_default: false },
];
