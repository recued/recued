export const stripSourceComments = (source: string): string => {
  let output = '';
  let i = 0;
  let state: 'normal' | 'single' | 'double' | 'template' = 'normal';

  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];

    if (state === 'normal') {
      if (ch === '/' && next === '/') {
        i += 2;
        while (i < source.length && source[i] !== '\n') i++;
        continue;
      }
      if (ch === '/' && next === '*') {
        i += 2;
        while (i < source.length) {
          const blockCh = source[i]!;
          if (blockCh === '\n') output += '\n';
          if (blockCh === '*' && source[i + 1] === '/') {
            i += 2;
            break;
          }
          i++;
        }
        continue;
      }
      if (ch === "'") state = 'single';
      else if (ch === '"') state = 'double';
      else if (ch === '`') state = 'template';
      output += ch;
      i++;
      continue;
    }

    output += ch;
    if (ch === '\\') {
      if (i + 1 < source.length) {
        output += source[i + 1]!;
        i += 2;
        continue;
      }
    } else if (
      (state === 'single' && ch === "'") ||
      (state === 'double' && ch === '"') ||
      (state === 'template' && ch === '`')
    ) {
      state = 'normal';
    }
    i++;
  }

  return output;
};
