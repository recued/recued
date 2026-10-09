/** Response shapes RECORDED FROM THE LIVE PROVIDERS, with provenance.
 *
 *  ⛔⛔ WHY THESE EXIST AND WHY THEY ARE NOT INVENTED. A mock whose response
 *  shape comes from the test author's belief makes the real bug unreachable from
 *  the only test that would catch it — `provider-mock/pack-ops.ts` exists
 *  because a fabricated `customer_details.email` kept a recipe green through 28
 *  tests while it aborted on every real run. So the substrate generates requests
 *  from each op's declared `bind`, and refuses to synthesise responses.
 *
 *  These packs declare no response contract — and CANNOT: the composition schema
 *  has no field for one. `request_schema` describes the request, `result_path`
 *  says where to walk, and `bind.response_json` is constrained by the validator
 *  to exactly `{ unsafe_integers: 'string' }`, a JSON parse mode. Declaring a
 *  response contract needs a D-165 schema change, not a pack edit.
 *
 *  ⇒ so the shapes below were fetched from the real services instead, with the
 *  packs' own declared User-Agent and their own `static_query`, and verified
 *  rather than eyeballed. That is the difference between a recorded fixture and
 *  a guess: every field and type here was observed, and the provenance says
 *  exactly what was observed and how much of it.
 *
 *  ⚠ A RECORDING IS A SAMPLE, NOT A GUARANTEE. "Always present" below means
 *  present in every sample taken on the date given, not promised by the
 *  provider. A field could be absent for an input shape not sampled. Re-record
 *  before trusting these for anything beyond driving a recipe past its call.
 *
 *  ⚠ THE DOCS WERE WRONG, WHICH IS THE POINT. nominatim.org documents `osm_id`
 *  as a string; the live API returns an INTEGER, and returns `licence`,
 *  `addresstype` and `name` that its field list omits. A contract written from
 *  the documentation would have shipped that error.
 */

/** Nominatim `GET /search?format=jsonv2&addressdetails=1&limit=5`
 *
 *  Recorded 2026-08-01 from https://nominatim.openstreetmap.org, UA
 *  `RecuedNominatimPack/1.0 (https://recued.dev)`. Two queries, 6 results
 *  total; all 15 fields present on all 6, one type each.
 *
 *  ⚠ `address` sub-keys VARY by place (observed: house_number, road, quarter,
 *  suburb, city, state, postcode, country, country_code, office,
 *  ISO3166-2-lvl4/lvl8) and are deliberately not pinned — the provider returns
 *  what a place happens to have.
 *  ⚠ `boundingbox` is four STRINGS: min lat, max lat, min lon, max lon.
 *  ⚠ An empty result set is `[]`; a no-match `reverse` returns an `error`
 *  object instead — NOT sampled, so not represented here.
 */
export const NOMINATIM_SEARCH_RESULT = [{
  "place_id": 281174363,
  "licence": "Data © OpenStreetMap contributors, ODbL 1.0. http://osm.org/copyright",
  "osm_type": "relation",
  "osm_id": 1879842,
  "lat": "51.5034878",
  "lon": "-0.1276965",
  "category": "office",
  "type": "government",
  "place_rank": 30,
  "importance": 0.5505744539169398,
  "addresstype": "office",
  "name": "10 Downing Street",
  "display_name": "10 Downing Street, 10, Downing Street, Westminster, Covent Garden, City of Westminster, Greater London, England, SW1A 2AA, United Kingdom",
  "address": {
    "office": "10 Downing Street",
    "house_number": "10",
    "road": "Downing Street",
    "quarter": "Westminster",
    "suburb": "Covent Garden",
    "city": "City of Westminster",
    "ISO3166-2-lvl8": "GB-WSM",
    "state": "England",
    "ISO3166-2-lvl4": "GB-ENG",
    "postcode": "SW1A 2AA",
    "country": "United Kingdom",
    "country_code": "gb"
  },
  "boundingbox": [
    "51.5033074",
    "51.5036913",
    "-0.1277991",
    "-0.1273088"
  ]
}] as const;

