import { lazy, Suspense, type ComponentType } from 'react';

/** Load a named export on first render so it stays out of the entry chunk. */
export function lazyNamed<P extends object>(load: () => Promise<ComponentType<P>>): ComponentType<P> {
  const Comp = lazy(() => load().then((C) => ({ default: C }))) as ComponentType<P>;
  return function LazyBoundary(props: P) {
    return (
      <Suspense fallback={null}>
        <Comp {...props} />
      </Suspense>
    );
  };
}
