/**
 * Dev-only logger. No-ops in production to avoid leaking data via console.
 */
const isDev = typeof import.meta !== 'undefined' && import.meta.env?.DEV === true;

export const log = (...args) => isDev && console.log(...args);
export const warn = (...args) => isDev && console.warn(...args);
export const error = (...args) => isDev && console.error(...args);
