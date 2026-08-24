#!/usr/bin/env python3
"""slate.py - build the term slate for the trend-margin task.

Input modes are auto-detected from the file contents:
  compact : lines  DATE|TERM|BUCKET   (field order auto-detected per line)
  json    : the whole /trends/us-7d body, e.g. {"row_count":3030,"csv":"..."}
  csv     : bare CSV text with the standard header row

Usage:  slate.py ROWS_FILE [--now NOW_FILE] [--top 5]
Prints one compact JSON object on stdout. Exit 2 = hard failure.
"""
import argparse
import csv
import io
import json
import re
import sys

# U+202F narrow no-break space appears before AM/PM in the Started column.
_WS = {'\u202f': ' ', '\u00a0': ' ', '\u2009': ' ', '\ufeff': ''}


def clean(s):
    if s is None:
        return ''
    s = str(s)
    for k, v in _WS.items():
        s = s.replace(k, v)
    return s.strip()


VOL_RE = re.compile(r'^([0-9][0-9,]*(?:\.[0-9]+)?)\s*([KMB]?)\+?$', re.I)
MULT = {'': 1, 'K': 1000, 'M': 1000000, 'B': 1000000000}


def parse_volume(s):
    """'200K+' -> 200000 ; '2K+' -> 2000 ; '200+' -> 200 ; '1,500' -> 1500."""
    s = clean(s).strip('"').replace(' ', '')
    m = VOL_RE.match(s)
    if not m:
        return None
    return int(round(float(m.group(1).replace(',', '')) * MULT[m.group(2).upper()]))


