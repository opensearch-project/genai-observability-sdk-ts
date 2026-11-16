// An instrumentation that loads but fails when it is wired to a provider.
export class Throwing {
  setTracerProvider() {
    throw new Error('no provider for you');
  }
  enable() {}
}
