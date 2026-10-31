export class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const bad = (message) => new AppError(400, message);
export const notFound = (message = 'مش موجود') => new AppError(404, message);
