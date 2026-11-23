/** D-339 slice 12a (D-339 §5.6) — the owner's chats' switch for a Body's numbers, on every
 *  Body's page: Off · Ask · Allow, each choice saying what it does.
 *
 *  The page is driven in real Chrome by `scripts/drives/d-339-ask-with-numbers-live.mjs`; here, the words
 *  and the seams the page builds them in. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BODY_NUMBERS_MODES } from '@recued/contracts';
import { BODY_NUMBERS_CHOICES, BODY_NUMBERS_INTRO, BODY_NUMBERS_TITLE, bodyNumbersSetWords } from '../yours/body-numbers-words.js';

describe('D-339 slice 12a — the switch in the owner\'s words', () => {
  it('every choice, in order, says what it does: none is only "not the other one"', () => {
    expect(BODY_NUMBERS_CHOICES.map(choice => choice.mode)).toEqual([...BODY_NUMBERS_MODES]);
    expect(BODY_NUMBERS_CHOICES.map(choice => `${choice.label}: ${choice.words}`)).toEqual([
      'Off: Your chats can’t read the numbers.',
      'Ask: Your chats ask you before each read.',
      'Allow: Your chats read the numbers without asking.',
    ]);
  });

  it('says it is one switch for every Body, what chats see anyway, and where an AI app\'s is', () => {
    expect(BODY_NUMBERS_TITLE).toBe('Body numbers in your chats');
    expect(BODY_NUMBERS_INTRO).toBe('One switch for every Body. Your chats always see the names of the readings, not the numbers. '
      + 'AI apps have their own switch, in Contracts.');
  });

  it('what the page says once it is set', () => {
    expect(BODY_NUMBERS_MODES.map(bodyNumbersSetWords)).toEqual([
      'Body numbers are off for your chats.',
      'Your chats will ask before reading body numbers.',
      'Your chats will read body numbers without asking.',
    ]);
  });
});

describe('⛔ D-339 slice 12a — the seams on the page', () => {
  const route = readFileSync(new URL('../yours/bootstrap-yours-route.ts', import.meta.url), 'utf8');
  const bootstrap = readFileSync(new URL('../webclient-bootstrap.ts', import.meta.url), 'utf8');
  const block = route.slice(route.indexOf('// D-339 slice 12a — on a Body\'s page'), route.indexOf('const facts = section(panels.overview'));

  it('shows it on a Body\'s page only, as the server read it, each choice a radio checked as it stands', () => {
    expect(block).toMatch(/if \(snapshot\.body_numbers && asset\.class_id === 'body'\) \{/u);
    expect(block).toMatch(/input\.type = 'radio'; input\.name = 'body-numbers'; input\.value = choice\.mode;/u);
    expect(block).toMatch(/input\.checked = choice\.mode === chats; input\.disabled = options\.bodyNumbers === undefined;/u);
    expect(block).toMatch(/el\('span', `\$\{choice\.label\}: \$\{choice\.words\}`, host\)/u);
  });

  it('a new choice is set through the server, and the page reads it again (the shared write)', () => {
    expect(block).toMatch(/if \(input\.checked && choice\.mode !== chats\) void setBodyNumbers\(choice\.mode\);/u);
    expect(route).toMatch(/const setBodyNumbers = \(chats: BodyNumbersMode\) => write\(async \(\): Promise<YoursCommandResult> =>\n\s+\(\{ message: bodyNumbersSetWords\(\(await options\.bodyNumbers!\.set\(chats\)\)\.chats\) \}\)\);/u);
  });

  it('the app sends it to contract.grant.body_numbers.write', () => {
    expect(bootstrap).toMatch(/bodyNumbers: \{ set: chats => rpcConn\.call\('contract\.grant\.body_numbers\.write', \{ chats \}\) \},/u);
  });
});
