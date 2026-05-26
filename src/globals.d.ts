// Build-time constants injected by esbuild's `define` option.
// Production builds substitute literal values, so dead-code elimination
// can strip any `if (__BUTTER_DEV__) { … }` block from the bundle.

declare const __BUTTER_DEV__: boolean;
