export type EmployeeRoleStatus =
  | "awaiting_position"
  | "configured"
  | "unmapped";

export interface EmployeeIdentity {
  userId: string;
  username: string;
  realName: string;
  phone: string;
  email: string;
}

export interface EmployeeRoleBinding {
  status: EmployeeRoleStatus;
  department: string;
  position: string;
  roleId: string | null;
  roleName: string | null;
  mandatorySkills: string[];
}

export interface EmployeeProfileBinding {
  schemaVersion: 1;
  provisionState: "ready";
  employee: EmployeeIdentity;
  role: EmployeeRoleBinding;
  soulTemplateVersion: number;
  roleCatalogVersion: number;
  updatedAt: number;
}

export interface EmployeeProvisionResult {
  ok: true;
  profileId: string;
  userId: string;
  realName: string;
  models: string[];
  fallbackConfigured: boolean;
  role: EmployeeRoleBinding;
  activated: boolean;
}
