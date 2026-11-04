import { ApiError } from "../api/client";

export interface IssueError {
  code: string;
  message: string;
  missing: boolean;
}

export function describeIssueError(caught: unknown): IssueError {
  if (caught instanceof ApiError) {
    return { code: caught.code, message: caught.message, missing: caught.status === 404 };
  }
  return {
    code: "REQUEST_FAILED",
    message: caught instanceof Error ? caught.message : "The issue request failed.",
    missing: false,
  };
}

export function errorLabel(error: IssueError): string {
  return `${error.code}: ${error.message}`;
}
