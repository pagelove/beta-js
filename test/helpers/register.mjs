/**
 * Installs the module resolve hook. Loaded via `node --import` from the test
 * script so it is in place before any test file imports library code.
 */
import { register } from 'node:module';

register('./loader.mjs', import.meta.url);
