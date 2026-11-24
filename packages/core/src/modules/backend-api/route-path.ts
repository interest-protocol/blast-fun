/**
 * A route's path with named segments, such as `/api/social/profiles/:callsign/pnl`.
 * Each `:name` matches one non-empty segment unless the route gives that name its own pattern.
 */
export type RoutePath = `/${string}`;

export type RouteParamPatterns = Readonly<Record<string, string>>;

type ParamNames<P extends string> = P extends `${string}:${infer Name}/${infer Rest}`
  ? Name | ParamNames<`/${Rest}`>
  : P extends `${string}:${infer Name}`
    ? Name
    : never;

/** Each `:name` segment of a path exactly as the request wrote it. */
export type RouteSegments<P extends RoutePath> = { readonly [K in ParamNames<P>]: string };

/** Each `:name` segment URL-decoded once; null when it is not valid percent-encoding. */
export type RouteParams<P extends RoutePath> = { readonly [K in ParamNames<P>]: string | null };

const ANY_SEGMENT = "[^/]+";
// Empty segments match so the handler's own validator names the bad parameter.
const SHAPE_SEGMENT = "[^/]*";

const shapes = new Map<string, RegExp>();

/** The whole-path matcher for a route path; each parameter becomes a named group. */
export function routePattern(path: RoutePath, params: RouteParamPatterns = {}): RegExp {
  return compile(path, (name) => params[name] ?? ANY_SEGMENT);
}

/** The raw `:name` segments of `pathname`, or null when its shape differs from `path`. */
export function routeSegments<P extends RoutePath>(path: P, pathname: string): RouteSegments<P> | null {
  let shape = shapes.get(path);
  if (!shape) {
    shape = compile(path, () => SHAPE_SEGMENT);
    shapes.set(path, shape);
  }
  const match = shape.exec(pathname);
  return match ? ({ ...match.groups } as RouteSegments<P>) : null;
}

/** The `:name` segments of `pathname`, each URL-decoded once, or null when its shape differs from `path`. */
export function routeParams<P extends RoutePath>(path: P, pathname: string): RouteParams<P> | null {
  const segments = routeSegments(path, pathname);
  if (!segments) {
    return null;
  }

  return Object.fromEntries(
    Object.entries(segments).map(([name, raw]) => [name, decoded(raw as string)]),
  ) as RouteParams<P>;
}

function compile(path: RoutePath, segmentFor: (name: string) => string): RegExp {
  const segments = path.split("/").map((segment) => {
    if (!segment.startsWith(":")) {
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    const name = segment.slice(1);
    return `(?<${name}>${segmentFor(name)})`;
  });
  return new RegExp(`^${segments.join("/")}$`);
}

function decoded(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}
