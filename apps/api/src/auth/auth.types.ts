import type { Request } from 'express';

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
}

export interface AuthenticatedRequest extends Request {
  authUser?: PublicUser;
}
