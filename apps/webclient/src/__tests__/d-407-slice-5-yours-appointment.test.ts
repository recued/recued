/** D-407 slice 5 (U2) — an occasion that holds an event it did not write (a clinic's invite the owner ticked
 *  Occasion on) shows one appointment: where it came from on its card, and on its own page the event's title and time
 *  and the booking the same invite made, never three records to manage. The words, and the seams the card and page
 *  build them in. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { occasionHeldFrom } from '../yours/bootstrap-yours-route.js';

const route = readFileSync(resolve(import.meta.dirname, '..', 'yours', 'bootstrap-yours-route.ts'), 'utf8');

describe('D-407 slice 5 — the appointment an occasion holds, in Yours', () => {
  it('says where it came from: an invite by its organizer, else the event in its calendar', () => {
    expect(occasionHeldFrom({ name: 'Work', appointment: { organizer: 'clinic@hospital.example' } })).toBe('from clinic@hospital.example’s invite');
    expect(occasionHeldFrom({ name: 'Work', appointment: {} })).toBe('follows an event in Work');
  });

  it('the card says it in place of "in <calendar>", and the page lists the event, its time and its booking', () => {
    expect(route).toMatch(/: snapshot\.occasion_events\[occasion\.id\]!\.appointment\s+\? ` · \$\{occasionHeldFrom\(snapshot\.occasion_events\[occasion\.id\]!\)\}`\s+: ` · in \$\{snapshot\.occasion_events\[occasion\.id\]!\.name\}`/u);
    expect(route).toMatch(/const appointment = section\(item, 'Appointment'\); appointment\.setAttribute\(YOURS_OCCASION_APPOINTMENT_ATTR, occasion\.id\);/u);
    expect(route).toMatch(/el\('p', `\$\{held\.appointment\.title\}, \$\{at\}`, appointment\)/u);
    expect(route).toMatch(/if \(held\.appointment\.booking\) el\('p', `Its booking: \$\{held\.appointment\.booking\}`, appointment\);/u);
    // On its own page only, as its suggestions and history are.
    const page = route.indexOf('if (occasion.id === selectedOccasion) {');
    expect(route.indexOf("section(item, 'Appointment')")).toBeGreaterThan(page);
    expect(route.indexOf("section(item, 'Appointment')")).toBeLessThan(route.indexOf("section(item, 'History')"));
  });
});
