import { TRANSPORT_LIMITS } from "./contracts.ts";
import { refusal } from "./responses.ts";

/** One permit covers authentication, handler work and the entire streamed response. */
export function requestLifetime(
  request: Request,
  release: () => void,
  code: string,
  deadlineMs: number = TRANSPORT_LIMITS.deadlineMs,
) {
  const controller = new AbortController();
  let settled = false;
  let finished = false;
  let released = false;
  let completeBody: (() => void) | undefined;
  let timeoutResponse!: (response: Response) => void;
  const aborted = new Promise<Response>((resolve) => {
    timeoutResponse = resolve;
  });

  function cleanup() {
    if (!settled || !finished || released) {
      return;
    }
    released = true;
    clearTimeout(timer);
    request.signal.removeEventListener("abort", disconnected);
    release();
  }

  function finish() {
    finished = true;
    cleanup();
  }

  function abort(reason: unknown) {
    if (controller.signal.aborted) {
      return;
    }
    controller.abort(reason);
    timeoutResponse(refusal(503, code, 5));
    if (completeBody) {
      completeBody();
    } else {
      finish();
    }
  }

  const disconnected = () => abort(request.signal.reason);
  const timer = setTimeout(
    () => abort(new Error("Backend request deadline exceeded.")),
    deadlineMs,
  );
  request.signal.addEventListener("abort", disconnected, { once: true });
  if (request.signal.aborted) {
    disconnected();
  }

  function responseBody(response: Response): Response {
    settled = true;
    if (controller.signal.aborted) {
      void Promise.resolve(response.body?.cancel())
        .catch(() => {})
        .then(finish);
      return refusal(503, code, 5);
    }
    if (!response.body || request.method === "HEAD") {
      void Promise.resolve(response.body?.cancel())
        .catch(() => {})
        .then(finish);
      return new Response(null, {
        status: response.status,
        headers: response.headers,
      });
    }
    const reader = response.body.getReader();
    let streamController: ReadableStreamDefaultController<Uint8Array>;
    let ended = false;

    function end(reason?: unknown) {
      if (ended) {
        return;
      }
      ended = true;
      if (reason) {
        streamController.error(reason);
        void reader
          .cancel(reason)
          .catch(() => {})
          .then(finish);
      } else {
        finish();
      }
    }

    completeBody = () => end(controller.signal.reason);
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        streamController = stream;
      },
      async pull(stream) {
        try {
          const chunk = await reader.read();
          if (ended) {
            return;
          }
          if (chunk.done) {
            stream.close();
            end();
          } else {
            stream.enqueue(chunk.value);
          }
        } catch (error) {
          end(error);
        }
      },
      cancel(reason) {
        if (!ended) {
          ended = true;
          controller.abort(reason);
        }
        return reader
          .cancel(reason)
          .catch(() => {})
          .then(finish);
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  return {
    signal: controller.signal,
    aborted,
    responseBody,
    failed(error: unknown) {
      settled = true;
      finish();
      return error instanceof Response ? error : refusal(503, code, 5);
    },
  };
}
