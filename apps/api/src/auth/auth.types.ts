import type { Request } from 'express';
import type { PublicUser as PublicUserResponse } from '@repo/contracts';

export interface PublicUser extends Omit<PublicUserResponse, 'createdAt'> {
  createdAt: Date;
}

export interface AuthenticatedRequest extends Request {
  authUser?: PublicUser;
}
