import { ZodError } from "zod";

export type PublicError = {
  code: string;
  message: string;
  statusCode: number;
};

const SAFE_MESSAGES: Record<string, { message: string; statusCode: number }> = {
  VALIDATION_ERROR: {
    message: "The request contains invalid data.",
    statusCode: 400,
  },
  UNAUTHORIZED: {
    message: "Authentication is required.",
    statusCode: 401,
  },
  FORBIDDEN: {
    message: "You do not have permission to perform this action.",
    statusCode: 403,
  },
  NOT_FOUND: {
    message: "The requested resource was not found.",
    statusCode: 404,
  },
  CONFLICT: {
    message: "The request conflicts with the current resource state.",
    statusCode: 409,
  },
  RATE_LIMITED: {
    message: "Too many requests. Please try again later.",
    statusCode: 429,
  },
  INTERNAL_ERROR: {
    message: "An unexpected server error occurred.",
    statusCode: 500,
  },
};

export function toPublicError(error: unknown): PublicError {
  if (error instanceof ZodError) {
    return {
      code: "VALIDATION_ERROR",
      message: SAFE_MESSAGES.VALIDATION_ERROR.message,
      statusCode: 400,
    };
  }

  if (error && typeof error === "object") {
    const candidate = error as {
      code?: unknown;
      statusCode?: unknown;
      status?: unknown;
      name?: unknown;
    };

    if (candidate.name === "CastError") {
      return {
        code: "VALIDATION_ERROR",
        message: SAFE_MESSAGES.VALIDATION_ERROR.message,
        statusCode: 400,
      };
    }

    if (candidate.code === 11000) {
      return {
        code: "CONFLICT",
        message: SAFE_MESSAGES.CONFLICT.message,
        statusCode: 409,
      };
    }

    const code = typeof candidate.code === "string" ? candidate.code : "";
    if (code in SAFE_MESSAGES) {
      const safe = SAFE_MESSAGES[code];
      return { code, message: safe.message, statusCode: safe.statusCode };
    }
  }

  // Never expose raw exception messages, database details, or credentials.
  return {
    code: "INTERNAL_ERROR",
    message: SAFE_MESSAGES.INTERNAL_ERROR.message,
    statusCode: 500,
  };
}
