const PREFIX = "[rd-core]";

export const log = {
  debug: (...a: unknown[]) => console.debug(PREFIX, ...a),
  info: (...a: unknown[]) => console.info(PREFIX, ...a),
  warn: (...a: unknown[]) => console.warn(PREFIX, ...a),
  error: (...a: unknown[]) => console.error(PREFIX, ...a),
};
