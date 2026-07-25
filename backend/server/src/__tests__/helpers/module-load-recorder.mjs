import { appendFileSync } from 'node:fs';

const tracePath = process.env.RECUED_MODULE_LOAD_TRACE;

const record = (entry) => {
  if (!tracePath) return;
  appendFileSync(tracePath, `${JSON.stringify(entry)}\n`);
};

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  record({
    kind: 'resolve',
    specifier,
    parentURL: context.parentURL,
    url: result.url,
  });
  return result;
}
