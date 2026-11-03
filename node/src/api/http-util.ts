import type http from "node:http";

import { ApiError } from "./errors.js";

/** Shared request/response helpers for the product API routes. */

const MAX_BODY_BYTES = 1024 * 1024;

export async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) {
      throw new ApiError(400, "INVALID_REQUEST", "request body is too large");
    }
    chunks.push(buffer);
  }
  if (size === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ApiError(400, "INVALID_REQUEST", "request body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    throw new ApiError(400, "INVALID_REQUEST", "request body is not valid JSON");
  }
}

export function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new ApiError(400, "INVALID_REQUEST", `${field} is required`);
  }
  return value;
}

export function optionalStringArray(body: Record<string, unknown>, field: string): string[] {
  const value = body[field];
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new ApiError(400, "INVALID_REQUEST", `${field} must be an array of strings`);
  }
  return value as string[];
}

export function writeJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const encoded = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(encoded),
  });
  res.end(encoded);
}

export function writeText(res: http.ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

export function writeRedirect(
  res: http.ServerResponse,
  location: string,
  setCookies: string[] = [],
): void {
  res.writeHead(302, {
    Location: location,
    ...(setCookies.length > 0 ? { "Set-Cookie": setCookies } : {}),
  });
  res.end();
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}
