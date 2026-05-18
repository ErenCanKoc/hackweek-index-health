import { seedContext } from '../src/core/bootstrap.js';

const { counts, thresholds, store } = await seedContext({ reset: true });
console.log(JSON.stringify({
  ok: true,
  counts,
  thresholds,
  urls: store.state.urls.length,
  properties: store.state.properties.length
}, null, 2));
