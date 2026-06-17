const DEV = import.meta.env.DEV;
const noop = () => {};

export const logger = {
  log:   DEV ? console.log.bind(console)   : noop,
  info:  DEV ? console.info.bind(console)  : noop,
  warn:  DEV ? console.warn.bind(console)  : noop,
  error: console.error.bind(console),
};

export function tagLog(scope, msg, ...rest) {
  if (!DEV) return;
  console.log(`%c[${scope}] ${msg}`, 'color:#00cc00;font-weight:bold', ...rest);
}