/** Nominatim `GET /reverse?format=jsonv2&addressdetails=1&zoom=18`
 *  Same 15 fields, but the top level is a single OBJECT, not an array. */
export const NOMINATIM_REVERSE_RESULT = NOMINATIM_SEARCH_RESULT[0];

/** SEC `GET https://www.sec.gov/files/company_tickers.json`
 *
 *  Recorded 2026-08-01 with UA `RecuedSecEdgarPack/1.0 (https://recued.dev)`.
 *  796,564 bytes, 10,412 entries. Verified across EVERY entry, not a sample:
 *  one key set `(cik_str, ticker, title)` and one type set `(int, str, str)` —
 *  zero variants. The top level is an OBJECT whose keys are the stringified
 *  indices "0".."10411", NOT an array and NOT keyed by CIK.
 *
 *  ⚠ The three entries below are the file's first three, VERBATIM. An earlier
 *  draft of this file had me typing them from memory and getting two of the
 *  three wrong — so they are emitted from the recorded bytes, never retyped.
 */
export const SEC_TICKER_MAP = {
  "0": {
    "cik_str": 320193,
    "ticker": "AAPL",
    "title": "Apple Inc."
  },
  "1": {
    "cik_str": 1045810,
    "ticker": "NVDA",
    "title": "NVIDIA CORP"
  },
  "2": {
    "cik_str": 1652044,
    "ticker": "GOOGL",
    "title": "Alphabet Inc."
  }
} as const;

/** SEC `GET https://data.sec.gov/api/xbrl/companyconcept/CIK0000320193/us-gaap/RevenueFromContractWithCustomerExcludingAssessedTax.json`
 *
 *  Recorded 2026-10-08 with UA `RecuedSecEdgarPack/1.0 (https://recued.dev)`, HTTP 200,
 *  18,356 bytes, 117 facts, all under `units.USD`. Verified across every fact:
 *  two key sets only, `(accn, end, filed, form, fp, fy, start, val)` and the same plus `frame`
 *  (39 of 117).
 *
 *  ⛔⛔ THE SHAPE A HAND-WRITTEN FIXTURE GOT WRONG. One `end` date carries SEVERAL facts: a 10-Q
 *  reports the quarter AND the year to date (`start` differs), and a later filing repeats earlier
 *  periods as comparatives, carrying ITS OWN `fy` / `fp`. Only the fact the SEC aligned to a
 *  calendar period carries a `frame` (`CY2026Q2` a quarter, `CY2025` a year). The earlier fixture
 *  had one fact per date, no `start`, no `frame` — and so could not reach the defect it hid.
 *
 *  ⚠ `units.USD` is trimmed to the 18 facts ending on or after 2024-09-28 (Apple's FY2024
 *  year end), each VERBATIM and in recorded order: 8 framed, 6 end dates with
 *  more than one fact. Emitted from the recorded bytes by script, never retyped. */
