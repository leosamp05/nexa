-- Introduce a non-privileged role for self-registered and guest users.
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'USER';
