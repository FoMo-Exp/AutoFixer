import type { DshError } from "../dsh/client.js";

/** forgepilot-api/v1 error envelope (M0 contract). */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    request_id: string;
    retryable: boolean;
    details: Record<string, unknown>;
  };
}

/** An error that renders as the contract's error envelope. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
    retryable = false,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }

  toBody(requestId: string): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        request_id: requestId,
        retryable: this.retryable,
        details: this.details,
      },
    };
  }
}

/**
 * Translate a dsh-control/v1 failure into the product API's error vocabulary.
 *
 * Node maps dsh policy outcomes without exposing dsh internals: the contract
 * codes the M0 error model allows, with the originating dsh code preserved in
 * `details.dsh_code` for audit correlation.
 */
export function apiErrorFromDsh(error: DshError): ApiError {
  const details = { ...error.details, dsh_code: error.code };
  switch (error.status) {
    case 400:
      return new ApiError(400, "INVALID_REQUEST", error.message, details);
    case 403:
      if (error.code === "DSH_SCOPE_DENIED" || error.code === "DSH_POLICY_DENIED") {
        return new ApiError(403, error.code, error.message, details);
      }
      return new ApiError(403, "FORBIDDEN", error.message, details);
    case 404:
      return new ApiError(404, "TASK_NOT_FOUND", error.message, details);
    case 409:
      return new ApiError(409, "TASK_STATE_CONFLICT", error.message, details);
    case 410:
      return new ApiError(410, "DSH_GRANT_EXPIRED", error.message, details);
    case 422:
      return new ApiError(422, "DSH_RISK_PROHIBITED", error.message, details);
    case 428:
      return new ApiError(428, "DSH_APPROVAL_REQUIRED", error.message, details);
    case 429:
      return new ApiError(429, "RATE_LIMITED", error.message, details, true);
    case 503:
      return new ApiError(503, "DSH_UNAVAILABLE", error.message, details, true);
    default:
      return new ApiError(500, "INTERNAL_ERROR", error.message, details);
  }
}
