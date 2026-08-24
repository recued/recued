#!/usr/bin/env python3
"""rank.py - margin / acquisition / contribution ranking for the trend-margin task.

PRODUCTS file (one line per catalogue row, out-of-stock rows may be omitted):
    slug,product_id,price_usd,landed_cost_usd,platform_fee_pct,monthly_units[,in_stock]
ADCOSTS file (one line per keyword):
    slug,cpc_low_usd,cpc_high_usd,conversion_rate_est
NAMES file (optional, only if a slug is not just the keyword with spaces->hyphens):
    slug|product keyword

margin      = price - landed - price*fee
acquisition = mean(cpc_low, cpc_high) / conversion_rate_est
contribution= margin - acquisition
score       = 0.75*norm(contribution) + 0.25*norm(monthly_units)   (min-max over the
              whole surviving in-stock pool; ties break on product_id ascending)

Usage: rank.py PRODUCTS ADCOSTS [--names NAMES] [--top 15] [--allow-missing]
Prints one compact JSON object on stdout. Exit 1 = fix the input and re-run.
"""
import argparse
import csv
import io
import json
import sys


def die(msg, extra=None):
    o = {'ok': False, 'error': msg}
    if extra:
        o.update(extra)
    print(json.dumps(o, ensure_ascii=False))
    sys.exit(1)


def rows(path):
    out = []
    for ln in open(path, encoding='utf-8', errors='replace').read().splitlines():
        s = ln.strip()
        if not s or s.startswith('#'):
            continue
        rec = next(csv.reader(io.StringIO(s)))
        rec = [c.strip() for c in rec]
        if rec and rec[0].lower() in ('slug', 'product_keyword_slug'):
            continue  # header line
        out.append((s, rec))
    return out


def num(v, line, field):
    try:
        return float(str(v).replace('$', '').replace(',', '').replace('%', ''))
    except Exception:
        die('BAD_NUMBER: %s in line: %s' % (field, line))


TRUTHY = ('1', 'true', 't', 'yes', 'y', 'in_stock')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('products')
    ap.add_argument('adcosts')
    ap.add_argument('--names')
    ap.add_argument('--top', type=int, default=15)
    ap.add_argument('--allow-missing', action='store_true')
    a = ap.parse_args()

    names = {}
    if a.names:
        for ln in open(a.names, encoding='utf-8', errors='replace').read().splitlines():
            if '|' in ln:
                k, v = ln.split('|', 1)
                names[k.strip()] = v.strip()

    ads = {}
    for line, rec in rows(a.adcosts):
        if len(rec) < 4:
            die('BAD_ADCOST_LINE (need slug,cpc_low,cpc_high,conv): %s' % line)
        slug = rec[0]
        lo, hi, cv = (num(rec[1], line, 'cpc_low'), num(rec[2], line, 'cpc_high'),
                      num(rec[3], line, 'conv'))
        if cv <= 0:
            die('BAD_CONVERSION_RATE (must be > 0): %s' % line)
        ads[slug] = ((lo + hi) / 2.0) / cv

    pool, oos, seen_ids, dupe_ids, rows_by_kw, missing = [], 0, set(), 0, {}, set()
    for line, rec in rows(a.products):
        if len(rec) < 6:
            die('BAD_PRODUCT_LINE (need slug,product_id,price,landed,fee,units[,in_stock]): %s' % line)
        slug, pid = rec[0], rec[1]
        rows_by_kw[slug] = rows_by_kw.get(slug, 0) + 1
        if len(rec) >= 7 and rec[6] != '' and rec[6].strip().lower() not in TRUTHY:
            oos += 1
            continue
        if pid in seen_ids:
            dupe_ids += 1
            continue
        seen_ids.add(pid)
        if slug not in ads:
            missing.add(slug)
            continue
        price = num(rec[2], line, 'price')
        landed = num(rec[3], line, 'landed')
        fee = num(rec[4], line, 'fee')
        units = num(rec[5], line, 'units')
        if fee > 1:            # tolerate a percentage written as 8.85
            fee = fee / 100.0
        margin = price - landed - price * fee
        acq = ads[slug]
        pool.append({'slug': slug, 'pid': pid, 'margin': margin, 'acq': acq,
                     'contrib': margin - acq, 'units': units, 'price': price})

    if missing and not a.allow_missing:
        die('MISSING_ADCOSTS: no /ad-costs row for %s - fetch them (or pass --allow-missing).'
            % sorted(missing), {'missing': sorted(missing)})
    if not pool:
        die('EMPTY_POOL: no surviving in-stock rows.')

    cs = [p['contrib'] for p in pool]
    us = [p['units'] for p in pool]
    cmin, cmax, umin, umax = min(cs), max(cs), min(us), max(us)
    warnings = []
    if cmax == cmin or umax == umin:
        warnings.append('DEGENERATE normalisation: a metric has zero range across the pool; '
                        'its normalised value is 0 for every row.')

    def nz(x, lo, hi):
        return 0.0 if hi == lo else (x - lo) / (hi - lo)

    for p in pool:
        p['score'] = 0.75 * nz(p['contrib'], cmin, cmax) + 0.25 * nz(p['units'], umin, umax)
    pool.sort(key=lambda p: (-p['score'], p['pid']))

    top = pool[:a.top]
    ranked = [{'rank': i + 1, 'product_id': p['pid'],
               'product_keyword': names.get(p['slug'], p['slug'].replace('-', ' ')),
               'per_sale_margin_usd': round(p['margin'], 2),
               'acquisition_cost_usd': round(p['acq'], 2),
               'contribution_usd': round(p['contrib'], 2),
               'monthly_units': int(round(p['units']))} for i, p in enumerate(top)]
    diag = [[p['pid'], round(p['score'], 4),
             round(p['margin'] / p['price'], 3) if p['price'] else None,
             round(p['acq'] / p['margin'], 3) if p['margin'] > 0 else None] for p in top]

    if dupe_ids:
        warnings.append('NOTE %d duplicate product_id line(s) ignored.' % dupe_ids)
    if missing:
        warnings.append('EXCLUDED keyword(s) with no ad-cost row: %s' % sorted(missing))
    short = {k: v for k, v in rows_by_kw.items() if v < 15}
    if short:
        warnings.append('CHECK each keyword has 25 catalogue rows (minus any out-of-stock ones you '
                        'skipped); these look short, so lines may have been dropped: %s' % short)

    print(json.dumps({
        'ok': True, 'pool_size': len(pool), 'dropped_out_of_stock': oos,
        'rows_by_kw': rows_by_kw,
        'contribution_range': [round(cmin, 2), round(cmax, 2)],
        'units_range': [int(umin), int(umax)],
        'ranked_products': ranked,
        'diag_legend': ['product_id', 'score', 'margin/price', 'acq/margin'],
        'diag': diag,
        'allowed_product_ids': [r['product_id'] for r in ranked],
        'warnings': warnings}, ensure_ascii=False, separators=(',', ':')))


if __name__ == '__main__':
    main()
