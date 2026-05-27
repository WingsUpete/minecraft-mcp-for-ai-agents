/**
 * MCP stdio expects every stdout byte to be JSON-RPC. Dependencies often use
 * console.log (stdout); send those to stderr instead.
 * Import this file at the top of your main entrypoint.
 */
const toStderr: typeof console.log = (...args) => {
  console.error(...args);
};

console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;
