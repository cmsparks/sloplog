/**
 * Example sloplog registry file.
 *
 * This filename/location is just a convention. config() accepts any path.
 * Swap this out for your own registry when you define custom partials.
 */

import { builtInRegistry } from './js/partials.js';
import { config } from './js/codegen.js';

await config({
  registry: builtInRegistry,
  outDir: '.',
  outputs: {
    python: 'python/sloplog/partials.py',
    jsonschema: 'generated/sloplog.json',
  },
});

export default builtInRegistry;