export const SEC_COMPANY_CONCEPT_AAPL_REVENUE = {
  "cik": 320193,
  "taxonomy": "us-gaap",
  "tag": "RevenueFromContractWithCustomerExcludingAssessedTax",
  "label": "Revenue from Contract with Customer, Excluding Assessed Tax",
  "description": "Amount, excluding tax collected from customer, of revenue from satisfaction of performance obligation by transferring promised good or service to customer. Tax collected from customer is tax assessed by governmental authority that is both imposed on and concurrent with specific revenue-producing transaction, including, but not limited to, sales, use, value added and excise.",
  "entityName": "Apple Inc.",
  "units": {
    "USD": [
      {"start": "2023-10-01", "end": "2024-09-28", "val": 391035000000, "accn": "0000320193-24-000123", "fy": 2024, "fp": "FY", "form": "10-K", "filed": "2024-11-01"},
      {"start": "2023-10-01", "end": "2024-09-28", "val": 391035000000, "accn": "0000320193-25-000079", "fy": 2025, "fp": "FY", "form": "10-K", "filed": "2025-10-31", "frame": "CY2024"},
      {"start": "2024-09-29", "end": "2024-12-28", "val": 124300000000, "accn": "0000320193-25-000008", "fy": 2025, "fp": "Q1", "form": "10-Q", "filed": "2025-01-31"},
      {"start": "2024-09-29", "end": "2024-12-28", "val": 124300000000, "accn": "0000320193-26-000006", "fy": 2026, "fp": "Q1", "form": "10-Q", "filed": "2026-01-30", "frame": "CY2024Q4"},
      {"start": "2024-09-29", "end": "2025-03-29", "val": 219659000000, "accn": "0000320193-25-000057", "fy": 2025, "fp": "Q2", "form": "10-Q", "filed": "2025-05-02"},
      {"start": "2024-09-29", "end": "2025-03-29", "val": 219659000000, "accn": "0000320193-26-000013", "fy": 2026, "fp": "Q2", "form": "10-Q", "filed": "2026-05-01"},
      {"start": "2024-12-29", "end": "2025-03-29", "val": 95359000000, "accn": "0000320193-25-000057", "fy": 2025, "fp": "Q2", "form": "10-Q", "filed": "2025-05-02"},
      {"start": "2024-12-29", "end": "2025-03-29", "val": 95359000000, "accn": "0000320193-26-000013", "fy": 2026, "fp": "Q2", "form": "10-Q", "filed": "2026-05-01", "frame": "CY2025Q1"},
      {"start": "2024-09-29", "end": "2025-06-28", "val": 313695000000, "accn": "0000320193-25-000073", "fy": 2025, "fp": "Q3", "form": "10-Q", "filed": "2025-08-01"},
      {"start": "2024-09-29", "end": "2025-06-28", "val": 313695000000, "accn": "0000320193-26-000020", "fy": 2026, "fp": "Q3", "form": "10-Q", "filed": "2026-07-31"},
      {"start": "2025-03-30", "end": "2025-06-28", "val": 94036000000, "accn": "0000320193-25-000073", "fy": 2025, "fp": "Q3", "form": "10-Q", "filed": "2025-08-01"},
      {"start": "2025-03-30", "end": "2025-06-28", "val": 94036000000, "accn": "0000320193-26-000020", "fy": 2026, "fp": "Q3", "form": "10-Q", "filed": "2026-07-31", "frame": "CY2025Q2"},
      {"start": "2024-09-29", "end": "2025-09-27", "val": 416161000000, "accn": "0000320193-25-000079", "fy": 2025, "fp": "FY", "form": "10-K", "filed": "2025-10-31", "frame": "CY2025"},
      {"start": "2025-09-28", "end": "2025-12-27", "val": 143756000000, "accn": "0000320193-26-000006", "fy": 2026, "fp": "Q1", "form": "10-Q", "filed": "2026-01-30", "frame": "CY2025Q4"},
      {"start": "2025-09-28", "end": "2026-03-28", "val": 254940000000, "accn": "0000320193-26-000013", "fy": 2026, "fp": "Q2", "form": "10-Q", "filed": "2026-05-01"},
      {"start": "2025-12-28", "end": "2026-03-28", "val": 111184000000, "accn": "0000320193-26-000013", "fy": 2026, "fp": "Q2", "form": "10-Q", "filed": "2026-05-01", "frame": "CY2026Q1"},
      {"start": "2025-09-28", "end": "2026-06-27", "val": 364357000000, "accn": "0000320193-26-000020", "fy": 2026, "fp": "Q3", "form": "10-Q", "filed": "2026-07-31"},
      {"start": "2026-03-29", "end": "2026-06-27", "val": 109417000000, "accn": "0000320193-26-000020", "fy": 2026, "fp": "Q3", "form": "10-Q", "filed": "2026-07-31", "frame": "CY2026Q2"},
    ],
  },
} as const;
