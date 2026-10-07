# Dummy eMAG Marketplace API

Un API **dummy, compatibil cu documentația oficială eMAG & FD Marketplace API v4.5.2**
(<https://marketplace-api.emag.ro/api-doc>), pentru a-ți testa integrările fără a lovi producția.

- Toate cele **41 de endpoint-uri** din specificația oficială (produse/oferte, comenzi, AWB, retururi, categorii, campanii, facturi).
- **Validare automată pe schemele OpenAPI oficiale** (`spec/openapi.json` e copia exactă a specificației publice), plus regulile de business descrise în documentație (tranziții de status, câmpuri obligatorii, limite).
- **UI web** cu jurnalul live al request-urilor trimise prin el (request/response, note de validare, „Copy as cURL”) și **generatoare de date dummy pe fiecare secțiune**.
- **Totul e persistent în SQLite** (`data/dummy-emag.sqlite`): colecțiile, setările și **fiecare request cu body-ul complet** (ultimele 20 000, body-uri până la 1 MB — configurabil, vezi *Expunere publică*).
- **UI protejat prin cont** (primul cont se poate înregistra, apoi înregistrarea se închide) și **import read-only din API-ul real eMAG**, cu credențiale folosite doar în memorie și niciodată salvate.
- Fără dependențe externe: doar Node.js ≥ 22.16 (folosește `node:sqlite`, inclus în Node).

## Pornire

```bash
npm start            # http://127.0.0.1:3030
PORT=4000 npm start  # alt port
HOST=0.0.0.0 npm start   # expune și în rețea (UI-ul cere cont; API-ul dummy acceptă orice Basic auth)
npm test             # 60 de teste (API, SQLite, autentificare, import, securitate)
```

**Prima pornire:** deschide UI-ul și creezi contul (username ≥ 3 caractere, parolă ≥ 8). Este singurul cont care se va putea înregistra vreodată; după el, `register` răspunde 403. Parola e stocată cu scrypt, sesiunea e un cookie `HttpOnly; SameSite=Strict` (în baza de date se păstrează doar SHA-256 al token-ului), loginul eșuat e limitat (5 încercări / minut). Dacă îți uiți parola, șterge rândul din tabelul `users` (`sqlite3 data/dummy-emag.sqlite "DELETE FROM users"`) și te înregistrezi din nou.

În integrarea ta setează:

| | |
|---|---|
| Base URL | `http://127.0.0.1:3030/api-3` (la fel ca `https://marketplace-api.emag.ro/api-3`) |
| Autentificare | HTTP Basic. Implicit **orice** credențiale sunt acceptate; din *Settings* poți trece pe mod `strict` (doar utilizatorii definiți, altfel 401) |
| UI | `http://127.0.0.1:3030/` |

```bash
curl -u user:parola -X POST http://127.0.0.1:3030/api-3/order/read \
  -H 'Content-Type: application/json' -d '{"status":1,"currentPage":1}'
```

Căile din spec care apar deja prefixate cu `/api-3` (facturi, smart-deals) funcționează atât ca `/api-3/invoice/read`, cât și ca `/api-3/api-3/invoice/read`.

## Cum îl folosești

1. Deschide UI-ul → secțiunea dorită (ex. *Orders*) → **Generate dummy data** → „Orders” (alegi număr, status, plată…).
2. Pornește integrarea ta împotriva Base URL-ului de mai sus: citește comenzi, confirmă (`/order/acknowledge`), emite AWB etc.
3. În **Requests** vezi live fiecare apel: metodă, status, durată, body-ul trimis, răspunsul și **notele de validare** (ex. „filtrele nu trebuie împachetate în `data`”, „string numeric convertit”).
4. Acțiuni pe rând (tabelele din secțiuni): aprobă/respinge documentația unei oferte, clientul anulează comanda, avansează statusul AWB-ului, pornește/oprește o campanie etc. — multe declanșează și **callback-uri**.

### Secțiuni și ce generezi

| Secțiune | Endpoint-uri | Generatoare | Acțiuni pe rând |
|---|---|---|---|
| **Products & Offers** | `product_offer/read·save·count`, `offer/save`, `offer_stock/{id}` (PATCH), `documentation/find_by_eans`, `measurements/save` | oferte proprii, produse din catalogul eMAG (pt. atașare după EAN/PNK) | aprobă / respinge / blochează documentația, stoc 0 / +50, preț în afara intervalului |
| **Orders** | `order/read·save·count`, `order/acknowledge/{id}`, `order/{id}/unlock-courier`, `order/attachments/read·save` | comenzi (status, tip 2/3, plată) | **generează AWB dummy** (+ PDF/ZPL), client anulează, marchează plătită, resetează la New, finalizează |
| **Shipping** | `awb/read·save`, `awb/read_pdf`, `awb/read_zpl`, `locality/read·count`, `courier_accounts/read`, `addresses/read`, `awb/package/read·save`, `order/volumetry/read` | AWB-uri pentru comenzi, conturi curier, adrese | avansează statusul AWB (declanșează `awb.status`), descarcă eticheta PDF/ZPL |
| **Returns** | `rma/read·save·count` | retururi din comenzi finalizate | confirmat / primit / anulat de client |
| **Categories** | `category/read·count`, `vat/read`, `handling_time/read` | reset date de referință | — |
| **Campaigns** | `campaigns/read`, `campaign_categories/read`, `campaigns/{id}/eligible-offers`, `campaign_proposals/save`, `smart-deals-price-check`, `offers/{id}/campaign_product_badge_timeline` | campanii (live/trecute/viitoare) **cu oferte eligibile, unele cu susținere eMAG și altele fără**, oferte eligibile pentru o campanie existentă (și importată), oferte în campanii | pornește / oprește campania; pe tab-ul *Eligible offers*: dă / scoate susținerea eMAG |
| **Invoices** | `invoice/categories·read`, `customer-invoice/read` | facturi eMAG, facturi client (+ storno) | — |
| **Callbacks** | (eMAG → serverul tău) | — | retrimite un callback |

## Ce reproduce din comportamentul real

- **Convenții de request**: `save` ⇒ payload în `data` (max. 50 elemente); `read/count` ⇒ filtre top-level (`data` e ignorat și apare ca notă în jurnal); max. 4000 de variabile; chei case-sensitive.
- **Envelope**: `{isError, messages, results}`; la `count`, `results = {noOfItems, noOfPages, itemsPerPage}`. Erori de validare ⇒ HTTP 200 + `isError: true` (elementul invalid nu se salvează, restul da); eroare de *documentație* la salvarea unui produs ⇒ `isError: true` dar oferta **se salvează** (status 8 + `doc_errors`), exact ca în documentație.
- **Produse**: draft (documentație incompletă), atașare la produs existent prin `part_number_key` (status 9) sau EAN (status 3), caracteristici obligatorii/valori permise per categorie, `offer_validation_status` 1/2 din `min/max_sale_price`, `start_date` programat (între mâine și +60 zile), `part_number` curățat de spații/`,`/`;`. Documentația nou trimisă trece 1 → 9 automat după `autoApproveSeconds` (implicit 20 s; `0` = manual din UI) și apoi `part_number_key` apare în catalog.
- **Comenzi**: `acknowledge` e singura cale New → In progress; tranziții permise la `order/save` (2→3→4, anulare cu `reason_cancellation`, reactivare < 48 h), comenzi cu plată online card nu permit eliminarea/reducerea produselor, adăugare produs, comenzi finalizate (4) doar storno (total 4→5 sau parțial cu `is_storno`), comenzile `type 2` doar atașamente, atașamente doar `.pdf`.
- **AWB**: validează comanda (tip 3; ca în eMAG real, **fără restricții de status** și **fără limită de AWB-uri per comandă** — se poate emite oricând, chiar dacă există deja unul, cu eMAG courier sau cu curierii contractuali), localități, cont de curier, `weight` = suma pachetelor, `envelope_number`/`parcel_number`, reguli pentru AWB de retur; returnează `reservation_id` + `emag_id`. **Emiterea unui AWB pentru o comandă în status 1/2/3 o trece automat în status 4 (Finalizată)** (comutator în *Settings → Issuing an AWB finalizes the order*; AWB-urile de retur nu schimbă comanda).
- **Etichete AWB dummy**: `awb/read_pdf` (A4/A5/A6) și `awb/read_zpl` întorc o etichetă generată pe loc — curier, număr AWB, **cod de bare Code 128 real**, destinatar/expeditor, ramburs, colete/greutate, comandă. Din UI (*Orders* → deschizi o comandă): **„Generate dummy AWB”** emite un AWB fără să construiești payload-ul (orice stare a comenzii seller) și linkurile **AWB PDF (A6/A4)** / **ZPL** îl descarcă — generându-l la cerere dacă nu există încă (o singură dată per comandă). Aceleași linkuri există și pe rândurile din *Shipping → AWBs*.
- **Retururi**: matricea de tranziții din documentație (ex. New → Finalized e respins).
- **Rate limiting**: 12 req/s la comenzi, 3 req/s restul (cumulat), 5 req/s `find_by_eans`, și limitele pe minut; depășirea ⇒ HTTP 429 `{"message":"API rate limit exceeded"}` + headerele `X-RateLimit-*`. Cererile invalide se numără. Se poate opri din *Settings*.
- **Callback-uri** (`order.new`, `order.cancel`, `rma.new`, `rma.status`, `awb.status`, `documentation.approved`): configurezi URL-ul în *Callbacks*; dummy-ul face `POST` cu entitatea JSON ca body (+ header `X-Dummy-Emag-Event`) și păstrează un jurnal de livrare.
- **Chaos / fault injection** (*Settings*): latență, procent de erori 5xx aleatoare și reguli „pe endpoint” (ex. `/order/*` → 429 de 3 ori, `/awb/save` → 500, 401…).
- **`Settings → strictRules`**: dezactivează regulile de business (rămâne doar validarea de schemă) dacă vrei să treci peste ele la un test.

## Import din API-ul real (read-only)

*Import* din sidebar → alegi platforma (eMAG RO/BG/HU, Fashion Days RO/BG), introduci username/parola contului de API și ce vrei să aduci. Dummy-ul apelează API-ul real **doar pe endpoint-uri de citire** (allow-list în `src/importer/client.js`; orice altceva e refuzat în cod) și scrie datele în aceleași colecții pe care le servește apoi API-ul dummy, deci id-urile sunt cele reale.

| Sursă | Ce aduce | De ce ajută |
|---|---|---|
| VAT, handling time | `vat_id`-urile și valorile reale | obligatorii la fiecare `product_offer/save` |
| **Categorii** | arborele real + opțional caracteristici, valori permise, family types (implicit doar pentru categoriile folosite de ofertele tale; valorile se aduc paginat) | validarea documentației ca în producție |
| **Produse & oferte** | ofertele tale cu documentația trimisă (+ completează catalogul dummy: atașare după EAN/PNK cu coduri reale) | teste cu date reale |
| Conturi curier, adrese, pachete AWB, localități | id-urile reale | `awb/save` cu valori valide |
| Campanii | campaniile active și regulile lor | testarea propunerilor |
| Comenzi, retururi (opt-in) | ultimele N zile | teste de sincronizare pe forme reale |

- **Mod `merge`** (implicit în UI): upsert după id, restul rămâne. **Mod `replace`**: datele locale ale surselor alese sunt înlocuite de cele reale (ex. categoriile reale înlocuiesc pe cele dummy).
- Respectă limitele eMAG (≈2,5 req/s, backoff la 429), progres live, anulare, istoric al importurilor. Contul tău trebuie să aibă IP-ul whitelisted, altfel eMAG răspunde 403 și vezi un mesaj explicit.
- **Date personale:** comenzile și retururile conțin date de clienți. Sunt oprite implicit, cer bifare explicită și vin **anonimizate** (nume, telefon, adrese, email, IBAN… înlocuite cu date fake; același client real ⇒ același client fake; orașul/județul/localitatea rămân pentru AWB-uri valide). Poți dezactiva anonimizarea doar în mod explicit.
- **Credențialele nu se salvează NICIODATĂ:** ajung o singură dată la serverul local, trăiesc doar într-un closure din memorie pe durata importului și sunt șterse la final (`dispose()`); nu intră în baza de date, în jurnal, în starea sau istoricul job-ului, în mesaje de eroare, nici în browser (nu ajung în storage/URL/console, câmpurile se golesc imediat după trimitere). Rutele UI (unde ar trece parola) nu sunt înregistrate în jurnalul de request-uri. Un test automat rulează un import complet împotriva unui „eMAG” fals și caută parola, username-ul și base64-ul lor în baza de date, WAL, istoricul importurilor și jurnal.
- Adresa de bază e fixată pe hosturile oficiale; un `baseUrl` custom e acceptat doar pentru loopback (teste).

## Expunere publică (securitate)

Dummy-ul e gândit să stea permanent pe internet. Ce îl protejează și ce trebuie să faci tu la deploy:

**Ce e deja în cod**

- **UI-ul** cere cont (primul se înregistrează, apoi `register` ⇒ 403). Parole scrypt, sesiune în cookie `HttpOnly; SameSite=Strict` (+ `Secure` pe HTTPS), token hash-uit în DB, login limitat (5 încercări / minut / IP), verificare `Origin` pe orice request care modifică ceva. Headere de hardening pe UI: `Content-Security-Policy` (fără scripturi inline, doar `self`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` pe API-ul intern.
- **API-ul dummy** (`/api-3`) rămâne deschis prin design (orice Basic auth), de aceea tot ce poate face un necunoscut e **plafonat**:
  - protecție anti-flood **per IP**, care nu se poate opri din UI (`ABUSE_LIMIT_PER_SEC`, implicit 100; `ABUSE_LIMIT_PER_MIN`, implicit 3000; `0` = oprit) ⇒ HTTP 429, fără să fie scrisă în jurnal;
  - limitele eMAG (3/12 req/s) se aplică pe **IP + username**, deci schimbarea username-ului nu resetează fereastra;
  - body maxim 2 MB (`API_MAX_BODY_BYTES`) ⇒ 413;
  - fiecare colecție acceptă maxim 20 000 de documente (`MAX_DOCS_PER_COLLECTION`, `0` = nelimitat) ⇒ HTTP 507 `Storage limit reached`; ștergi date din UI sau ridici limita;
  - jurnalul păstrează ultimele 20 000 de request-uri (`LOG_MAX_REQUESTS`, `0` = nelimitat) și trunchiază body-urile peste 1 MB (`LOG_BODY_MAX_BYTES`), ca să nu umple discul.
- **Callback-uri (anti-SSRF)**: când serverul e expus (`HOST` diferit de loopback), URL-urile de callback pot ținti doar hosturi publice `http(s)`; loopback, rețele private, link-local și metadata cloud (`169.254.169.254`) sunt refuzate, redirecturile nu sunt urmate. Pe `HOST=127.0.0.1` callback-urile către localhost rămân permise. Forțezi cu `CALLBACKS_ALLOW_PRIVATE=1` / `=0`.
- **Importul din API-ul real** apelează doar hosturile oficiale eMAG/FD, doar endpoint-uri de citire, fără a salva credențialele (vezi mai sus).
- Setările și snapshot-urile sunt protejate la prototype pollution; fișierele statice sunt servite doar din `public/` (fără path traversal); timeouts pe cereri lente (30 s headere / 120 s request).

**Ce trebuie să faci la deploy**

1. **Pune-l în spatele unui reverse proxy cu TLS** (Caddy / nginx / Cloudflare) — aplicația vorbește doar HTTP. Lasă `HOST=127.0.0.1` dacă proxy-ul e pe aceeași mașină, altfel `HOST=0.0.0.0` + firewall.
2. Setează **`TRUST_PROXY=1`** doar dacă proxy-ul rescrie `X-Forwarded-For` / `X-Forwarded-Proto`; fără el, toate limitele per IP ar vedea IP-ul proxy-ului (și un atacator ar putea bloca login-ul tuturor), iar cookie-ul nu ar primi `Secure`. Poți forța `COOKIE_SECURE=1`.
3. **Înregistrează contul imediat** după prima pornire (până atunci oricine poate crea primul cont) și folosește o parolă lungă.
4. Rulează sub un utilizator fără privilegii, cu `data/` scris doar de acel utilizator; fă backup la `data/dummy-emag.sqlite` dacă îți pasă de date.
5. Ține minte că **tot ce intră în API-ul public e vizibil în UI**: nu trimite date reale de clienți; folosește generatoarele sau importul anonimizat.

Variabile de mediu: `PORT`, `HOST`, `DATA_DIR`, `TRUST_PROXY`, `COOKIE_SECURE`, `ABUSE_LIMIT_PER_SEC`, `ABUSE_LIMIT_PER_MIN`, `API_MAX_BODY_BYTES`, `MAX_DOCS_PER_COLLECTION`, `LOG_MAX_REQUESTS`, `LOG_BODY_MAX_BYTES`, `CALLBACKS_ALLOW_PRIVATE`.

## Persistență (SQLite)

`data/dummy-emag.sqlite` (WAL): `docs` (documentele tuturor colecțiilor, JSON), `meta` (secvențe, setări), `requests` (**fiecare apel API cu request/response**, cu retenția din *Expunere publică*), `users`, `sessions`, `import_runs`. Datele stau și în memorie pentru viteză; orice modificare este scrisă în tranzacție (diff pe conținut) înainte ca răspunsul HTTP să plece, deci un apel confirmat este deja pe disc. „Clear log” din UI golește jurnalul; peste `LOG_MAX_REQUESTS` cele mai vechi intrări se șterg automat. Dacă ai folosit versiunea cu JSON, `db.json` și `requests.json` se migrează automat la prima pornire (originalele rămân ca `*.migrated`). Interogări directe: `sqlite3 data/dummy-emag.sqlite "select method,path,status from requests order by id desc limit 20"`.

## Ce NU e definit de specificație (alegeri făcute aici — verifică-le față de contul tău real)

Specificația oficială publică nu descrie forma exactă a unor răspunsuri. Am ales forme rezonabile; unde integrarea ta e sensibilă, confirmă cu un apel real și ajustează modulul respectiv:

- `awb/save` ⇒ `results: [{order_id, reservation_id, emag_id}]`; `awb/read_zpl` ⇒ `results: ["<base64>"]`; statusurile curierului (1–7) sunt inventate.
- `invoice/read` și `customer-invoice/read` ⇒ `results` e **obiect** `{total_results, invoices[]}` (conform descrierii); `invoice/categories` ⇒ listă (doar `FC` e din exemplele oficiale, restul sunt inventate).
- `vat/read` ⇒ `{vat_id, vat_rate:"0.2100", status}`; `handling_time/read` ⇒ `{id, value}`; id-urile de categorii/caracteristici/TVA/localități **nu** sunt cele din producție.
- `order/read`: pe lângă cheile din spec returnează și câmpuri întâlnite în API-ul real (`payment_mode`, `shipping_*`, `part_number_key`, `vat` ca string…).
- `campaign_categories/read`: schema oficială nu menționează filtrul, dar API-ul real cere `campaignId` (camelCase, obligatoriu; altfel HTTP 400 cu `messages: {campaignId: "campaignId cannot be empty"}`, observat la un import real) — dummy-ul se comportă la fel. `eligible-offers` adaugă cheia top-level `next` (URL pagina următoare). Ofertele fără susținere eMAG au `emag_support: []`; cele cu susținere au 1–3 praguri. Tab-ul *Campaigns → Eligible offers* e calculat live (read-only), exact ce răspunde endpoint-ul, plus `key` și `has_emag_support`.
- Textele mesajelor de eroare sunt formulate liber (în engleză), nu cele din producție. Nu se simulează filtrarea pe IP.
- Callback-urile trimit direct entitatea (ca la `*/read`), fără alt „plic”.

## Structura (modular)

```
server.js                 pornire HTTP
src/app.js                asamblare: store + spec + setări + jurnal + module
src/core/                 http pipeline, router, validator OpenAPI, SQLite (db.js, store.js), rate-limit, faults, request log
src/ui/                   api.js (API intern /__ui/api/*), auth.js (conturi, sesiuni)
src/importer/             client read-only către API-ul real, surse de import, anonimizare, manager de job-uri
src/modules/<secțiune>/   index.js (rute + generatoare + acțiuni), service.js (logică), seed.js (date de referință)
public/                   UI (HTML/CSS/JS vanilla, fără build)
spec/openapi.json         specificația oficială v4.5.2
test/                     teste de integrare (API, SQLite, autentificare, import + scanare de credențiale, securitate)
```

**Adaugi o secțiune/endpoint nou** creând `src/modules/<nume>/index.js` și înregistrându-l în `src/modules/index.js`. Un modul declară `collections`, `routes` (cu `body`/`items`/`query` = nume de schemă din spec sau schemă inline — validarea e automată), `generators` și `rowActions`; UI-ul le afișează automat din `/__ui/api/meta`.

Când eMAG publică o versiune nouă: înlocuiește `spec/openapi.json` (se extrage din pagina `/api-doc`, constanta `spec` din HTML) și rulează `npm test`.

## Resetare

*Settings → Data*: export/import de snapshot (colecții + setări, fără conturi/sesiuni), „Reset all data” (șterge colecțiile și reface datele de referință; conturile și jurnalul rămân). Pentru o pornire complet curată oprește serverul și șterge `data/`.
