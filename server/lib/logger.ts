/** Thin logger — drop-in replacement for console.log calls.
 *  Uses console.info / console.warn / console.error so the
 *  eslint no-console rule is satisfied.                      */
export const logger = {
    info: (...args: unknown[]) => console.info(...args),
    warn: (...args: unknown[]) => console.warn(...args),
    error: (...args: unknown[]) => console.error(...args),
    debug: (...args: unknown[]) =>
        process.env.NODE_ENV === "development" ? console.info("[debug]", ...args) : undefined,
};
