import { corsHeaders, corsHeadersFor } from "./cors.ts";

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

function jsonResponse(status: number, body: ErrorBody, req?: Request): Response {
  const hdrs = req
    ? { ...corsHeadersFor(req), "Content-Type": "application/json" }
    : { ...corsHeaders, "Content-Type": "application/json" };
  return new Response(JSON.stringify(body), { status, headers: hdrs });
}

export function badRequest(
  reqOrMessage?: Request | string,
  messageOrDetails?: string | unknown,
  details?: unknown,
): Response {
  if (reqOrMessage instanceof Request) {
    return jsonResponse(400, {
      error: { code: "BAD_REQUEST", message: (messageOrDetails as string) ?? "Bad request", details },
    }, reqOrMessage);
  }
  return jsonResponse(400, {
    error: { code: "BAD_REQUEST", message: reqOrMessage ?? "Bad request", details: messageOrDetails },
  });
}

export function unauthorized(reqOrMessage?: Request | string, message?: string): Response {
  if (reqOrMessage instanceof Request) {
    return jsonResponse(401, {
      error: { code: "UNAUTHORIZED", message: message ?? "Unauthorized" },
    }, reqOrMessage);
  }
  return jsonResponse(401, {
    error: { code: "UNAUTHORIZED", message: reqOrMessage ?? "Unauthorized" },
  });
}

export function forbidden(reqOrMessage?: Request | string, message?: string): Response {
  if (reqOrMessage instanceof Request) {
    return jsonResponse(403, {
      error: { code: "FORBIDDEN", message: message ?? "Forbidden" },
    }, reqOrMessage);
  }
  return jsonResponse(403, {
    error: { code: "FORBIDDEN", message: reqOrMessage ?? "Forbidden" },
  });
}

export function notFound(reqOrMessage?: Request | string, message?: string): Response {
  if (reqOrMessage instanceof Request) {
    return jsonResponse(404, {
      error: { code: "NOT_FOUND", message: message ?? "Not found" },
    }, reqOrMessage);
  }
  return jsonResponse(404, {
    error: { code: "NOT_FOUND", message: reqOrMessage ?? "Not found" },
  });
}

export function conflict(
  codeOrReq?: string | Request,
  messageOrCode?: string,
  detailsOrMessage?: unknown,
  details?: unknown,
): Response {
  if (codeOrReq instanceof Request) {
    return jsonResponse(409, {
      error: { code: messageOrCode ?? "CONFLICT", message: (detailsOrMessage as string) ?? "Conflict", details },
    }, codeOrReq);
  }
  return jsonResponse(409, {
    error: { code: codeOrReq ?? "CONFLICT", message: messageOrCode ?? "Conflict", details: detailsOrMessage },
  });
}

export function serverError(
  reqOrMessage?: Request | string,
  messageOrDetails?: string | unknown,
  details?: unknown,
): Response {
  if (reqOrMessage instanceof Request) {
    return jsonResponse(500, {
      error: { code: "INTERNAL_ERROR", message: (messageOrDetails as string) ?? "Internal server error", details },
    }, reqOrMessage);
  }
  return jsonResponse(500, {
    error: { code: "INTERNAL_ERROR", message: reqOrMessage ?? "Internal server error", details: messageOrDetails },
  });
}

export function unprocessable(
  reqOrMessage?: Request | string,
  messageOrDetails?: string | unknown,
  details?: unknown,
): Response {
  if (reqOrMessage instanceof Request) {
    return jsonResponse(422, {
      error: { code: "UNPROCESSABLE_ENTITY", message: (messageOrDetails as string) ?? "Validation failed", details },
    }, reqOrMessage);
  }
  return jsonResponse(422, {
    error: { code: "UNPROCESSABLE_ENTITY", message: reqOrMessage ?? "Validation failed", details: messageOrDetails },
  });
}