MONTHS = {m: i + 1 for i, m in enumerate(
    ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'])}
D_MDY = re.compile(r'^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$')
D_ISO = re.compile(r'^(\d{4})-(\d{1,2})-(\d{1,2})$')
D_SLASH = re.compile(r'^(\d{1,2})/(\d{1,2})/(\d{4})$')


def parse_day(s):
    """'August 23, 2026 at 11:30:00 AM UTC-7' -> '2026-08-23'. None if not a date."""
    s = clean(s).strip('"')
    i = s.lower().find(' at ')
    if i != -1:
        s = s[:i]
    s = s.strip().rstrip(',').strip()
    m = D_MDY.match(s)
    if m:
        mo = MONTHS.get(m.group(1)[:3].lower())
        if mo:
            return '%04d-%02d-%02d' % (int(m.group(3)), mo, int(m.group(2)))
    m = D_ISO.match(s)
    if m:
        return '%04d-%02d-%02d' % (int(m.group(1)), int(m.group(2)), int(m.group(3)))
    m = D_SLASH.match(s)
    if m:
        return '%04d-%02d-%02d' % (int(m.group(3)), int(m.group(1)), int(m.group(2)))
    return None


def die(msg):
    print(json.dumps({'ok': False, 'error': msg}, ensure_ascii=False))
    sys.exit(2)


TRUNC = re.compile(r'\[\s*\.\.\..{0,40}truncated', re.I)


def parse_csv_text(text):
    rdr = csv.reader(io.StringIO(text))
    recs = [r for r in rdr if r and any(c.strip() for c in r)]
    if not recs:
        return []
    idx = (0, 1, 2)
    hdr = [clean(c).lower() for c in recs[0]]
    if 'trends' in hdr or 'search volume' in hdr:
        idx = (hdr.index('trends') if 'trends' in hdr else 0,
               hdr.index('search volume') if 'search volume' in hdr else 1,
               hdr.index('started') if 'started' in hdr else 2)
        recs = recs[1:]
    out = []
    for r in recs:
        term = clean(r[idx[0]]) if len(r) > idx[0] else ''
        vol = parse_volume(r[idx[1]]) if len(r) > idx[1] else None
        day = parse_day(r[idx[2]]) if len(r) > idx[2] else None
        out.append((day, term, vol))
    return out


def _pick_vol_index(parts, skip):
    # prefer a bucket-looking field ('200K+', '2K+', '10M+') over a bare number
    for i, p in enumerate(parts):
        if i == skip:
            continue
        q = clean(p)
        if (q.endswith('+') or re.search(r'[KMB]\+?$', q, re.I)) and parse_volume(q) is not None:
            return i
    for i, p in enumerate(parts):
        if i != skip and parse_volume(p) is not None:
            return i
    return None


def parse_compact(raw):
    out, bad = [], 0
    for ln in raw.splitlines():
        ln = ln.strip()
        if not ln or ln.startswith('#'):
            continue
        parts = [p.strip() for p in (ln.split('|') if '|' in ln else ln.split('\t'))]
        if len(parts) < 3:
            bad += 1
            continue
        di = next((i for i, p in enumerate(parts) if parse_day(p)), None)
        vi = _pick_vol_index(parts, di)
        if di is None or vi is None:
            if len(parts) == 3:  # positional fallback: DATE|TERM|BUCKET
                out.append((parse_day(parts[0]), clean(parts[1]), parse_volume(parts[2])))
            else:
                bad += 1
            continue
        term = '|'.join(p for i, p in enumerate(parts) if i not in (di, vi)).strip()
        out.append((parse_day(parts[di]), term, parse_volume(parts[vi])))
    return out, bad


def load_rows(path):
    raw = open(path, encoding='utf-8', errors='replace').read()
    if TRUNC.search(raw):
        die('TRUNCATED_INPUT: a truncation marker is present in the supplied payload; '
            'the data is incomplete - declare it, do not proceed on a fragment.')
    t = raw.lstrip()
    if t.startswith('{'):
        try:
            body = json.loads(t)
        except Exception as e:
            die('JSON_PARSE: %s (body likely truncated)' % e)
        text = body.get('csv') or ''
        return parse_csv_text(text), body.get('row_count'), 'json', 0
    first = next((l for l in raw.splitlines() if l.strip()), '')
    if 'Search volume' in first or first.lower().lstrip('"').startswith('trends'):
        return parse_csv_text(raw), None, 'csv', 0
    rows, bad = parse_compact(raw)
    return rows, None, 'compact', bad


def load_now(path):
    raw = open(path, encoding='utf-8', errors='replace').read().strip()
    if raw.startswith('{'):
        body = json.loads(raw)
        return [(clean(t.get('term')), parse_volume(t.get('approx_traffic_bucket')))
                for t in body.get('terms', [])]
    out = []
    for ln in raw.splitlines():
        ln = ln.strip()
        if not ln or ln.startswith('#'):
            continue
        if '|' in ln:
            a, b = ln.split('|', 1)
            out.append((clean(a), parse_volume(b)))
        else:
            out.append((clean(ln), None))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('rows')
    ap.add_argument('--now')
    ap.add_argument('--top', type=int, default=5)
    a = ap.parse_args()

    rows, declared, mode, bad = load_rows(a.rows)
    warnings = []
    if bad:
        warnings.append('UNPARSED %d input line(s) skipped - check the DATE|TERM|BUCKET format.' % bad)

    by_day, dropped, dups = {}, 0, 0
    for day, term, vol in rows:
        if not day or not term or vol is None:
            dropped += 1
            continue
        d = by_day.setdefault(day, {})
        if term in d:
            dups += 1
            if vol > d[term]:
                d[term] = vol
        else:
            d[term] = vol
    if dropped:
        warnings.append('DROPPED %d row(s) missing a parseable day/term/volume.' % dropped)
    if declared is not None and len(rows) != declared:
        warnings.append('PARTIAL rowcount: parsed %d of the declared %d rows - the payload was '
                        'truncated; per-day top-%d may be incomplete.' % (len(rows), declared, a.top))
    if not by_day:
        die('NO_ROWS: nothing parseable in %s' % a.rows)

    days_out, slate, seen = {}, [], {}
    for day in sorted(by_day):
        items = sorted(by_day[day].items(), key=lambda kv: (-kv[1], kv[0]))
        days_out[day] = len(items)
        top = items[:a.top]
        if len(items) < a.top:
            warnings.append('INSUFFICIENT %s: only %d term(s) supplied, need %d - go back to the '
                            'CSV already in context and add the next volume bucket down for this '
                            'day, then re-run.' % (day, len(items), a.top))
        elif mode == 'compact' and top[-1][1] <= min(v for _, v in items):
            warnings.append('VERIFY %s: the rank-%d term sits at the lowest bucket you supplied '
                            '(%d) - confirm you copied EVERY row of that bucket for this day '
                            '(ties break on term ascending).' % (day, a.top, top[-1][1]))
        for term, vol in top:
            k = term.casefold()
            if k in seen:
                e = slate[seen[k]]
                e['v'] = max(e['v'], vol)
                continue
            seen[k] = len(slate)
            slate.append({'t': term, 'v': vol, 'd': day})

    from_7d = len(slate)
    from_now = 0
    if a.now:
        for term, vol in load_now(a.now):
            if not term or term.casefold() in seen:
                continue
            seen[term.casefold()] = len(slate)
            slate.append({'t': term, 'v': vol, 'd': 'now'})
            from_now += 1

    if len(days_out) not in (7, 8):
        warnings.append('NOTE %d distinct calendar day(s) - a 7d window normally spans 7 or 8.'
                        % len(days_out))
    if dups:
        warnings.append('NOTE %d duplicate term/day row(s) collapsed to their max volume.' % dups)

    ok = not any(w.startswith(('INSUFFICIENT', 'PARTIAL')) for w in warnings)
    print(json.dumps({'ok': ok, 'mode': mode, 'rows_in': len(rows), 'days': days_out,
                      'term_count': len(slate), 'from_7d': from_7d, 'from_now': from_now,
                      'slate': slate, 'warnings': warnings},
                     ensure_ascii=False, separators=(',', ':')))
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
