export type PublicErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'REQUEST_FAILED'
  | 'INTERNAL_ERROR';

export interface PublicApiError {
  code: PublicErrorCode;
  message: string;
}

const errorsByStatus: Record<number, PublicApiError> = {
  400: { code: 'VALIDATION_ERROR', message: 'Request validation failed.' },
  401: { code: 'UNAUTHENTICATED', message: 'Authentication is required.' },
  403: { code: 'FORBIDDEN', message: 'You do not have permission to perform this action.' },
  404: { code: 'NOT_FOUND', message: 'The requested resource was not found.' },
  409: { code: 'CONFLICT', message: 'The request conflicts with the current state.' },
  422: { code: 'VALIDATION_ERROR', message: 'Request validation failed.' },
  429: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' },
  503: {
    code: 'DEPENDENCY_UNAVAILABLE',
    message: 'A required service is temporarily unavailable.',
  },
};

export function mapPublicError(statusCode: number): PublicApiError {
  if (statusCode >= 500) {
    return { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' };
  }

  return (
    errorsByStatus[statusCode] ?? {
      code: 'REQUEST_FAILED',
      message: 'The request could not be completed.',
    }
  );
}
