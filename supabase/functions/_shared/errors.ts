import { corsHeaders } from "./cors.ts";

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

function jsonResponse(status: number, body: ErrorBody): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function badRequest(
  message = "Bad request",
  details?: unknown,
): Response {
  return jsonResponse(400, {
    error: { code: "BAD_REQUEST", message, details },
  });
}

export function unauthorized(message = "Unauthorized"): Response {
  return jsonResponse(401, {
    error: { code: "UNAUTHORIZED", message },
  });
}

export function forbidden(message = "Forbidden"): Response {
  return jsonResponse(403, {
    error: { code: "FORBIDDEN", message },
  });
}

export function notFound(message = "Not found"): Response {
  return jsonResponse(404, {
    error: { code: "NOT_FOUND", message },
  });
}

export function conflict(
  code = "CONFLICT",
  message = "Conflict",
  details?: unknown,
): Response {
  return jsonResponse(409, {
    error: { code, message, details },
  });
}

export function serverError(
  message = "Internal server error",
  details?: unknown,
): Response {
  return jsonResponse(500, {
    error: { code: "INTERNAL_ERROR", message, details },
  });
}
