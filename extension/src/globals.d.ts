/** True only in test builds (OLR_TEST_HOOKS=1): enables hooks that simulate failures. */
declare const __TEST_HOOKS__: boolean
/** Setting defaults replaced at build time (test builds only; see scripts/build.mjs). */
declare const __SETTINGS_OVERRIDES__: Record<string, unknown>
