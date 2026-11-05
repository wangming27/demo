import type { ManagedUser, PublicUser } from '@repo/contracts';

type StoredPublicUser = Omit<PublicUser, 'createdAt'> & { createdAt: Date };
type StoredManagedUser = Omit<ManagedUser, 'createdAt' | 'updatedAt'> & {
  createdAt: Date;
  updatedAt: Date;
};

export function serializePublicUser(user: StoredPublicUser): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
  };
}

export function serializeManagedUser(user: StoredManagedUser): ManagedUser {
  return {
    ...serializePublicUser(user),
    status: user.status,
    updatedAt: user.updatedAt.toISOString(),
  };
}
