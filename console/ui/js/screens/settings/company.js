// Settings › Company and charter (#/settings/company[/company|charter|certify]): the name, owner and timezone, the
// charter, and certification. The same step bodies as the first-run Setup wizard (screens/setup.js, embedded).
import * as setup from '../setup.js';

export function render(host, ctx) {
  return setup.render(host, Object.assign({}, ctx, { only: ['company', 'charter', 'certify'], embedded: true, extras: true }));
}
