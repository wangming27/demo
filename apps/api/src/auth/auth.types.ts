import type { Request } from 'express';
import type { UserRole } from '../generated/prisma/client';

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
  role: UserRole;
}

export interface AuthenticatedRequest extends Request {
  authUser?: PublicUser;
}
