/* eslint-disable */

const parseAllowedOrigins = () =>
  new Set(
    (Deno.env.get("APP_ALLOWED_ORIGINS") || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );

export const getCorsHeaders = (request: Request, methods = "POST, OPTIONS") => {
  const origin = request.headers.get("Origin") || "";
  const allowedOrigins = parseAllowedOrigins();
  const allowedOrigin = allowedOrigins.has(origin) ? origin : "";

  return {
    ...(allowedOrigin ? { "Access-Control-Allow-Origin": allowedOrigin } : {}),
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": methods,
    Vary: "Origin",
  };
};

export const jsonResponse = (
  request: Request,
  status: number,
  body: unknown,
  methods?: string,
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...getCorsHeaders(request, methods),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });

export const errorResponse = (
  request: Request,
  status: number,
  code: string,
  methods?: string,
) => jsonResponse(request, status, { error: code }, methods);
