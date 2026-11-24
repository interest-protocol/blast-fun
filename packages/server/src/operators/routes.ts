import { operatorRoute, type OperatorRouteId } from "@blast/core/modules/backend-api/operator-routes.ts";

type Handler = (request: Request) => Promise<Response>;

/**
 * Dispatches an `OPERATOR_ROUTES` row to its owner. The backend transport has
 * already refused unknown paths and checked each row's `auth`.
 */
export function createOperatorRoutes(handlers: Readonly<Record<OperatorRouteId, Handler>>) {
  return async (request: Request): Promise<Response | null> => {
    const match = operatorRoute(new URL(request.url).pathname);
    return match ? handlers[match.route.id](request) : null;
  };
}
