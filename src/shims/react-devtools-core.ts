/**
 * Ink statically imports react-devtools-core, which it only ever uses when
 * DEV=true. The real package is not a runtime dependency of this CLI, so it is
 * aliased to this no-op for `bun build --compile`.
 */
export default {
  connectToDevTools(): void {},
};
