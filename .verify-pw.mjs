import { readFileSync } from 'node:fs';
const t = readFileSync('node_modules/playwright-core/lib/coreBundle.js', 'utf8');
let k = -1;
const hits = [];
while ((k = t.indexOf('launchPersistentContext', k + 1)) >= 0) {
  const ctx = t.slice(k - 200, k + 300).replace(/\n/g, ' | ');
  if (/dispatcher|Dispatcher|_dispatch|toImmutable|handler/.test(ctx)) hits.push(ctx);
}
console.log(hits.slice(0, 6).join('\n=====\n'));
